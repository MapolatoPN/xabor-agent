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

export function crearTokenSesion({ usuarioId, negocioId, rol }) {
  const now = Date.now();
  const payload = { usuarioId, negocioId, rol, iat: now, exp: now + DURACION_MS };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = firmar(payloadB64);
  return `${payloadB64}.${sig}`;
}

// Devuelve el payload {usuarioId, negocioId, rol, iat, exp} si el token es
// válido (firma correcta y no expirado), o null si no lo es. Nunca lanza.
export function verificarTokenSesion(token) {
  try {
    if (!token || typeof token !== 'string') return null;
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
