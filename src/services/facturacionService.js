import { pool, guardarClienteFiscal, registrarFacturaEmitida } from './database.js';
import {
  crearRecibo, obtenerRecibo, obtenerFactura, facturarRecibo,
  enviarFacturaPorEmail, puedeFacturar, FacturapiNoConfiguradoError,
} from './facturapi.js';

export class FacturacionError extends Error {
  constructor(message, codigo, status = 400) {
    super(message);
    this.name = 'FacturacionError';
    this.codigo = codigo;
    this.status = status;
  }
}

export function normalizarFolioFactura(valor) {
  const v = String(valor || '').trim().toUpperCase().replace(/\s+/g, '-');
  const m = v.match(/(?:XAB[- ]?)?(\d{1,8})$/);
  if (m && !v.startsWith('RM-')) return `XAB-${m[1].padStart(4, '0')}`;
  return v.replace(/[^A-Z0-9-]/g, '');
}

export async function obtenerConfiguracionFacturacion(negocioId) {
  const { rows } = await pool.query(
    `SELECT negocio_id, iva_tasa, autoemitir_recibo, clave_producto_restaurante,
            clave_producto_para_llevar, serie
       FROM facturacion_configuracion WHERE negocio_id = $1`, [negocioId]);
  return rows[0] || {
    negocio_id: negocioId, iva_tasa: null, autoemitir_recibo: true,
    clave_producto_restaurante: '90101501', clave_producto_para_llevar: '90101800', serie: null,
  };
}

export async function guardarConfiguracionFacturacion(negocioId, { ivaTasa, autoemitirRecibo, serie = null } = {}) {
  const tasa = ivaTasa === null || ivaTasa === '' ? null : Number(ivaTasa);
  if (tasa !== null && ![0, 0.08, 0.16].includes(tasa)) {
    throw new FacturacionError('La tasa de IVA debe ser 0 %, 8 % o 16 %.', 'IVA_INVALIDO');
  }
  const { rows } = await pool.query(
    `INSERT INTO facturacion_configuracion (negocio_id, iva_tasa, autoemitir_recibo, serie)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (negocio_id) DO UPDATE SET
       iva_tasa=EXCLUDED.iva_tasa,
       autoemitir_recibo=EXCLUDED.autoemitir_recibo,
       serie=EXCLUDED.serie,
       updated_at=NOW()
     RETURNING *`,
    [negocioId, tasa, autoemitirRecibo !== false, String(serie || '').trim() || null]);
  return rows[0];
}

export async function obtenerPedidoFacturable(negocioId, folioEntrada) {
  const folio = normalizarFolioFactura(folioEntrada);
  const { rows } = await pool.query(
    `SELECT folio, estado, datos, created_at, entregado_at
       FROM pedidos_activos
      WHERE negocio_id=$1 AND upper(folio)=upper($2)
      LIMIT 1`, [negocioId, folio]);
  const row = rows[0];
  if (!row) throw new FacturacionError('No encontré una venta con ese folio.', 'PEDIDO_NO_ENCONTRADO', 404);
  if (row.estado === 'cancelado') throw new FacturacionError('Un pedido cancelado no se puede facturar.', 'PEDIDO_CANCELADO', 409);
  const pedido = { folio: row.folio, ...(row.datos || {}), _estado: row.estado, _created_at: row.created_at };
  const pagado = pedido.origen === 'restaurante'
    || pedido.pago_confirmado === true
    || row.estado === 'entregado' && pedido.forma_pago !== 'por_cobrar';
  if (!pagado) throw new FacturacionError('El pedido todavía no aparece pagado.', 'PEDIDO_NO_PAGADO', 409);
  if (!Number.isFinite(Number(pedido.total)) || Number(pedido.total) <= 0) {
    throw new FacturacionError('La venta no tiene un total facturable.', 'TOTAL_NO_FACTURABLE', 409);
  }
  return pedido;
}

export async function obtenerUltimoPedidoFacturablePorTelefono(negocioId, telefono) {
  const tel = String(telefono || '').replace(/\D/g, '').slice(-10);
  if (!tel) return null;
  const { rows } = await pool.query(
    `SELECT folio FROM pedidos_activos
      WHERE negocio_id=$1 AND estado <> 'cancelado'
        AND (
          right(regexp_replace(COALESCE(datos->>'telefono_conversacion',''), '\\D', '', 'g'),10)=$2
          OR right(regexp_replace(COALESCE(datos->'cliente'->>'telefono',''), '\\D', '', 'g'),10)=$2
        )
        AND (
          datos->>'origen'='restaurante'
          OR datos->>'pago_confirmado' = 'true'
          OR (estado='entregado' AND COALESCE(datos->>'forma_pago','') <> 'por_cobrar')
        )
      ORDER BY COALESCE(entregado_at, updated_at, created_at) DESC LIMIT 1`, [negocioId, tel]);
  return rows[0] ? obtenerPedidoFacturable(negocioId, rows[0].folio) : null;
}

