// Cliente exclusivo para la mensualidad SaaS de Xabor.
// No reutiliza Clip ni credenciales de pago de ningún restaurante.
// Documentación de MP: /preapproval y /authorized_payments/{id}.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { precioBasicoMxn } from './planBasico.js';

const BASE = 'https://api.mercadopago.com';
export const PRECIO_SAAS_MXN = precioBasicoMxn();
// Tamaño aceptado por la API real en el ensayo de suscripciones de México.
export const LIMITE_FACTURAS_MP_SAAS = 12;
const entornoMpValido = env => ['prueba','produccion'].includes(env.MP_SAAS_MODO) &&
  /^\d{1,20}$/.test(env.MP_SAAS_VENDEDOR_ID || '') &&
  !(env.RAILWAY_ENVIRONMENT_NAME === 'staging-basico' && env.MP_SAAS_MODO !== 'prueba') &&
  !(env.RAILWAY_ENVIRONMENT_NAME === 'production' && env.MP_SAAS_MODO !== 'produccion');
export const mpSaasHabilitado = (env = process.env) =>
  env.XABOR_SUSCRIPCIONES_MP === 'true' && entornoMpValido(env) &&
  Boolean(env.MP_SAAS_ACCESS_TOKEN) && Boolean(env.MP_SAAS_WEBHOOK_SECRET);

export class ErrorMercadoPagoSaas extends Error {
  constructor(mensaje, estado = 502, { rechazoDefinitivo = false } = {}) {
    super(mensaje); this.name = 'ErrorMercadoPagoSaas'; this.estado = estado;
    this.rechazoDefinitivo = rechazoDefinitivo;
  }
}

let cuentaVerificada;
// Una credencial APP_USR también puede pertenecer a un vendedor de prueba.
// Se comprueba su identidad antes de cualquier solicitud de cobro, no su prefijo.
export async function verificarCuentaMpSaas({ fetchImpl = fetch, env = process.env } = {}) {
  const token = env.MP_SAAS_ACCESS_TOKEN;
  const fallo = () => new ErrorMercadoPagoSaas('No se pudo verificar el entorno de Mercado Pago', 503, { rechazoDefinitivo: true });
  if (!token || !entornoMpValido(env)) throw fallo();
  const clave = createHash('sha256').update([token,env.MP_SAAS_MODO,env.MP_SAAS_VENDEDOR_ID,env.RAILWAY_ENVIRONMENT_NAME].join('\n')).digest('hex');
  if (cuentaVerificada?.clave === clave && cuentaVerificada.fetchImpl === fetchImpl && cuentaVerificada.vence > Date.now()) return cuentaVerificada.promesa;
  const promesa = (async () => {
    try {
      const r = await fetchImpl(BASE+'/users/me', {
        headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000), redirect: 'error',
      });
      if (!r.ok) throw fallo();
      const cuenta = await r.json();
      if (String(cuenta.id) !== env.MP_SAAS_VENDEDOR_ID || cuenta.site_id !== 'MLM' ||
          !Array.isArray(cuenta.tags) || cuenta.tags.includes('test_user') !== (env.MP_SAAS_MODO === 'prueba')) throw fallo();
      return { modo: env.MP_SAAS_MODO, vendedorVerificado: true, pais: 'MLM' };
    } catch { throw fallo(); }
  })();
  cuentaVerificada = { clave, fetchImpl, vence: Date.now()+60_000, promesa };
  try { return await promesa; }
  catch (e) { if (cuentaVerificada?.promesa === promesa) cuentaVerificada = undefined; throw e; }
}

const idRemotoValido = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
export const enlaceMPValido = enlace => {
  try {
    const u = new URL(enlace);
    return u.protocol === 'https:' && /(^|\.)mercadopago\.com(\.(mx|ar|br|uy|cl|co|pe))?$/.test(u.hostname) &&
      !u.username && !u.password;
  } catch { return false; }
};

