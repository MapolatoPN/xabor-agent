// Autofactura nativa de Xabor — fase 4A: motor de emisión del CFDI.
//
// Convierte una autofactura VIGENTE con datos fiscales validados en un CFDI de
// ingreso vía POST /invoices de Facturapi, con dos defensas contra la doble
// facturación:
//   1. Xabor: `facturas_pedido` (ledger) + el reclamo atómico de la fila de
//      `autofacturas` (UPDATE ... WHERE estado='vigente' RETURNING).
//   2. Proveedor: una idempotency_key ESTABLE por intento
//      (`xabor:af:<id autofactura>:<número de intento>`), sin datos fiscales.
//
// El request exacto que se manda se persiste ANTES de tocar la red, cifrado
// (AES-256-GCM, cifradoIntegraciones.js) y con su SHA-256. Mientras el
// resultado de un intento sea desconocido (timeout, 429, 5xx, credenciales),
// la autofactura se queda en `emitiendo` y el único reintento posible es
// reenviar ESE snapshot con ESA idempotency_key (reanudarEmisionAutofactura).
// Nunca se reconstruye el payload a partir de una venta que pudo cambiar, y
// nunca se generan claves nuevas por un reintento.
//
// Nada de este módulo escribe RFC, nombre, CP, correo, payload ni token en el
// log ni en columnas en claro; solo ids, folios y códigos.
//
// Este motor es consumido por las rutas públicas del portal y por la
// reconciliación de estados; el token sigue siendo la única autorización.
import { createHash } from 'crypto';
import { pool, registrarFacturaEmitida, guardarClienteFiscal, negocioEstaActivo, moduloHabilitado } from './database.js';
import { cifrarSecretoIntegracion, descifrarSecretoIntegracion } from './cifradoIntegraciones.js';
import { resolverAutofacturaPorToken, esFormatoTokenValido } from './autofacturaService.js';
import { obtenerPedidoFacturable, obtenerConfiguracionFacturacion, FacturacionError } from './facturacionService.js';
import { validarDatosFiscales } from './autofacturaFiscal.js';
import { construirConceptoVenta, mapFormaPago, crearFacturaDirecta, obtenerFactura, enviarFacturaPorEmail } from './facturapi.js';

// fuente de la emisión (autofacturas.fuente_emision) -> fuente del ledger
// (facturas_pedido.fuente, CHECK de la 087).
const FUENTES = Object.freeze({ portal: 'autofactura', panel: 'panel', restaurante: 'restaurante', whatsapp: 'whatsapp' });
const NO_ENCONTRADA = () => new FacturacionError('No encontramos esta liga de facturación.', 'AUTOFACTURA_NO_ENCONTRADA', 404);
const MENSAJE_ESTADO = Object.freeze({
  expirada: 'Esta liga de facturación ha expirado.',
  revocada: 'Esta liga ya no está disponible.',
  error: 'Esta liga requiere revisión del negocio antes de volver a intentar.',
});
const redondear = (n) => Math.round(Number(n) * 100) / 100;
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/**
 * Forma de pago SAT (c_FormaPago) a partir de la forma de pago REAL de la
 * venta, con la misma tabla que ya usa facturapi.js (mapFormaPago). Lo que
 * mapFormaPago resolvería como '99 Por definir' (mixto, "tarjeta" sin
 * distinguir crédito/débito, vacío, valores desconocidos) NO se inventa: un
 * CFDI PUE no admite '99', así que se rechaza antes de tocar la red.
 */
export function formaPagoDeVenta(pedido) {
  let f = String(pedido?.forma_pago || '').trim().toLowerCase();
  if (f.startsWith('efectivo')) f = 'efectivo';
  const codigo = f ? mapFormaPago(f) : '99';
  if (codigo === '99') {
    throw new FacturacionError('No se pudo determinar la forma de pago de la venta para el CFDI.', 'FORMA_PAGO_NO_DETERMINADA', 409);
  }
  return codigo;
}

