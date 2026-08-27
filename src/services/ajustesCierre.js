/**
 * ajustesCierre.js — Ajustes administrativos al cierre de semana.
 *
 * Herramienta para revisar las ventas NO facturadas de una semana operativa
 * y registrar descuentos, bonificaciones, cortesías, devoluciones o ajustes
 * administrativos. Tres invariantes gobiernan todo este archivo:
 *
 * 1. LA VENTA ORIGINAL ES INMUTABLE. Ningún camino de este módulo escribe
 *    en pedidos_activos, pedidos, pagos ni cortes_caja. Un ajuste es un
 *    renglón SEPARADO en ajustes_cierre que conserva monto original, monto
 *    del ajuste y neto. Los cortes cerrados jamás se reescriben: el ajuste
 *    es una capa administrativa posterior, visible en su propio reporte.
 *
 * 2. UNA VENTA FACTURADA ESTÁ BLOQUEADA. La fuente es facturas_pedido (el
 *    registro local de emisión, ver migración 065). El bloqueo se valida
 *    DOS veces: en la vista previa y otra vez dentro de la transacción de
 *    confirmación — si alguien facturó el pedido entre una y otra, el lote
 *    completo se rechaza con el folio señalado y no se aplica nada.
 *
 * 3. REVERSIÓN, JAMÁS BORRADO. Revertir marca estado='revertido' con actor,
 *    motivo y fecha; el renglón queda como constancia histórica.
 *
 * SEMANA OPERATIVA: lunes a domingo en la zona horaria DEL NEGOCIO (mismo
 * kit de día operativo que los cortes de caja). Una venta de sábado 23:40
 * hora local pertenece a esa semana aunque en UTC ya sea domingo.
 *
 * BRECHA DOCUMENTADA (facturación posterior al ajuste): si una venta
 * ajustada se factura DESPUÉS, el CFDI se emite con los datos originales
 * del pedido — integrar el monto ajustado a la factura requeriría tocar la
 * generación de CFDI, lo cual queda fuera de este módulo a propósito. El
 * reporte marca esas ventas como "ajustada y facturada después" para que
 * el contador las revise a mano.
 */
import { randomUUID } from 'crypto';
import { pool } from './database.js';
import {
  zonaHorariaNegocio, fechaOperativaHoy, fechaOperativaDe,
  rangoUtcDeFecha, esFechaValida, clasificarFormaPago,
} from './cortesCaja.js';

export const TIPOS_AJUSTE = Object.freeze(['descuento', 'bonificacion', 'cortesia', 'devolucion', 'ajuste']);
export const MODOS_AJUSTE = Object.freeze(['fijo', 'porcentual']);

const dinero = (n) => Math.round((Number(n) || 0) * 100) / 100;

function err(mensaje, code) {
  const e = new Error(mensaje); e.code = code; return e;
}

function requerirNegocio(negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    throw err('negocioId requerido', 'TENANT_CONTEXT_REQUIRED');
  }
  return negocioId.trim();
}

// ─── Semana operativa ───────────────────────────────────────────────────────

// ─── Frontera de facturación confiable (fail-closed histórico) ──────────────
// Antes de que facturas_pedido empezara a registrar emisiones NO existe un
// vínculo confiable pedido→CFDI (auditoría del gate: Facturapi nunca recibió
// el folio; `invoices` del SAT no enlaza a pedidos). Por eso NO se puede
// afirmar "no facturada" de una venta anterior a esa frontera: se clasifica
// como HISTORICA_NO_VERIFICABLE y queda fuera de todo ajuste.
//
// La frontera vive en `configuracion` (clave `ajustes_facturacion_confiable_desde`,
// por negocio) como un INSTANTE ISO-8601 en UTC. Se compara contra
// pedidos_activos.created_at, que también es un instante UTC — comparación de
// instantes, sin ninguna ambigüedad de zona horaria. Una fecha desnuda
// ('YYYY-MM-DD') se interpreta como medianoche UTC de ese día.
//
// FAIL-CLOSED: si la clave NO existe, la frontera es +infinito, es decir
// TODAS las ventas son históricas no verificables y NADA es elegible. El
// módulo queda inerte hasta que el rollout fije la clave al instante del
// despliegue del sistema confiable. Nunca se hardcodea una fecha aquí.
export const CLAVE_CUTOFF = 'ajustes_facturacion_confiable_desde';

