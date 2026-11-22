// Rutas públicas de alta BASICO. Requieren bandera explícita; no se toca
// el onboarding de Superadmin ni se habilita automáticamente en Railway.
// No existe endpoint público para elegir módulos, plan, negocioId o rol.
import { rateLimitMiddleware } from './rateLimit.js';
import {
  solicitarRegistroBasico, confirmarRegistroBasico, ErrorRegistroBasico,
} from './registroBasico.js';

export const registroBasicoPublicoHabilitado = () =>
  process.env.XABOR_ALTA_PUBLICA_BASICO === 'true';

const soloSiHabilitado = (_req, res, next) => {
  if (!registroBasicoPublicoHabilitado()) {
    return res.status(503).json({ error: 'El registro automático está en preparación', code: 'REGISTRO_NO_DISPONIBLE' });
  }
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
};

function manejarError(res, error) {
  if (error instanceof ErrorRegistroBasico) {
    return res.status(error.status).json({ error: error.message, code: error.code });
  }
  // Nunca devolver SQL, stack, secretos o información de otras cuentas.
  console.error('[registro-basico] Fallo interno:', error?.code || 'desconocido');
  return res.status(500).json({ error: 'No pudimos procesar tu solicitud', code: 'REGISTRO_ERROR' });
}

export function registrarRutasRegistroBasico(app) {
  app.get('/api/publico/registro-basico/estado', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ habilitado: registroBasicoPublicoHabilitado() });
  });
  app.post('/api/publico/registro-basico/solicitar',
    soloSiHabilitado,
    rateLimitMiddleware(req => `registro-basico-ip:${req.ip}`, 5, 15 * 60_000),
    rateLimitMiddleware(req => `registro-basico-email:${typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : 'sin-email'}`, 3, 15 * 60_000),
    async (req, res) => {
      try {
        const salida = await solicitarRegistroBasico(req.body || {});
        return res.status(202).json(salida);
      } catch (e) { return manejarError(res, e); }
    });
  app.post('/api/publico/registro-basico/confirmar',
    soloSiHabilitado,
    rateLimitMiddleware(req => `confirmar-basico:${req.ip}`, 12, 15 * 60_000),
    async (req, res) => {
      try {
        const salida = await confirmarRegistroBasico(req.body?.token);
        return res.status(201).json(salida);
      } catch (e) { return manejarError(res, e); }
    });
}
