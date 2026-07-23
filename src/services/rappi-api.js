/**
 * Cliente Rappi API v2
 * Sandbox: microservices.dev.rappi.com
 * Producción: microservices.rappi.com
 *
 * Flujo de orden:
 *   Rappi → NEW_ORDER webhook → nosotros → PUT /orders/{id}/take → listo
 */

const BASE_URL  = process.env.RAPPI_BASE_URL  || 'https://api.rappi.com.mx';
const AUTH_URL  = process.env.RAPPI_AUTH_URL  || 'https://api.rappi.com.mx/restaurants/auth/v1/token/login/integrations';
const CLIENT_ID = process.env.RAPPI_CLIENT_ID;
const CLIENT_SECRET = process.env.RAPPI_CLIENT_SECRET;
const STORE_ID  = process.env.RAPPI_STORE_ID  || '900172582';

const API_BASE = `${BASE_URL}/api/v2/restaurants-integrations-public-api`;

// ─── Token cache ─────────────────────────────────────────────────────────────
let _token = null;
let _tokenExpires = 0;

export async function obtenerToken() {
  if (_token && Date.now() < _tokenExpires - 60_000) return _token;

  console.log(`[Rappi Auth] POST ${AUTH_URL} | client_id: ${CLIENT_ID}`);
  const resp = await fetch(AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET
    })
  });

  const authText = await resp.text();
  console.log(`[Rappi Auth] HTTP ${resp.status}:`, authText.slice(0, 200));

  if (!resp.ok) {
    throw new Error(`[Rappi Auth] ${resp.status}: ${authText}`);
  }

  const data = JSON.parse(authText);
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
      'x-authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  };
  if (body) opts.body = JSON.stringify(body);

  const fullUrl = `${API_BASE}${path}`;
  console.log(`[Rappi] ${method} ${fullUrl}`);
  const resp = await fetch(fullUrl, opts);
  const text = await resp.text();
  console.log(`[Rappi] HTTP ${resp.status}:`, text.slice(0, 300));

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
// Schema aprobado por Rappi: estructura plana con items/children + camelCase

/**
 * Sube o reemplaza el catálogo completo de la tienda en Rappi.
 * Endpoint nuevo: PUT /restaurants/menu/v1/stores/{storeId}/store-menu
 */
