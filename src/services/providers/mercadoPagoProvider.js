/**
 * mercadoPagoProvider.js — Adaptador de Mercado Pago para la interfaz común
 * de proveedores de pago.
 *
 * El negocio conecta SU propia cuenta: el access token viaja en `credenciales`,
 * resuelto por (negocio, proveedor) desde integracionesService. Aquí no existe
 * ninguna credencial de plataforma, ni un token por defecto, ni un fallback.
 * El dinero va del cliente a la cuenta del negocio; Xabor solo crea la
 * preferencia y verifica el resultado.
 *
 * Superficie usada de la API de Mercado Pago:
 *   POST /checkout/preferences         → crea la preferencia, devuelve init_point
 *   GET  /checkout/preferences/search  → recupera una preferencia por referencia
 *   GET  /v1/payments/:id              → estado real de un pago
 *
 * IDEMPOTENCIA EN LA CREACIÓN: la referencia oficial de "Create preference"
 * documenta un solo header de petición, Authorization. No hay X-Idempotency-Key
 * documentado para /checkout/preferences (sí lo hay para la API de pagos, que
 * es otra cosa). Así que aquí NO se finge idempotencia.
 *
 * Lo que sí ofrece Mercado Pago es RECUPERACIÓN: /checkout/preferences/search
 * acepta external_reference (últimos 90 días). Eso permite resolver el caso
 * ambiguo -- creación enviada, respuesta perdida -- preguntando si la
 * preferencia existe, en vez de adivinar.
 *
 * La base se puede apuntar a otro host con XABOR_MP_API_BASE. Es lo que usan
 * las pruebas para hablar con un mock local: ninguna prueba toca la API real
 * ni mueve dinero.
 */
import { createHmac, timingSafeEqual } from 'crypto';

const BASE = () => process.env.XABOR_MP_API_BASE || 'https://api.mercadopago.com';
const TIMEOUT_MS = Number(process.env.XABOR_MP_TIMEOUT_MS) || 12000;

class MercadoPagoError extends Error {
  constructor(mensaje, code = 'MP_ERROR') { super(mensaje); this.code = code; }
}

