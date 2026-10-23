// Cancelación de CFDI desde Xabor (antes solo se podía en el tablero de
// Facturapi).
//
// Solo el admin, solo CFDI del propio negocio registrados en Xabor (ventas en
// facturas_pedido o facturas de servicio), con el motivo del SAT:
//   01 errores con relación  -> exige el CFDI que la sustituye, de este negocio
//   02 errores sin relación
//   03 la operación no se llevó a cabo
//   04 nominativa relacionada en una factura global -> exige la global
// La cancelación no siempre es inmediata: el receptor puede tener que
// aceptarla (pending) o el SAT la valida (verifying). El estado vive en
// facturacion_cancelaciones y lo actualiza la reconciliación consultando la
// factura. Una solicitud viva por CFDI; una rechazada, expirada o con error se
// puede volver a pedir.
//
// Para corregir los datos de una venta: emitir el CFDI correcto (factura de
// servicio con la referencia de la venta) y cancelar el anterior con motivo 01
// apuntando al nuevo. Este módulo no reabre la venta para otra autofactura.
import { pool } from './database.js';
import { cancelarFactura, obtenerFactura } from './facturapi.js';
import { puedeLlamarFacturapi } from './facturapiRitmo.js';
import { FacturacionError } from './facturacionService.js';
import { registrarBitacoraFacturacion, actorDe } from './facturacionDocumentos.js';

export const MOTIVOS_CANCELACION = Object.freeze({
  '01': 'Comprobante emitido con errores con relación',
  '02': 'Comprobante emitido con errores sin relación',
  '03': 'No se llevó a cabo la operación',
  '04': 'Operación nominativa relacionada en una factura global',
});
const UUID_CFDI = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
const ID_PROVEEDOR = /^[A-Za-z0-9_-]{6,64}$/;

function vista(r) {
  if (!r) return null;
  return {
    factura_id: r.factura_id, uuid: r.uuid, origen: r.origen, referencia: r.referencia,
    motivo: r.motivo, motivo_nombre: MOTIVOS_CANCELACION[r.motivo] || null, sustitucion: r.sustitucion,
    estado: r.estado, cancellation_status: r.cancellation_status,
    error_codigo: r.error_codigo, error_detalle: r.error_detalle,
    solicitada_por: r.solicitada_por, created_at: r.created_at, updated_at: r.updated_at,
  };
}

// Un CFDI de ESTE negocio, por id de Facturapi o por UUID. Nunca uno ajeno.
async function cfdiDelNegocio(negocioId, idOUuid) {
  const v = String(idOUuid || '').trim();
  if (!v || !(UUID_CFDI.test(v) || ID_PROVEEDOR.test(v))) return null;
  const { rows: [venta] } = await pool.query(
    `SELECT factura_id, uuid, folio FROM facturas_pedido
      WHERE negocio_id=$1 AND (factura_id=$2 OR upper(uuid)=upper($2)) AND factura_id IS NOT NULL
      ORDER BY emitida_at DESC LIMIT 1`, [negocioId, v]);
  if (venta) return { origen: 'venta', facturaId: venta.factura_id, uuid: venta.uuid, referencia: venta.folio };
  const { rows: [servicio] } = await pool.query(
    `SELECT id, factura_id, uuid, referencia FROM facturacion_servicios
      WHERE negocio_id=$1 AND (factura_id=$2 OR upper(uuid)=upper($2)) AND estado IN ('facturada','cancelada')
      LIMIT 1`, [negocioId, v]);
  if (servicio) return { origen: 'servicio', facturaId: servicio.factura_id, uuid: servicio.uuid, referencia: servicio.referencia || servicio.id };
  return null;
}

async function filaPorFactura(negocioId, facturaId) {
  const { rows: [r] } = await pool.query(
    'SELECT * FROM facturacion_cancelaciones WHERE negocio_id=$1 AND factura_id=$2', [negocioId, facturaId]);
  return r || null;
}

function estadoDesdeProveedor(factura) {
  const status = String(factura?.status || '');
  const cs = String(factura?.cancellation_status || '');
  if (status === 'canceled' || cs === 'accepted') return 'cancelada';
  if (cs === 'pending' || cs === 'verifying') return 'en_proceso';
  if (cs === 'rejected') return 'rechazada';
  if (cs === 'expired') return 'expirada';
  return null; // vigente sin solicitud: el DELETE no llegó al proveedor
}

