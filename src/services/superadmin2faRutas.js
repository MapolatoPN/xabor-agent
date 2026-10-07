// ─── Rutas del segundo factor de Superadmin (migración 116) ─────────────────
//
// Viven FUERA de /api/superadmin/* a propósito: todo lo de ahí exige el
// segundo factor ya verificado, y estas rutas son justo las que lo dan. Piden
// sesión moderna + privilegio de superadmin vivo, nada más.
//
//   GET  /api/superadmin-2fa/estado     { configurado, verificado }
//   POST /api/superadmin-2fa/alta       { password } → { secreto, uri, qr }
//   POST /api/superadmin-2fa/verificar  { codigo }   → cookie xabor_sa2fa
//
// El alta vuelve a pedir la contraseña y solo procede si NO hay un TOTP
// confirmado: una vez dado de alta, la web no permite cambiarlo (reponer un
// teléfono perdido: scripts/superadmin-2fa-reiniciar.mjs). Cada alta,
// verificación y fallo queda en la bitácora con la IP.
import { esSuperadmin, obtenerUsuarioPorId, obtenerUsuarioPorEmail, registrarAuditoriaPlataforma } from './database.js';
import { verificarTokenSesion } from './session.js';
import { verifyPassword } from './password.js';
import { rateLimitMiddleware } from './rateLimit.js';
import {
  obtenerTotp, iniciarAltaTotp, verificarCodigoTotp, crearCookie2fa, setCookie2fa, sesion2faVigente,
} from './superadmin2fa.js';

const INTENTOS = 5;
const VENTANA_MS = 5 * 60 * 1000;

async function auditar(req, accion, contexto = null) {
  try {
    await registrarAuditoriaPlataforma({ superadminId: req.usuarioId, accion, contexto, ip: req.ip || null });
  } catch (e) {
    console.error(`[superadmin-2fa] No se pudo auditar ${accion}:`, e.message);
  }
}

export function registrarRutasSuperadmin2fa(app, { leerCookieSesion }) {
  // Sesión moderna + superadmin vivo; nunca una sesión de soporte.
  async function requireSuperadminSin2fa(req, res, next) {
    try {
      const token = leerCookieSesion(req);
      const payload = token ? verificarTokenSesion(token) : null;
      if (!payload || !payload.usuarioId) return res.status(401).json({ error: 'No autenticado' });
      if (payload.sop === true) {
        return res.status(403).json({ error: 'Estás en una sesión de soporte — sal de soporte para usar la consola de Superadmin' });
      }
      if (!(await esSuperadmin(payload.usuarioId))) {
        return res.status(403).json({ error: 'Acceso exclusivo del propietario de la plataforma' });
      }
      req.usuarioId = payload.usuarioId;
      req.tokenSesion = token;
      req.expSesion = payload.exp;
      return next();
    } catch (e) {
      console.error('[superadmin-2fa] Error de autenticación:', e.message);
      return res.status(503).json({ error: 'No se pudo verificar el acceso' });
    }
  }

  const limitePorUsuario = (nombre) => rateLimitMiddleware(
    req => `sa2fa-${nombre}:${req.usuarioId}`, INTENTOS, VENTANA_MS,
    'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.');
  const limitePorIp = (nombre) => rateLimitMiddleware(
    req => `sa2fa-${nombre}-ip:${req.ip}`, INTENTOS * 2, VENTANA_MS,
    'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.');

  app.get('/api/superadmin-2fa/estado', requireSuperadminSin2fa, async (req, res) => {
    try {
      const fila = await obtenerTotp(req.usuarioId);
      const verificado = await sesion2faVigente(req, { usuarioId: req.usuarioId, tokenSesion: req.tokenSesion });
      res.json({ configurado: fila?.estado === 'confirmado', verificado });
    } catch (e) {
      console.error('[GET /api/superadmin-2fa/estado] Error:', e.message);
      res.status(500).json({ error: 'No se pudo leer el estado del segundo factor' });
    }
  });

  app.post('/api/superadmin-2fa/alta', limitePorIp('alta'), requireSuperadminSin2fa, limitePorUsuario('alta'), async (req, res) => {
    try {
      const { password } = req.body || {};
      const usuario = await obtenerUsuarioPorId(req.usuarioId);
      const conHash = usuario ? await obtenerUsuarioPorEmail(usuario.email) : null;
      if (typeof password !== 'string' || !conHash || conHash.id !== req.usuarioId
          || !verifyPassword(password, conHash.password_hash)) {
        await auditar(req, 'superadmin_2fa_alta_rechazada', { motivo: 'password_incorrecta' });
        return res.status(400).json({ error: 'Contraseña incorrecta' });
      }
      const { secreto, uri } = await iniciarAltaTotp(req.usuarioId, usuario.email);
      let qr = null;
      try {
        const QR = (await import('qrcode')).default;
        qr = await QR.toDataURL(uri, { margin: 1, width: 240 });
      } catch (e) {
        console.error('[superadmin-2fa] No se pudo dibujar el QR:', e.message); // el secreto en texto basta
      }
      await auditar(req, 'superadmin_2fa_alta_iniciada');
      res.set('Cache-Control', 'no-store');
      res.json({ secreto, uri, qr });
    } catch (e) {
      if (e.code === 'YA_CONFIGURADO') return res.status(409).json({ error: e.message });
      console.error('[POST /api/superadmin-2fa/alta] Error:', e.message);
      res.status(500).json({ error: 'No se pudo iniciar el alta del segundo factor' });
    }
  });

  app.post('/api/superadmin-2fa/verificar', limitePorIp('verificar'), requireSuperadminSin2fa, limitePorUsuario('verificar'), async (req, res) => {
    try {
      const codigo = String(req.body?.codigo ?? '').replace(/\s+/g, '');
      const r = await verificarCodigoTotp(req.usuarioId, codigo);
      if (!r.ok) {
        await auditar(req, 'superadmin_2fa_fallido', { motivo: r.motivo });
        return res.status(400).json({ error: r.motivo === 'sin_alta' ? 'Primero da de alta el segundo factor' : 'Código incorrecto o ya usado' });
      }
      const { valor, exp } = crearCookie2fa({ usuarioId: req.usuarioId, tokenSesion: req.tokenSesion, version: r.version, expSesion: req.expSesion });
      setCookie2fa(res, valor, exp);
      await auditar(req, r.confirmadoAhora ? 'superadmin_2fa_alta_confirmada' : 'superadmin_2fa_verificado');
      res.json({ ok: true });
    } catch (e) {
      console.error('[POST /api/superadmin-2fa/verificar] Error:', e.message);
      res.status(500).json({ error: 'No se pudo verificar el código' });
    }
  });
}