// Un proveedor de pago no puede quedarse colgado: un fetch sin límite deja la
// petición del cliente esperando para siempre.
async function pedir(ruta, { metodo = 'GET', token, cuerpo = null } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`${BASE()}${ruta}`, {
      method: metodo,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
      signal: ctrl.signal,
    });
    const texto = await r.text();
    let json = null;
    try { json = texto ? JSON.parse(texto) : null; } catch { /* respuesta no JSON */ }
    if (!r.ok) {
      // Nunca se registra el token ni el cuerpo completo: solo el código.
      throw new MercadoPagoError(`Mercado Pago respondió ${r.status}`, 'MP_HTTP_' + r.status);
    }
    return json;
  } catch (e) {
    if (e.name === 'AbortError') throw new MercadoPagoError('Mercado Pago no respondió a tiempo', 'MP_TIMEOUT');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function exigirToken(credenciales) {
  const token = credenciales?.accessToken;
  if (typeof token !== 'string' || !token.trim()) {
    throw new MercadoPagoError('Mercado Pago no está configurado para este negocio', 'MP_NO_CONFIGURADO');
  }
  return token.trim();
}

export async function createPaymentLink({ total, descripcion, cliente, referencia, credenciales, notificationUrl = null }) {
  const token = exigirToken(credenciales);
  // external_reference lleva NUESTRA referencia interna
  // (negocio:folio:versionHash). Es lo que permite resolver el negocio al
  // recibir el webhook sin creerle nada al cuerpo del mensaje.
  const pref = await pedir('/checkout/preferences', {
    metodo: 'POST', token,
    cuerpo: {
      items: [{
        title: String(descripcion || 'Pedido').slice(0, 250),
        quantity: 1,
        unit_price: Number(total),
        currency_id: 'MXN',
      }],
      external_reference: referencia,
      // La notification_url la fija Xabor y lleva el token de ruteo: es lo que
      // permite resolver la integración al recibir el webhook sin creerle nada
      // al cuerpo del mensaje.
      notification_url: notificationUrl || undefined,
      // Nunca se manda más dato del cliente del necesario: nombre y nada más.
      payer: cliente?.nombre ? { name: String(cliente.nombre).slice(0, 100) } : undefined,
    },
  });
  if (!pref?.id || !pref?.init_point) {
    throw new MercadoPagoError('Mercado Pago no devolvió una preferencia utilizable', 'MP_RESPUESTA_INVALIDA');
  }
  // Estado 'pendiente' por definición del vocabulario interno: el estado real
  // lo dicta después el webhook verificado o la re-consulta, nunca este punto.
  // preferenceId explícito: NO es un payment_id y no debe usarse como tal.
  // referenciaExterna se conserva por compatibilidad con el registro existente.
  return {
    referenciaExterna: String(pref.id), preferenceId: String(pref.id),
    url: pref.init_point, estado: 'pendiente',
  };
}

// Traducción del vocabulario de Mercado Pago al interno. Deliberadamente
// explícita: cualquier estado que MP agregue en el futuro cae en
// 'requiere_revision' -- nunca se asume que algo desconocido significa pagado.
const MAPA_ESTADOS = {
  approved: 'pagado',
  authorized: 'pendiente',
  in_process: 'pendiente',
  pending: 'pendiente',
  in_mediation: 'requiere_revision',
  rejected: 'fallido',
  cancelled: 'cancelado',
  refunded: 'reembolsado',
  charged_back: 'requiere_revision',
};
export function traducirEstado(estadoMp) {
  return MAPA_ESTADOS[String(estadoMp || '').toLowerCase()] || 'requiere_revision';
}

export async function getPaymentStatus(referenciaExterna, credenciales) {
  const token = exigirToken(credenciales);
  const pago = await pedir(`/v1/payments/${encodeURIComponent(referenciaExterna)}`, { token });
  if (!pago) return null;
  return normalizarPago(pago);
}

// Forma canónica de un pago de Mercado Pago para el resto de Xabor.
//
// `monto` NO usa `Number(x) || null`: ese patrón convierte un 0 legítimo en
// null, y null es justo el valor que el verificador trata como "no hay dato
// que comparar". Un cobro por 0, o una respuesta incompleta, se colarían sin
// que nadie comparase nada. Aquí se distingue: si el campo no es un número
// finito, se devuelve null a propósito y quien valida lo rechaza; si es un
// número, se devuelve tal cual, incluido el 0.
function normalizarPago(pago) {
  const bruto = pago.transaction_amount;
  const monto = (typeof bruto === 'number' && Number.isFinite(bruto)) ? bruto
    : (typeof bruto === 'string' && bruto.trim() !== '' && Number.isFinite(Number(bruto)) ? Number(bruto) : null);
  const moneda = typeof pago.currency_id === 'string' && pago.currency_id.trim()
    ? pago.currency_id.trim().toUpperCase() : null;
  return {
    estadoProveedor: pago.status,
    estado: traducirEstado(pago.status),
    referenciaInterna: pago.external_reference || null,
    paymentId: pago.id != null ? String(pago.id) : null,
    monto,
    moneda,
  };
}

/**
 * Busca el pago REAL a partir de la referencia que Xabor puso al crear el
 * cobro. Es la vía soportada por Mercado Pago para llegar al payment sin
 * conocer su id -- y la única forma de reconciliar cuando el webhook se
 * perdió. Jamás se consulta /v1/payments/:preferenceId: la preferencia no es
 * un pago.
 *
 * Devuelve el pago aprobado si lo hay; si no, el más reciente, para poder
 * registrar un rechazo o un pendiente sin inventar nada.
 */
export async function buscarPagoPorReferencia(referencia, credenciales) {
  const token = exigirToken(credenciales);
  const r = await pedir(`/v1/payments/search?external_reference=${encodeURIComponent(referencia)}`, { token });
  const resultados = Array.isArray(r?.results) ? r.results : [];
  if (!resultados.length) return null;
  const aprobado = resultados.find(p => String(p.status).toLowerCase() === 'approved');
  return normalizarPago(aprobado || resultados[0]);
}

export async function cancelPayment(referenciaExterna, credenciales) {
  const token = exigirToken(credenciales);
  const pago = await pedir(`/v1/payments/${encodeURIComponent(referenciaExterna)}`, {
    metodo: 'PUT', token, cuerpo: { status: 'cancelled' },
  });
  return { estado: traducirEstado(pago?.status) };
}

/**
 * Verificación de firma del webhook.
 *
 * Mercado Pago firma con la cabecera `x-signature: ts=<epoch>,v1=<hmac>`, donde
 * el HMAC-SHA256 se calcula sobre el manifiesto
 *   id:<data.id>;request-id:<x-request-id>;ts:<ts>;
 * con el secreto que el negocio configura en su panel de MP.
 *
 * Fail closed en todos los caminos: sin secreto configurado, sin cabecera, con
 * formato raro o con HMAC distinto, el webhook NO se considera verificado. El
 * llamador además vuelve a consultar el pago real antes de confirmar nada, así
 * que la firma es la primera barrera, no la única.
 */
export function verifyWebhook(req, credenciales) {
  const secreto = credenciales?.webhookSecret;
  if (typeof secreto !== 'string' || !secreto.trim()) {
    return { verificado: false, motivo: 'sin webhookSecret configurado para este negocio' };
  }
  const cabecera = req?.headers?.['x-signature'];
  if (typeof cabecera !== 'string' || !cabecera) {
    return { verificado: false, motivo: 'falta la cabecera x-signature' };
  }
  const partes = Object.fromEntries(
    cabecera.split(',').map(p => p.split('=').map(x => x && x.trim())).filter(p => p.length === 2));
  const ts = partes.ts;
  const v1 = partes.v1;
  if (!ts || !v1) return { verificado: false, motivo: 'x-signature sin ts/v1' };

  const dataId = req?.query?.['data.id'] || req?.body?.data?.id;
  const requestId = req?.headers?.['x-request-id'] || '';
  if (!dataId) return { verificado: false, motivo: 'sin data.id que firmar' };

  // Especificación de Mercado Pago: el data.id del manifiesto viene del query
  // param y, si es alfanumérico, se normaliza a MINÚSCULAS. Con ids puramente
  // numéricos no cambia nada; con los alfanuméricos, no normalizar hace que
  // toda firma legítima se rechace.
  const idNormalizado = /[a-zA-Z]/.test(String(dataId))
    ? String(dataId).toLowerCase()
    : String(dataId);
  const manifiesto = `id:${idNormalizado};request-id:${requestId};ts:${ts};`;
  const esperado = createHmac('sha256', secreto.trim()).update(manifiesto).digest('hex');

  // Comparación en tiempo constante, y sobre buffers del MISMO tamaño: si las
  // longitudes difieren, timingSafeEqual lanza, así que se descarta antes.
  const a = Buffer.from(esperado, 'utf8');
  const b = Buffer.from(String(v1), 'utf8');
  if (a.length !== b.length) return { verificado: false, motivo: 'firma con longitud inesperada' };
  if (!timingSafeEqual(a, b)) return { verificado: false, motivo: 'firma no coincide' };
  return { verificado: true, dataId: String(dataId) };
}

export async function testConnection(credenciales) {
  // Prueba real que NO mueve dinero: consulta los métodos de pago de la cuenta.
  // Si el token es inválido, Mercado Pago responde 401 y se reporta como tal.
  try {
    const token = exigirToken(credenciales);
    await pedir('/v1/payment_methods', { token });
    return { ok: true, motivo: 'credenciales aceptadas por Mercado Pago' };
  } catch (e) {
    return { ok: false, motivo: e.code === 'MP_NO_CONFIGURADO' ? 'falta accessToken' : `rechazado (${e.code})` };
  }
}

export function getCapabilities() {
  return {
    createLink: true, getStatus: true, cancelLink: true, webhookSignature: true,
    monedas: ['MXN'], sandbox: true,
    // Verificado contra la referencia oficial de Create preference: no hay
    // header de idempotencia documentado para /checkout/preferences.
    idempotenciaCreacion: false,
    // Pero sí se puede preguntar despues si la preferencia llego a existir.
    recuperaCreacionPorReferencia: true,
  };
}

/**
 * ¿Existe ya una preferencia para esta referencia?
 *
 * Es la salida del caso ambiguo: Xabor mando el POST y no supo si llego a
 * crearse. En vez de reintentar a ciegas -- que crearia un segundo checkout
 * cobrable -- se pregunta. La busqueda cubre los ultimos 90 dias, que es de
 * sobra para un checkout cuya respuesta se perdio hace segundos.
 */
export async function buscarCheckoutPorReferencia(referenciaInterna, credenciales) {
  const token = exigirToken(credenciales);
  const r = await pedir(
    `/checkout/preferences/search?external_reference=${encodeURIComponent(referenciaInterna)}`,
    { token });
  const elem = (r?.elements || r?.results || [])[0];
  if (!elem) return null;
  return {
    preferenciaId: elem.id || null,
    url: elem.init_point || elem.sandbox_init_point || null,
    referenciaExterna: elem.id || null,
  };
}

export { MercadoPagoError };
