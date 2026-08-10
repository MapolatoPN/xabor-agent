// Worker del buzón durable de WhatsApp.
//
// ─── POR QUÉ EXISTE ─────────────────────────────────────────────────────────
//
// El webhook ya persiste antes de contestar 200. Eso solo sirve si alguien
// vacía después la tabla: sin este proceso, un evento que llega mientras el
// bot está caído se guarda y se queda ahí para siempre. Persistir sin
// procesar no es durabilidad, es una fuga con mejor contabilidad.
//
// El caso que de verdad importa: el webhook guarda, contesta 200, y el
// proceso muere en ese instante. Meta ya tiene su acuse y no reintenta. Al
// arrancar de nuevo, este worker encuentra el evento pendiente y lo procesa
// sin que nadie tenga que reenviar nada.
//
// ─── QUÉ NO HACE ────────────────────────────────────────────────────────────
//
// No decide qué hacer con un mensaje: eso sigue viviendo donde vivía. El
// worker solo garantiza que cada evento se procese una vez, que un worker
// muerto no bloquee la cola, y que dos instancias no se pisen.
import { reclamarEntrantes, marcarEntranteProcesado, marcarEntranteFallido,
         recuperarSalientesColgados, metricasWhatsapp } from './whatsappDurable.js';

const INTERVALO_MS = 1000;
const LOTE = 10;
const LEASE_MS = 60_000;
// Cada cuánto se rescatan los salientes cuyo worker murió en vuelo. No hace
// falta que sea frecuente: son casos raros y su resolución es humana.
const BARRIDO_MS = 30_000;

/**
 * @param procesarEvento  (fila) => Promise<void>. Debe ser idempotente: el
 *   worker puede morir DESPUÉS de aplicar el efecto y ANTES de marcar el
 *   evento, y entonces el reintento lo verá otra vez. Es la razón de que el
 *   procesamiento real dedupliqué por su cuenta (los mensajes por wamid, los
 *   pedidos por su clave de idempotencia).
 */
export function crearWorkerWhatsapp({ procesarEvento, logger = console,
                                      intervaloMs = INTERVALO_MS, lote = LOTE,
                                      leaseMs = LEASE_MS, barridoMs = BARRIDO_MS,
                                      workerId = null } = {}) {
  if (typeof procesarEvento !== 'function') {
    throw new Error('crearWorkerWhatsapp requiere procesarEvento');
  }
  const id = workerId || `wa-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

  let corriendo = false;
  let parando = false;
  // Se guarda la vuelta en curso para que detener() pueda esperarla: cortar a
  // mitad dejaría eventos en 'procesando' hasta que venza su lease.
  let vueltaEnCurso = null;
  let temporizador = null;
  let temporizadorBarrido = null;
  const stats = { vueltas: 0, procesados: 0, fallidos: 0, ultimaVuelta: null, ultimoError: null };

  async function unaVuelta() {
    if (parando) return 0;
    let filas;
    try {
      filas = await reclamarEntrantes(id, { limite: lote, leaseMs });
    } catch (e) {
      // La base no responde. No es un fallo de los eventos: se reintenta en
      // la siguiente vuelta y no se marca nada como fallido.
      stats.ultimoError = e.message;
      logger?.warn?.(`[WA worker] no se pudo reclamar: ${e.message}`);
      return 0;
    }

    for (const fila of filas) {
      if (parando) break;
      try {
        await procesarEvento(fila);
        await marcarEntranteProcesado(fila.id);
        stats.procesados++;
      } catch (e) {
        // Se anota el error y el evento vuelve a la cola hasta agotar sus
        // intentos. Nunca se borra: un evento que no supimos procesar sigue
        // siendo información que alguien tiene que poder ver.
        stats.fallidos++;
        stats.ultimoError = e.message;
        logger?.error?.(`[WA worker] evento ${fila.evento_id} falló: ${e.message}`);
        await marcarEntranteFallido(fila.id, e.message).catch(() => {});
      }
    }
    stats.vueltas++;
    stats.ultimaVuelta = new Date().toISOString();
    return filas.length;
  }

  async function bucle() {
    if (parando || vueltaEnCurso) return;
    vueltaEnCurso = unaVuelta()
      // Si había trabajo, se vuelve enseguida; si no, se espera el intervalo.
      // Así una ráfaga se drena rápido sin consultar en vacío el resto del
      // tiempo.
      .then((n) => { if (!parando && n >= lote) setImmediate(bucle); })
      .catch((e) => logger?.error?.(`[WA worker] vuelta con error: ${e.message}`))
      .finally(() => { vueltaEnCurso = null; });
    return vueltaEnCurso;
  }

  return {
    id,
    get corriendo() { return corriendo; },
    estadisticas() { return { ...stats, workerId: id, corriendo }; },

    iniciar() {
      if (corriendo) return;
      corriendo = true; parando = false;
      logger?.info?.(`[WA worker] iniciado (${id})`);
      temporizador = setInterval(() => { bucle(); }, intervaloMs);
      // unref: el worker no debe impedir que el proceso termine.
      temporizador.unref?.();
      temporizadorBarrido = setInterval(() => {
        recuperarSalientesColgados().catch(() => {});
      }, barridoMs);
      temporizadorBarrido.unref?.();
      bucle();
    },

    /** Apagado ordenado: se espera la vuelta en curso antes de soltar. */
    async detener() {
      if (!corriendo) return;
      parando = true;
      if (temporizador) { clearInterval(temporizador); temporizador = null; }
      if (temporizadorBarrido) { clearInterval(temporizadorBarrido); temporizadorBarrido = null; }
      try { await vueltaEnCurso; } catch { /* ya se registró */ }
      corriendo = false;
      logger?.info?.(`[WA worker] detenido (${id}): ${stats.procesados} procesados, ${stats.fallidos} fallidos`);
    },

    /** Para pruebas y para el arranque: drena hasta vaciar. */
    async drenar({ vueltasMax = 200 } = {}) {
      let total = 0;
      for (let i = 0; i < vueltasMax; i++) {
        const n = await unaVuelta();
        total += n;
        if (n === 0) break;
      }
      return total;
    },

    async metricas() { return metricasWhatsapp(); },
  };
}
