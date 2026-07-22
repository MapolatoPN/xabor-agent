import { getIntegracion } from '../server.js';
// Clip — generación de enlaces de pago
// Docs: https://developer.clip.mx/reference/createnewpaymentlink
// Auth: Basic base64(CLIP_API_KEY:CLIP_API_SECRET)

const CLIP_CHECKOUT_URL = 'https://api.payclip.com/v2/checkout';

function getAuthHeader() {
  const apiKey  = getIntegracion('clip_api_key')  || process.env.CLIP_API_KEY;
  const secret  = getIntegracion('clip_api_secret') || process.env.CLIP_API_SECRET;
  if (!apiKey || !secret) {
    throw new Error('Faltan variables CLIP_API_KEY o CLIP_API_SECRET');
  }
  const b64 = Buffer.from(`${apiKey}:${secret}`).toString('base64');
  return `Basic ${b64}`;
}

/**
 * Crea un link de pago en Clip y devuelve la URL lista para enviar al cliente.
 *
 * @param {object} opts
 * @param {string}  opts.pedidoId        - ID del pedido (referencia interna)
 * @param {number}  opts.total           - Monto a cobrar (MXN)
 * @param {string}  [opts.descripcion]   - Texto visible para el cliente en el checkout
 * @param {object}  [opts.cliente]       - { nombre, telefono }
 * @returns {Promise<{ linkId: string, url: string, status: string }>}
 */
/**
 * Consulta el estado actual de un link de pago en Clip.
 * Devuelve { resource_status, me_reference_id } o null si falla.
 */
export async function consultarEstadoPago(linkId) {
  try {
    const resp = await fetch(`https://api.payclip.com/v2/checkout/${linkId}`, {
      headers: { 'Authorization': getAuthHeader() }
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

export async function crearLinkDePago({ pedidoId, total, descripcion, cliente = {} }) {
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
      'Authorization': getAuthHeader(),
      'Content-Type':  'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(`Clip ${resp.status}: ${err.message || JSON.stringify(err)}`);
  }

  const data = await resp.json();
  console.log(`[Clip] Link creado para pedido ${pedidoId}: ${data.payment_request_url}`);

  return {
    linkId: data.payment_request_id,
    url:    data.payment_request_url,
    status: data.status
  };
}
