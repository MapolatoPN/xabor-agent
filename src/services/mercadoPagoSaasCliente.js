// Cliente exclusivo para la mensualidad SaaS de Xabor.
// No reutiliza Clip ni credenciales de pago de ningún restaurante.
// Documentación de MP: /preapproval y /authorized_payments/{id}.
import { createHmac, timingSafeEqual } from 'node:crypto';

const BASE = 'https://api.mercadopago.com';
export const PRECIO_SAAS_MXN = 150;
export const mpSaasHabilitado = () =>
  process.env.XABOR_SUSCRIPCIONES_MP === 'true' &&
  Boolean(process.env.MP_SAAS_ACCESS_TOKEN) &&
  Boolean(process.env.MP_SAAS_WEBHOOK_SECRET);

export class ErrorMercadoPagoSaas extends Error {
  constructor(mensaje, estado = 502) { super(mensaje); this.name = 'ErrorMercadoPagoSaas'; this.estado = estado; }
}

const idRemotoValido = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
export const enlaceMPValido = enlace => {
  try {
    const u = new URL(enlace);
    return u.protocol === 'https:' && /(^|\.)mercadopago\.com(\.(mx|ar|br|uy|cl|co|pe))?$/.test(u.hostname) &&
      !u.username && !u.password;
  } catch { return false; }
};

export function construirPreapprovalBasico({ negocioId, email, inicioCobro, baseUrl }) {
  if (!/^[0-9a-f-]{36}$/.test(String(negocioId)) || !/^\S+@\S+\.\S+$/.test(String(email))) {
    throw new ErrorMercadoPagoSaas('Negocio o correo inválido', 400);
  }
  const fecha = new Date(inicioCobro);
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
      transaction_amount: PRECIO_SAAS_MXN,
      currency_id: 'MXN',
    },
    back_url: new URL('/suscripcion-basico', url).toString(),
    status: 'pending',
  };
}

// Cliente HTTP de URL y rutas FIJAS para impedir SSRF, con timeout.
// Jamás se registra el Authorization header, respuesta de pago ni token.
export async function consultarMpSaas(ruta, { method = 'GET', body, idempotencyKey, fetchImpl = fetch } = {}) {
  if (!/^\/(preapproval|authorized_payments|v1\/payments)(\/([A-Za-z0-9_-]+))?$/.test(ruta)) {
    throw new ErrorMercadoPagoSaas('Ruta no permitida', 400);
  }
  const token = process.env.MP_SAAS_ACCESS_TOKEN;
  if (!token) throw new ErrorMercadoPagoSaas('Mercado Pago no configurado', 503);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  if (idempotencyKey) headers['X-Idempotency-Key'] = idempotencyKey;
  let response;
  try {
    response = await fetchImpl(BASE + ruta, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    throw new ErrorMercadoPagoSaas('Mercado Pago no respondió; revisión requerida', 503);
  }
  // Nunca confiar en el body de error externo para mensajes ni logs.
  if (!response.ok) throw new ErrorMercadoPagoSaas('Mercado Pago rechazó la solicitud', 502);
  try { return await response.json(); }
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
export function validarCobroSaas({ factura, pago, preapprovalId }) {
  const montoFactura = Number(factura?.transaction_amount);
  const montoPago = Number(pago?.transaction_amount);
  const id = String(factura?.payment?.id ?? '');
  const aprobadoAt = Date.parse(pago?.date_approved || '');
  return Boolean(
    String(factura?.preapproval_id || '') === preapprovalId &&
    factura?.currency_id === 'MXN' && montoFactura === PRECIO_SAAS_MXN &&
    factura?.payment?.status === 'approved' && /^\d{1,24}$/.test(id) &&
    String(pago?.id) === id && pago?.status === 'approved' &&
    pago?.currency_id === 'MXN' && montoPago === PRECIO_SAAS_MXN &&
    Number.isFinite(aprobadoAt)
  );
}