export async function fronteraFacturacionConfiable(negocioId) {
  const nid = requerirNegocio(negocioId);
  const { rows } = await pool.query(
    `SELECT valor FROM configuracion WHERE negocio_id = $1 AND clave = $2 LIMIT 1`,
    [nid, CLAVE_CUTOFF]);
  const crudo = rows[0]?.valor?.trim();
  if (!crudo) return { instante: null, configurada: false };   // fail-closed
  // Fecha desnuda → medianoche UTC; instante ISO → tal cual.
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(crudo) ? `${crudo}T00:00:00Z` : crudo;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    // Un valor corrupto NO abre la puerta: se comporta como sin configurar.
    console.error(`[Ajustes] cutoff inválido para ${nid}: ${crudo} — fail-closed`);
    return { instante: null, configurada: false, invalida: true };
  }
  return { instante: d, configurada: true };
}

/** Lunes ('YYYY-MM-DD') de la semana a la que pertenece la fecha dada. */
export function lunesDeSemana(fecha) {
  if (!esFechaValida(fecha)) throw err(`Fecha inválida: ${fecha}`, 'FECHA_INVALIDA');
  const d = new Date(`${fecha}T12:00:00Z`);           // mediodía UTC: inmune a desfases
  const retroceso = (d.getUTCDay() + 6) % 7;          // lunes=0 ... domingo=6
  d.setUTCDate(d.getUTCDate() - retroceso);
  return d.toISOString().slice(0, 10);
}

