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

/**
 * Crea el state firmado del Embedded Signup.
 *
 * El negocio va DENTRO del state firmado, no en el cuerpo de la petición.
 * Es lo que permite que el callback sea público sin ser inseguro: quien
 * responde no puede elegir a qué negocio conectar el WhatsApp, porque esa
 * decisión ya viaja firmada desde que se abrió la ventana de Meta.
 *
 * Dos actores pueden iniciarlo y la diferencia importa para la auditoría:
 *
 *   superadminId  lo inició Xabor desde el panel de plataforma
 *   usuarioId     lo inició el propio negocio desde su panel (autoservicio)
 *
 * Se exige exactamente uno de los dos. Un state sin actor no se puede
 * auditar, y uno con los dos no se sabe a quién atribuir.
 */
export function crearState({ negocioId, superadminId = null, usuarioId = null }) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) throw new Error('crearState: negocioId requerido');
  const sup = typeof superadminId === 'string' && superadminId.trim() ? superadminId.trim() : null;
  const usr = typeof usuarioId === 'string' && usuarioId.trim() ? usuarioId.trim() : null;
  if (!sup && !usr) throw new Error('crearState: hace falta superadminId o usuarioId');
  if (sup && usr) throw new Error('crearState: no puede haber dos actores en el mismo state');

  const now = Date.now();
  const payload = {
    negocioId: negocioId.trim(),
    superadminId: sup,
    usuarioId: usr,
    actor: sup ? 'superadmin' : 'negocio',
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
    // Un state sin actor no se puede auditar. Vale cualquiera de los dos,
    // pero tiene que haber uno: los de Superadmin traen superadminId, los del
    // autoservicio del negocio traen usuarioId.
    const tieneActor = Boolean(payload.superadminId || payload.usuarioId);
    if (!payload.negocioId || !tieneActor || !payload.exp) return null;
    if (Date.now() > payload.exp) return null; // vencido

    usados.set(state, payload.exp); // marca como consumido -- un solo uso
    return {
      negocioId: payload.negocioId,
      superadminId: payload.superadminId || null,
      usuarioId: payload.usuarioId || null,
      // Los states viejos (anteriores al autoservicio) no traen `actor`; si
      // falta, viene de Superadmin, que era el unico que existia.
      actor: payload.actor || 'superadmin',
    };
  } catch {
    return null;
  }
}