export async function subirCatalogo(catalogoRappi) {
  const token = await obtenerToken();
  const menuUrl = `${BASE_URL}/restaurants/menu/v1/stores/${STORE_ID}/store-menu`;
  console.log(`[Rappi Menu] PUT ${menuUrl}`);
  const resp = await fetch(menuUrl, {
    method: 'PUT',
    headers: {
      'x-authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(catalogoRappi)
  });
  const text = await resp.text();
  console.log(`[Rappi Menu] HTTP ${resp.status}:`, text.slice(0, 300));
  if (!resp.ok) throw new Error(`[Rappi] PUT /menus → ${resp.status}: ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}

/**
 * Sube el catálogo completo (alias para re-subir desde el panel).
 */
export async function actualizarSchedule() {
  return subirCatalogo(construirCatalogoRappi());
}

// Helper para crear un topping con todos los campos requeridos
function topping({ sku, name, description, categoryId, categoryName, categoryMinQty, categoryMaxQty, categorySortPos, sortingPosition, price = 0, maxLimit = 1 }) {
  return {
    sku,
    name,
    type: 'TOPPING',
    price,
    category: {
      id: categoryId,
      name: categoryName,
      maxQty: categoryMaxQty,
      minQty: categoryMinQty,
      sortingPosition: categorySortPos
    },
    children: [],
    imageUrl: '',
    maxLimit,
    description,
    sortingPosition
  };
}

export function construirCatalogoRappi() {
  return {
    storeId: STORE_ID,
    items: [

      // ── Paninis ───────────────────────────────────────────────────────────
      {
        sku: 'PAN001', name: 'Chicken Louisiana', type: 'PRODUCT', price: 259,
        category: { id: 'cat-paninis', name: 'Paninis', maxQty: 0, minQty: 0, sortingPosition: 1 },
        children: [], imageUrl: '', maxLimit: 0, sortingPosition: 1,
        description: 'Pechuga de pollo al horno bañada en salsa Louisiana, con cebolla morada, pimientos rostizados, queso manchego y aderezo Ranch.'
      },
      {
        sku: 'PAN002', name: 'Chicken Parm', type: 'PRODUCT', price: 270,
        category: { id: 'cat-paninis', name: 'Paninis', maxQty: 0, minQty: 0, sortingPosition: 1 },
        children: [], imageUrl: '', maxLimit: 0, sortingPosition: 2,
        description: 'Pechuga de pollo a la plancha, spread de Philadelphia con queso parmesano, salsa de tomate, queso mozzarella y mezcla de lechugas.'
      },
      {
        sku: 'PAN003', name: 'Chicken Fit', type: 'PRODUCT', price: 256,
        category: { id: 'cat-paninis', name: 'Paninis', maxQty: 0, minQty: 0, sortingPosition: 1 },
        children: [], imageUrl: '', maxLimit: 0, sortingPosition: 3,
        description: 'Pechuga de pollo a la plancha, tomate, pepino, lechuga, mayonesa chipotle y queso feta.'
      },

      // ── Focaccia Bar ──────────────────────────────────────────────────────
      {
        sku: 'FOC001', name: 'Focaccia Bar', type: 'PRODUCT', price: 322,
        category: { id: 'cat-focaccia', name: 'Focaccia Bar', maxQty: 0, minQty: 0, sortingPosition: 2 },
        imageUrl: '', maxLimit: 0, sortingPosition: 1,
        description: 'Focaccia personalizada. Elige spread, proteína, queso, toppings y aderezo.',
        children: [
          // Spreads
          topping({ sku: 'spread-pesto',   name: 'Pesto',                        description: 'Spread de pesto.',                                  categoryId: 'foc-spreads',   categoryName: 'Elige tu spread',   categoryMinQty: 1, categoryMaxQty: 1, categorySortPos: 1, sortingPosition: 1 }),
          topping({ sku: 'spread-phila',   name: 'Philadelphia y parmesano',     description: 'Spread de queso Philadelphia con queso parmesano.', categoryId: 'foc-spreads',   categoryName: 'Elige tu spread',   categoryMinQty: 1, categoryMaxQty: 1, categorySortPos: 1, sortingPosition: 2 }),
          topping({ sku: 'spread-tomate',  name: 'Pasta de tomate deshidratado', description: 'Spread elaborado con tomate deshidratado.',         categoryId: 'foc-spreads',   categoryName: 'Elige tu spread',   categoryMinQty: 1, categoryMaxQty: 1, categorySortPos: 1, sortingPosition: 3 }),
          // Proteínas
          topping({ sku: 'prot-salami',   name: 'Salami',          description: 'Porción de salami.',                   categoryId: 'foc-proteinas', categoryName: 'Elige tu proteína', categoryMinQty: 1, categoryMaxQty: 1, categorySortPos: 2, sortingPosition: 1 }),
          topping({ sku: 'prot-peperoni', name: 'Peperoni',        description: 'Porción de peperoni.',                 categoryId: 'foc-proteinas', categoryName: 'Elige tu proteína', categoryMinQty: 1, categoryMaxQty: 1, categorySortPos: 2, sortingPosition: 2 }),
          topping({ sku: 'prot-pavo',     name: 'Pechuga de pavo', description: 'Porción de pechuga de pavo horneada.', categoryId: 'foc-proteinas', categoryName: 'Elige tu proteína', categoryMinQty: 1, categoryMaxQty: 1, categorySortPos: 2, sortingPosition: 3 }),
          // Quesos
          topping({ sku: 'q-manchego', name: 'Manchego',             description: 'Porción de queso manchego.',             categoryId: 'foc-quesos', categoryName: 'Elige tu queso', categoryMinQty: 1, categoryMaxQty: 1, categorySortPos: 3, sortingPosition: 1 }),
          topping({ sku: 'q-mozza',    name: 'Mozzarella',           description: 'Porción de queso mozzarella.',           categoryId: 'foc-quesos', categoryName: 'Elige tu queso', categoryMinQty: 1, categoryMaxQty: 1, categorySortPos: 3, sortingPosition: 2 }),
          topping({ sku: 'q-colby',    name: 'Monterrey Jack Colby', description: 'Porción de queso Monterrey Jack Colby.', categoryId: 'foc-quesos', categoryName: 'Elige tu queso', categoryMinQty: 1, categoryMaxQty: 1, categorySortPos: 3, sortingPosition: 3 }),
          topping({ sku: 'q-feta',     name: 'Feta',                 description: 'Porción de queso feta.',                categoryId: 'foc-quesos', categoryName: 'Elige tu queso', categoryMinQty: 1, categoryMaxQty: 1, categorySortPos: 3, sortingPosition: 4 }),
          // Toppings
          topping({ sku: 'top-lechuga',    name: 'Lechuga',               description: 'Porción de lechuga.',               categoryId: 'foc-toppings', categoryName: 'Elige tus toppings', categoryMinQty: 0, categoryMaxQty: 5, categorySortPos: 4, sortingPosition: 1 }),
          topping({ sku: 'top-espinacas',  name: 'Espinacas',             description: 'Porción de espinacas.',             categoryId: 'foc-toppings', categoryName: 'Elige tus toppings', categoryMinQty: 0, categoryMaxQty: 5, categorySortPos: 4, sortingPosition: 2 }),
          topping({ sku: 'top-tomate',     name: 'Tomate',                description: 'Porción de tomate.',                categoryId: 'foc-toppings', categoryName: 'Elige tus toppings', categoryMinQty: 0, categoryMaxQty: 5, categorySortPos: 4, sortingPosition: 3 }),
          topping({ sku: 'top-pepino',     name: 'Pepino',                description: 'Porción de pepino.',                categoryId: 'foc-toppings', categoryName: 'Elige tus toppings', categoryMinQty: 0, categoryMaxQty: 5, categorySortPos: 4, sortingPosition: 4 }),
          topping({ sku: 'top-cebolla',    name: 'Cebolla morada',        description: 'Porción de cebolla morada.',        categoryId: 'foc-toppings', categoryName: 'Elige tus toppings', categoryMinQty: 0, categoryMaxQty: 5, categorySortPos: 4, sortingPosition: 5 }),
          topping({ sku: 'top-aceitunas',  name: 'Aceitunas negras',      description: 'Porción de aceitunas negras.',      categoryId: 'foc-toppings', categoryName: 'Elige tus toppings', categoryMinQty: 0, categoryMaxQty: 5, categorySortPos: 4, sortingPosition: 6 }),
          topping({ sku: 'top-pepinillos', name: 'Pepinillos',            description: 'Porción de pepinillos.',            categoryId: 'foc-toppings', categoryName: 'Elige tus toppings', categoryMinQty: 0, categoryMaxQty: 5, categorySortPos: 4, sortingPosition: 7 }),
          topping({ sku: 'top-jalapenos',  name: 'Jalapeños',             description: 'Porción de jalapeños.',             categoryId: 'foc-toppings', categoryName: 'Elige tus toppings', categoryMinQty: 0, categoryMaxQty: 5, categorySortPos: 4, sortingPosition: 8 }),
          topping({ sku: 'top-pimientos',  name: 'Pimientos rostizados',  description: 'Porción de pimientos rostizados.',  categoryId: 'foc-toppings', categoryName: 'Elige tus toppings', categoryMinQty: 0, categoryMaxQty: 5, categorySortPos: 4, sortingPosition: 9 }),
          topping({ sku: 'top-champi',     name: 'Champiñones rostizados',description: 'Porción de champiñones rostizados.',categoryId: 'foc-toppings', categoryName: 'Elige tus toppings', categoryMinQty: 0, categoryMaxQty: 5, categorySortPos: 4, sortingPosition: 10 }),
          // Aderezos
          topping({ sku: 'ad-aceite',    name: 'Aceite de oliva',    description: 'Porción de aceite de oliva.',    categoryId: 'foc-aderezos', categoryName: 'Elige tu aderezo', categoryMinQty: 0, categoryMaxQty: 2, categorySortPos: 5, sortingPosition: 1 }),
          topping({ sku: 'ad-chipotle',  name: 'Mayonesa chipotle',  description: 'Porción de mayonesa chipotle.',  categoryId: 'foc-aderezos', categoryName: 'Elige tu aderezo', categoryMinQty: 0, categoryMaxQty: 2, categorySortPos: 5, sortingPosition: 2 }),
          topping({ sku: 'ad-ranch',     name: 'Ranch',              description: 'Porción de aderezo Ranch.',      categoryId: 'foc-aderezos', categoryName: 'Elige tu aderezo', categoryMinQty: 0, categoryMaxQty: 2, categorySortPos: 5, sortingPosition: 3 }),
          topping({ sku: 'ad-glaseado',  name: 'Glaseado balsámico', description: 'Porción de glaseado balsámico.', categoryId: 'foc-aderezos', categoryName: 'Elige tu aderezo', categoryMinQty: 0, categoryMaxQty: 2, categorySortPos: 5, sortingPosition: 4 }),
          topping({ sku: 'ad-vinagreta', name: 'Vinagreta balsámica',description: 'Porción de vinagreta balsámica.',categoryId: 'foc-aderezos', categoryName: 'Elige tu aderezo', categoryMinQty: 0, categoryMaxQty: 2, categorySortPos: 5, sortingPosition: 5 }),
          topping({ sku: 'ad-italiano',  name: 'Aderezo italiano',   description: 'Porción de aderezo italiano.',   categoryId: 'foc-aderezos', categoryName: 'Elige tu aderezo', categoryMinQty: 0, categoryMaxQty: 2, categorySortPos: 5, sortingPosition: 6 })
        ]
      },

      // ── Ensaladas ─────────────────────────────────────────────────────────
      {
        sku: 'ENS001', name: 'Ensalada César', type: 'PRODUCT', price: 270,
        category: { id: 'cat-ensaladas', name: 'Ensaladas', maxQty: 0, minQty: 0, sortingPosition: 3 },
        children: [], imageUrl: '', maxLimit: 0, sortingPosition: 1,
        description: 'Lechuga, queso parmesano, queso feta, aderezo César, crotones hechos en casa y pechuga de pollo.'
      },
      {
        sku: 'ENS002', name: 'Ensalada Clásica', type: 'PRODUCT', price: 259,
        category: { id: 'cat-ensaladas', name: 'Ensaladas', maxQty: 0, minQty: 0, sortingPosition: 3 },
        children: [], imageUrl: '', maxLimit: 0, sortingPosition: 2,
        description: 'Mezcla de lechuga, zanahoria, tomate, col morada, queso Monterrey Jack Colby, pechuga de pollo a la plancha, salsa Louisiana y crotones caseros.'
      },
      {
        sku: 'ENS003', name: 'Ensalada del Bosque', type: 'PRODUCT', price: 265,
        category: { id: 'cat-ensaladas', name: 'Ensaladas', maxQty: 0, minQty: 0, sortingPosition: 3 },
        children: [], imageUrl: '', maxLimit: 0, sortingPosition: 3,
        description: 'Mezcla de lechuga y espinacas, manzana, blueberries, fresas, queso feta y nueces. Con pechuga de pollo al horno.'
      },
      {
        sku: 'ENS004', name: 'Combo Focaccia + Media Ensalada', type: 'PRODUCT', price: 359,
        category: { id: 'cat-ensaladas', name: 'Ensaladas', maxQty: 0, minQty: 0, sortingPosition: 3 },
        imageUrl: '', maxLimit: 0, sortingPosition: 4,
        description: 'Una focaccia completa más media ensalada sin pollo de tu elección.',
        children: [
          topping({ sku: 'combo-cesar',   name: 'Media Ensalada César',       description: 'Media porción de Ensalada César sin pollo.',       categoryId: 'combo-ensalada', categoryName: 'Elige tu media ensalada', categoryMinQty: 1, categoryMaxQty: 1, categorySortPos: 1, sortingPosition: 1 }),
          topping({ sku: 'combo-clasica', name: 'Media Ensalada Clásica',     description: 'Media porción de Ensalada Clásica sin pollo.',     categoryId: 'combo-ensalada', categoryName: 'Elige tu media ensalada', categoryMinQty: 1, categoryMaxQty: 1, categorySortPos: 1, sortingPosition: 2 }),
          topping({ sku: 'combo-bosque',  name: 'Media Ensalada del Bosque',  description: 'Media porción de Ensalada del Bosque sin pollo.',  categoryId: 'combo-ensalada', categoryName: 'Elige tu media ensalada', categoryMinQty: 1, categoryMaxQty: 1, categorySortPos: 1, sortingPosition: 3 })
        ]
      },

      // ── Bebidas ───────────────────────────────────────────────────────────
      {
        sku: 'BEB001', name: 'Refresco', type: 'PRODUCT', price: 50,
        category: { id: 'cat-bebidas', name: 'Bebidas', maxQty: 0, minQty: 0, sortingPosition: 4 },
        imageUrl: '', maxLimit: 0, sortingPosition: 1,
        description: 'Refresco de lata.',
        children: [
          topping({ sku: 'ref-regular', name: 'Coca-Cola regular',    description: 'Coca-Cola regular en lata.',    categoryId: 'refresco-sabor', categoryName: 'Elige tu refresco', categoryMinQty: 1, categoryMaxQty: 1, categorySortPos: 1, sortingPosition: 1 }),
          topping({ sku: 'ref-light',   name: 'Coca-Cola sin azúcar', description: 'Coca-Cola sin azúcar en lata.', categoryId: 'refresco-sabor', categoryName: 'Elige tu refresco', categoryMinQty: 1, categoryMaxQty: 1, categorySortPos: 1, sortingPosition: 2 })
        ]
      },
      {
        sku: 'BEB002', name: 'Botella de agua', type: 'PRODUCT', price: 36,
        category: { id: 'cat-bebidas', name: 'Bebidas', maxQty: 0, minQty: 0, sortingPosition: 4 },
        children: [], imageUrl: '', maxLimit: 0, sortingPosition: 2,
        description: 'Agua embotellada.'
      },
      {
        sku: 'BEB003', name: 'Aguas frescas', type: 'PRODUCT', price: 79,
        category: { id: 'cat-bebidas', name: 'Bebidas', maxQty: 0, minQty: 0, sortingPosition: 4 },
        imageUrl: '', maxLimit: 0, sortingPosition: 3,
        description: 'Aguas frescas del día.',
        children: [
          topping({ sku: 'agua-betabel',  name: 'Betabel con guayaba', description: 'Agua fresca de betabel con guayaba.', categoryId: 'agua-sabor', categoryName: 'Elige el sabor', categoryMinQty: 1, categoryMaxQty: 1, categorySortPos: 1, sortingPosition: 1 }),
          topping({ sku: 'agua-mango',    name: 'Mango con piña',      description: 'Agua fresca de mango con piña.',      categoryId: 'agua-sabor', categoryName: 'Elige el sabor', categoryMinQty: 1, categoryMaxQty: 1, categorySortPos: 1, sortingPosition: 2 }),
          topping({ sku: 'agua-horchata', name: 'Horchata',            description: 'Agua fresca de horchata.',            categoryId: 'agua-sabor', categoryName: 'Elige el sabor', categoryMinQty: 1, categoryMaxQty: 1, categorySortPos: 1, sortingPosition: 3 })
        ]
      },
      {
        sku: 'BEB004', name: 'Poppi', type: 'PRODUCT', price: 113,
        category: { id: 'cat-bebidas', name: 'Bebidas', maxQty: 0, minQty: 0, sortingPosition: 4 },
        imageUrl: '', maxLimit: 0, sortingPosition: 4,
        description: 'Refresco prebiótico Poppi.',
        children: [
          topping({ sku: 'poppi-uva',    name: 'Uva',    description: 'Poppi sabor uva.',    categoryId: 'poppi-sabor', categoryName: 'Elige el sabor', categoryMinQty: 1, categoryMaxQty: 1, categorySortPos: 1, sortingPosition: 1 }),
          topping({ sku: 'poppi-naranja',name: 'Naranja',description: 'Poppi sabor naranja.',categoryId: 'poppi-sabor', categoryName: 'Elige el sabor', categoryMinQty: 1, categoryMaxQty: 1, categorySortPos: 1, sortingPosition: 2 })
        ]
      },
      {
        sku: 'BEB005', name: 'Olipop', type: 'PRODUCT', price: 113,
        category: { id: 'cat-bebidas', name: 'Bebidas', maxQty: 0, minQty: 0, sortingPosition: 4 },
        imageUrl: '', maxLimit: 0, sortingPosition: 5,
        description: 'Refresco de fibra prebiótica Olipop.',
        children: [
          topping({ sku: 'olipop-manzana', name: 'Manzana',        description: 'Olipop sabor manzana.',        categoryId: 'olipop-sabor', categoryName: 'Elige el sabor', categoryMinQty: 1, categoryMaxQty: 1, categorySortPos: 1, sortingPosition: 1 }),
          topping({ sku: 'olipop-fresa',   name: 'Strawberry Cream',description: 'Olipop sabor Strawberry Cream.',categoryId: 'olipop-sabor', categoryName: 'Elige el sabor', categoryMinQty: 1, categoryMaxQty: 1, categorySortPos: 1, sortingPosition: 2 })
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
  for (const event of ['NEW_ORDER', 'ORDER_EVENT_CANCEL', 'PING', 'MENU_APPROVED', 'MENU_REJECTED']) {
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