function sumarDias(fecha, dias) {
  const d = new Date(`${fecha}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

/** Semana operativa [lunes..domingo] y su rango UTC en la tz del negocio. */
// Una fecha PROVISTA pero malformada se rechaza (fail closed): caer en
// silencio a "hoy" mostraría la semana equivocada como si fuera la pedida.
export async function semanaOperativa(negocioId, fecha = null) {
  const nid = requerirNegocio(negocioId);
  if (fecha !== null && fecha !== undefined && fecha !== '' && !esFechaValida(fecha)) {
    throw err(`Fecha inválida: ${fecha}`, 'FECHA_INVALIDA');
  }
  const tz = await zonaHorariaNegocio(nid);
  const ref = fecha && esFechaValida(fecha) ? fecha : fechaOperativaHoy(tz);
  const lunes = lunesDeSemana(ref);
  const domingo = sumarDias(lunes, 6);
  const inicio = rangoUtcDeFecha(lunes, tz).inicio;
  const fin = rangoUtcDeFecha(domingo, tz).fin;
  return { negocioId: nid, timezone: tz, lunes, domingo, inicio, fin };
}

// ─── Ventas de la semana (con facturación y ajustes) ────────────────────────

/**
 * Todas las ventas de la semana con su estado de facturación y sus ajustes.
 * "Venta" usa el mismo criterio que el corte de caja: pedidos creados en el
 * rango, sin cancelados; un pedido abierto (por_cobrar sin confirmar) se
 * lista pero no es elegible — todavía no es una venta cobrada.
 */
export async function ventasDeSemana(negocioId, fecha = null) {
  const semana = await semanaOperativa(negocioId, fecha);
  const { negocioId: nid, timezone: tz, inicio, fin } = semana;
  const cutoff = await fronteraFacturacionConfiable(nid);

  const { rows } = await pool.query(
    `SELECT pa.folio, pa.estado, pa.created_at,
            pa.datos->>'forma_pago'                                  AS forma_pago,
            COALESCE((pa.datos->>'pago_confirmado')::boolean, false) AS pago_confirmado,
            COALESCE((pa.datos->>'total')::decimal, 0)               AS total,
            pa.datos->'cliente'->>'nombre'                           AS cliente,
            EXISTS (SELECT 1 FROM facturas_pedido fp
                     WHERE fp.negocio_id = $1::uuid AND fp.folio = pa.folio) AS facturada,
            (SELECT MIN(fp.emitida_at) FROM facturas_pedido fp
              WHERE fp.negocio_id = $1::uuid AND fp.folio = pa.folio)        AS facturada_at,
            COALESCE((SELECT SUM(a.monto_ajuste) FROM ajustes_cierre a
                       WHERE a.negocio_id = $1::uuid AND a.folio = pa.folio
                         AND a.estado = 'aplicado'), 0)              AS ajustes_total,
            COALESCE((SELECT COUNT(*) FROM ajustes_cierre a
                       WHERE a.negocio_id = $1::uuid AND a.folio = pa.folio
                         AND a.estado = 'aplicado'), 0)::int         AS ajustes_num
       FROM pedidos_activos pa
      WHERE pa.negocio_id = $1 AND pa.created_at >= $2 AND pa.created_at < $3
        AND pa.estado <> 'cancelado'
      ORDER BY pa.created_at`,
    [nid, inicio.toISOString(), fin.toISOString()]);

  const ventas = rows.map(v => {
    const total = dinero(v.total);
    const ajustesTotal = dinero(v.ajustes_total);
    const abierta = String(v.forma_pago || '') === 'por_cobrar' && v.pago_confirmado !== true;
    const facturada = v.facturada === true;
    // TERCERA CATEGORÍA: si la venta es anterior a la frontera de facturación
    // confiable (o no hay frontera configurada), no podemos afirmar su estado
    // de CFDI. NUNCA se trata como "no facturada": es histórica no verificable
    // y no es seleccionable ni ajustable.
    const historica = !facturada &&
      (!cutoff.configurada || new Date(v.created_at) < cutoff.instante);
    // Categoría canónica, fuente única para UI y backend:
    const categoria = facturada ? 'FACTURADA'
      : historica ? 'HISTORICA_NO_VERIFICABLE'
      : 'NO_FACTURADA_VERIFICABLE';
    // Facturada DESPUÉS de ajustada: como el bloqueo impide ajustar ventas
    // ya facturadas, una venta con ambas cosas solo pudo facturarse después
    // del ajuste — y el CFDI salió con los datos originales del pedido. Se
    // señala para revisión manual del contador (brecha documentada arriba).
    const facturadaTrasAjuste = facturada && v.ajustes_num > 0;
    return {
      folio: v.folio,
      fecha: v.created_at,
      fecha_operativa: fechaOperativaDe(new Date(v.created_at), tz),
      cliente: v.cliente || null,
      forma_pago: v.forma_pago || 'no especificado',
      clase_pago: clasificarFormaPago(v.forma_pago),
      total_original: total,
      facturada,
      facturada_at: v.facturada_at || null,
      abierta,
      historica_no_verificable: historica,
      categoria,
      ajustes_total: ajustesTotal,
      ajustes_num: v.ajustes_num,
      total_neto: dinero(total - ajustesTotal),
      // Solo una venta con estado de facturación VERIFICADO como no-facturada
      // (y cobrada) puede ajustarse. Facturada, abierta o histórica: no.
      elegible: categoria === 'NO_FACTURADA_VERIFICABLE' && !abierta,
      // Aviso pre-CFDI: tiene ajustes y aún no está facturada. Si se factura
      // después desde el flujo actual, el CFDI llevará los importes ORIGINALES.
      aviso_pre_factura: !facturada && v.ajustes_num > 0,
      revisar_manual: facturadaTrasAjuste === true,
    };
  });

  const suma = (pred) => dinero(ventas.filter(pred).reduce((s, v) => s + v.total_original, 0));
  const resumen = {
    ventas_count: ventas.length,
    total_original: dinero(ventas.reduce((s, v) => s + v.total_original, 0)),
    facturadas_count: ventas.filter(v => v.facturada).length,
    facturadas_total: suma(v => v.facturada),
    // "No facturadas" ahora significa VERIFICABLES: excluye las históricas.
    no_facturadas_count: ventas.filter(v => v.categoria === 'NO_FACTURADA_VERIFICABLE').length,
    no_facturadas_total: suma(v => v.categoria === 'NO_FACTURADA_VERIFICABLE'),
    historicas_no_verificables_count: ventas.filter(v => v.historica_no_verificable).length,
    historicas_no_verificables_total: suma(v => v.historica_no_verificable),
    abiertas_count: ventas.filter(v => v.abierta).length,
    elegibles_count: ventas.filter(v => v.elegible).length,
    ajustado_total: dinero(ventas.reduce((s, v) => s + v.ajustes_total, 0)),
    ajustadas_count: ventas.filter(v => v.ajustes_num > 0).length,
    sin_ajustes_count: ventas.filter(v => v.ajustes_num === 0).length,
    neto_total: dinero(ventas.reduce((s, v) => s + v.total_neto, 0)),
  };

  return {
    semana: { lunes: semana.lunes, domingo: semana.domingo, timezone: tz },
    cutoff: { configurada: cutoff.configurada, desde: cutoff.instante ? cutoff.instante.toISOString() : null },
    resumen, ventas,
  };
}

/** Ajustes registrados para la semana (aplicados y revertidos). */
export async function ajustesDeSemana(negocioId, fecha = null) {
  const nid = requerirNegocio(negocioId);
  if (fecha !== null && fecha !== undefined && fecha !== '' && !esFechaValida(fecha)) {
    throw err(`Fecha inválida: ${fecha}`, 'FECHA_INVALIDA');
  }
  const lunes = lunesDeSemana(fecha && esFechaValida(fecha) ? fecha
    : fechaOperativaHoy(await zonaHorariaNegocio(nid)));
  const { rows } = await pool.query(
    `SELECT a.id, a.lote_id, a.folio, a.tipo, a.modo, a.porcentaje,
            a.monto_original, a.monto_ajuste, a.monto_neto, a.motivo, a.estado,
            a.created_at, a.revertido_at, a.motivo_reversion,
            u.nombre AS usuario, ur.nombre AS revertido_por_nombre
       FROM ajustes_cierre a
       LEFT JOIN usuarios u  ON u.id = a.usuario_id
       LEFT JOIN usuarios ur ON ur.id = a.revertido_por
      WHERE a.negocio_id = $1 AND a.semana_inicio = $2
      ORDER BY a.created_at DESC`,
    [nid, lunes]);
  return rows.map(a => ({
    ...a,
    monto_original: dinero(a.monto_original),
    monto_ajuste: dinero(a.monto_ajuste),
    monto_neto: dinero(a.monto_neto),
    porcentaje: a.porcentaje === null ? null : Number(a.porcentaje),
  }));
}

// ─── Validación compartida preview/commit ───────────────────────────────────

function validarSolicitud({ folios, tipo, modo, valor, motivo }) {
  if (!Array.isArray(folios) || folios.length === 0) {
    throw err('Selecciona al menos una venta', 'FOLIOS_REQUERIDOS');
  }
  if (folios.length !== new Set(folios).size) {
    throw err('Hay folios repetidos en la selección', 'FOLIOS_DUPLICADOS');
  }
  if (folios.some(f => typeof f !== 'string' || !f.trim())) {
    throw err('Folio inválido en la selección', 'FOLIO_INVALIDO');
  }
  if (!TIPOS_AJUSTE.includes(tipo)) {
    throw err(`Tipo de ajuste inválido: ${tipo}`, 'TIPO_INVALIDO');
  }
  if (!MODOS_AJUSTE.includes(modo)) {
    throw err(`Modo de ajuste inválido: ${modo}`, 'MODO_INVALIDO');
  }
  const v = Number(valor);
  if (!Number.isFinite(v) || v <= 0) {
    throw err('El valor del ajuste debe ser mayor que cero', 'VALOR_INVALIDO');
  }
  if (modo === 'porcentual') {
    if (v > 100) throw err('Un porcentaje no puede exceder 100', 'VALOR_INVALIDO');
    if (folios.length !== 1) {
      // Decisión de producto: el porcentual es INDIVIDUAL (cada ticket tiene
      // su propio contexto); la multi-selección usa monto fijo POR TICKET.
      throw err('El ajuste porcentual se aplica a una sola venta a la vez', 'PORCENTUAL_INDIVIDUAL');
    }
  }
  if (typeof motivo !== 'string' || !motivo.trim()) {
    throw err('El motivo es obligatorio', 'MOTIVO_REQUERIDO');
  }
  return { folios: folios.map(f => f.trim()), tipo, modo, valor: dinero(v), motivo: motivo.trim() };
}

/**
 * Evalúa la solicitud contra el estado dado de las ventas. Devuelve renglones
 * calculados y rechazos con razón. Se usa idéntica en preview y en commit
 * (dentro de la transacción) para que las dos fases no puedan divergir.
 */
function evaluarAjuste(ventasPorFolio, { folios, modo, valor }) {
  const renglones = [];
  const rechazos = [];
  for (const folio of folios) {
    const v = ventasPorFolio.get(folio);
    if (!v) { rechazos.push({ folio, razon: 'NO_EXISTE', detalle: 'No es una venta de esta semana' }); continue; }
    if (v.facturada) { rechazos.push({ folio, razon: 'FACTURADA', detalle: 'Venta facturada: bloqueada para ajustes' }); continue; }
    // Fail-closed histórico: el backend rechaza aunque el frontend lo hubiera
    // dejado pasar. No se confía en la UI (misma evaluación en preview/commit).
    if (v.historica_no_verificable) { rechazos.push({ folio, razon: 'HISTORICA_NO_VERIFICABLE', detalle: 'Facturación histórica no verificable: no ajustable desde este módulo' }); continue; }
    if (v.abierta) { rechazos.push({ folio, razon: 'ABIERTA', detalle: 'Pedido sin cobro confirmado: aún no es una venta' }); continue; }
    const disponible = dinero(v.total_original - v.ajustes_total);
    const ajuste = modo === 'fijo' ? valor : dinero(disponible * (valor / 100));
    if (ajuste <= 0) { rechazos.push({ folio, razon: 'SIN_DISPONIBLE', detalle: 'La venta ya no tiene monto disponible para ajustar' }); continue; }
    if (ajuste > disponible) {
      rechazos.push({ folio, razon: 'EXCEDE_NETO', detalle: `El ajuste ($${ajuste.toFixed(2)}) excede el neto disponible ($${disponible.toFixed(2)})` });
      continue;
    }
    renglones.push({
      folio,
      monto_original: v.total_original,
      ajustes_previos: v.ajustes_total,
      monto_ajuste: ajuste,
      monto_neto: dinero(v.total_original - v.ajustes_total - ajuste),
    });
  }
  return { renglones, rechazos };
}

// ─── Vista previa ───────────────────────────────────────────────────────────

export async function previewAjuste(negocioId, solicitud) {
  const nid = requerirNegocio(negocioId);
  const s = validarSolicitud(solicitud);
  const { semana, ventas } = await ventasDeSemana(nid, solicitud.fecha || null);
  const porFolio = new Map(ventas.map(v => [v.folio, v]));
  const { renglones, rechazos } = evaluarAjuste(porFolio, s);
  return {
    semana,
    tipo: s.tipo, modo: s.modo, valor: s.valor, motivo: s.motivo,
    renglones, rechazos,
    total_ajuste: dinero(renglones.reduce((t, r) => t + r.monto_ajuste, 0)),
    aplicable: rechazos.length === 0 && renglones.length > 0,
  };
}

// ─── Confirmación (transaccional, con revalidación) ─────────────────────────

export async function aplicarAjuste(negocioId, solicitud, usuarioId = null) {
  const nid = requerirNegocio(negocioId);
  const s = validarSolicitud(solicitud);
  const semana = await semanaOperativa(nid, solicitud.fecha || null);
  const cutoff = await fronteraFacturacionConfiable(nid);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Candado sobre las ventas seleccionadas: dos confirmaciones simultáneas
    // sobre los mismos folios se serializan y la segunda revalida contra lo
    // que la primera dejó.
    const { rows } = await client.query(
      `SELECT pa.folio, pa.estado, pa.created_at,
              pa.datos->>'forma_pago'                                  AS forma_pago,
              COALESCE((pa.datos->>'pago_confirmado')::boolean, false) AS pago_confirmado,
              COALESCE((pa.datos->>'total')::decimal, 0)               AS total
         FROM pedidos_activos pa
        WHERE pa.negocio_id = $1 AND pa.folio = ANY($2)
          AND pa.created_at >= $3 AND pa.created_at < $4
          AND pa.estado <> 'cancelado'
        FOR UPDATE`,
      [nid, s.folios, semana.inicio.toISOString(), semana.fin.toISOString()]);

    // REVALIDACIÓN dentro de la transacción: facturación y ajustes se leen
    // otra vez AHORA. Si un pedido fue facturado entre la vista previa y la
    // confirmación, cae aquí — el lote completo se rechaza y no se aplica
    // nada (all-or-nothing: lo que el operador confirmó fue la vista previa
    // completa, no una versión recortada de ella).
    const ventasPorFolio = new Map();
    for (const v of rows) {
      const { rows: [f] } = await client.query(
        `SELECT EXISTS (SELECT 1 FROM facturas_pedido fp
                         WHERE fp.negocio_id = $1::uuid AND fp.folio = $2) AS facturada,
                COALESCE((SELECT SUM(a.monto_ajuste) FROM ajustes_cierre a
                           WHERE a.negocio_id = $1::uuid AND a.folio = $2
                             AND a.estado = 'aplicado'), 0) AS ajustes_total`,
        [nid, v.folio]);
      const facturada = f.facturada === true;
      ventasPorFolio.set(v.folio, {
        total_original: dinero(v.total),
        facturada,
        // Misma frontera fail-closed, revalidada dentro de la transacción.
        historica_no_verificable: !facturada &&
          (!cutoff.configurada || new Date(v.created_at) < cutoff.instante),
        abierta: String(v.forma_pago || '') === 'por_cobrar' && v.pago_confirmado !== true,
        ajustes_total: dinero(f.ajustes_total),
      });
    }

    const { renglones, rechazos } = evaluarAjuste(ventasPorFolio, s);
    if (rechazos.length > 0 || renglones.length === 0) {
      await client.query('ROLLBACK');
      const facturadas = rechazos.filter(r => r.razon === 'FACTURADA').map(r => r.folio);
      if (facturadas.length) {
        throw Object.assign(
          err(`No se aplicó ningún ajuste: ${facturadas.join(', ')} ya ${facturadas.length === 1 ? 'fue facturada' : 'fueron facturadas'}. Recarga la lista y revisa la selección.`, 'FACTURADA_TRAS_PREVIEW'),
          { rechazos });
      }
      const historicas = rechazos.filter(r => r.razon === 'HISTORICA_NO_VERIFICABLE').map(r => r.folio);
      if (historicas.length) {
        throw Object.assign(
          err(`No se aplicó ningún ajuste: ${historicas.join(', ')} ${historicas.length === 1 ? 'corresponde' : 'corresponden'} a facturación histórica no verificable y no ${historicas.length === 1 ? 'puede' : 'pueden'} ajustarse desde este módulo.`, 'FACTURACION_HISTORICA_NO_VERIFICADA'),
          { rechazos });
      }
      throw Object.assign(err('No se aplicó ningún ajuste: hay ventas no elegibles en la selección', 'SELECCION_NO_ELEGIBLE'), { rechazos });
    }

    const loteId = randomUUID();
    // monto_original de cada renglón es la BASE al momento del ajuste (el
    // neto disponible tras ajustes previos): así cada renglón cumple por sí
    // solo la aritmética del CHECK (neto = original - ajuste) y la cadena
    // completa reconstruye la venta original renglón por renglón.
    for (const r of renglones) {
      await client.query(
        `INSERT INTO ajustes_cierre
           (negocio_id, lote_id, semana_inicio, folio, tipo, modo, porcentaje,
            monto_original, monto_ajuste, monto_neto, motivo, usuario_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [nid, loteId, semana.lunes, r.folio, s.tipo, s.modo,
         s.modo === 'porcentual' ? s.valor : null,
         dinero(r.monto_original - r.ajustes_previos), r.monto_ajuste, r.monto_neto,
         s.motivo, usuarioId || null]);
    }
    await client.query('COMMIT');
    return {
      lote_id: loteId, semana_inicio: semana.lunes,
      aplicados: renglones.length,
      total_ajuste: dinero(renglones.reduce((t, r) => t + r.monto_ajuste, 0)),
      renglones,
    };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* ya cerrada */ }
    throw e;
  } finally {
    client.release();
  }
}

