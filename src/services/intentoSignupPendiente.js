// Rastreo del intento de Embedded Signup pendiente por negocio (Fase C).
// Reemplaza el bloqueo booleano signupEnCurso -- en vez de bloquear un
// segundo intento con 409 hasta que venza el timeout, cada negocio
// tiene como máximo UN intento VIGENTE a la vez: iniciar uno nuevo
// reemplaza (invalida) cualquier anterior, y también se puede cancelar
// explícitamente. Nunca se almacena el state completo -- solo su
// digest SHA-256, ni siquiera en memoria.
//
// Efímero a propósito (Map en memoria, no tabla de BD): un reinicio de
// Node borra cualquier intento pendiente, lo cual es correcto -- un
// intento de conexión no tiene sentido sobrevivir a un redeploy.
import { createHash } from 'crypto';

const DURACION_MS = 10 * 60 * 1000; // 10 minutos
const intentos = new Map(); // negocioId -> { stateHash, exp, cancelado }

function hashState(state) {
  return createHash('sha256').update(state).digest('hex');
}

function limpiarSiVencido(negocioId) {
  const entry = intentos.get(negocioId);
  if (entry && Date.now() > entry.exp) intentos.delete(negocioId);
}

/**
 * Registra (o reemplaza) el intento vigente de un negocio. Cualquier
 * intento previo queda automáticamente invalidado: si alguien intenta
 * usar su state más tarde, su hash ya no coincidirá con el nuevo y se
 * rechazará como "reemplazado".
 */
export function registrarIntentoPendiente(negocioId, state) {
  intentos.set(negocioId, { stateHash: hashState(state), exp: Date.now() + DURACION_MS, cancelado: false });
}

/**
 * Cancela el intento vigente de un negocio. Idempotente: si no existe
 * o ya estaba cancelado, sigue devolviendo true -- cancelar dos veces
 * nunca falla. Conserva la entrada (marcada cancelado=true) hasta que
 * venza, para poder rechazar con claridad un callback tardío como
 * "cancelado" en vez de "no encontrado".
 */
export function cancelarIntentoPendiente(negocioId) {
  limpiarSiVencido(negocioId);
  const entry = intentos.get(negocioId);
  if (entry) entry.cancelado = true;
  return true;
}

/** true solo si hay un intento vigente: no cancelado, no vencido. */
export function hayIntentoPendiente(negocioId) {
  limpiarSiVencido(negocioId);
  const entry = intentos.get(negocioId);
  return !!entry && !entry.cancelado;
}

/**
 * Valida que `state` sea el intento VIGENTE del negocio indicado.
 * Se llama DESPUÉS de validarYConsumirState() (que ya verifica firma,
 * vencimiento criptográfico y reutilización del token en sí) -- esta
 * capa cubre lo que esa no puede saber: cancelación explícita y
 * reemplazo por un intento más nuevo. No consume nada del state.
 *
 * A propósito NO usa limpiarSiVencido() aquí: si limpiara primero, un
 * intento vencido desaparecería del Map ANTES de poder distinguirlo de
 * "nunca existió" -- siempre reportaría "no_vigente" en vez de
 * "vencido". Se comprueba el vencimiento explícitamente y solo
 * entonces se limpia, para reportar el motivo correcto.
 */
export function validarIntentoVigente(negocioId, state) {
  const entry = intentos.get(negocioId);
  if (!entry) return { ok: false, motivo: 'no_vigente' };
  if (entry.cancelado) return { ok: false, motivo: 'cancelado' };
  if (Date.now() > entry.exp) {
    intentos.delete(negocioId);
    return { ok: false, motivo: 'vencido' };
  }
  if (hashState(state) !== entry.stateHash) return { ok: false, motivo: 'reemplazado' };
  return { ok: true };
}

/** Limpia el intento tras completarlo (éxito o fallo definitivo). */
export function limpiarIntentoPendiente(negocioId) {
  intentos.delete(negocioId);
}
