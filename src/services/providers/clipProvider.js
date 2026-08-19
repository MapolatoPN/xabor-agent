/**
 * clipProvider.js — Adaptador Clip para la interfaz común de proveedores
 * de pago. Envuelve el clip-api.js ya existente (Incidente P0: resuelto
 * por negocio, nunca una cuenta global) sin duplicar su lógica.
 */
import { crearLinkDePago, consultarEstadoPago, ClipNoConfiguradoError, ExpiracionInvalidaError } from '../clip-api.js';

export async function createPaymentLink({ negocioId, pedidoId, total, descripcion, cliente, referencia, expiresAt = null }) {
  const r = await crearLinkDePago({ negocioId, pedidoId, total, descripcion, cliente, referenciaExterna: referencia, expiresAt });
  // Causa raíz del incidente "el bot no envió el enlace": aquí se devolvía
  // r.status CRUDO de Clip ('CHECKOUT'), que pagosService escribía tal
  // cual en pagos.estado y violaba su CHECK -- el enlace se creaba en
  // Clip pero el registro explotaba y la URL jamás llegaba al cliente.
  // Un link recién creado es, por definición del vocabulario interno,
  // 'pendiente'; el estado del proveedor se reconcilia después por
  // getPaymentStatus/webhook, nunca guardándolo crudo aquí.

  // Expiración (CLIP expires_at): comparar lo solicitado contra lo que el
  // proveedor DEVOLVIÓ como efectivo (`expired_at`, documentado en la
  // respuesta de creación). Si divergen de forma significativa (>60s -- Clip
  // trunca a segundos, jamás a minutos), NO se ignora en silencio: queda en
  // metadata sanitizada para que Xabor conozca la frontera EFECTIVA del
  // enlace. La política de autorización no cambia aquí: xabor_espera_hasta ya
  // quedó durable ANTES del POST y NUNCA se amplía por lo que el proveedor
  // conteste -- Xabor sigue siendo la autorización de cocina.
  const solicitadaMs = r.expiracionSolicitada ? Date.parse(r.expiracionSolicitada) : null;
  const proveedorMs = r.expiracionProveedor ? Date.parse(r.expiracionProveedor) : null;
  const divergencia = (solicitadaMs != null && proveedorMs != null)
    ? Math.abs(proveedorMs - solicitadaMs) : null;
  const expiracionMeta = {};
  if (r.expiracionSolicitada) expiracionMeta.requested_expires_at = r.expiracionSolicitada;
  if (r.expiracionProveedor) expiracionMeta.provider_expires_at = r.expiracionProveedor;
  if (r.expiracionAjustadaPorLimite) expiracionMeta.expiracion_ajustada_por_limite_cdmx = true;
  if (r.expiracionOmitida) expiracionMeta.expiracion_omitida = r.expiracionOmitida;
  if (divergencia != null && divergencia > 60 * 1000) {
    expiracionMeta.expiracion_divergente = true;
    expiracionMeta.expiracion_divergencia_segundos = Math.round(divergencia / 1000);
    console.warn(`[Clip] El proveedor devolvió una expiración distinta a la solicitada para ${pedidoId}: pedida ${r.expiracionSolicitada}, efectiva ${r.expiracionProveedor} -- la frontera local de Xabor NO se mueve`);
  }

  return {
    referenciaExterna: r.linkId, url: r.url, estado: 'pendiente',
    // La expiración EFECTIVA declarada por el proveedor (para pagos.expires_at)
    // y el rastro sanitizado (sin secretos) para metadata_sanitizada.
    expiresAtProveedor: r.expiracionProveedor || null,
    expiracionMeta: Object.keys(expiracionMeta).length ? expiracionMeta : null,
  };
}

/**
 * Normaliza la respuesta de GET /v2/checkout/{payment_request_id}.
 *
 * VERIFICADO CONTRA LA DOCUMENTACION OFICIAL (Check payment link status v2).
 * Esa respuesta trae:
 *   payment_request_id · status · amount · currency · metadata.external_reference
 *   · payment_request_url · expired_at · receipt_no · object_type
 *
 * Y NO trae `resource_status` ni `me_reference_id`: esos dos son campos del
 * WEBHOOK, que es otro contrato. El codigo anterior leia los del webhook sobre
 * la respuesta de la reconsulta, asi que la comparacion
 * `resource_status === 'COMPLETED'` era SIEMPRE falsa: ningun cobro de Clip
 * llegaba a asentarse. Fail-closed, pero perdiendo dinero real.
 *
 * Los valores documentados de `status` son CHECKOUT_CREATED, CHECKOUT_PENDING,
 * CHECKOUT_CANCELLED, CHECKOUT_EXPIRED y CHECKOUT_COMPLETED.
 */