export function construirPreapprovalBasico({ negocioId, email, inicioCobro, baseUrl, montoMensual = PRECIO_SAAS_MXN }) {
  if (!/^[0-9a-f-]{36}$/.test(String(negocioId)) || !/^\S+@\S+\.\S+$/.test(String(email))) {
    throw new ErrorMercadoPagoSaas('Negocio o correo inválido', 400);
  }
  const fecha = new Date(inicioCobro);
  if (!Number.isFinite(montoMensual) || montoMensual <= 0) throw new ErrorMercadoPagoSaas('Precio inválido',503);
  if (!Number.isFinite(fecha.getTime())) throw new ErrorMercadoPagoSaas('Fecha de inicio inválida', 400);
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:') throw new ErrorMercadoPagoSaas('URL pública debe usar HTTPS', 503);
  return {
    reason: 'Xabor Básico — mensualidad',
    external_reference: `xabor-basico:${negocioId}`,
    payer_email: email,
    auto_recurring: {
      frequency: 1, frequency_type: 'months',
      start_date: fecha.toISOString(),
      transaction_amount: montoMensual,
      currency_id: 'MXN',
    },
    back_url: new URL('/suscripcion-basico', url).toString(),
    status: 'pending',
  };
}

// Cliente HTTP de URL y rutas FIJAS para impedir SSRF, con timeout.
// Jamás se registra el Authorization header, respuesta de pago ni token.
export async function consultarMpSaas(ruta, { method = 'GET', body, idempotencyKey, fetchImpl = fetch } = {}) {
  if (!/^\/(preapproval|authorized_payments|v1\/payments)(\/([A-Za-z0-9_-]+))?(\?(?:payment_id=\d{1,24}|preapproval_id=[A-Za-z0-9_-]{1,128}&limit=\d{1,2}&offset=\d{1,4}))?$/.test(ruta)) {
    throw new ErrorMercadoPagoSaas('Ruta no permitida', 400);
  }
  const token = process.env.MP_SAAS_ACCESS_TOKEN;
  if (!token) throw new ErrorMercadoPagoSaas('Mercado Pago no configurado', 503);
  await verificarCuentaMpSaas({ fetchImpl });
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  if (idempotencyKey) headers['X-Idempotency-Key'] = idempotencyKey;
  let response;
  try {
    response = await fetchImpl(BASE + ruta, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(12_000),
      redirect: 'error',
    });
  } catch {
    throw new ErrorMercadoPagoSaas('Mercado Pago no respondió; revisión requerida', 503);
  }
  // Nunca confiar en el body de error externo para mensajes ni logs.
  if (!response.ok) throw new ErrorMercadoPagoSaas('Mercado Pago rechazó la solicitud', 502, {
    // Conflictos de idempotencia, timeouts, límites y errores de servidor
    // pueden ocultar una creación: nunca liberan la reserva automáticamente.
    rechazoDefinitivo: [400, 401, 403, 404, 405, 422].includes(response.status),
  });
  try {
    const datos = await response.json();
    if ((ruta === '/preapproval' || ruta.startsWith('/preapproval/') || ruta.startsWith('/v1/payments/')) &&
        String(datos.collector_id) !== process.env.MP_SAAS_VENDEDOR_ID) throw new Error('Vendedor distinto');
    if (ruta.startsWith('/v1/payments/') && datos.live_mode !== (process.env.MP_SAAS_MODO === 'produccion')) throw new Error('Ambiente de pago distinto');
    return datos;
  }
  catch { throw new ErrorMercadoPagoSaas('Respuesta inválida de Mercado Pago', 502); }
}

export async function crearPreapprovalBasico(args, opciones) {
  const body = construirPreapprovalBasico(args);
  const respuesta = await consultarMpSaas('/preapproval', {
    method: 'POST', body, idempotencyKey: args.idempotencyKey, ...opciones,
  });
  if (!idRemotoValido(String(respuesta?.id || '')) || !enlaceMPValido(respuesta?.init_point)) {
    throw new ErrorMercadoPagoSaas('Suscripción creada sin enlace verificable; revisar manualmente', 502);
  }
  if (String(respuesta.external_reference) !== body.external_reference) {
    throw new ErrorMercadoPagoSaas('La referencia de Mercado Pago no coincide; revisar manualmente', 502);
  }
  return { id: String(respuesta.id), checkoutUrl: respuesta.init_point, estado: String(respuesta.status || 'pending') };
}

export const obtenerPreapprovalBasico = (id, opciones) => {
  if (!idRemotoValido(String(id))) throw new ErrorMercadoPagoSaas('ID inválido', 400);
  return consultarMpSaas(`/preapproval/${id}`, opciones);
};
export const obtenerFacturaMpSaas = (id, opciones) => {
  if (!/^\d{1,24}$/.test(String(id))) throw new ErrorMercadoPagoSaas('ID de factura inválido', 400);
  return consultarMpSaas(`/authorized_payments/${id}`, opciones);
};
export const obtenerPagoMpSaas = (id, opciones) => {
  if (!/^\d{1,24}$/.test(String(id))) throw new ErrorMercadoPagoSaas('ID de pago inválido', 400);
  return consultarMpSaas(`/v1/payments/${id}`, opciones);
};