// ─── Reversión ──────────────────────────────────────────────────────────────

export async function revertirAjuste(negocioId, { ajusteId = null, loteId = null, motivo, usuarioId = null }) {
  const nid = requerirNegocio(negocioId);
  if (typeof motivo !== 'string' || !motivo.trim()) {
    throw err('El motivo de la reversión es obligatorio', 'MOTIVO_REQUERIDO');
  }
  if (!ajusteId && !loteId) throw err('Indica el ajuste o el lote a revertir', 'OBJETIVO_REQUERIDO');
  const campo = ajusteId ? 'id' : 'lote_id';
  const objetivo = ajusteId || loteId;
  const { rowCount } = await pool.query(
    `UPDATE ajustes_cierre
        SET estado = 'revertido', revertido_at = NOW(), revertido_por = $3,
            motivo_reversion = $4
      WHERE negocio_id = $1 AND ${campo} = $2 AND estado = 'aplicado'`,
    [nid, objetivo, usuarioId || null, motivo.trim()]);
  return { revertidos: rowCount };
}

// ─── Reporte CSV ────────────────────────────────────────────────────────────

const csvCampo = (v) => {
  const t = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};

export async function csvSemana(negocioId, fecha = null) {
  const { semana, resumen, ventas } = await ventasDeSemana(negocioId, fecha);
  const ajustes = await ajustesDeSemana(negocioId, fecha);
  const porFolio = new Map();
  for (const a of ajustes) {
    if (a.estado !== 'aplicado') continue;
    if (!porFolio.has(a.folio)) porFolio.set(a.folio, []);
    porFolio.get(a.folio).push(`${a.tipo} ${a.modo === 'porcentual' ? a.porcentaje + '%' : '$' + a.monto_ajuste.toFixed(2)} (${a.motivo})`);
  }
  // Etiqueta legible de la categoría de facturación (fuente única: v.categoria).
  const etiquetaCategoria = (v) => v.categoria === 'FACTURADA' ? 'FACTURADA'
    : v.categoria === 'HISTORICA_NO_VERIFICABLE' ? 'HISTORICA_NO_VERIFICABLE'
    : 'NO_FACTURADA_VERIFICABLE';
  const lineas = [
    ['semana', 'folio', 'fecha_operativa', 'cliente', 'forma_pago', 'total_original',
     'facturada', 'categoria_facturacion', 'ajustes', 'total_ajustado', 'total_neto',
     'detalle_ajustes', 'aviso_pre_factura', 'revisar_manual'].join(','),
  ];
  for (const v of ventas) {
    lineas.push([
      `${semana.lunes} a ${semana.domingo}`, v.folio, v.fecha_operativa, csvCampo(v.cliente),
      csvCampo(v.forma_pago), v.total_original.toFixed(2), v.facturada ? 'SI' : 'NO',
      etiquetaCategoria(v),
      v.ajustes_num, v.ajustes_total.toFixed(2), v.total_neto.toFixed(2),
      csvCampo(porFolio.has(v.folio) ? porFolio.get(v.folio).join(' | ') : ''),
      v.aviso_pre_factura ? 'REVISAR_ANTES_DE_FACTURAR' : '',
      v.revisar_manual ? 'SI' : '',
    ].join(','));
  }
  lineas.push('');
  lineas.push(`TOTALES,,,,,${resumen.total_original.toFixed(2)},,,${'' + resumen.ajustadas_count},${resumen.ajustado_total.toFixed(2)},${resumen.neto_total.toFixed(2)},,,`);
  lineas.push('');
  lineas.push(`RESUMEN,facturadas,${resumen.facturadas_count},no_facturadas_verificables,${resumen.no_facturadas_count},historicas_no_verificables,${resumen.historicas_no_verificables_count},elegibles,${resumen.elegibles_count}`);
  return { nombre: `ajustes-cierre-${semana.lunes}.csv`, csv: lineas.join('\n') };
}