export function normalizarConsultaCheckout(r) {
  if (!r) return null;
  const bruto = String(r.status || '').toUpperCase();
  const estado =
    bruto === 'CHECKOUT_COMPLETED' ? 'pagado'
    : bruto === 'CHECKOUT_CANCELLED' ? 'cancelado'
    : bruto === 'CHECKOUT_EXPIRED' ? 'vencido'
    : (bruto === 'CHECKOUT_CREATED' || bruto === 'CHECKOUT_PENDING') ? 'pendiente'
    : 'desconocido';
  const monto = typeof r.amount === 'number' && Number.isFinite(r.amount) ? r.amount : null;
  return {
    estadoProveedor: bruto || null,
    estado,
    pagado: estado === 'pagado',
    // La referencia que Xabor mando al crear el checkout. Es lo unico que ata
    // este checkout a una fila nuestra, y por eso se verifica siempre.
    referenciaInterna: r.metadata?.external_reference || null,
    checkoutId: r.payment_request_id || null,
    url: r.payment_request_url || null,
    monto, moneda: r.currency || null,
    expiraAt: r.expired_at || null,
    reciboNo: r.receipt_no || null,
  };
}

export async function getPaymentStatus(referenciaExterna, negocioId) {
  return normalizarConsultaCheckout(await consultarEstadoPago(referenciaExterna, negocioId));
}

/**
 * Recupera un checkout por SU id, con las credenciales del negocio dueño.
 *
 * Es la salida del caso ambiguo: Xabor mando el POST, se perdio la respuesta y
 * nunca supo el payment_request_id... hasta que el cliente paga y el WEBHOOK de
 * Clip lo trae. Ese id del webhook es solo un CANDIDATO -- el webhook no viene
 * firmado --, asi que aqui se va a la API con las credenciales del negocio y el
 * llamador verifica que el external_reference devuelto sea el de SU fila.
 */
export async function recuperarCheckoutPorId(checkoutId, negocioId) {
  return normalizarConsultaCheckout(await consultarEstadoPago(checkoutId, negocioId));
}

export async function cancelPayment() {
  // Clip no expone cancelación de un checkout ya creado en su API pública
  // -- documentado explícitamente en vez de fingir soporte.
  throw new Error('clipProvider.cancelPayment: no soportado por la API de Clip');
}

/**
 * Verificación de webhook: Clip no firma sus webhooks con un secreto
 * compartido en su API pública (a diferencia de Stripe/Mercado Pago) --
 * la mitigación real aquí es NO confiar en el payload por sí solo: el
 * llamador (server.js) siempre re-consulta el estado real vía
 * getPaymentStatus antes de marcar como pagado (ver pagosService.js).
 * Se documenta como riesgo residual, no se finge una firma que Clip no
 * ofrece.
 */
export function verifyWebhook() {
  return { verificado: false, motivo: 'Clip no ofrece firma de webhook en su API pública -- se reconcilia por consulta activa' };
}

export async function testConnection(credenciales) {
  // Prueba mínima real: Clip no tiene un endpoint "ping" público
  // documentado; una prueba de conexión real requeriría crear y cancelar
  // un cargo de prueba, lo cual el encargo prohíbe explícitamente
  // (no crear cobros reales). Se valida solo la FORMA de las credenciales
  // aquí; la validación funcional ocurre en el primer enlace real.
  if (!credenciales?.apiKey || !credenciales?.apiSecret) {
    return { ok: false, motivo: 'faltan apiKey/apiSecret' };
  }
  return { ok: true, motivo: 'formato válido (no se realizó cargo de prueba real)' };
}

export function getCapabilities() {
  return {
    createLink: true, getStatus: true, cancelLink: false, webhookSignature: false,
    monedas: ['MXN'], sandbox: false,
    // La documentacion publica del Checkout redirigido de Clip no expone ningun
    // header de idempotencia, ni una busqueda de checkouts por referencia: solo
    // consultar un link por SU id, que es justo lo que no se tiene cuando la
    // respuesta se perdio. Sin ninguno de los dos mecanismos, un resultado
    // ambiguo no se puede resolver por API: queda en revision y nadie manda
    // otro POST por su cuenta.
    idempotenciaCreacion: false,
    recuperaCreacionPorReferencia: false,
    // Pero el WEBHOOK de Checkout de Clip si trae `payment_request_id`
    // (documentado). Eso permite recuperar una creacion ambigua cuando el
    // cliente termina pagando: el id llega por el webhook, se reconsulta con
    // las credenciales del negocio y se verifica el external_reference. Es
    // recuperacion por AVISO, no por busqueda: si nadie paga, la ambiguedad
    // sigue sin resolverse por API y queda para revision manual.
    recuperaCreacionPorAvisoDeWebhook: true,
    // La API publica no expone cancelacion de un checkout ya creado: "vencido
    // en Xabor" nunca significa "imposible de pagar en Clip".
    cancelacionReal: false,
    // La reconsulta si devuelve expired_at, asi que la expiracion del checkout
    // es conocida DESPUES de consultarlo.
    expiracionConocida: true,
    // CLIP expires_at: la creacion acepta una expiracion explicita
    // (documentada: "YYYY-MM-DDTHH-MM-SSZ", > creacion + 1 min, <= fin del
    // dia CDMX). pagosService la deriva de xabor_espera_hasta -- calculada
    // UNA vez y persistida ANTES del POST, nunca un segundo reloj.
    expiracionEnCreacion: true,
  };
}

export { ClipNoConfiguradoError, ExpiracionInvalidaError };
