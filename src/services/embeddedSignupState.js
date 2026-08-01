// Estado firmado, de un solo uso, para el flujo de Embedded Signup de
// Meta (Fase C). Mismo patrón que session.js (HMAC + payload base64url),
// namespace propio para que nunca colisione con tokens de sesión.
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

const SECRETO = process.env.SESSION_SECRET || 'xabor-session-secret-temporal';
const DURACION_MS = 10 * 60 * 1000; // 10 minutos

const usados = new Map(); // state -> exp (para rechazar reutilización)

function firmar(payloadB64) {
  return createHmac('sha256', SECRETO).update('xabor-embedded-signup:' + payloadB64).digest('hex');
}

function limpiarUsados() {
  const ahora = Date.now();
  for (const [s, exp] of usados) if (exp < ahora) usados.delete(s);
}

export function crearState({ negocioId, superadminId }) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) throw new Error('crearState: negocioId requerido');
  if (typeof superadminId !== 'string' || !superadminId.trim()) throw new Error('crearState: superadminId requerido');
  const now = Date.now();
  const payload = {
    negocioId: negocioId.trim(),
    superadminId: superadminId.trim(),
    nonce: randomBytes(16).toString('hex'),
    iat: now,
    exp: now + DURACION_MS,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${payloadB64}.${firmar(payloadB64)}`;
}

/**
 * Valida y CONSUME el state (uso único). Devuelve { negocioId,
 * superadminId } si es válido, o null si es inválido, vencido, o ya
 * usado. Nunca lanza.
 */
export function validarYConsumirState(state) {
  try {
    limpiarUsados();
    if (typeof state !== 'string' || !state) return null;
    if (usados.has(state)) return null; // reutilización

    const [payloadB64, sig] = state.split('.');
    if (!payloadB64 || !sig) return null;
    const sigEsperada = firmar(payloadB64);
    const sigBuf = Buffer.from(sig, 'hex');
    const espBuf = Buffer.from(sigEsperada, 'hex');
    if (sigBuf.length !== espBuf.length || !timingSafeEqual(sigBuf, espBuf)) return null; // alterado

    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (!payload.negocioId || !payload.superadminId || !payload.exp) return null;
    if (Date.now() > payload.exp) return null; // vencido

    usados.set(state, payload.exp); // marca como consumido -- un solo uso
    return { negocioId: payload.negocioId, superadminId: payload.superadminId };
  } catch {
    return null;
  }
}