export function pedidoPerteneceATelefono(pedido, telefono) {
  const ultimos10 = v => String(v || '').replace(/\D/g, '').slice(-10);
  const buscado = ultimos10(telefono);
  if (!buscado) return false;
  return [pedido?.telefono_conversacion, pedido?.cliente?.telefono, pedido?.telefono]
    .some(v => ultimos10(v) === buscado);
}

function configProveedor(c) {
  if (c.iva_tasa === null || c.iva_tasa === undefined) {
    throw new FacturacionError('Configura la tasa de IVA del negocio antes de emitir.', 'IVA_NO_CONFIGURADO', 409);
  }
  return {
    ivaTasa: Number(c.iva_tasa),
    claveRestaurante: c.clave_producto_restaurante,
    claveParaLlevar: c.clave_producto_para_llevar,
  };
}

function estadoLocalFacturapi(status) {
  return ({ open: 'abierto', invoiced_to_customer: 'facturado', invoiced_globally: 'global', canceled: 'cancelado' })[status] || 'abierto';
}

async function guardarRespuestaRecibo(negocioId, folio, remoto) {
  const totalRemoto = Number(remoto.total);
  const { rows: [local] } = await pool.query(
    `SELECT total FROM facturacion_recibos WHERE negocio_id=$1 AND folio=$2`, [negocioId, folio]);
  if (!local || !Number.isFinite(totalRemoto) || Math.abs(Number(local.total) - totalRemoto) > 0.01) {
    await pool.query(
      `UPDATE facturacion_recibos SET estado='error', error_codigo='TOTAL_DIVERGENTE',
        error_detalle=$3, updated_at=NOW() WHERE negocio_id=$1 AND folio=$2`,
      [negocioId, folio, `local=${local?.total ?? 'n/a'} remoto=${remoto.total ?? 'n/a'}`]);
    throw new FacturacionError('El total calculado por facturación no coincide con la venta. Se detuvo la emisión.', 'TOTAL_DIVERGENTE', 409);
  }
  const facturaId = typeof remoto.invoice === 'string' ? remoto.invoice : remoto.invoice?.id || null;
  const { rows } = await pool.query(
    `UPDATE facturacion_recibos SET recibo_id=$3, clave=$4, url_autofactura=$5,
       expires_at=$6, estado=$7, factura_id=COALESCE($8,factura_id),
       error_codigo=NULL, error_detalle=NULL, updated_at=NOW()
     WHERE negocio_id=$1 AND folio=$2 RETURNING *`,
    [negocioId, folio, remoto.id, remoto.key || null, remoto.self_invoice_url || null,
      remoto.expires_at || null, estadoLocalFacturapi(remoto.status), facturaId]);
  return rows[0];
}

export async function asegurarReciboPedido(negocioId, folioEntrada) {
  if (!(await puedeFacturar(negocioId))) throw new FacturapiNoConfiguradoError();
  const pedido = await obtenerPedidoFacturable(negocioId, folioEntrada);
  const config = await obtenerConfiguracionFacturacion(negocioId);
  const providerConfig = configProveedor(config);
  const folio = pedido.folio;
  const idempotencyKey = `xabor:${negocioId}:${folio}`;
  await pool.query(
    `INSERT INTO facturacion_recibos (negocio_id, folio, total, idempotency_key)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (negocio_id, folio) DO NOTHING`,
    [negocioId, folio, Number(pedido.total), idempotencyKey]);
  const { rows: [existente] } = await pool.query(
    `SELECT * FROM facturacion_recibos WHERE negocio_id=$1 AND folio=$2`, [negocioId, folio]);
  if (Number(existente.total) !== Number(pedido.total)) {
    throw new FacturacionError('La venta cambió después de preparar su recibo; requiere revisión.', 'TOTAL_CAMBIO', 409);
  }
  if (existente.recibo_id && ['abierto', 'facturado', 'global'].includes(existente.estado)) return existente;
  try {
    const remoto = await crearRecibo(negocioId, pedido, providerConfig);
    return await guardarRespuestaRecibo(negocioId, folio, remoto);
  } catch (e) {
    await pool.query(
      `UPDATE facturacion_recibos SET estado='error', error_codigo=$3, error_detalle=$4, updated_at=NOW()
       WHERE negocio_id=$1 AND folio=$2`,
      [negocioId, folio, e.codigo || 'FACTURAPI_ERROR', String(e.message || e).slice(0, 500)]).catch(() => {});
    throw e;
  }
}

