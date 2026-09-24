// Facturación de servicios/catering sin pedido POS ni folio normal.
//
// Este ledger es deliberadamente separado de facturas_pedido: un evento puede
// tener una referencia comercial opcional, pero no debe fingir que existe un
// ticket del mostrador. El request fiscal se cifra antes de tocar Facturapi y
// conserva una idempotency_key estable para reanudar un timeout sin duplicar.
import { createHash, randomUUID } from 'node:crypto';
import { pool, guardarClienteFiscal } from './database.js';
import { cifrarSecretoIntegracion, descifrarSecretoIntegracion } from './cifradoIntegraciones.js';
import { validarDatosFiscales } from './autofacturaFiscal.js';
import { obtenerConfiguracionFacturacion, FacturacionError } from './facturacionService.js';
import { crearFacturaDirecta, obtenerFactura, enviarFacturaPorEmail, mapFormaPago, puedeFacturar } from './facturapi.js';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const redondear = (n) => Math.round(Number(n) * 100) / 100;

function errorFiscal(errores) {
  return Object.assign(new FacturacionError('Los datos fiscales no son válidos.', 'DATOS_FISCALES_INVALIDOS', 422), { errores });
}

function formaPagoServicio(valor) {
  const codigo = mapFormaPago(valor);
  if (!['01', '03', '04', '28'].includes(codigo)) {
    throw new FacturacionError('Selecciona una forma de pago real para el servicio.', 'FORMA_PAGO_NO_DETERMINADA', 400);
  }
  return codigo;
}

export function validarEntradaServicio(entrada, config = {}) {
  const b = entrada && typeof entrada === 'object' && !Array.isArray(entrada) ? entrada : {};
  const descripcion = String(b.descripcion || '').trim();
  if (descripcion.length < 3 || descripcion.length > 500) {
    throw new FacturacionError('Describe el servicio entre 3 y 500 caracteres.', 'DESCRIPCION_INVALIDA', 400);
  }
  const total = redondear(b.total);
  if (!Number.isFinite(total) || total <= 0) {
    throw new FacturacionError('El total del servicio debe ser mayor que cero.', 'TOTAL_NO_FACTURABLE', 400);
  }
  const claveSat = String(b.clave_sat || '').trim();
  if (!/^\d{8}$/.test(claveSat)) {
    throw new FacturacionError('La clave SAT del servicio debe tener 8 dígitos.', 'CLAVE_SAT_INVALIDA', 400);
  }
  const pago = formaPagoServicio(b.forma_pago);
  const fiscal = validarDatosFiscales({
    rfc: b.rfc, nombre: b.nombre ?? b.razon_social, cp: b.cp_fiscal ?? b.cp,
    regimen: b.regimen_fiscal ?? b.regimen, uso_cfdi: b.uso_cfdi, email: b.email,
  }, { emailObligatorio: false });
  if (!fiscal.ok) throw errorFiscal(fiscal.errores);
  const ivaTasa = Number(config.iva_tasa);
  if (config.iva_tasa === null || config.iva_tasa === undefined || config.iva_tasa === ''
      || ![0, 0.08, 0.16].includes(ivaTasa)) {
    throw new FacturacionError('Configura la tasa de IVA del negocio antes de emitir.', 'IVA_NO_CONFIGURADO', 409);
  }
  const referencia = String(b.referencia || '').trim().slice(0, 120) || null;
  return { descripcion, total, claveSat, pago, referencia, fiscal: fiscal.datos };
}

function payloadServicio({ id, negocioId, datos, config }) {
  return {
    customer: {
      legal_name: datos.fiscal.nombre,
      tax_id: datos.fiscal.rfc,
      tax_system: datos.fiscal.regimen,
      address: { zip: datos.fiscal.cp },
      ...(datos.fiscal.email ? { email: datos.fiscal.email } : {}),
    },
    items: [{ quantity: 1, product: {
      description: datos.descripcion,
      product_key: datos.claveSat,
      unit_key: 'E48',
      unit_name: 'Unidad de servicio',
      price: datos.total,
      tax_included: true,
      taxes: [{ type: 'IVA', rate: Number(config.iva_tasa) }],
    } }],
    use: datos.fiscal.uso_cfdi,
    payment_form: datos.pago,
    payment_method: 'PUE',
    currency: 'MXN',
    external_id: `xabor:${negocioId}:servicio:${id}`,
    idempotency_key: `xabor:servicio:${id}`,
    ...(config.serie ? { series: String(config.serie).trim() } : {}),
  };
}

