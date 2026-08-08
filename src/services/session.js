// ─── Sesiones multiempresa (Fase 2) ────────────────────────────────────────
// Token firmado stateless (HMAC-SHA256), sin dependencias nuevas — mismo
// enfoque criptográfico que ya usa server.js para los tokens de panel
// (createHmac con un secreto de servidor), aplicado aquí a un payload
// estructurado {usuarioId, negocioId, rol, iat, exp} en vez de un token
// plano. No es JWT estándar (sin librería), pero sigue el mismo principio:
// payload + firma que solo el servidor puede generar/validar.
//
// Este módulo NO decide autorización — solo emite y valida la sesión.
// La verificación de pertenencia usuario↔negocio vive en database.js
// (obtenerMembresiaUsuarioNegocio), y la decisión de autorizar o no una
// request vive en el middleware requireSesionNegocio de server.js.

import { createHmac, timingSafeEqual } from 'crypto';

const SESSION_SECRET = process.env.SESSION_SECRET || 'xabor-session-secret-temporal';
const DURACION_MS = 12 * 60 * 60 * 1000; // 12 horas

function firmar(payloadB64) {
  return createHmac('sha256', SESSION_SECRET).update(payloadB64).digest('hex');
}

// ─── Revocación de sesión (logout) ─────────────────────────────────────────
// Un token firmado es válido criptográficamente hasta su expiración natural
// aunque el usuario haya cerrado sesión — logout solo borra la cookie del
// navegador, no invalida el token en sí. Se mantiene en memoria el conjunto
// de tokens cerrados explícitamente para que, si esa misma cookie se
// reenvía (p. ej. el botón Atrás del navegador restaura una página
// cacheada que vuelve a llamar a la API con la cookie que aún tenía en
// memoria), el servidor la rechace igual que a un token expirado.
// Limitación conocida y aceptada: es en memoria del proceso — un reinicio
// del servidor limpia la lista y un token cerrado antes del reinicio
// volvería a ser válido hasta su expiración natural (máx. 12h). No hay
// múltiples instancias del proceso hoy, así que esto es suficiente por
// ahora; si el proceso se replica, esto necesitará moverse a un store
// compartido (Redis/DB).
// Map<token, exp> en vez de Set para poder purgar entradas ya expiradas
// (que de todos modos verificarTokenSesion rechazaría por exp) y que el
// set no crezca sin límite en un proceso de larga duración.
const tokensRevocados = new Map();

export function revocarTokenSesion(token) {
  if (!token) return;
  const ahora = Date.now();
  for (const [t, exp] of tokensRevocados) {
    if (exp < ahora) tokensRevocados.delete(t);
  }
  // Guarda la expiración real del token si se puede leer, o una hora desde
  // ahora como respaldo si el payload no se pudo decodificar.
  let exp = ahora + 60 * 60 * 1000;
  try {
    const [payloadB64] = token.split('.');
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (payload.exp) exp = payload.exp;
  } catch { /* token corrupto — se guarda igual con el respaldo de 1h */ }
  tokensRevocados.set(token, exp);
}

// sop (opcional): marca el token como sesión de SOPORTE (Superadmin
// operando el panel de un negocio ajeno). Los middlewares que lo acepten
// deben validarlo ADEMÁS contra sesiones_soporte (revocación server-side)
// y re-verificar el privilegio de superadmin en cada request — el flag
// solo nunca basta. duracionMs (opcional): las sesiones de soporte viven
// menos que las 12h estándar; el default de las sesiones normales no cambia.
// `est: true` marca una sesión de ESTACIÓN DE MESEROS: se emite con PIN en
// /api/auth/mesero/login y solo abre la operación de Restaurante, nunca el
// panel administrativo. Va dentro del payload firmado, así que el cliente no
// puede fabricarla ni convertir una sesión normal en una de mesero.
export function crearTokenSesion({ usuarioId, negocioId, rol, sop, est }, duracionMs = DURACION_MS) {
  const now = Date.now();
  const payload = { usuarioId, negocioId, rol, iat: now, exp: now + duracionMs };
  if (sop === true) payload.sop = true;
  if (est === true) payload.est = true;
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = firmar(payloadB64);
  return `${payloadB64}.${sig}`;
}

// Devuelve el payload {usuarioId, negocioId, rol, iat, exp} si el token es
// válido (firma correcta y no expirado), o null si no lo es. Nunca lanza.
export function verificarTokenSesion(token) {
  try {
    if (!token || typeof token !== 'string') return null;
    if (tokensRevocados.has(token)) return null; // sesión cerrada explícitamente (logout)
    const [payloadB64, sig] = token.split('.');
    if (!payloadB64 || !sig) return null;

    const sigEsperada = firmar(payloadB64);
    const sigBuf = Buffer.from(sig, 'hex');
    const esperadaBuf = Buffer.from(sigEsperada, 'hex');
    if (sigBuf.length !== esperadaBuf.length || !timingSafeEqual(sigBuf, esperadaBuf)) {
      return null; // firma inválida — token manipulado o secreto distinto
    }

    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (!payload.usuarioId || !payload.negocioId || !payload.exp) return null;
    if (Date.now() > payload.exp) return null; // expirado

    return payload;
  } catch {
    return null; // payload corrupto/no-JSON — token inválido, no un error de servidor
  }
}

// ─── Token de preselección de negocio ──────────────────────────────────────
// Cuando un usuario pertenece a varios negocios, el login no puede emitir
// aún una sesión completa (no sabe negocioId). Se emite en su lugar este
// token de corta duración que solo prueba "ya validé email+password para
// usuarioId", para completar la selección en un segundo paso sin pedir la
// contraseña otra vez. No sirve como sesión — no lleva negocioId ni rol.
const DURACION_PREAUTH_MS = 5 * 60 * 1000; // 5 minutos

export function crearTokenPreAuth(usuarioId) {
  const now = Date.now();
  const payload = { usuarioId, tipo: 'seleccion_pendiente', iat: now, exp: now + DURACION_PREAUTH_MS };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${payloadB64}.${firmar(payloadB64)}`;
}

// Devuelve usuarioId si el token de preselección es válido, o null.
export function verificarTokenPreAuth(token) {
  try {
    if (!token || typeof token !== 'string') return null;
    const [payloadB64, sig] = token.split('.');
    if (!payloadB64 || !sig) return null;

    const sigEsperada = firmar(payloadB64);
    const sigBuf = Buffer.from(sig, 'hex');
    const esperadaBuf = Buffer.from(sigEsperada, 'hex');
    if (sigBuf.length !== esperadaBuf.length || !timingSafeEqual(sigBuf, esperadaBuf)) {
      return null;
    }

    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (payload.tipo !== 'seleccion_pendiente' || !payload.usuarioId || !payload.exp) return null;
    if (Date.now() > payload.exp) return null;

    return payload.usuarioId;
  } catch {
    return null;
  }
}