/**
 * El payload exacto de POST /invoices: un solo concepto fiscal por venta
 * (construirConceptoVenta, decisión vigente), receptor con los datos ya
 * validados, PUE (la venta ya está pagada) y la idempotency_key del intento.
 * Orden de llaves fijo: el JSON serializado es el snapshot y su SHA-256.
 */
export function construirPayloadCFDI({ autofactura, pedido, datos, config, intentoKey }) {
  let item;
  try {
    item = construirConceptoVenta({ ...pedido, folio: autofactura.folio, total: autofactura.total }, {
      ivaTasa: config?.iva_tasa, claveRestaurante: config?.clave_producto_restaurante, claveParaLlevar: config?.clave_producto_para_llevar,
    });
  } catch (e) {
    throw new FacturacionError(e.message, e.codigo || 'CONCEPTO_INVALIDO', 409);
  }
  const payload = {
    customer: {
      legal_name: datos.nombre,
      tax_id: datos.rfc,
      tax_system: datos.regimen,
      address: { zip: datos.cp },
      email: datos.email,
    },
    items: [item],
    use: datos.uso_cfdi,
    payment_form: formaPagoDeVenta(pedido),
    payment_method: 'PUE',
    currency: 'MXN',
    external_id: `xabor:${autofactura.negocioId}:${autofactura.folio}`,
    idempotency_key: intentoKey,
  };
  if (config?.serie) payload.series = String(config.serie).trim();
  return payload;
}

async function filaPorId(id, client = pool) {
  const { rows: [r] } = await client.query('SELECT * FROM autofacturas WHERE id=$1', [id]);
  return r || null;
}

async function facturaPreviaEnLedger(negocioId, folio) {
  const { rows: [r] } = await pool.query(
    `SELECT factura_id, uuid, fuente, emitida_at FROM facturas_pedido
      WHERE negocio_id=$1 AND folio=$2 AND factura_id IS NOT NULL
      ORDER BY emitida_at DESC LIMIT 1`, [negocioId, folio]);
  return r || null;
}

function resultadoFacturada(fila, { yaEmitida = false } = {}) {
  return { estado: 'facturada', yaEmitida, factura_id: fila.factura_id || null, uuid: fila.uuid || null, folio: fila.folio };
}

function descifrarSnapshot(fila) {
  const json = descifrarSecretoIntegracion({
    cifrado: fila.snapshot_cifrado, iv: fila.snapshot_iv, authTag: fila.snapshot_auth_tag, version: fila.snapshot_formato_version,
  });
  if (sha256(json) !== fila.snapshot_sha256) {
    throw new FacturacionError('El snapshot del intento no coincide con su huella.', 'SNAPSHOT_CORRUPTO', 500);
  }
  return json;
}

// Datos fiscales del snapshot, para guardar la ficha del cliente tras un
// éxito reanudado/reconciliado (la ficha nunca se guarda antes del CFDI).
function datosDesdeSnapshot(json) {
  try {
    const p = JSON.parse(json);
    return {
      rfc: p.customer?.tax_id, nombre: p.customer?.legal_name, regimen: p.customer?.tax_system,
      cp: p.customer?.address?.zip, email: p.customer?.email || null, uso_cfdi: p.use,
    };
  } catch { return null; }
}

/**
 * Cierre exitoso: estado facturada + ledger en UNA transacción. Si el ledger
 * no se puede asentar, la fila se queda en `emitiendo` con factura_id/uuid y
 * `LEDGER_PENDIENTE`: el CFDI ya existe y se reconcilia después por
 * factura_id, jamás se genera otro. La ficha fiscal se guarda solo después,
 * y su falla nunca convierte el éxito en fracaso.
 */
