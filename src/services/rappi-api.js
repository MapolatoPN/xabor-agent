/**
 * Cliente Rappi API v2
 * Sandbox: microservices.dev.rappi.com
 * Producción: microservices.rappi.com
 *
 * Flujo de orden:
 *   Rappi → NEW_ORDER webhook → nosotros → PUT /orders/{id}/take → listo
 */

const BASE_URL  = process.env.RAPPI_BASE_URL  || 'https://microservices.dev.rappi.com';
const AUDIENCE  = process.env.RAPPI_AUDIENCE  || 'https://int-public-api-v2/api';
const CLIENT_ID = process.env.RAPPI_CLIENT_ID;
const CLIENT_SECRET = process.env.RAPPI_CLIENT_SECRET;
const STORE_ID  = process.env.RAPPI_STORE_ID  || '900172582';

const API_BASE = `${BASE_URL}/api/v2/restaurants-integrations-public-api`;

// ─── Token cache ─────────────────────────────────────────────────────────────
let _token = null;
let _tokenExpires = 0;

export async function obtenerToken() {
  if (_token && Date.now() < _tokenExpires - 60_000) return _token;

  const resp = await fetch(`${API_BASE}/auth/${encodeURIComponent(AUDIENCE)}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'client_credentials',
      audience: AUDIENCE
    })
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`[Rappi Auth] ${resp.status}: ${err}`);
  }

  const data = await resp.json();
  _token = data.access_token;
  // expires_in viene en segundos, por defecto 1 hora
  _tokenExpires = Date.now() + (data.expires_in || 3600) * 1000;
  console.log('[Rappi] Token obtenido, expira en', data.expires_in, 'seg');
  return _token;
}

async function rappiRequest(method, path, body = null) {
  const token = await obtenerToken();
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  };
  if (body) opts.body = JSON.stringify(body);

  const resp = await fetch(`${API_BASE}${path}`, opts);
  const text = await resp.text();

  if (!resp.ok) {
    throw new Error(`[Rappi] ${method} ${path} → ${resp.status}: ${text}`);
  }

  try { return JSON.parse(text); } catch { return text; }
}

// ─── Órdenes ─────────────────────────────────────────────────────────────────

/**
 * Tomar una orden (SENT → TAKEN)
 * cookingTime: minutos estimados de preparación (default 20)
 */
export async function tomarOrden(orderId, cookingTime = 20) {
  return rappiRequest('PUT', `/orders/${orderId}/take/${cookingTime}`);
}

/**
 * Rechazar una orden (SENT → REJECTED)
 * motivo: string explicando la razón
 * itemsSku: array de SKUs a desactivar (opcional)
 */
export async function rechazarOrden(orderId, motivo = 'Producto no disponible', itemsSku = []) {
  const body = { reason: motivo };
  if (itemsSku.length > 0) body.items_sku = itemsSku;
  return rappiRequest('PUT', `/orders/${orderId}/reject`, body);
}

/**
 * Notificar que la orden está lista para recoger (si se configuró como Manual)
 */
export async function ordenListaParaRecoger(orderId) {
  return rappiRequest('POST', `/orders/${orderId}/ready-for-pickup`);
}

/**
 * Obtener órdenes nuevas (status READY) — solo si no se usa webhook
 */
export async function obtenerOrdenesNuevas() {
  return rappiRequest('GET', `/orders?storeId=${STORE_ID}`);
}

// ─── Disponibilidad de productos ─────────────────────────────────────────────

/**
 * Activar o desactivar productos por SKU
 * turnOn: array de SKUs a activar
 * turnOff: array de SKUs a desactivar
 */
export async function actualizarDisponibilidad(turnOn = [], turnOff = []) {
  const body = [
    {
      store_integration_id: STORE_ID,
      items: {}
    }
  ];
  if (turnOn.length > 0)  body[0].items.turn_on  = turnOn.map(String);
  if (turnOff.length > 0) body[0].items.turn_off = turnOff.map(String);

  return rappiRequest('PUT', '/availability/stores/items', body);
}

/**
 * Consultar disponibilidad de productos por SKU
 */
export async function consultarDisponibilidad(skus) {
  return rappiRequest('POST', '/availability/items/status', {
    store_id: STORE_ID,
    item_ids: skus.map(String)
  });
}

/**
 * Activar / desactivar la tienda completa
 */
export async function actualizarEstadoTienda(activa) {
  return rappiRequest('PUT', '/availability/stores/enable', {
    stores: [{ store_id: STORE_ID, is_enabled: activa }]
  });
}

// ─── Registro de webhooks ─────────────────────────────────────────────────────

/**
 * Registrar o actualizar la URL del webhook para un evento
 * event: 'NEW_ORDER' | 'ORDER_EVENT_CANCEL' | 'PING'
 */
export async function registrarWebhook(event, url) {
  // Primero intentar actualizar, si falla crear
  try {
    return await rappiRequest('PUT', `/webhook/${event}/change-url`, { url });
  } catch {
    return rappiRequest('POST', '/webhook', {
      event,
      url,
      store_ids: [STORE_ID]
    });
  }
}

/**
 * Registrar todos los webhooks necesarios para Sprint 1
 * baseUrl: URL pública del servidor (ej. https://xabor.up.railway.app)
 */
export async function configurarWebhooks(baseUrl) {
  const results = {};
  for (const event of ['NEW_ORDER', 'ORDER_EVENT_CANCEL', 'PING']) {
    try {
      const url = `${baseUrl}/webhook/rappi`;
      results[event] = await registrarWebhook(event, url);
      console.log(`[Rappi] Webhook ${event} → ${url}`);
    } catch (e) {
      results[event] = { error: e.message };
      console.error(`[Rappi] Error registrando ${event}:`, e.message);
    }
  }
  return results;
}
