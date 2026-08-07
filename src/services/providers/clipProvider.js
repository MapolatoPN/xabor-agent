/**
 * clipProvider.js — Adaptador Clip para la interfaz común de proveedores
 * de pago. Envuelve el clip-api.js ya existente (Incidente P0: resuelto
 * por negocio, nunca una cuenta global) sin duplicar su lógica.
 */
import { crearLinkDePago, consultarEstadoPago, ClipNoConfiguradoError } from '../clip-api.js';

export async function createPaymentLink({ negocioId, pedidoId, total, descripcion, cliente, referencia }) {
  const r = await crearLinkDePago({ negocioId, pedidoId, total, descripcion, cliente, referenciaExterna: referencia });
  // Causa raíz del incidente "el bot no envió el enlace": aquí se devolvía
  // r.status CRUDO de Clip ('CHECKOUT'), que pagosService escribía tal
  // cual en pagos.estado y violaba su CHECK -- el enlace se creaba en
  // Clip pero el registro explotaba y la URL jamás llegaba al cliente.
  // Un link recién creado es, por definición del vocabulario interno,
  // 'pendiente'; el estado del proveedor se reconcilia después por
  // getPaymentStatus/webhook, nunca guardándolo crudo aquí.
  return { referenciaExterna: r.linkId, url: r.url, estado: 'pendiente' };
}

export async function getPaymentStatus(referenciaExterna, negocioId) {
  const r = await consultarEstadoPago(referenciaExterna, negocioId);
  if (!r) return null;
  return { estadoProveedor: r.resource_status, referenciaInterna: r.me_reference_id };
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
  };
}

export { ClipNoConfiguradoError };
