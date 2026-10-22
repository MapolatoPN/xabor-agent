// Ritmo de las llamadas de Xabor a Facturapi.
//
// Los barridos en segundo plano (reconciliación cada 5 minutos, cierres,
// ligas, cancelaciones) consultaban Facturapi recibo por recibo, sin pausa:
// ráfagas de varias peticiones por segundo que Facturapi trató como abuso y
// por las que suspendió la cuenta. Aquí vive el freno, en un solo lugar:
//
//   - enBarridoFacturapi(fn): todo lo que corre dentro comparte un presupuesto
//     de llamadas (FACTURAPI_BARRIDO_MAX_LLAMADAS, 20 por omisión) y deja un
//     espacio mínimo entre una y otra (FACTURAPI_BARRIDO_ESPACIO_MS, 1500).
//     Un barrido anidado usa el presupuesto del de afuera, no uno nuevo.
//   - Pausa por negocio: si Facturapi responde 401/403 (cuenta suspendida o
//     llave inválida) Xabor deja de llamar en segundo plano 6 horas; con 429,
//     lo que diga Retry-After (15 minutos si no lo dice). Una respuesta buena,
//     por ejemplo una emisión manual desde el panel, quita la pausa.
//
// Las llamadas que hace una persona (fuera de enBarridoFacturapi) no tienen
// presupuesto ni espera: van una a la vez y al ritmo de quien da clic.
import { AsyncLocalStorage } from 'node:async_hooks';

const contexto = new AsyncLocalStorage();
const pausas = new Map(); // negocioId -> { hasta, motivo }

const PAUSA_RECHAZO_MS = 6 * 60 * 60 * 1000;
const PAUSA_429_MS = 15 * 60 * 1000;

function numeroEnv(nombre, porOmision) {
  const v = process.env[nombre];
  if (v === undefined || v === '') return porOmision;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : porOmision;
}

export class FacturapiRitmoError extends Error {
  constructor(message, codigo) {
    super(message);
    this.name = 'FacturapiRitmoError';
    this.codigo = codigo; // 'FACTURAPI_EN_PAUSA' | 'FACTURAPI_RITMO'
    this.status = 503;
  }
}

/** Corre fn con presupuesto y ritmo de barrido. Si ya hay uno activo, lo comparte. */
export function enBarridoFacturapi(fn, { llamadas, espacioMs } = {}) {
  if (contexto.getStore()) return fn();
  return contexto.run({
    restantes: llamadas ?? numeroEnv('FACTURAPI_BARRIDO_MAX_LLAMADAS', 20),
    espacioMs: espacioMs ?? numeroEnv('FACTURAPI_BARRIDO_ESPACIO_MS', 1500),
    ultima: 0,
  }, fn);
}

export function pausaFacturapi(negocioId) {
  const p = pausas.get(negocioId);
  if (!p) return null;
  if (p.hasta <= Date.now()) { pausas.delete(negocioId); return null; }
  return p;
}

/**
 * Antes de procesar un elemento de un barrido: ¿el negocio no está en pausa y
 * queda presupuesto para las `llamadas` que puede necesitar? (Sincronizar un
 * recibo facturado son dos: el recibo y la factura; quedarse a la mitad
 * dejaría el recibo sin UUID.)
 */
export function puedeLlamarFacturapi(negocioId, llamadas = 2) {
  if (pausaFacturapi(negocioId)) return false;
  const ctx = contexto.getStore();
  return !ctx || ctx.restantes >= llamadas;
}

/** Lo llama apiCall antes de salir a la red. Fuera de un barrido no hace nada. */
export async function antesDeLlamarFacturapi(negocioId) {
  const ctx = contexto.getStore();
  if (!ctx) return;
  const p = pausaFacturapi(negocioId);
  if (p) {
    throw new FacturapiRitmoError(
      `Facturapi en pausa para este negocio hasta ${new Date(p.hasta).toISOString()} (${p.motivo}).`, 'FACTURAPI_EN_PAUSA');
  }
  if (ctx.restantes <= 0) throw new FacturapiRitmoError('Se agotaron las llamadas a Facturapi de este barrido.', 'FACTURAPI_RITMO');
  ctx.restantes -= 1;
  const espera = ctx.ultima + ctx.espacioMs - Date.now();
  if (espera > 0) await new Promise((r) => setTimeout(r, espera));
  ctx.ultima = Date.now();
}

/** Lo llama apiCall con cada respuesta de Facturapi. */
export function registrarRespuestaFacturapi(negocioId, status, { codigo = null, retryAfter = null } = {}) {
  if (status >= 200 && status < 300) {
    if (pausas.delete(negocioId)) console.log('[Facturapi] respuesta correcta: se reanudan los barridos de este negocio');
    return;
  }
  let ms = null, motivo = null;
  if (status === 401 || status === 403 || /suspend/i.test(String(codigo || ''))) {
    ms = PAUSA_RECHAZO_MS; motivo = `Facturapi respondió ${status}${codigo ? ` ${codigo}` : ''}`;
  } else if (status === 429) {
    const s = Number(retryAfter);
    ms = Number.isFinite(s) && s > 0 ? s * 1000 : PAUSA_429_MS; motivo = 'Facturapi pidió bajar el ritmo (429)';
  }
  if (ms === null) return;
  const hasta = Date.now() + ms;
  const previa = pausas.get(negocioId);
  if (!previa || previa.hasta < hasta) pausas.set(negocioId, { hasta, motivo });
  if (!previa) console.warn(`[Facturapi] ${motivo}: barridos en pausa ${Math.round(ms / 60000)} min para este negocio`);
}

/** Solo pruebas. */
export function _reiniciarRitmoFacturapi() { pausas.clear(); }