export function validarFirmaWebhookMp({ signature, requestId, dataId, secret, ahora = Date.now() }) {
  if (![signature, requestId, dataId, secret].every(x => typeof x === 'string' && x.length > 0)) return false;
  if (!idRemotoValido(dataId) || requestId.length > 200) return false;
  const partes = Object.fromEntries(signature.split(',').map(x => x.trim().split('=')));
  if (!/^\d{10,13}$/.test(partes.ts || '') || !/^[a-f0-9]{64}$/i.test(partes.v1 || '')) return false;
  const tsNum = Number(partes.ts);
  const tsMs = partes.ts.length === 13 ? tsNum : tsNum * 1000;
  if (Math.abs(ahora - tsMs) > 10 * 60_000) return false;
  const manifiesto = `id:${dataId.toLowerCase()};request-id:${requestId};ts:${partes.ts};`;
  const esperado = createHmac('sha256', secret).update(manifiesto).digest();
  const recibido = Buffer.from(partes.v1, 'hex');
  return recibido.length === esperado.length && timingSafeEqual(recibido, esperado);
}

// Un estado de suscripción 'authorized' no significa un pago aprobado.
// Solo facturas vinculadas a un pago aprobado y verificadas con GET adicional.
export function validarCobroSaas({ factura, pago, preapprovalId, montoEsperado = PRECIO_SAAS_MXN }) {
  const montoFactura = Number(factura?.transaction_amount);
  const montoPago = Number(pago?.transaction_amount);
  const id = String(factura?.payment?.id ?? '');
  const aprobadoAt = Date.parse(pago?.date_approved || '');
  return Boolean(
    String(factura?.preapproval_id || '') === preapprovalId &&
    factura?.currency_id === 'MXN' && montoFactura === montoEsperado &&
    factura?.payment?.status === 'approved' && /^\d{1,24}$/.test(id) &&
    String(pago?.id) === id && pago?.status === 'approved' &&
    pago?.currency_id === 'MXN' && montoPago === montoEsperado &&
    Number(pago?.transaction_amount_refunded || 0) === 0 &&
    Number.isFinite(aprobadoAt)
  );
}

export async function buscarFacturaMpSaasPorPago(paymentId, opciones) {
  if (!/^\d{1,24}$/.test(String(paymentId))) throw new ErrorMercadoPagoSaas('ID de pago inválido', 400);
  const resultado = await consultarMpSaas(`/authorized_payments/search?payment_id=${paymentId}`, opciones);
  return Array.isArray(resultado?.results) ? resultado.results
    .filter(x => String(x?.payment?.id || '') === String(paymentId))
    .slice(0, 10) : [];
}

export async function cancelarPreapprovalBasico(id, opciones) {
  if (!idRemotoValido(String(id))) throw new ErrorMercadoPagoSaas('ID inválido', 400);
  const r = await consultarMpSaas(`/preapproval/${id}`, {
    method: 'PUT', body: { status: 'canceled' }, ...opciones,
  });
  if (String(r?.id || '') !== String(id) || !['canceled','cancelled'].includes(r?.status)) {
    throw new ErrorMercadoPagoSaas('Cancelación no confirmada por Mercado Pago', 503);
  }
  return r;
}

export async function buscarFacturasMpSaasPorContrato(preapprovalId, {
  limit = LIMITE_FACTURAS_MP_SAAS, offset = 0, ...opciones
} = {}) {
  if (!idRemotoValido(String(preapprovalId)) ||
      !Number.isInteger(limit) || limit < 1 || limit > LIMITE_FACTURAS_MP_SAAS ||
      !Number.isInteger(offset) || offset < 0 || offset > 9999) {
    throw new ErrorMercadoPagoSaas('Parámetros inválidos', 400);
  }
  const resultado = await consultarMpSaas(
    `/authorized_payments/search?preapproval_id=${preapprovalId}&limit=${limit}&offset=${offset}`, opciones);
  return Array.isArray(resultado?.results)
    ? resultado.results.filter(f => String(f?.preapproval_id || '') === String(preapprovalId))
    : [];
}
