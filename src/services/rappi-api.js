/**
 * Cliente Rappi API v2
 * Sandbox: microservices.dev.rappi.com
 * Producción: microservices.rappi.com
 *
 * Flujo de orden:
 *   Rappi → NEW_ORDER webhook → nosotros → PUT /orders/{id}/take → listo
 */

const BASE_URL  = process.env.RAPPI_BASE_URL  || 'https://microservices.dev.rappi.com';
const AUTH_URL  = process.env.RAPPI_AUTH_URL  || 'https://rests-integrations-dev.auth0.com/oauth/token';
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

  const resp = await fetch(AUTH_URL, {
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

// ─── Catálogo / Menú ──────────────────────────────────────────────────────────

/**
 * Sube o reemplaza el catálogo completo de la tienda en Rappi.
 * Endpoint: PUT /menus  (Rappi Integration API v2)
 * Docs: https://dev.rappi.com/docs/restaurants-menu-integration
 */
export async function subirCatalogo(catalogoRappi) {
  return rappiRequest('PUT', '/menus', catalogoRappi);
}

/**
 * Construye el payload del catálogo en formato Rappi a partir de menu.json
 */
export function construirCatalogoRappi() {
  return {
    store_integration_id: STORE_ID,
    categories: [
      // ── Paninis ─────────────────────────────────────────────────────────
      {
        integration_id: 'cat-paninis',
        name: 'Paninis',
        sorting_position: 1,
        items: [
          {
            integration_id: 'PAN001',
            name: 'Chicken Louisiana',
            description: 'Pechuga de pollo al horno bañada en salsa Louisiana, acompañada de cebolla morada y pimientos rostizados, queso manchego y aderezo Ranch.',
            price: 180,
            available: true,
            modifiers_groups: []
          },
          {
            integration_id: 'PAN002',
            name: 'Chicken Parm',
            description: 'Pechuga de pollo al horno y empanizada con queso parmesano, salsa de tomate, queso mozzarella y mezcla de lechugas.',
            price: 189,
            available: true,
            modifiers_groups: []
          },
          {
            integration_id: 'PAN003',
            name: 'Chicken Fit',
            description: 'Pechuga de pollo a la plancha, tomate, pepino, lechuga, mayonesa chipotle y queso feta.',
            price: 179,
            available: true,
            modifiers_groups: []
          }
        ]
      },

      // ── Focaccia Bar ─────────────────────────────────────────────────────
      {
        integration_id: 'cat-focaccia',
        name: 'Focaccia Bar',
        sorting_position: 2,
        items: [
          {
            integration_id: 'FOC001',
            name: 'Focaccia Bar',
            description: 'Focaccia personalizada. Elige hasta 2 spreads, 1 proteína, 1 queso, toppings a gusto y hasta 4 aderezos.',
            price: 225,
            available: true,
            modifiers_groups: [
              {
                integration_id: 'fg-spread',
                name: 'Spread (elige hasta 2)',
                min_quantity: 0,
                max_quantity: 2,
                modifiers: [
                  { integration_id: 'spread-pesto',   name: 'Pesto',                        price: 0 },
                  { integration_id: 'spread-phila',   name: 'Philadelphia y parmesano',     price: 0 },
                  { integration_id: 'spread-tomate',  name: 'Pasta de tomate deshidratado', price: 0 }
                ]
              },
              {
                integration_id: 'fg-proteina',
                name: 'Proteína (elige 1)',
                min_quantity: 1,
                max_quantity: 1,
                modifiers: [
                  { integration_id: 'prot-salami',  name: 'Salami',           price: 0 },
                  { integration_id: 'prot-peperoni',name: 'Peperoni',         price: 0 },
                  { integration_id: 'prot-pavo',    name: 'Pechuga de pavo',  price: 0 }
                ]
              },
              {
                integration_id: 'fg-queso',
                name: 'Queso (elige 1)',
                min_quantity: 1,
                max_quantity: 1,
                modifiers: [
                  { integration_id: 'q-manchego',  name: 'Manchego',              price: 0 },
                  { integration_id: 'q-mozza',     name: 'Mozzarella',            price: 0 },
                  { integration_id: 'q-colby',     name: 'Monterrey Jack Colby',  price: 0 },
                  { integration_id: 'q-feta',      name: 'Feta',                  price: 0 }
                ]
              },
              {
                integration_id: 'fg-toppings',
                name: 'Toppings',
                min_quantity: 0,
                max_quantity: 10,
                modifiers: [
                  { integration_id: 'top-lechuga',    name: 'Lechuga',                  price: 0 },
                  { integration_id: 'top-espinacas',  name: 'Espinacas',               price: 0 },
                  { integration_id: 'top-tomate',     name: 'Tomate',                  price: 0 },
                  { integration_id: 'top-pepino',     name: 'Pepino',                  price: 0 },
                  { integration_id: 'top-cebolla',    name: 'Cebolla morada',          price: 0 },
                  { integration_id: 'top-aceitunas',  name: 'Aceitunas negras',        price: 0 },
                  { integration_id: 'top-pepinillos', name: 'Pepinillos',              price: 0 },
                  { integration_id: 'top-jalapenos',  name: 'Jalapeños',               price: 0 },
                  { integration_id: 'top-pimientos',  name: 'Pimientos rostizados',    price: 0 },
                  { integration_id: 'top-champi',     name: 'Champiñones rostizados',  price: 0 }
                ]
              },
              {
                integration_id: 'fg-aderezo',
                name: 'Aderezo (hasta 4)',
                min_quantity: 0,
                max_quantity: 4,
                modifiers: [
                  { integration_id: 'ad-aceite',    name: 'Aceite de oliva',       price: 0 },
                  { integration_id: 'ad-chipotle',  name: 'Mayo chipotle',         price: 0 },
                  { integration_id: 'ad-ranch',     name: 'Aderezo Ranch',         price: 0 },
                  { integration_id: 'ad-glassado',  name: 'Glassado balsámico',    price: 0 },
                  { integration_id: 'ad-vinagreta', name: 'Vinagreta balsámica',   price: 0 },
                  { integration_id: 'ad-italiano',  name: 'Aderezo italiano',      price: 0 }
                ]
              }
            ]
          }
        ]
      },

      // ── Ensaladas ────────────────────────────────────────────────────────
      {
        integration_id: 'cat-ensaladas',
        name: 'Ensaladas',
        sorting_position: 3,
        items: [
          {
            integration_id: 'ENS001',
            name: 'Ensalada César',
            description: 'Lechuga, queso parmesano, queso feta, aderezo césar, crotones hechos en casa y pechuga de pollo.',
            price: 189,
            available: true,
            modifiers_groups: []
          },
          {
            integration_id: 'ENS002',
            name: 'Ensalada Clásica',
            description: 'Mezcla de lechuga, zanahoria, tomate, col morada, queso Monterrey Jack Colby, pechuga de pollo a la plancha, bañada en salsa Louisiana y crotones hechos en casa.',
            price: 180,
            available: true,
            modifiers_groups: []
          },
          {
            integration_id: 'ENS003',
            name: 'Ensalada del Bosque',
            description: 'Mezcla de lechuga y espinacas, manzana, blueberries, fresas, queso feta y nueces. Acompañada de pechuga de pollo al horno.',
            price: 185,
            available: true,
            modifiers_groups: []
          },
          {
            integration_id: 'ENS004',
            name: 'Combo Focaccia + Media Ensalada',
            description: 'Una Focaccia completa más media ensalada sin pollo de tu elección (César, Clásica o del Bosque).',
            price: 250,
            available: true,
            modifiers_groups: [
              {
                integration_id: 'combo-ensalada',
                name: 'Elige tu media ensalada',
                min_quantity: 1,
                max_quantity: 1,
                modifiers: [
                  { integration_id: 'combo-cesar',   name: 'Media Ensalada César',        price: 0 },
                  { integration_id: 'combo-clasica', name: 'Media Ensalada Clásica',      price: 0 },
                  { integration_id: 'combo-bosque',  name: 'Media Ensalada del Bosque',   price: 0 }
                ]
              }
            ]
          }
        ]
      },

      // ── Bebidas ──────────────────────────────────────────────────────────
      {
        integration_id: 'cat-bebidas',
        name: 'Bebidas',
        sorting_position: 4,
        items: [
          {
            integration_id: 'BEB001',
            name: 'Refresco',
            description: 'Refresco de lata.',
            price: 35,
            available: true,
            modifiers_groups: [
              {
                integration_id: 'beb-refresco-opciones',
                name: 'Elige tu refresco',
                min_quantity: 1,
                max_quantity: 1,
                modifiers: [
                  { integration_id: 'ref-regular', name: 'Coca Cola regular',     price: 0 },
                  { integration_id: 'ref-light',   name: 'Coca Cola sin azúcar',  price: 0 }
                ]
              }
            ]
          },
          {
            integration_id: 'BEB002',
            name: 'Botella de agua',
            description: 'Agua embotellada.',
            price: 25,
            available: true,
            modifiers_groups: []
          },
          {
            integration_id: 'BEB003',
            name: 'Aguas frescas',
            description: 'Aguas frescas del día.',
            price: 55,
            available: true,
            modifiers_groups: [
              {
                integration_id: 'agua-opciones',
                name: 'Elige tu sabor',
                min_quantity: 1,
                max_quantity: 1,
                modifiers: [
                  { integration_id: 'agua-betabel', name: 'Betabel con guayaba', price: 0 },
                  { integration_id: 'agua-mango',   name: 'Mango con piña',      price: 0 },
                  { integration_id: 'agua-horchata',name: 'Horchata',            price: 0 }
                ]
              }
            ]
          },
          {
            integration_id: 'BEB004',
            name: 'Poppi',
            description: 'Refresco probiótico Poppi.',
            price: 79,
            available: true,
            modifiers_groups: [
              {
                integration_id: 'poppi-opciones',
                name: 'Elige tu sabor',
                min_quantity: 1,
                max_quantity: 1,
                modifiers: [
                  { integration_id: 'poppi-uva',    name: 'Uva',     price: 0 },
                  { integration_id: 'poppi-naranja', name: 'Naranja', price: 0 }
                ]
              }
            ]
          },
          {
            integration_id: 'BEB005',
            name: 'Olipop',
            description: 'Refresco de fibra prebiótica Olipop.',
            price: 79,
            available: true,
            modifiers_groups: [
              {
                integration_id: 'olipop-opciones',
                name: 'Elige tu sabor',
                min_quantity: 1,
                max_quantity: 1,
                modifiers: [
                  { integration_id: 'olipop-manzana',  name: 'Manzana',        price: 0 },
                  { integration_id: 'olipop-fresa',    name: 'Strawberry Cream', price: 0 }
                ]
              }
            ]
          }
        ]
      }
    ]
  };
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