async function filaPorId(id) {
  const { rows: [r] } = await pool.query('SELECT * FROM facturacion_servicios WHERE id=$1', [id]);
  return r || null;
}

function vistaServicio(r) {
  if (!r) return null;
  return {
    id: r.id, referencia: r.referencia, descripcion: r.descripcion,
    clave_sat: r.clave_sat, total: Number(r.total), forma_pago: r.forma_pago,
    estado: r.estado, factura_id: r.factura_id || null, uuid: r.uuid || null,
    error_codigo: r.error_codigo || null, created_at: r.created_at, updated_at: r.updated_at,
  };
}

function snapshotDatos(json) {
  try {
    const p = JSON.parse(json);
    return { rfc: p.customer?.tax_id, nombre: p.customer?.legal_name, regimen: p.customer?.tax_system,
      cp: p.customer?.address?.zip, uso_cfdi: p.use, email: p.customer?.email || null };
  } catch { return null; }
}

function descifrarPayload(r) {
  const json = descifrarSecretoIntegracion({ cifrado: r.snapshot_cifrado, iv: r.snapshot_iv,
    authTag: r.snapshot_auth_tag, version: r.snapshot_formato_version });
  if (sha256(json) !== r.snapshot_sha256) throw new FacturacionError('El snapshot del servicio no coincide con su huella.', 'SNAPSHOT_CORRUPTO', 500);
  return json;
}

async function cerrarFacturada(r, invoice) {
  const facturaId = invoice?.id || r.factura_id;
  if (!facturaId) throw new FacturacionError('Facturapi no devolvió el identificador de la factura.', 'FACTURAPI_RESULTADO_INVALIDO', 502);
  const uuid = invoice?.uuid || invoice?.folio_fiscal || r.uuid || null;
  const { rows: [cerrada] } = await pool.query(
    `UPDATE facturacion_servicios
        SET estado='facturada', factura_id=$2, uuid=$3, proveedor_status='valid',
            error_codigo=NULL, error_detalle=NULL, updated_at=NOW()
      WHERE id=$1 AND estado IN ('emitiendo','procesando') RETURNING *`, [r.id, facturaId, uuid]);
  const actual = cerrada || await filaPorId(r.id);
  if (!actual || actual.estado !== 'facturada') return { estado: 'procesando', codigo: 'EMISION_EN_CURSO', servicio: vistaServicio(actual) };
  const fiscal = r.snapshot_cifrado ? snapshotDatos(descifrarPayload(r)) : null;
  if (fiscal?.rfc) await guardarClienteFiscal({ negocioId: r.negocio_id, rfc: fiscal.rfc, razonSocial: fiscal.nombre,
    regimen: fiscal.regimen, usoCfdi: fiscal.uso_cfdi, cp: fiscal.cp, email: fiscal.email }).catch(() => {});
  if (fiscal?.email && actual.factura_id && !actual.email_enviado_at) {
    const { rows: [claim] } = await pool.query(`UPDATE facturacion_servicios SET email_enviado_at=NOW()
      WHERE id=$1 AND email_enviado_at IS NULL RETURNING id`, [r.id]);
    if (claim) await enviarFacturaPorEmail(r.negocio_id, actual.factura_id, fiscal.email).catch(async () => {
      await pool.query('UPDATE facturacion_servicios SET email_enviado_at=NULL WHERE id=$1', [r.id]).catch(() => {});
    });
  }
  return { estado: 'facturada', servicio: vistaServicio(actual) };
}