async function aplicarEstado(fila, factura) {
  const estado = estadoDesdeProveedor(factura);
  const nuevo = estado || 'error';
  const { rows: [r] } = await pool.query(
    `UPDATE facturacion_cancelaciones SET estado=$2, cancellation_status=$3,
       error_codigo=$4, error_detalle=$5, updated_at=now()
     WHERE id=$1 RETURNING *`,
    [fila.id, nuevo, factura?.cancellation_status || null,
      estado ? null : 'SIN_SOLICITUD_EN_PROVEEDOR', estado ? null : 'Facturapi no tiene una solicitud de cancelación de este CFDI; se puede volver a pedir.']);
  if (nuevo === 'cancelada' && fila.origen === 'servicio') {
    await pool.query(
      `UPDATE facturacion_servicios SET estado='cancelada', updated_at=now()
        WHERE negocio_id=$1 AND factura_id=$2 AND estado='facturada'`, [fila.negocio_id, fila.factura_id]);
  }
  // Una venta con su CFDI cancelado deja de contar como timbrada: el ledger
  // lo marca y su recibo pasa a 'cancelado'.
  if (nuevo === 'cancelada' && fila.origen === 'venta') {
    await pool.query(
      `UPDATE facturas_pedido SET cancelada_at=now()
        WHERE negocio_id=$1 AND factura_id=$2 AND cancelada_at IS NULL`, [fila.negocio_id, fila.factura_id]);
    await pool.query(
      `UPDATE facturacion_recibos SET estado='cancelado', updated_at=now()
        WHERE negocio_id=$1 AND factura_id=$2 AND estado='facturado'`, [fila.negocio_id, fila.factura_id]);
  }
  return r;
}

/**
 * Pide al SAT (vía Facturapi) la cancelación de un CFDI del negocio. Devuelve
 * la vista de la solicitud; lanza FacturacionError si no procede.
 */
export async function solicitarCancelacionCfdi(negocioId, facturaIdEntrada, { motivo, sustitucion = null, actor = null } = {}) {
  if (!negocioId) throw new FacturacionError('Falta el contexto del negocio.', 'NEGOCIO_REQUERIDO', 400);
  const m = String(motivo || '').trim();
  if (!MOTIVOS_CANCELACION[m]) throw new FacturacionError('Elige el motivo de cancelación del SAT (01, 02, 03 o 04).', 'MOTIVO_INVALIDO', 400);
  const cfdi = await cfdiDelNegocio(negocioId, facturaIdEntrada);
  if (!cfdi) throw new FacturacionError('No encontramos ese CFDI en este negocio.', 'FACTURA_NO_ENCONTRADA', 404);

  let sust = null;
  if (m === '01' || m === '04') {
    const s = String(sustitucion || '').trim();
    if (!s) throw new FacturacionError('Con el motivo 01 o 04 indica el CFDI que la sustituye.', 'SUSTITUCION_REQUERIDA', 400);
    if (m === '01') {
      const reemplazo = await cfdiDelNegocio(negocioId, s);
      if (!reemplazo) throw new FacturacionError('El CFDI que la sustituye debe ser de este negocio y estar registrado en Xabor.', 'SUSTITUCION_INVALIDA', 400);
      if (reemplazo.facturaId === cfdi.facturaId) throw new FacturacionError('Un CFDI no puede sustituirse a sí mismo.', 'SUSTITUCION_INVALIDA', 400);
      sust = reemplazo.uuid || reemplazo.facturaId;
    } else {
      if (!UUID_CFDI.test(s) && !ID_PROVEEDOR.test(s)) throw new FacturacionError('El CFDI de la factura global no tiene un formato válido.', 'SUSTITUCION_INVALIDA', 400);
      sust = s;
    }
  }

  // Reclamo: una sola solicitud viva por CFDI.
  const { rows: [fila] } = await pool.query(
    `INSERT INTO facturacion_cancelaciones (negocio_id, factura_id, uuid, origen, referencia, motivo, sustitucion, solicitada_por)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (negocio_id, factura_id) DO UPDATE SET
       motivo=EXCLUDED.motivo, sustitucion=EXCLUDED.sustitucion, solicitada_por=EXCLUDED.solicitada_por,
       estado='solicitando', cancellation_status=NULL, error_codigo=NULL, error_detalle=NULL, updated_at=now()
     WHERE facturacion_cancelaciones.estado IN ('rechazada','expirada','error')
     RETURNING *`,
    [negocioId, cfdi.facturaId, cfdi.uuid, cfdi.origen, cfdi.referencia, m, sust, actor ? String(actor).slice(0, 120) : null]);
  if (!fila) {
    const actual = await filaPorFactura(negocioId, cfdi.facturaId);
    if (actual?.estado === 'cancelada') throw new FacturacionError('Este CFDI ya está cancelado.', 'CFDI_YA_CANCELADO', 409);
    throw new FacturacionError('Ya hay una cancelación en curso para este CFDI.', 'CANCELACION_EN_CURSO', 409);
  }

  let factura;
  try {
    factura = await cancelarFactura(negocioId, cfdi.facturaId, { motivo: m, sustitucion: sust });
  } catch (e) {
    const status = Number(e?.status) || 0;
    const definitivo = status >= 400 && status < 500 && ![401, 403, 408, 429].includes(status);
    const codigo = String(e?.codigo || 'FACTURAPI_ERROR').toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 40);
    if (definitivo) {
      await pool.query(
        `UPDATE facturacion_cancelaciones SET estado='error', error_codigo=$2, error_detalle=$3, updated_at=now() WHERE id=$1`,
        [fila.id, codigo, String(e?.message || '').slice(0, 300)]);
      throw new FacturacionError(`Facturapi no aceptó la cancelación: ${e?.message || codigo}`, 'CANCELACION_RECHAZADA', 409);
    }
    // Resultado desconocido (timeout, red, 5xx, credenciales): la
    // reconciliación consulta la factura y decide.
    const { rows: [r] } = await pool.query(
      `UPDATE facturacion_cancelaciones SET estado='en_proceso', error_codigo='RESULTADO_DESCONOCIDO', error_detalle=$2, updated_at=now()
        WHERE id=$1 RETURNING *`, [fila.id, codigo]);
    console.warn(`[Facturacion] cancelación de ${cfdi.facturaId} sin resultado (${codigo}); se verifica con el proveedor`);
    return vista(r);
  }
  return vista(await aplicarEstado(fila, factura));
}

