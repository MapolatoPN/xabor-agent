// Clip — generación de enlaces de pago
// Docs: https://developer.clip.mx/reference/createnewpaymentlink
// Auth: Basic base64(CLIP_API_KEY:CLIP_API_SECRET)
//
// negocioId OBLIGATORIO en todas las funciones (Incidente P0, 2 de agosto
// de 2026): antes, este archivo resolvía las credenciales Clip desde una
// única variable/config GLOBAL (getIntegracion, server.js) -- causa raíz
// confirmada de que un cliente de WhatsApp de Alora recibiera un enlace
// de pago generado con la cuenta Clip real de Nonna Maye. Las credenciales
// ahora se resuelven exclusivamente por negocio (integracionesService.js,
// canal='pagos' proveedor='clip'). Sin negocioId, o sin Clip configurado
// para ESE negocio, estas funciones fallan cerrado -- nunca caen a otra
// cuenta ni a una variable de entorno global.
import { obtenerCredencialesClipDescifradas } from './integracionesService.js';

const CLIP_CHECKOUT_URL = 'https://api.payclip.com/v2/checkout';

// Código de error estable para que los llamadores (whatsapp-meta.js, voice.js)
// distingan "Clip no configurado para este negocio" (transferir a humano,
// conservar el pedido) de un error real de red/Clip (reintentable).
export class ClipNoConfiguradoError extends Error {
  constructor(negocioId) {
    super(`ClipNoConfiguradoError: no hay integración Clip activa para el negocio ${negocioId}`);
    this.code = 'CLIP_NO_CONFIGURADO';
  }
}

async function obtenerAuthHeader(negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    throw new Error('clip-api: negocioId requerido');
  }
  const credenciales = await obtenerCredencialesClipDescifradas(negocioId.trim());
  if (!credenciales) {
    throw new ClipNoConfiguradoError(negocioId.trim());
  }
  const b64 = Buffer.from(`${credenciales.apiKey}:${credenciales.apiSecret}`).toString('base64');
  return `Basic ${b64}`;
}

/**
 * Consulta el estado actual de un link de pago en Clip. Devuelve
 * { resource_status, me_reference_id } o null si falla o no hay
 * integración configurada para ese negocio (no lanza -- uso desde jobs
 * de reconciliación en background, nunca debe tumbar el proceso).
 */
export async function consultarEstadoPago(linkId, negocioId) {
  try {
    const auth = await obtenerAuthHeader(negocioId);
    const resp = await fetch(`https://api.payclip.com/v2/checkout/${linkId}`, {
      headers: { 'Authorization': auth }
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

/**
 * Crea un link de pago en Clip y devuelve la URL lista para enviar al cliente.
 *
 * @param {object} opts
 * @param {string}  opts.negocioId       - Negocio dueño del pedido (obligatorio)
 * @param {string}  opts.pedidoId        - ID del pedido (referencia interna)
 * @param {number}  opts.total           - Monto a cobrar (MXN)
 * @param {string}  [opts.descripcion]   - Texto visible para el cliente en el checkout
 * @param {object}  [opts.cliente]       - { nombre, telefono }
 * @returns {Promise<{ linkId: string, url: string, status: string }>}
 * @throws {ClipNoConfiguradoError} si el negocio no tiene Clip configurado/activo
 */
export async function crearLinkDePago({ negocioId, pedidoId, total, descripcion, cliente = {} }) {
  const auth = await obtenerAuthHeader(negocioId);

  const baseUrl    = process.env.PUBLIC_URL || 'https://xabor.up.railway.app';
  const webhookUrl = `${baseUrl}/webhook/clip`;
  const paginaGracias = `${baseUrl}/pago/gracias`;

  const body = {
    amount: Number(total),
    currency: 'MXN',
    purchase_description: descripcion || 'Pedido Xabor',
    redirection_url: {
      success: paginaGracias,
      error:   paginaGracias,
      default: paginaGracias
    },
    webhook_url: webhookUrl,
    metadata: {
      external_reference: String(pedidoId),
      customer_info: {}
    }
  };

  if (cliente.nombre)   body.metadata.customer_info.name  = cliente.nombre;
  if (cliente.telefono) body.metadata.customer_info.phone = Number(String(cliente.telefono).replace(/\D/g, ''));

  const resp = await fetch(CLIP_CHECKOUT_URL, {
    method:  'POST',
    headers: {
      'Authorization': auth,
      'Content-Type':  'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(`Clip ${resp.status}: ${err.message || JSON.stringify(err)}`);
  }

  const data = await resp.json();
  console.log(`[Clip] Link creado para pedido ${pedidoId} (negocio ${negocioId}): ${data.payment_request_url}`);

  return {
    linkId: data.payment_request_id,
    url:    data.payment_request_url,
    status: data.status
  };
}
