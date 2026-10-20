// El recibo de Facturapi de una venta que se factura por el portal de Xabor.
//
// Cada venta tiene su recibo en Facturapi (asegurarReciboPedido), con su
// propia liga de autofactura, y es lo que entra en una factura global. El
// portal de Xabor no factura ese recibo: timbra un CFDI directo (POST
// /invoices). Si el recibo se quedaba abierto, la misma venta podía salir dos
// veces: otra vez en el portal de Facturapi, o dentro de la factura global.
//
// Tres piezas:
//   - antes de timbrar, se consulta el recibo con el proveedor: si ya se
//     facturó, la sincronización lo asienta en el ledger y el portal no emite
//     otro; si ya entró en una global, el portal no emite;
//   - después de timbrar, se cancela el recibo (DELETE /receipts/:id) y queda
//     `facturado` con el CFDI del portal;
//   - un barrido reintenta los cierres que fallaron (proveedor caído).
//
// Nunca toca datos fiscales del cliente: solo folios, ids y códigos.
import { pool } from './database.js';
import { cancelarRecibo, obtenerRecibo } from './facturapi.js';
import { sincronizarRecibo, FacturacionError } from './facturacionService.js';

// Estados locales de un recibo que todavía se puede facturar en Facturapi.
const CERRABLES = ['abierto', 'creando', 'error'];
const ESTADO_REMOTO = { invoiced_to_customer: 'facturado', invoiced_globally: 'global' };

async function ledgerDe(negocioId, folio) {
  const { rows: [r] } = await pool.query(
    `SELECT factura_id FROM facturas_pedido
      WHERE negocio_id=$1 AND upper(folio)=upper($2) AND factura_id IS NOT NULL LIMIT 1`, [negocioId, folio]);
  return r || null;
}

/**
 * Antes del POST /invoices del portal. Sin recibo en Facturapi no hay nada
 * que duplicar. Con recibo, manda el proveedor: la reconciliación tarda
 * horas en pasar por cada recibo abierto. Si no se puede confirmar, no se
 * timbra (la liga sigue vigente).
 */
export async function confirmarReciboAntesDeAutofactura(negocioId, folio) {
  const { rows: [local] } = await pool.query(
    `SELECT recibo_id, estado FROM facturacion_recibos WHERE negocio_id=$1 AND upper(folio)=upper($2)`, [negocioId, folio]);
  if (!local?.recibo_id || local.estado === 'cancelado') return local || null;
  let recibo;
  try {
    recibo = await sincronizarRecibo(negocioId, folio);
  } catch (e) {
    console.warn(`[Facturacion] no se pudo confirmar el recibo de ${folio} antes de la autofactura: ${e.codigo || e.status || e.message}`);
    throw new FacturacionError('No pudimos confirmar que esta venta no esté facturada. Intenta de nuevo en unos minutos.', 'RECIBO_NO_VERIFICABLE', 503);
  }
  if (recibo?.estado === 'global') {
    throw new FacturacionError('Esta venta ya se incluyó en la factura global del negocio. Pide tu factura en la sucursal con tu folio.', 'VENTA_EN_FACTURA_GLOBAL', 409);
  }
  if (recibo?.estado === 'facturado' && !(await ledgerDe(negocioId, folio))) {
    throw new FacturacionError('Esta venta ya fue facturada. Pide el CFDI en la sucursal con tu folio.', 'VENTA_YA_FACTURADA', 409);
  }
  return recibo;
}

async function marcarFacturado(negocioId, folio, facturaId, uuid, { soloSinRecibo = false } = {}) {
  const { rowCount } = await pool.query(
    `UPDATE facturacion_recibos SET estado='facturado', factura_id=$3, uuid=$4,
       error_codigo=NULL, error_detalle=NULL, updated_at=NOW()
     WHERE negocio_id=$1 AND upper(folio)=upper($2) AND estado = ANY($5)${soloSinRecibo ? ' AND recibo_id IS NULL' : ''}`,
    [negocioId, folio, facturaId, uuid, CERRABLES]);
  return rowCount > 0;
}

/**
 * Después de que el portal timbró `facturaId`. Nunca convierte la emisión en
 * fallo: si el proveedor no responde, deja CIERRE_PENDIENTE y lo retoma el
 * barrido. Si el recibo ya estaba facturado o en una global, la venta tiene
 * dos CFDI: se deja asentado y se avisa en el log.
 */