/** Consulta la factura en Facturapi y actualiza una solicitud viva. */
export async function sincronizarCancelacionCfdi(negocioId, facturaId) {
  const fila = await filaPorFactura(negocioId, String(facturaId || '').trim());
  if (!fila) throw new FacturacionError('No hay una cancelación registrada para ese CFDI.', 'CANCELACION_NO_ENCONTRADA', 404);
  if (!['solicitando', 'en_proceso'].includes(fila.estado)) return vista(fila);
  const factura = await obtenerFactura(negocioId, fila.factura_id);
  return vista(await aplicarEstado(fila, factura));
}

/** Barrido de la reconciliación: solicitudes vivas de más de 2 minutos. */
export async function sincronizarCancelacionesPendientes(limite = 50) {
  const { rows } = await pool.query(
    `SELECT negocio_id, factura_id FROM facturacion_cancelaciones
      WHERE estado IN ('solicitando','en_proceso') AND updated_at < now() - INTERVAL '2 minutes'
      ORDER BY updated_at ASC LIMIT $1`, [Math.min(Math.max(Number(limite) || 50, 1), 200)]);
  let revisadas = 0;
  for (const r of rows) {
    if (!puedeLlamarFacturapi(r.negocio_id, 1)) continue; // en pausa o sin presupuesto (facturapiRitmo.js)
    try { await sincronizarCancelacionCfdi(r.negocio_id, r.factura_id); revisadas++; }
    catch (e) { console.warn(`[Facturacion] verificación de cancelación ${r.factura_id}: ${e.codigo || e.message}`); }
  }
  return { pendientes: rows.length, revisadas };
}

export async function listarCancelacionesCfdi(negocioId) {
  const { rows } = await pool.query(
    `SELECT * FROM facturacion_cancelaciones WHERE negocio_id=$1 ORDER BY updated_at DESC LIMIT 500`, [negocioId]);
  return rows.map(vista);
}

/**
 * Rutas de admin. Se registran desde server.js con sus propios guardias, para
 * que este módulo no dependa de cómo se resuelve la sesión.
 */
export function registrarRutasCancelacionCfdi(app, { requireAdminSeguro, requireModulo, responderError }) {
  const guardias = [requireAdminSeguro, requireModulo('facturacion')];
  app.get('/api/admin/facturacion/cancelaciones', ...guardias, async (req, res) => {
    try { res.json({ ok: true, motivos: MOTIVOS_CANCELACION, cancelaciones: await listarCancelacionesCfdi(req.negocioId) }); }
    catch (e) { responderError(res, e); }
  });
  app.post('/api/admin/facturacion/facturas/:facturaId/cancelar', ...guardias, async (req, res) => {
    try {
      const r = await solicitarCancelacionCfdi(req.negocioId, req.params.facturaId, {
        motivo: req.body?.motivo, sustitucion: req.body?.sustitucion, actor: req.usuarioId || req.rol || null,
      });
      await registrarBitacoraFacturacion({
        negocioId: req.negocioId, ...actorDe(req), accion: 'solicitar_cancelacion', folio: r?.referencia || null,
        facturaId: r?.factura_id || null, detalle: { motivo: r?.motivo || null, estado: r?.estado || null },
      });
      res.json({ ok: true, cancelacion: r });
    } catch (e) { responderError(res, e); }
  });
  app.post('/api/admin/facturacion/facturas/:facturaId/cancelacion/sincronizar', ...guardias, async (req, res) => {
    try { res.json({ ok: true, cancelacion: await sincronizarCancelacionCfdi(req.negocioId, req.params.facturaId) }); }
    catch (e) { responderError(res, e); }
  });
}
