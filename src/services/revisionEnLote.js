/**
 * revisionEnLote.js — «Marcar todas como revisadas» (Chats → Revisión).
 *
 * 29-oct-2026: Obispado juntó 116 conversaciones en revisión desde el 30-sep.
 * Todas con el bot pausado: si uno de esos clientes vuelve a escribir, el bot
 * no le contesta. Mario pidió un botón para marcarlas de una vez y aprobó que
 * deje fuera las que una persona debe ver una por una.
 *
 * Cada conversación marcada recibe EXACTAMENTE lo mismo que «Revisé y atendí»
 * (escribirDevolucionAlBot, vencimientoPausasWhatsapp.js): sus entradas pasan a
 * 'revisado', se quita la revisión, se reinicia el agente y vuelve al bot.
 *
 * Dos pasos: la vista previa dice cuántas se marcan y por qué quedan fuera las
 * demás; al confirmar, cada una se vuelve a leer y a decidir dentro de su propia
 * transacción, con el mismo candado y los mismos FOR UPDATE que el job. Si algo
 * cambió desde la vista previa (llegó un mensaje, alguien la tomó, el bot la
 * volvió a escalar), esa no se toca.
 */
import { pool as poolApp, registrarAuditoriaPlataforma } from './database.js';
import { leerCandidatas, claveDelCandado, escribirDevolucionAlBot } from './vencimientoPausasWhatsapp.js';
import { motivoDeDineroOIncierto, clasificarOrigen, VENTANA_CLIENTE_HORAS } from './pausaVencePolitica.js';

export const MAX_POR_LOTE = 500;

// Se revisan una por una aunque no hablen de dinero: factura, evento o
// catering (una venta por cerrar) y quejas.
const MOTIVO_DELICADO = /^(?:FACTURACION_|SOLICITUD_EVENTO|CATERING_|RECEPCION_QUEJA|RECEPCION_RETRASO)/;

export const ETIQUETA_FUERA = Object.freeze({
  pago_o_incierto: 'pago, comprobante o pedido sin confirmar',
  caso_delicado: 'factura, evento o queja',
  cliente_reciente: `el cliente escribió en las últimas ${VENTANA_CLIENTE_HORAS} h`,
  tomada_por_persona: 'la tomó una persona del equipo',
  atendiendo_ahora: 'alguien la está atendiendo ahora',
  // Solo al aplicar: algo cambió entre la vista previa y la confirmación.
  cambio: 'cambió mientras tanto (mensaje nuevo o alguien la atendió)',
  formato: 'teléfono con formato no reconocido',
  error: 'no se pudo marcar',
});
const TELEFONO = /^\d{8,15}$/;

/** LA DECISIÓN, pura. `f` es una fila de leerCandidatas({ revisionEnLote }). */
export function decidirRevisionEnLote(f) {
  const no = (razon) => ({ marca: false, razon });
  if (!f || f.requiere_revision !== true) return no('sin_revision');
  if (motivoDeDineroOIncierto(f.motivo)) return no('pago_o_incierto');
  if (MOTIVO_DELICADO.test(String(f.motivo ?? '').trim())) return no('caso_delicado');
  // Lo que guardó el agente, no solo el primer motivo de la revisión.
  if (f.confirmacion_incierta === true || f.confirmacion_sin_resultado === true
    || motivoDeDineroOIncierto(f.handoff_motivo) || (f.motivos_agente || []).some(motivoDeDineroOIncierto)
    || f.pedido_esperando_pago === true) return no('pago_o_incierto');
  // Una persona la tomó a propósito: devolverla al bot desharía su «Tomar».
  if (clasificarOrigen(f) === 'manual') return no('tomada_por_persona');
  if (f.takeover_vigente === true || Number(f.entradas_procesando) > 0) return no('atendiendo_ahora');
  const h = f.horas_desde_cliente;
  if (h !== null && h !== undefined && Number(h) < VENTANA_CLIENTE_HORAS) return no('cliente_reciente');
  return { marca: true, razon: 'marca' };
}

const resumenFuera = (conteo) => Object.entries(conteo)
  .map(([razon, n]) => ({ razon, etiqueta: ETIQUETA_FUERA[razon] || razon, n }))
  .sort((a, b) => b.n - a.n);

