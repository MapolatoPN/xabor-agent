// ─── Segundo factor (TOTP) de la consola de Superadmin (migración 116) ──────
//
// La contraseña sola ya no abre /api/superadmin/* ni /ws/superadmin: hace
// falta además un código de 6 dígitos de una app de autenticación (RFC 6238:
// HMAC-SHA1, pasos de 30 s, 6 dígitos — lo que esperan Google Authenticator,
// 1Password, Authy). Sin dependencias: crypto de Node.
//
// La prueba de que ESTA sesión pasó el segundo factor es una cookie aparte,
// `xabor_sa2fa`, firmada con SESSION_SECRET y atada a tres cosas:
//   · el usuario (u),
//   · la sesión exacta (s = huella sha256 de la cookie xabor_sesion): robar
//     solo la cookie del 2FA no sirve, y un login nuevo pide un código nuevo;
//   · la versión del TOTP (v): reiniciar el TOTP la invalida en el acto.
// Dura lo que le quede a la sesión, como máximo 12 h.
//
// El secreto se guarda cifrado con INTEGRATIONS_ENCRYPTION_KEY y nunca sale
// del servidor salvo una vez, al darlo de alta, para que se escanee el QR.

import { createHmac, createHash, randomBytes, timingSafeEqual } from 'crypto';
import { pool } from './database.js';
import { cifrarSecretoIntegracion, descifrarSecretoIntegracion } from './cifradoIntegraciones.js';

export const COOKIE_2FA = 'xabor_sa2fa';
const PASO_S = 30;
const DIGITOS = 6;
const VENTANA = 1;            // ±1 paso: tolera 30 s de desfase de reloj
const DURACION_MAX_MS = 12 * 60 * 60 * 1000;
const EMISOR = 'Xabor Superadmin';