export async function cerrarReciboTrasAutofactura(negocioId, folio, { facturaId, uuid = null }) {
  const { rows: [local] } = await pool.query(
    `SELECT recibo_id, estado, factura_id FROM facturacion_recibos WHERE negocio_id=$1 AND upper(folio)=upper($2)`, [negocioId, folio]);
  if (!local) return { accion: 'sin_recibo' };
  if (!CERRABLES.includes(local.estado)) {
    if (local.estado === 'global' || (local.estado === 'facturado' && local.factura_id && local.factura_id !== facturaId)) {
      console.error(`[Facturacion] DOBLE CFDI: ${folio} se facturó por el portal (${facturaId}) y su recibo ya estaba ${local.estado}`);
      console.warn(`[TXN] evento=doble_cfdi negocio=${negocioId} folio=${folio}`);
      return { accion: 'doble_cfdi', estado: local.estado };
    }
    return { accion: 'sin_cambio', estado: local.estado };
  }
  // El recibo nunca llegó a Facturapi: se marca para que nadie lo cree después.
  if (!local.recibo_id) {
    await marcarFacturado(negocioId, folio, facturaId, uuid, { soloSinRecibo: true });
    return { accion: 'marcado_sin_recibo' };
  }

  let remoto = null;
  try {
    remoto = await cancelarRecibo(negocioId, local.recibo_id);
  } catch (e) {
    // Un rechazo puede significar que el recibo ya no estaba abierto: se
    // consulta antes de decidir.
    try { remoto = await obtenerRecibo(negocioId, local.recibo_id); } catch { remoto = null; }
    if (!remoto || remoto.status === 'open') {
      await pool.query(
        `UPDATE facturacion_recibos SET error_codigo='CIERRE_PENDIENTE', error_detalle=$3, updated_at=NOW()
          WHERE negocio_id=$1 AND upper(folio)=upper($2) AND estado = ANY($4)`,
        [negocioId, folio, `Recibo abierto tras la autofactura ${facturaId}; se reintenta (${e.codigo || e.status || 'error'})`, CERRABLES]);
      console.warn(`[Facturacion] recibo de ${folio} sigue abierto tras la autofactura: ${e.codigo || e.status || e.message}`);
      return { accion: 'reintentar', codigo: e.codigo || 'FACTURAPI_ERROR' };
    }
  }

  const status = String(remoto?.status || '');
  if (status === 'canceled') {
    await marcarFacturado(negocioId, folio, facturaId, uuid);
    return { accion: 'cancelado' };
  }
  const otroEstado = ESTADO_REMOTO[status];
  if (otroEstado) {
    const otraFactura = typeof remoto.invoice === 'string' ? remoto.invoice : remoto.invoice?.id || null;
    await pool.query(
      `UPDATE facturacion_recibos SET estado=$3, factura_id=COALESCE($4, factura_id),
         error_codigo='DOBLE_CFDI', error_detalle=$5, updated_at=NOW()
       WHERE negocio_id=$1 AND upper(folio)=upper($2)`,
      [negocioId, folio, otroEstado, otraFactura, `La venta también se facturó por el portal de Xabor (${facturaId})`]);
    console.error(`[Facturacion] DOBLE CFDI: ${folio} se facturó por el portal (${facturaId}) y su recibo ya estaba ${status}`);
    console.warn(`[TXN] evento=doble_cfdi negocio=${negocioId} folio=${folio}`);
    return { accion: 'doble_cfdi', estado: otroEstado };
  }
  console.warn(`[Facturacion] recibo de ${folio}: estado del proveedor no reconocido tras cancelar (${status || 'vacío'})`);
  return { accion: 'reintentar', codigo: 'ESTADO_DESCONOCIDO' };
}

/**
 * Barrido de la reconciliación: ventas facturadas por el portal (intento
 * propio, no espejo) cuyo recibo sigue abierto. Un cierre que falló espera
 * 30 minutos antes de reintentarse.
 */
export async function cerrarRecibosPendientesTrasAutofactura(limite = 50) {
  const { rows } = await pool.query(
    `SELECT a.negocio_id, r.folio, a.factura_id, a.uuid
       FROM autofacturas a
       JOIN facturacion_recibos r ON r.negocio_id=a.negocio_id AND upper(r.folio)=upper(a.folio)
      WHERE a.estado='facturada' AND a.intento_key IS NOT NULL AND a.factura_id IS NOT NULL
        AND r.estado = ANY($2) AND r.factura_id IS DISTINCT FROM a.factura_id
        AND (r.error_codigo IS DISTINCT FROM 'CIERRE_PENDIENTE' OR r.updated_at < NOW() - INTERVAL '30 minutes')
      ORDER BY a.emitida_at ASC LIMIT $1`, [Math.min(Math.max(Number(limite) || 50, 1), 200), CERRABLES]);
  const resultado = { revisados: rows.length, cerrados: 0, pendientes: 0, dobles: 0 };
  for (const row of rows) {
    try {
      const r = await cerrarReciboTrasAutofactura(row.negocio_id, row.folio, { facturaId: row.factura_id, uuid: row.uuid });
      if (r.accion === 'cancelado' || r.accion === 'marcado_sin_recibo') resultado.cerrados++;
      else if (r.accion === 'doble_cfdi') resultado.dobles++;
      else resultado.pendientes++;
    } catch (e) {
      resultado.pendientes++;
      console.warn(`[Facturacion] cierre de recibo ${row.folio}: ${e.codigo || e.message}`);
    }
  }
  return resultado;
}