async function procesarFila(r) {
  if (!r?.snapshot_cifrado) throw new FacturacionError('El servicio no tiene snapshot para reanudar.', 'SNAPSHOT_AUSENTE', 409);
  const payload = descifrarPayload(r);
  try {
    const respuesta = await crearFacturaDirecta(r.negocio_id, payload);
    const invoice = respuesta.body || {};
    if (respuesta.status === 202 || String(invoice.status || '').toLowerCase() === 'pending') {
      const { rows: [actual] } = await pool.query(`UPDATE facturacion_servicios
        SET estado='procesando', factura_id=COALESCE($2,factura_id), proveedor_status='pending', updated_at=NOW()
        WHERE id=$1 RETURNING *`, [r.id, invoice.id || null]);
      return { estado: 'procesando', servicio: vistaServicio(actual) };
    }
    const proveedorStatus = String(invoice.status || '').toLowerCase();
    if ((respuesta.status === 200 || respuesta.status === 201)
        && (proveedorStatus === 'valid' || (!proveedorStatus && invoice.uuid))) {
      return cerrarFacturada(r, invoice);
    }
    const codigoEstado = `FACTURAPI_ESTADO_${(proveedorStatus || 'DESCONOCIDO').toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 30)}`;
    const rechazo = ['failed', 'rejected', 'canceled', 'cancelled'].includes(proveedorStatus);
    const { rows: [actual] } = await pool.query(`UPDATE facturacion_servicios
      SET estado=$2, factura_id=COALESCE($3,factura_id), proveedor_status=$4,
          error_codigo=$5, error_detalle=$6, updated_at=NOW() WHERE id=$1 RETURNING *`,
      [r.id, rechazo ? 'error' : 'procesando', invoice.id || null, proveedorStatus || null,
        codigoEstado, rechazo ? 'Facturapi rechazó el servicio.' : 'Facturapi devolvió un estado que requiere sincronización.']);
    if (rechazo) throw Object.assign(new FacturacionError('Facturapi rechazó la factura del servicio.', 'FACTURAPI_RECHAZO', 409), { servicio: vistaServicio(actual) });
    return { estado: 'procesando', codigo: codigoEstado, servicio: vistaServicio(actual) };
  } catch (e) {
    const status = Number(e?.status) || 0;
    const determinista = status >= 400 && status < 500 && ![401, 403, 408, 429].includes(status);
    const codigo = determinista ? `FACTURAPI_${status}`
      : (status === 429 ? 'FACTURAPI_429' : status >= 500 ? 'FACTURAPI_5XX' : e?.codigo || 'FACTURAPI_RESULTADO_DESCONOCIDO');
    const estado = determinista ? 'error' : 'emitiendo';
    const { rows: [actual] } = await pool.query(`UPDATE facturacion_servicios
      SET estado=$2, proveedor_status=$3, error_codigo=$4,
          error_detalle=$5, updated_at=NOW() WHERE id=$1 RETURNING *`,
      [r.id, estado, determinista ? 'rejected' : 'unknown', codigo, determinista ? 'Facturapi rechazó los datos del servicio.' : 'Resultado desconocido; se conserva el intento para reanudar.']);
    if (determinista) throw Object.assign(new FacturacionError('Facturapi rechazó los datos fiscales del servicio.', 'FACTURAPI_RECHAZO', 409), { servicio: vistaServicio(actual) });
    return { estado: 'emitiendo', codigo, servicio: vistaServicio(actual) };
  }
}

export async function emitirFacturaServicio(negocioId, entrada) {
  if (!(await puedeFacturar(negocioId))) throw new FacturacionError('Este negocio no tiene una cuenta de Facturapi activa.', 'FACTURAPI_NO_CONFIGURADO', 409);
  const config = await obtenerConfiguracionFacturacion(negocioId);
  const datos = validarEntradaServicio(entrada, config);
  const idempotencyKey = `xabor:servicio:${randomUUID()}`;
  let fila;
  try {
    ({ rows: [fila] } = await pool.query(
      `INSERT INTO facturacion_servicios (negocio_id, referencia, descripcion, clave_sat, total, forma_pago, estado, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,'emitiendo',$7) RETURNING *`,
      [negocioId, datos.referencia, datos.descripcion, datos.claveSat, datos.total, datos.pago, idempotencyKey]));
  } catch (e) {
    if (e?.code === '23505' && datos.referencia) {
      throw new FacturacionError('Ya existe un servicio con esa referencia en este negocio.', 'REFERENCIA_DUPLICADA', 409);
    }
    throw e;
  }
  const payload = payloadServicio({ id: fila.id, negocioId, datos, config });
  const json = JSON.stringify(payload);
  const cifrado = cifrarSecretoIntegracion(json);
  const { rows: [preparada] } = await pool.query(
    `UPDATE facturacion_servicios SET snapshot_cifrado=$2, snapshot_iv=$3, snapshot_auth_tag=$4,
       snapshot_formato_version=$5, snapshot_sha256=$6 WHERE id=$1 RETURNING *`,
    [fila.id, cifrado.cifrado, cifrado.iv, cifrado.authTag, cifrado.version, sha256(json)]);
  return procesarFila(preparada);
}