/** Vista previa: { total, conversaciones: [{ telefono, huella }], fuera: [{ razon, etiqueta, n }] }. */
export async function previsualizarRevisionEnLote(negocioId, { db = poolApp } = {}) {
  const filas = await leerCandidatas(db, { negocioId, revisionEnLote: true, limite: MAX_POR_LOTE });
  const conversaciones = []; const fuera = {};
  for (const f of filas) {
    const d = TELEFONO.test(f.telefono) ? decidirRevisionEnLote(f) : { marca: false, razon: 'formato' };
    if (d.marca) conversaciones.push({ telefono: f.telefono, huella: f.huella });
    else fuera[d.razon] = (fuera[d.razon] || 0) + 1;
  }
  return { total: filas.length, conversaciones, fuera: resumenFuera(fuera) };
}

/** Lo que manda el panel: la lista de la vista previa, tal cual. */
export function listaValida(lista) {
  if (!Array.isArray(lista) || !lista.length || lista.length > MAX_POR_LOTE) return null;
  const vistos = new Set();
  for (const x of lista) {
    if (!x || typeof x.telefono !== 'string' || !TELEFONO.test(x.telefono)
      || typeof x.huella !== 'string' || !x.huella || x.huella.length > 400 || vistos.has(x.telefono)) return null;
    vistos.add(x.telefono);
  }
  return lista.map(({ telefono, huella }) => ({ telefono, huella }));
}

async function marcarUna(db, negocioId, { telefono, huella }, { usuarioId, actor }) {
  const cliente = await db.connect();
  const no = async (razon) => { await cliente.query('ROLLBACK'); return { ok: false, razon }; };
  try {
    await cliente.query('BEGIN');
    const { rows: [candado] } = await cliente.query(
      'SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS ok', [claveDelCandado(negocioId, telefono)]);
    if (!candado.ok) return await no('atendiendo_ahora');
    // Mismo orden que el job: primero las dos filas, luego la relectura.
    await cliente.query('SELECT 1 FROM conversaciones_control WHERE negocio_id=$1 AND telefono=$2 FOR UPDATE', [negocioId, telefono]);
    await cliente.query('SELECT 1 FROM whatsapp_conversaciones WHERE negocio_id=$1 AND telefono=$2 FOR UPDATE', [negocioId, telefono]);
    const [fresca] = await leerCandidatas(cliente, { negocioId, telefono, limite: 1, revisionEnLote: true });
    if (!fresca || fresca.huella !== huella) return await no('cambio');
    const d = decidirRevisionEnLote(fresca);
    if (!d.marca) return await no(d.razon);
    const escrito = await escribirDevolucionAlBot(cliente, fresca, { quitadoPor: usuarioId });
    if (!escrito) return await no('cambio');
    await registrarAuditoriaPlataforma({
      ...actor, accion: 'devolver_conversacion_bot', negocioId,
      estadoAnterior: { telefono, bot_pausado: fresca.bot_pausado === true, motivo: fresca.motivo || null },
      estadoNuevo: { telefono, bot_pausado: false, revision_en_lote: true },
    }, cliente);
    await cliente.query('COMMIT');
    return { ok: true };
  } catch (e) {
    await cliente.query('ROLLBACK').catch(() => {});
    console.error(`[REVISION-LOTE] negocio=${negocioId} ***${telefono.slice(-4)}: ${e.message}`);
    return { ok: false, razon: 'error' };
  } finally {
    cliente.release();
  }
}

/**
 * Marca la lista confirmada. Cada conversación en su propia transacción: una
 * que falle no deshace las demás. `broadcast(telefono)` sale después de cada
 * commit. Devuelve { marcadas, omitidas: [{ razon, etiqueta, n }] }.
 */
export async function aplicarRevisionEnLote(negocioId, lista, { usuarioId, actor, broadcast = null, db = poolApp } = {}) {
  let marcadas = 0; const omitidas = {};
  for (const item of lista) {
    const r = await marcarUna(db, negocioId, item, { usuarioId, actor });
    if (!r.ok) { omitidas[r.razon] = (omitidas[r.razon] || 0) + 1; continue; }
    marcadas++;
    if (broadcast) { try { broadcast(item.telefono); } catch (e) { console.error('[REVISION-LOTE] panel:', e.message); } }
  }
  return { marcadas, omitidas: resumenFuera(omitidas) };
}