async function finalizarFacturada(fila, invoice, { datos, fuenteLedger, telefono = null }) {
  const facturaId = invoice.id || fila.factura_id;
  const uuid = invoice.uuid || invoice.folio_fiscal || null;
  const client = await pool.connect();
  let cerrada = null;
  try {
    await client.query('BEGIN');
    const { rows: [r] } = await client.query(
      `UPDATE autofacturas
          SET estado='facturada', factura_id=$2, uuid=$3, emitida_at=COALESCE(emitida_at, now()),
              proveedor_status='valid', intento_cerrado_at=now(), error_codigo=NULL, error_detalle=NULL
        WHERE id=$1 AND estado='emitiendo' RETURNING *`, [fila.id, facturaId, uuid]);
    if (!r) {
      await client.query('ROLLBACK');
      const actual = await filaPorId(fila.id);
      return actual?.estado === 'facturada' ? resultadoFacturada(actual, { yaEmitida: true }) : { estado: 'procesando', codigo: 'EMISION_EN_CURSO', factura_id: facturaId };
    }
    const ok = await registrarFacturaEmitida(
      { negocioId: fila.negocio_id, folio: fila.folio, facturaId, uuid, total: fila.total, fuente: fuenteLedger }, { db: client });
    if (!ok) {
      await client.query('ROLLBACK');
      console.error(`[autofactura] CFDI ${facturaId} emitido pero el ledger no se pudo asentar (autofactura ${fila.id}); queda para reconciliar`);
      await pool.query(
        `UPDATE autofacturas SET factura_id=$2, uuid=$3, proveedor_status='valid', error_codigo='LEDGER_PENDIENTE'
          WHERE id=$1 AND estado='emitiendo'`, [fila.id, facturaId, uuid]).catch(() => {});
      return { estado: 'procesando', codigo: 'LEDGER_PENDIENTE', factura_id: facturaId, uuid };
    }
    await client.query('COMMIT');
    cerrada = r;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  if (datos?.rfc) {
    try {
      const ficha = await guardarClienteFiscal({
        negocioId: fila.negocio_id, rfc: datos.rfc, razonSocial: datos.nombre, regimen: datos.regimen,
        usoCfdi: datos.uso_cfdi, cp: datos.cp, email: datos.email, telefono,
      });
      if (ficha?.error) console.warn(`[autofactura] ficha fiscal no guardada tras ${facturaId}: ${ficha.error}`);
    } catch (e) {
      console.warn(`[autofactura] ficha fiscal no guardada tras ${facturaId}: ${e.message}`);
    }
  }
  const emailEnviado = await enviarCorreoFacturaSiFalta(cerrada, datos?.email || null);
  return { ...resultadoFacturada(cerrada), email_enviado: emailEnviado };
}

/**
 * Manda la factura por correo UNA sola vez: se reclama la marca
 * `email_enviado_at` antes de enviar (un reintento idempotente o una segunda
 * finalización no vuelve a mandarlo); si el proveedor falla, la marca se
 * libera y la factura sigue siendo válida. Nunca convierte un éxito en fallo.
 */
async function enviarCorreoFacturaSiFalta(fila, emailConocido = null) {
  const email = emailConocido || (fila.snapshot_cifrado ? datosDesdeSnapshot(descifrarSnapshot(fila))?.email : null);
  if (!email || !fila.factura_id) return false;
  const { rows: [claim] } = await pool.query(
    `UPDATE autofacturas SET email_enviado_at=now()
      WHERE id=$1 AND estado='facturada' AND email_enviado_at IS NULL RETURNING id`, [fila.id]);
  if (!claim) return Boolean(fila.email_enviado_at) || false;
  try {
    await enviarFacturaPorEmail(fila.negocio_id, fila.factura_id, email);
    return true;
  } catch (e) {
    await pool.query('UPDATE autofacturas SET email_enviado_at=NULL WHERE id=$1', [fila.id]).catch(() => {});
    console.warn(`[autofactura] correo de la factura ${fila.factura_id} no enviado (${e.codigo || e.status || 'error'})`);
    return false;
  }
}

/**
 * Reconciliación con candado temporal, para el polling del portal: como
 * máximo una consulta al proveedor cada `minSegundos` por autofactura. El
 * candado es un UPDATE ... RETURNING sobre `reconciliado_at`, así que con N
 * refresh simultáneos solo uno consulta y el resto lee el estado actual.
 * Nunca hace POST.
 */
export async function reconciliarSiCorresponde(id, { minSegundos = 15 } = {}) {
  const { rows: [claim] } = await pool.query(
    `UPDATE autofacturas SET reconciliado_at=now()
      WHERE id=$1 AND estado='emitiendo' AND factura_id IS NOT NULL
        AND (reconciliado_at IS NULL OR reconciliado_at < now() - make_interval(secs => $2))
      RETURNING id`, [id, minSegundos]);
  if (!claim) {
    const fila = await filaPorId(id);
    if (!fila) throw new FacturacionError('Autofactura no encontrada.', 'AUTOFACTURA_NO_ENCONTRADA', 404);
    if (fila.estado === 'facturada') return resultadoFacturada(fila, { yaEmitida: true });
    return { estado: fila.estado === 'emitiendo' ? 'procesando' : fila.estado, codigo: 'RECONCILIACION_RECIENTE', factura_id: fila.factura_id || null };
  }
  return reconciliarAutofacturaPendiente(id);
}

// Solo un rechazo DETERMINISTA del proveedor (4xx de datos, intento cerrado
// como 'rejected') admite corrección. Timeout, red, credenciales, 429, 5xx y
// cualquier resultado desconocido dejan el intento en curso y NO se corrigen
// desde el portal.
const CODIGOS_NO_CORREGIBLES = new Set(['FACTURAPI_TIMEOUT', 'FACTURAPI_NO_DISPONIBLE', 'FACTURAPI_CREDENCIALES',
  'FACTURAPI_429', 'FACTURAPI_5XX', 'FACTURAPI_RESULTADO_DESCONOCIDO', 'LEDGER_PENDIENTE']);

/**
 * Reabre una liga cuyo intento terminó rechazado de forma determinista (400)
 * para que el cliente corrija sus datos. Antes de reabrir, el intento
 * anterior se ARCHIVA íntegro en autofactura_intentos (snapshot cifrado,
 * idempotency_key, huella, status, códigos): nunca se borra evidencia. El
 * siguiente intento usará intento_numero + 1, una idempotency_key nueva y un
 * snapshot nuevo.
 */
export async function prepararCorreccionAutofactura(token) {
  const t = typeof token === 'string' ? token.trim() : '';
  if (!esFormatoTokenValido(t)) throw NO_ENCONTRADA();
  const af = await resolverAutofacturaPorToken(t);
  if (!af) throw NO_ENCONTRADA();
  const [activo, habilitado] = await Promise.all([negocioEstaActivo(af.negocioId), moduloHabilitado(af.negocioId, 'facturacion')]);
  if (!activo || !habilitado) throw NO_ENCONTRADA();
  const fila = await filaPorId(af.id);
  if (!fila) throw NO_ENCONTRADA();
  const rechazo = (motivo) => new FacturacionError('Esta liga no admite corrección de datos en este momento.', 'AUTOFACTURA_NO_CORREGIBLE', 409, motivo);
  if (fila.estado !== 'error') { const e = rechazo(); e.motivo = `estado_${fila.estado}`; throw e; }
  if (fila.proveedor_status !== 'rejected' || !fila.intento_cerrado_at) { const e = rechazo(); e.motivo = 'intento_no_cerrado'; throw e; }
  if (!/^FACTURAPI_4\d\d/.test(String(fila.error_codigo || '')) || CODIGOS_NO_CORREGIBLES.has(fila.error_codigo)) { const e = rechazo(); e.motivo = 'error_no_determinista'; throw e; }
  if (fila.uuid || fila.factura_id) { const e = rechazo(); e.motivo = 'cfdi_existente'; throw e; }
  if (await facturaPreviaEnLedger(fila.negocio_id, fila.folio)) { const e = rechazo(); e.motivo = 'ledger_existente'; throw e; }
  if (!fila.intento_key) { const e = rechazo(); e.motivo = 'sin_intento'; throw e; }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO autofactura_intentos
         (autofactura_id, negocio_id, folio, intento_numero, intento_key, snapshot_cifrado, snapshot_iv, snapshot_auth_tag,
          snapshot_formato_version, snapshot_sha256, proveedor_status, error_codigo, error_detalle, factura_id,
          intento_iniciado_at, intento_cerrado_at, motivo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'correccion_cliente')
       ON CONFLICT (autofactura_id, intento_numero) DO NOTHING`,
      [fila.id, fila.negocio_id, fila.folio, fila.intento_numero, fila.intento_key, fila.snapshot_cifrado, fila.snapshot_iv,
        fila.snapshot_auth_tag, fila.snapshot_formato_version, fila.snapshot_sha256, fila.proveedor_status, fila.error_codigo,
        fila.error_detalle, fila.factura_id, fila.intento_iniciado_at, fila.intento_cerrado_at]);
    const { rows: [reabierta] } = await client.query(
      `UPDATE autofacturas
          SET estado='vigente', intento_key=NULL, snapshot_cifrado=NULL, snapshot_iv=NULL, snapshot_auth_tag=NULL,
              snapshot_formato_version=NULL, snapshot_sha256=NULL, proveedor_status=NULL, error_codigo=NULL, error_detalle=NULL,
              intento_iniciado_at=NULL, intento_cerrado_at=NULL
        WHERE id=$1 AND estado='error' RETURNING *`, [fila.id]);
    if (!reabierta) { await client.query('ROLLBACK'); const e = rechazo(); e.motivo = 'carrera'; throw e; }
    await client.query('COMMIT');
    console.log(`[autofactura] ${fila.id}: intento ${fila.intento_numero} archivado; liga reabierta para corrección (siguiente intento ${fila.intento_numero + 1})`);
    return { estado: 'vigente', folio: reabierta.folio, intento_siguiente: Number(reabierta.intento_numero) + 1 };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Códigos sanitizados: nunca el mensaje del proveedor (puede repetir el RFC o
// el nombre) ni el cuerpo completo de su respuesta.
function codigoSanitizado(prefijo, e) {
  const crudo = String(e?.codigo || '').toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 40);
  return crudo && crudo !== 'FACTURAPI_RECHAZO' ? `${prefijo}_${crudo}` : prefijo;
}

/**
 * Qué hacer con un error del proveedor. Solo un 4xx de datos (400/422/409...)
 * cierra el intento como `error`: Facturapi rechazó el documento y no lo
 * creó. Todo lo demás (timeout, red, 401/403, 429, 5xx) deja el intento en
 * `emitiendo`, reintentable con el MISMO snapshot y la MISMA idempotency_key.
 */
async function manejarErrorProveedor(fila, e) {
  const status = Number(e?.status) || 0;
  const definitivo = status >= 400 && status < 500 && ![401, 403, 408, 429].includes(status);
  if (definitivo) {
    const codigo = codigoSanitizado(`FACTURAPI_${status}`, e);
    await pool.query(
      `UPDATE autofacturas SET estado='error', proveedor_status='rejected', intento_cerrado_at=now(),
              error_codigo=$2, error_detalle=$3
        WHERE id=$1 AND estado='emitiendo'`, [fila.id, codigo, 'Facturapi rechazó los datos fiscales del intento.']);
    console.warn(`[autofactura] intento ${fila.intento_numero} de ${fila.id} rechazado por Facturapi (${codigo})`);
    return { estado: 'error', codigo: 'DATOS_FISCALES_RECHAZADOS', proveedor: codigo, reintentable: false };
  }
  let codigo;
  if (e?.codigo === 'FACTURAPI_TIMEOUT' || e?.codigo === 'FACTURAPI_NO_DISPONIBLE') codigo = e.codigo;
  else if (status === 401 || status === 403) codigo = 'FACTURAPI_CREDENCIALES';
  else if (status === 429) codigo = 'FACTURAPI_429';
  else if (status >= 500) codigo = 'FACTURAPI_5XX';
  else codigo = 'FACTURAPI_RESULTADO_DESCONOCIDO';
  await pool.query(
    `UPDATE autofacturas SET error_codigo=$2, error_detalle=$3 WHERE id=$1 AND estado='emitiendo'`,
    [fila.id, codigo, 'Resultado del intento desconocido; se reintenta con el mismo snapshot e idempotency_key.']);
  console.warn(`[autofactura] intento ${fila.intento_numero} de ${fila.id} sin resultado (${codigo}); queda en emitiendo`);
  return { estado: 'emitiendo', codigo, reintentable: true };
}

async function procesarRespuestaProveedor(fila, r, ctx) {
  const invoice = r.body || {};
  const statusProveedor = String(invoice.status || '').toLowerCase();
  if (r.status === 202 || statusProveedor === 'pending') {
    await pool.query(
      `UPDATE autofacturas SET factura_id=COALESCE($2, factura_id), proveedor_status='pending', error_codigo=NULL, error_detalle=NULL
        WHERE id=$1 AND estado='emitiendo'`, [fila.id, invoice.id || null]);
    return { estado: 'procesando', codigo: 'PROVEEDOR_PENDIENTE', factura_id: invoice.id || fila.factura_id || null };
  }
  if ((r.status === 200 || r.status === 201) && (statusProveedor === 'valid' || (!statusProveedor && invoice.uuid))) {
    return finalizarFacturada(fila, invoice, ctx);
  }
  // 2xx con un status que no es valid ni pending: no se inventa nada.
  const codigo = `FACTURAPI_ESTADO_${(statusProveedor || 'DESCONOCIDO').toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 30)}`;
  await pool.query(
    `UPDATE autofacturas SET factura_id=COALESCE($2, factura_id), proveedor_status=$3, error_codigo=$4, error_detalle=$5
      WHERE id=$1 AND estado='emitiendo'`,
    [fila.id, invoice.id || null, statusProveedor || null, codigo, 'Facturapi respondió con un estado no reconocido; requiere revisión.']);
  return { estado: 'emitiendo', codigo, reintentable: false };
}

async function ejecutarIntento(fila, json, ctx) {
  let r;
  try {
    r = await crearFacturaDirecta(fila.negocio_id, json);
  } catch (e) {
    if (e?.status || e?.codigo) return manejarErrorProveedor(fila, e);
    throw e;
  }
  return procesarRespuestaProveedor(fila, r, ctx);
}

/**
 * Emite el CFDI de una autofactura. Devuelve un resultado controlado
 * (`estado`: facturada | procesando | emitiendo | error) o lanza
 * FacturacionError ANTES de tocar la red (token, estado, datos, venta,
 * forma de pago): en ese caso la autofactura sigue `vigente`.
 */
export async function emitirAutofactura({ token, datosFiscales, fuente = 'portal' } = {}) {
  const fuenteLedger = FUENTES[fuente];
  if (!fuenteLedger) throw new FacturacionError('Fuente de emisión no válida.', 'FUENTE_INVALIDA', 400);

  // A-C: token, negocio activo, módulo habilitado (mismo 404 genérico para todo).
  const t = typeof token === 'string' ? token.trim() : '';
  if (!esFormatoTokenValido(t)) throw NO_ENCONTRADA();
  const af = await resolverAutofacturaPorToken(t);
  if (!af) throw NO_ENCONTRADA();
  const [activo, habilitado] = await Promise.all([negocioEstaActivo(af.negocioId), moduloHabilitado(af.negocioId, 'facturacion')]);
  if (!activo || !habilitado) throw NO_ENCONTRADA();

  // D: estado.
  if (af.estado === 'facturada') return resultadoFacturada({ factura_id: af.facturaId, uuid: af.uuid, folio: af.folio }, { yaEmitida: true });
  if (af.estado === 'emitiendo') return { estado: 'procesando', codigo: 'EMISION_EN_CURSO', factura_id: af.facturaId || null };
  if (af.estado !== 'vigente') {
    throw new FacturacionError(MENSAJE_ESTADO[af.estado] || MENSAJE_ESTADO.error, `AUTOFACTURA_${String(af.estado).toUpperCase()}`, 409);
  }

  // E: datos fiscales, otra vez, aquí (el portal no es autoridad).
  const v = validarDatosFiscales(datosFiscales);
  if (!v.ok) throw Object.assign(new FacturacionError('Los datos fiscales no son válidos.', 'DATOS_FISCALES_INVALIDOS', 422), { errores: v.errores });

  // F-G: la venta sigue facturable y con el total congelado.
  const pedido = await obtenerPedidoFacturable(af.negocioId, af.folio);
  if (redondear(pedido.total) !== af.total) {
    throw new FacturacionError('El total de la venta cambió y esta liga requiere revisión.', 'TOTAL_CAMBIO', 409);
  }

  // H: ya hay CFDI de esta venta (panel, POS, WhatsApp...): jamás otro.
  const previa = await facturaPreviaEnLedger(af.negocioId, af.folio);
  if (previa) {
    const { rows: [r] } = await pool.query(
      `UPDATE autofacturas SET estado='facturada', factura_id=$2, uuid=$3, emitida_at=$4,
              fuente_emision=COALESCE(fuente_emision, $5), proveedor_status='valid'
        WHERE id=$1 AND estado='vigente' RETURNING *`,
      [af.id, previa.factura_id, previa.uuid, previa.emitida_at, previa.fuente === 'autofactura' ? 'portal' : previa.fuente]);
    return resultadoFacturada(r || { factura_id: previa.factura_id, uuid: previa.uuid, folio: af.folio }, { yaEmitida: true });
  }

  // I: payload + snapshot, en memoria todavía.
  const [config, actual] = await Promise.all([obtenerConfiguracionFacturacion(af.negocioId), filaPorId(af.id)]);
  if (!actual) throw NO_ENCONTRADA();
  const intentoNumero = Number(actual.intento_numero || 0) + 1;
  const intentoKey = `xabor:af:${af.id}:${intentoNumero}`;
  const payload = construirPayloadCFDI({ autofactura: af, pedido, datos: v.datos, config, intentoKey });
  const json = JSON.stringify(payload);
  const c = cifrarSecretoIntegracion(json);

  // J-K: reclamo atómico + snapshot persistido en el MISMO UPDATE. Solo una
  // de N llamadas simultáneas obtiene la fila; el resto ve `emitiendo`.
  const { rows: [reclamada] } = await pool.query(
    `UPDATE autofacturas
        SET estado='emitiendo', intento_key=$2, intento_numero=$3, intento_iniciado_at=now(), intento_cerrado_at=NULL,
            snapshot_cifrado=$4, snapshot_iv=$5, snapshot_auth_tag=$6, snapshot_formato_version=$7, snapshot_sha256=$8,
            proveedor_status=NULL, error_codigo=NULL, error_detalle=NULL, fuente_emision=$9
      WHERE id=$1 AND estado='vigente' RETURNING *`,
    [af.id, intentoKey, intentoNumero, c.cifrado, c.iv, c.authTag, c.version, sha256(json), fuente]);
  if (!reclamada) {
    const otra = await filaPorId(af.id);
    if (otra?.estado === 'facturada') return resultadoFacturada(otra, { yaEmitida: true });
    return { estado: 'procesando', codigo: 'EMISION_EN_CURSO', factura_id: otra?.factura_id || null };
  }

  // L-M: solo ahora la red.
  const telefono = pedido?.cliente?.telefono || pedido?.telefono_conversacion || null;
  return ejecutarIntento(reclamada, json, { datos: v.datos, fuenteLedger, telefono });
}

/**
 * Reintento técnico de un intento cuyo resultado se desconoce: reenvía el
 * MISMO snapshot (byte a byte, misma idempotency_key). No acepta datos
 * nuevos. Si el proveedor ya había aceptado el documento como pendiente, se
 * reconcilia en vez de reenviar.
 */
export async function reanudarEmisionAutofactura(id) {
  const fila = await filaPorId(id);
  if (!fila) throw new FacturacionError('Autofactura no encontrada.', 'AUTOFACTURA_NO_ENCONTRADA', 404);
  if (fila.estado === 'facturada') return resultadoFacturada(fila, { yaEmitida: true });
  if (fila.estado !== 'emitiendo') {
    throw new FacturacionError(`La autofactura está ${fila.estado}; solo se reanuda un intento en curso.`, 'INTENTO_NO_EN_CURSO', 409);
  }
  if (fila.proveedor_status === 'pending' && fila.factura_id) return reconciliarAutofacturaPendiente(id);
  if (fila.proveedor_status === 'valid' && fila.factura_id) return reconciliarAutofacturaPendiente(id);
  if (!fila.snapshot_cifrado || !fila.intento_key) {
    throw new FacturacionError('El intento no tiene snapshot que reenviar.', 'SNAPSHOT_AUSENTE', 409);
  }
  const json = descifrarSnapshot(fila);
  const fuenteLedger = FUENTES[fila.fuente_emision] || 'autofactura';
  return ejecutarIntento(fila, json, { datos: datosDesdeSnapshot(json), fuenteLedger });
}

/**
 * Un intento que el proveedor dejó pendiente (202) o que quedó con CFDI y
 * ledger sin asentar: se consulta GET /invoices/:id. valid -> se cierra
 * exactamente como un 200; pending -> nada destructivo; otro -> error
 * controlado sin crear otro documento. Nunca hace POST.
 */
export async function reconciliarAutofacturaPendiente(id) {
  const fila = await filaPorId(id);
  if (!fila) throw new FacturacionError('Autofactura no encontrada.', 'AUTOFACTURA_NO_ENCONTRADA', 404);
  if (fila.estado === 'facturada') return resultadoFacturada(fila, { yaEmitida: true });
  if (fila.estado !== 'emitiendo') {
    throw new FacturacionError(`La autofactura está ${fila.estado}; no hay intento que reconciliar.`, 'INTENTO_NO_EN_CURSO', 409);
  }
  if (!fila.factura_id) return { estado: 'emitiendo', codigo: 'SIN_FACTURA_ID', reintentable: true };
  let invoice;
  try {
    invoice = await obtenerFactura(fila.negocio_id, fila.factura_id);
  } catch (e) {
    if (e?.status || e?.codigo) {
      console.warn(`[autofactura] no se pudo consultar ${fila.factura_id} para reconciliar ${fila.id}: ${e.codigo || e.status}`);
      return { estado: 'procesando', codigo: 'PROVEEDOR_NO_CONSULTABLE', factura_id: fila.factura_id };
    }
    throw e;
  }
  const statusProveedor = String(invoice?.status || '').toLowerCase();
  if (statusProveedor === 'valid') {
    const json = fila.snapshot_cifrado ? descifrarSnapshot(fila) : null;
    return finalizarFacturada(fila, invoice, { datos: json ? datosDesdeSnapshot(json) : null, fuenteLedger: FUENTES[fila.fuente_emision] || 'autofactura' });
  }
  if (statusProveedor === 'pending') {
    await pool.query(`UPDATE autofacturas SET proveedor_status='pending' WHERE id=$1 AND estado='emitiendo'`, [fila.id]);
    return { estado: 'procesando', codigo: 'PROVEEDOR_PENDIENTE', factura_id: fila.factura_id };
  }
  const codigo = `FACTURAPI_ESTADO_${(statusProveedor || 'DESCONOCIDO').toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 30)}`;
  await pool.query(
    `UPDATE autofacturas SET estado='error', proveedor_status=$2, intento_cerrado_at=now(), error_codigo=$3, error_detalle=$4
      WHERE id=$1 AND estado='emitiendo'`,
    [fila.id, statusProveedor || null, codigo, 'El proveedor no timbró el intento; requiere revisión antes de un nuevo intento.']);
  console.warn(`[autofactura] intento ${fila.intento_numero} de ${fila.id} terminó en ${statusProveedor || 'desconocido'}`);
  return { estado: 'error', codigo, reintentable: false, factura_id: fila.factura_id };
}