export async function reanudarFacturaServicio(negocioId, id) {
  const r = await filaPorId(id);
  if (!r || r.negocio_id !== negocioId) throw new FacturacionError('Servicio no encontrado.', 'SERVICIO_NO_ENCONTRADO', 404);
  if (r.estado === 'facturada') return { estado: 'facturada', servicio: vistaServicio(r) };
  if (!['emitiendo', 'procesando'].includes(r.estado)) throw new FacturacionError('Este servicio no tiene un intento técnico pendiente.', 'SERVICIO_NO_REANUDABLE', 409);
  if (r.estado === 'procesando') return reconciliarFacturaServicio(negocioId, id);
  return procesarFila(r);
}

export async function reconciliarFacturaServicio(negocioId, id) {
  const r = await filaPorId(id);
  if (!r || r.negocio_id !== negocioId) throw new FacturacionError('Servicio no encontrado.', 'SERVICIO_NO_ENCONTRADO', 404);
  if (r.estado === 'facturada') return { estado: 'facturada', servicio: vistaServicio(r) };
  if (r.estado !== 'procesando' || !r.factura_id) return { estado: r.estado, servicio: vistaServicio(r) };
  const invoice = await obtenerFactura(negocioId, r.factura_id);
  const status = String(invoice?.status || '').toLowerCase();
  if (status === 'valid') return cerrarFacturada(r, invoice);
  if (['failed', 'canceled', 'cancelled', 'rejected'].includes(status)) {
    const { rows: [actual] } = await pool.query(`UPDATE facturacion_servicios
      SET estado='error', proveedor_status=$2, error_codigo='FACTURAPI_RECHAZO',
          error_detalle='Facturapi reportó que la factura no puede validarse.', updated_at=NOW()
      WHERE id=$1 RETURNING *`, [r.id, status]);
    return { estado: 'error', servicio: vistaServicio(actual) };
  }
  return { estado: 'procesando', servicio: vistaServicio(r) };
}

export async function listarServiciosFacturacion(negocioId, { busqueda = '', estado = '', limite = 50, offset = 0 } = {}) {
  const max = Math.min(Math.max(Number.parseInt(limite, 10) || 50, 1), 100);
  const off = Math.max(Number.parseInt(offset, 10) || 0, 0);
  const q = String(busqueda || '').trim().slice(0, 100);
  const estados = new Set(['emitiendo', 'procesando', 'facturada', 'error', 'cancelada']);
  const e = String(estado || '').trim().toLowerCase();
  if (e && !estados.has(e)) throw new FacturacionError('El estado solicitado no es válido.', 'ESTADO_INVALIDO', 400);
  const { rows } = await pool.query(
    `SELECT id, referencia, descripcion, clave_sat, total, forma_pago, estado,
            factura_id, uuid, error_codigo, created_at, updated_at,
            COUNT(*) OVER()::int AS total_filas
       FROM facturacion_servicios
      WHERE negocio_id=$1 AND ($2='' OR estado=$2)
        AND ($3='' OR COALESCE(referencia,'') ILIKE '%'||$3||'%' OR descripcion ILIKE '%'||$3||'%')
      ORDER BY updated_at DESC, created_at DESC LIMIT $4 OFFSET $5`, [negocioId, e, q, max, off]);
  return { servicios: rows.map(({ total_filas: _n, ...r }) => ({ ...vistaServicio(r) })), paginacion: { limite: max, offset: off, total: Number(rows[0]?.total_filas || 0) } };
}