export async function emitirFacturaPedido(negocioId, folioEntrada, datos, { fuente = 'panel' } = {}) {
  const requerido = ['rfc', 'nombre_fiscal', 'regimen', 'uso_cfdi', 'cp'];
  for (const campo of requerido) {
    if (!String(datos?.[campo] || '').trim()) throw new FacturacionError(`Falta ${campo}.`, 'DATOS_FISCALES_INCOMPLETOS');
  }
  const pedido = await obtenerPedidoFacturable(negocioId, folioEntrada);
  const recibo = await asegurarReciboPedido(negocioId, pedido.folio);
  if (recibo.estado === 'facturado' && recibo.factura_id) {
    return { yaEmitida: true, factura_id: recibo.factura_id, uuid: recibo.uuid, recibo };
  }
  if (recibo.estado !== 'abierto') {
    throw new FacturacionError(`El recibo está ${recibo.estado} y ya no admite esta emisión.`, 'RECIBO_NO_ABIERTO', 409);
  }
  const config = await obtenerConfiguracionFacturacion(negocioId);
  const factura = await facturarRecibo(negocioId, recibo.recibo_id, datos, { serie: config.serie });
  const facturaId = factura.id || factura.invoice?.id;
  const uuid = factura.uuid || factura.folio_fiscal || null;
  await pool.query(
    `UPDATE facturacion_recibos SET estado='facturado', factura_id=$3, uuid=$4,
       error_codigo=NULL, error_detalle=NULL, updated_at=NOW()
     WHERE negocio_id=$1 AND folio=$2`, [negocioId, pedido.folio, facturaId, uuid]);
  await registrarFacturaEmitida({ negocioId, folio: pedido.folio, facturaId, uuid, total: pedido.total, fuente });
  const ficha = await guardarClienteFiscal({
    negocioId, rfc: datos.rfc, razonSocial: datos.nombre_fiscal,
    regimen: datos.regimen, usoCfdi: datos.uso_cfdi, cp: datos.cp,
    email: datos.email, telefono: datos.telefono || pedido?.cliente?.telefono || pedido.telefono_conversacion,
  });
  if (ficha?.error) throw new FacturacionError(`La factura se emitió, pero la ficha fiscal no se guardó: ${ficha.error}`, 'FICHA_NO_GUARDADA', 207);
  if (datos.email && facturaId) await enviarFacturaPorEmail(negocioId, facturaId, datos.email).catch(() => {});
  return { yaEmitida: false, factura_id: facturaId, uuid, recibo, factura };
}

export async function sincronizarRecibo(negocioId, folioEntrada) {
  const folio = normalizarFolioFactura(folioEntrada);
  const { rows: [local] } = await pool.query(
    `SELECT * FROM facturacion_recibos WHERE negocio_id=$1 AND folio=$2`, [negocioId, folio]);
  if (!local?.recibo_id) return local || null;
  const remoto = await obtenerRecibo(negocioId, local.recibo_id);
  const actualizado = await guardarRespuestaRecibo(negocioId, folio, remoto);
  if (actualizado.estado === 'facturado' && actualizado.factura_id && !actualizado.uuid) {
    const factura = await obtenerFactura(negocioId, actualizado.factura_id);
    await pool.query(`UPDATE facturacion_recibos SET uuid=$3, updated_at=NOW() WHERE negocio_id=$1 AND folio=$2`,
      [negocioId, folio, factura.uuid || null]);
    await registrarFacturaEmitida({ negocioId, folio, facturaId: actualizado.factura_id, uuid: factura.uuid || null, total: local.total, fuente: 'autofactura' });
    actualizado.uuid = factura.uuid || null;
  }
  return actualizado;
}

export async function estadoFacturacionNegocio(negocioId) {
  const [proveedor, config] = await Promise.all([puedeFacturar(negocioId), obtenerConfiguracionFacturacion(negocioId)]);
  return {
    proveedorConfigurado: proveedor,
    ivaConfigurado: config.iva_tasa !== null && config.iva_tasa !== undefined,
    puedeFacturar: proveedor && config.iva_tasa !== null && config.iva_tasa !== undefined,
    configuracion: config,
  };
}

export async function reconciliarRecibosFacturacion(limite = 50) {
  const { rows } = await pool.query(
    `SELECT negocio_id, folio, recibo_id, estado
       FROM facturacion_recibos
      WHERE estado IN ('abierto','creando','error')
        AND updated_at < NOW() - INTERVAL '1 minute'
      ORDER BY updated_at ASC LIMIT $1`, [Math.min(Math.max(Number(limite) || 50, 1), 200)]);
  let sincronizados = 0;
  for (const row of rows) {
    try {
      if (row.recibo_id) await sincronizarRecibo(row.negocio_id, row.folio);
      else await asegurarReciboPedido(row.negocio_id, row.folio);
      sincronizados++;
    } catch (e) {
      console.warn(`[Facturacion] reconciliación ${row.folio}: ${e.codigo || e.message}`);
    }
  }
  return { revisados: rows.length, sincronizados };
}