// ── RFC 4648 base32 (lo que llevan las URI otpauth://) ──────────────────────
const ALFABETO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(buf) {
  let bits = 0, valor = 0, out = '';
  for (const b of buf) {
    valor = (valor << 8) | b; bits += 8;
    while (bits >= 5) { out += ALFABETO[(valor >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALFABETO[(valor << (5 - bits)) & 31];
  return out;
}
export function desdeBase32(texto) {
  const limpio = String(texto).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, valor = 0; const out = [];
  for (const ch of limpio) {
    valor = (valor << 5) | ALFABETO.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((valor >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

// ── HOTP / TOTP ─────────────────────────────────────────────────────────────
export function codigoHotp(secreto, contador) {
  const c = Buffer.alloc(8);
  c.writeBigUInt64BE(BigInt(contador));
  const h = createHmac('sha1', secreto).update(c).digest();
  const o = h[h.length - 1] & 0x0f;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 10 ** DIGITOS).padStart(DIGITOS, '0');
}

export function pasoActual(ahoraMs = Date.now()) {
  return Math.floor(ahoraMs / 1000 / PASO_S);
}

// Devuelve el paso que corresponde al código, o null. Solo pasos POSTERIORES
// a ultimoPaso: un código ya aceptado no vale dos veces.
export function pasoDelCodigo(secreto, codigo, { ahoraMs = Date.now(), ultimoPaso = null } = {}) {
  if (typeof codigo !== 'string' || !/^\d{6}$/.test(codigo)) return null;
  const base = pasoActual(ahoraMs);
  const dado = Buffer.from(codigo);
  for (let d = -VENTANA; d <= VENTANA; d++) {
    const paso = base + d;
    if (ultimoPaso != null && paso <= Number(ultimoPaso)) continue;
    if (timingSafeEqual(Buffer.from(codigoHotp(secreto, paso)), dado)) return paso;
  }
  return null;
}

// ── Persistencia ────────────────────────────────────────────────────────────
export async function obtenerTotp(usuarioId) {
  const { rows } = await pool.query(
    `SELECT usuario_id, estado, secreto_cifrado, secreto_iv, secreto_tag, secreto_formato, version, ultimo_paso
     FROM superadmin_totp WHERE usuario_id = $1`, [usuarioId]);
  return rows[0] || null;
}

function secretoDe(fila) {
  const texto = descifrarSecretoIntegracion({
    cifrado: fila.secreto_cifrado, iv: fila.secreto_iv, authTag: fila.secreto_tag, version: fila.secreto_formato });
  return desdeBase32(texto);
}

// Alta: solo si no hay un TOTP CONFIRMADO. Uno pendiente (QR mostrado y nunca
// confirmado) se reemplaza. Devuelve el secreto en base32 y la URI otpauth;
// es la única vez que el secreto sale del servidor.
export async function iniciarAltaTotp(usuarioId, etiqueta) {
  const secreto = base32(randomBytes(20));
  const c = cifrarSecretoIntegracion(secreto);
  const { rows } = await pool.query(
    `INSERT INTO superadmin_totp (usuario_id, estado, secreto_cifrado, secreto_iv, secreto_tag, secreto_formato)
     VALUES ($1, 'pendiente', $2, $3, $4, $5)
     ON CONFLICT (usuario_id) DO UPDATE
       SET estado = 'pendiente', secreto_cifrado = EXCLUDED.secreto_cifrado, secreto_iv = EXCLUDED.secreto_iv,
           secreto_tag = EXCLUDED.secreto_tag, secreto_formato = EXCLUDED.secreto_formato,
           version = superadmin_totp.version + 1, ultimo_paso = NULL, confirmado_at = NULL
       WHERE superadmin_totp.estado = 'pendiente'
     RETURNING version`,
    [usuarioId, c.cifrado, c.iv, c.authTag, c.version]);
  if (!rows[0]) { const e = new Error('El segundo factor ya está configurado'); e.code = 'YA_CONFIGURADO'; throw e; }
  const nombre = encodeURIComponent(`${EMISOR}:${etiqueta}`);
  const uri = `otpauth://totp/${nombre}?secret=${secreto}&issuer=${encodeURIComponent(EMISOR)}&algorithm=SHA1&digits=${DIGITOS}&period=${PASO_S}`;
  return { secreto, uri };
}

// Verifica un código. Si el TOTP estaba pendiente, lo confirma. El UPDATE
// condicionado a `ultimo_paso < paso` y a la misma `version` es la garantía
// anti-repetición también entre dos peticiones simultáneas con el mismo
// código: solo una de las dos actualiza la fila.
// Devuelve { ok, version, confirmadoAhora } o { ok:false, motivo }.
export async function verificarCodigoTotp(usuarioId, codigo, ahoraMs = Date.now()) {
  const fila = await obtenerTotp(usuarioId);
  if (!fila) return { ok: false, motivo: 'sin_alta' };
  const paso = pasoDelCodigo(secretoDe(fila), codigo, { ahoraMs, ultimoPaso: fila.ultimo_paso });
  if (paso == null) return { ok: false, motivo: 'codigo_invalido' };
  const { rows } = await pool.query(
    `UPDATE superadmin_totp
        SET ultimo_paso = $2, estado = 'confirmado', confirmado_at = COALESCE(confirmado_at, now())
      WHERE usuario_id = $1 AND version = $3 AND (ultimo_paso IS NULL OR ultimo_paso < $2)
      RETURNING version`,
    [usuarioId, paso, fila.version]);
  if (!rows[0]) return { ok: false, motivo: 'codigo_invalido' };
  return { ok: true, version: rows[0].version, confirmadoAhora: fila.estado === 'pendiente' };
}

// ── Cookie del segundo factor ───────────────────────────────────────────────
function secretoCookie() {
  return process.env.SESSION_SECRET || 'xabor-session-secret-temporal';
}
function firmar(b64) {
  return createHmac('sha256', `sa2fa:${secretoCookie()}`).update(b64).digest('hex');
}
export function huellaSesion(tokenSesion) {
  return createHash('sha256').update(String(tokenSesion)).digest('base64url');
}

export function crearCookie2fa({ usuarioId, tokenSesion, version, expSesion }, ahoraMs = Date.now()) {
  const exp = Math.min(Number(expSesion) || ahoraMs + DURACION_MAX_MS, ahoraMs + DURACION_MAX_MS);
  const b64 = Buffer.from(JSON.stringify({ u: usuarioId, s: huellaSesion(tokenSesion), v: version, exp })).toString('base64url');
  return { valor: `${b64}.${firmar(b64)}`, exp };
}

// Payload si la cookie es auténtica, de ESTE usuario y ESTA sesión, y no ha
// expirado; null en cualquier otro caso. Nunca lanza. La versión se compara
// aparte, contra la base, en sesion2faVigente.
export function leerCookie2fa(valor, { usuarioId, tokenSesion }, ahoraMs = Date.now()) {
  try {
    if (typeof valor !== 'string' || !valor) return null;
    const [b64, sig] = valor.split('.');
    if (!b64 || !sig) return null;
    const a = Buffer.from(sig, 'hex'), b = Buffer.from(firmar(b64), 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const p = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
    if (p.u !== usuarioId || p.s !== huellaSesion(tokenSesion) || !(ahoraMs < p.exp)) return null;
    return p;
  } catch { return null; }
}

export function leerCookie2faDeReq(req) {
  const header = req.headers?.cookie;
  if (!header) return null;
  for (const par of header.split(';')) {
    const i = par.indexOf('=');
    if (i === -1 || par.slice(0, i).trim() !== COOKIE_2FA) continue;
    // Un valor válido es base64url + '.' + hex: nunca lleva «%». No se
    // decodifica nada (decodeURIComponent lanza con «%» suelto).
    return par.slice(i + 1).trim();
  }
  return null;
}

// ¿La petición trae el segundo factor vigente para esta sesión? Consulta la
// versión en la base en cada petición: un TOTP reiniciado o borrado corta las
// sesiones ya verificadas sin esperar a que expiren.
export async function sesion2faVigente(req, { usuarioId, tokenSesion }) {
  const p = leerCookie2fa(leerCookie2faDeReq(req), { usuarioId, tokenSesion });
  if (!p) return false;
  const fila = await obtenerTotp(usuarioId);
  return !!fila && fila.estado === 'confirmado' && fila.version === p.v;
}

export function setCookie2fa(res, valor, exp, ahoraMs = Date.now()) {
  const partes = [`${COOKIE_2FA}=${valor}`, 'Path=/', 'HttpOnly', 'SameSite=Strict',
    `Max-Age=${Math.max(0, Math.floor((exp - ahoraMs) / 1000))}`];
  if (process.env.NODE_ENV === 'production') partes.push('Secure');
  res.append('Set-Cookie', partes.join('; '));
}
