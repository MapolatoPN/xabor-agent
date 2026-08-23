/**
 * Cliente Rappi API v2
 * Sandbox: microservices.dev.rappi.com
 * Producción: microservices.rappi.com
 *
 * Flujo de orden:
 *   Rappi → NEW_ORDER webhook → nosotros → PUT /orders/{id}/take → listo
 */

const BASE_URL  = process.env.RAPPI_BASE_URL  || 'https://services.mxgrability.rappi.com'; // Órdenes, webhooks, menú (API vieja)
const NEW_BASE_URL = process.env.RAPPI_NEW_BASE_URL || 'https://api.rappi.com.mx';           // Auth nueva
const AUTH_URL  = process.env.RAPPI_AUTH_URL  || `${NEW_BASE_URL}/restaurants/auth/v1/token/login/integrations`;
const CLIENT_ID = process.env.RAPPI_CLIENT_ID;
const CLIENT_SECRET = process.env.RAPPI_CLIENT_SECRET;
const STORE_ID  = process.env.RAPPI_STORE_ID || null; // PROD: 1930419809 — null = Rappi desactivado

const API_BASE = `${BASE_URL}/api/v2/restaurants-integrations-public-api`;

// ─── Token cache ─────────────────────────────────────────────────────────────
let _token = null;
let _tokenExpires = 0;

export async function obtenerToken() {
  if (_token && Date.now() < _tokenExpires - 60_000) return _token;

  console.log(`[Rappi Auth] POST ${AUTH_URL} | client_id: …${String(CLIENT_ID || '').slice(-4)}`);
  const resp = await fetch(AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET
    })
  });

  const authText = await resp.text();

  if (!resp.ok) {
    // Nunca se loguea ni se propaga el cuerpo crudo de la respuesta -- puede
    // contener detalles de depuración de Rappi. El código HTTP alcanza para
    // diagnosticar (credenciales inválidas, servicio caído, etc.).
    console.error(`[Rappi Auth] HTTP ${resp.status} — fallo de autenticación`);
    throw new Error(`[Rappi Auth] Fallo de autenticación (HTTP ${resp.status})`);
  }

  console.log(`[Rappi Auth] HTTP ${resp.status} — token obtenido correctamente`);
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
export async function consultarAprobacionMenu(storeId = STORE_ID) {
  return rappiRequest('GET', `/menu/approved/${storeId}`);
}

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
 * Endpoint documentado: POST /api/v2/restaurants-integrations-public-api/menu
 */
export async function subirCatalogo(catalogoRappi) {
  const token = await obtenerToken();
  const menuUrl = `${API_BASE}/menu`;
  console.log(`[Rappi Menu] POST ${menuUrl}`);
  const resp = await fetch(menuUrl, {
    method: 'POST',
    headers: {
      'x-authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(catalogoRappi)
  });
  const text = await resp.text();
  console.log(`[Rappi Menu] HTTP ${resp.status}:`, text.slice(0, 300));
  if (!resp.ok) throw new Error(`[Rappi] POST /menu → ${resp.status}: ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}

/**
 * Sube el catálogo completo (alias para re-subir desde el panel).
 */
export async function actualizarSchedule(negocioId) {
  return subirCatalogo(await construirCatalogoRappi(negocioId));
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

// ─── Identidad estable del producto en Rappi ────────────────────────────────
// El SKU es la identidad del producto EN RAPPI: si cambia, Rappi lo ve como
// otro producto (pierde historial, disponibilidad y stockouts). Por eso NUNCA
// puede derivarse de la posición en un arreglo ni del nombre.
//   1) `menu_productos.codigo` cuando existe -- es lo que Rappi ya conoce de
//      los productos originales (PAN001, FOC001...), así que respetarlo evita
//      recrear el catálogo entero en su lado.
//   2) `XB-<id>` para el resto: la PK es inmutable y única, y el prefijo
//      reservado no puede chocar con un código escrito a mano (si alguien
//      escribiera uno así, se ignora y se usa la PK igual).
const PREFIJO_SKU = 'XB-';
export function skuDeProducto(p) {
  const codigo = typeof p.codigo === 'string' ? p.codigo.trim() : '';
  if (codigo && !codigo.toUpperCase().startsWith(PREFIJO_SKU)) return codigo;
  return `${PREFIJO_SKU}${p.id}`;
}

/**
 * ¿Este producto se publica en Rappi?
 *
 * Se excluyen los cargos técnicos (hoy `opciones.tipo_item='envio'`, la misma
 * marca estructural que usa validadorOrden) y la mercancía deshabilitada. La
 * exclusión es ESTRUCTURAL: jamás por el nombre del producto -- un negocio
 * puede llamar "Delivery" o "Servicio a domicilio" a su cargo de envío, y
 * adivinar por texto en un catálogo con precios es exactamente la clase de
 * heurística que no queremos en nada que toque dinero.
 */
export function esPublicableEnRappi(p) {
  if (!p) return false;
  if (p.opciones && typeof p.opciones === 'object' && p.opciones.tipo_item === 'envio') return false;
  if (p.disponible === false) return false;
  if (p.agotado === true) return false;
  return true;
}

/**
 * Construye el catálogo de Rappi a partir del MENÚ REAL del negocio.
 *
 * Antes esta función devolvía un objeto literal escrito a mano (13 productos
 * con precios de julio): el dueño editaba su menú en Xabor y Rappi seguía
 * mostrando lo viejo -- más caro y sin productos nuevos. La fuente de verdad
 * es ahora la base, por negocio.
 *
 * El ESQUEMA no cambia: es el mismo que Rappi ya aceptó (items planos con
 * children, camelCase, category embebida). Aquí solo cambia de dónde salen
 * los datos.
 *
 * PRECIO POR CANAL: el precio que sale a Rappi puede llevar el ajuste que el
 * negocio configuró (integraciones_canal.configuracion.rappi_pricing, ver
 * rappiPricing.js). El ajuste se aplica AQUÍ y solo aquí: `menu_productos.precio`
 * nunca se toca, y POS / WhatsApp / tienda / pagos siguen operando con el
 * precio base. Una configuración ausente o inválida cae a precio base sin
 * lanzar -- publicar caro de menos es recuperable; no poder publicar, no.
 */
export async function construirCatalogoRappi(negocioId, { storeId = STORE_ID, pricing = undefined } = {}) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    throw new Error('construirCatalogoRappi: negocioId obligatorio (el menú es por negocio)');
  }
  const nid = negocioId.trim();
  const { pool, obtenerConfiguracionCanal } = await import('./database.js');
  const { calcularPrecioRappi } = await import('./rappiPricing.js');

  // `pricing` explícito solo lo usa la vista previa del panel (calcular sin
  // guardar). El camino de publicación real siempre lee lo persistido.
  const configPrecios = pricing !== undefined
    ? pricing
    : (await obtenerConfiguracionCanal(nid, 'rappi').catch(() => ({})))?.rappi_pricing;

  // Menú del negocio -- SIEMPRE filtrado por negocio_id en ambas tablas: el
  // catálogo de otro tenant no existe desde aquí.
  const { rows: productos } = await pool.query(
    `SELECT p.id, p.codigo, p.nombre, p.descripcion, p.precio, p.disponible, p.agotado,
            p.opciones, p.orden AS orden_producto,
            c.id AS categoria_id, c.nombre AS categoria_nombre, c.orden AS categoria_orden, c.activa AS categoria_activa
       FROM menu_productos p
       JOIN menu_categorias c ON c.id = p.categoria_id AND c.negocio_id = p.negocio_id
      WHERE p.negocio_id = $1
      ORDER BY c.orden NULLS LAST, c.id, p.orden NULLS LAST, p.id`,
    [nid]);

  const publicables = productos.filter(p => p.categoria_activa !== false && esPublicableEnRappi(p));

  // Modificadores REALES del negocio (grupo -> opciones). Si un producto no
  // tiene grupos, va sin toppings: jamás se inventan.
  const { rows: grupos } = await pool.query(
    `SELECT g.id, g.producto_id, g.nombre, g.requerido, g.minimo, g.maximo, g.orden
       FROM menu_modificadores_grupos g WHERE g.negocio_id = $1 ORDER BY g.orden NULLS LAST, g.id`,
    [nid]);
  const { rows: opciones } = grupos.length
    ? await pool.query(
        `SELECT o.id, o.grupo_id, o.nombre, o.precio_extra, o.disponible, o.orden
           FROM menu_modificadores_opciones o WHERE o.negocio_id = $1 ORDER BY o.orden NULLS LAST, o.id`,
        [nid])
    : { rows: [] };
  const opcionesPorGrupo = new Map();
  for (const o of opciones) {
    if (o.disponible === false) continue;             // opción apagada no se publica
    if (!opcionesPorGrupo.has(o.grupo_id)) opcionesPorGrupo.set(o.grupo_id, []);
    opcionesPorGrupo.get(o.grupo_id).push(o);
  }
  const gruposPorProducto = new Map();
  for (const g of grupos) {
    if (!(opcionesPorGrupo.get(g.id) || []).length) continue;  // grupo sin opciones vivas: no se publica
    if (!gruposPorProducto.has(g.producto_id)) gruposPorProducto.set(g.producto_id, []);
    gruposPorProducto.get(g.producto_id).push(g);
  }

  // Categorías: solo las que quedan con al menos un producto publicable, y en
  // el orden real del menú (sortingPosition arranca en 1, como el contrato).
  const ordenCategoria = new Map();
  for (const p of publicables) {
    if (!ordenCategoria.has(p.categoria_id)) ordenCategoria.set(p.categoria_id, ordenCategoria.size + 1);
  }

  const items = [];
  const posEnCategoria = new Map();
  for (const p of publicables) {
    const pos = (posEnCategoria.get(p.categoria_id) || 0) + 1;
    posEnCategoria.set(p.categoria_id, pos);

    const children = [];
    for (const g of (gruposPorProducto.get(p.id) || [])) {
      let posOpcion = 0;
      for (const o of (opcionesPorGrupo.get(g.id) || [])) {
        children.push(topping({
          sku: `${PREFIJO_SKU}op-${o.id}`,
          name: o.nombre,
          description: o.nombre,
          categoryId: `${PREFIJO_SKU}grp-${g.id}`,
          categoryName: g.nombre,
          categoryMinQty: Number(g.minimo) || 0,
          categoryMaxQty: Number(g.maximo) || 1,
          categorySortPos: Number(g.orden) || 1,
          sortingPosition: ++posOpcion,
          // El extra también paga comisión: si el ajuste solo tocara el
          // precio base, un producto con muchos extras seguiría dejando
          // menos ingreso neto que en mostrador. Un extra de $0 sigue en $0.
          price: calcularPrecioRappi(o.precio_extra, configPrecios),
        }));
      }
    }

    items.push({
      sku: skuDeProducto(p),
      name: p.nombre,
      type: 'PRODUCT',
      // Precio del menú real con el ajuste de canal configurado (sin ajuste
      // configurado, es exactamente Number(p.precio) redondeado al peso).
      price: calcularPrecioRappi(p.precio, configPrecios),
      category: {
        id: `${PREFIJO_SKU}cat-${p.categoria_id}`,
        name: p.categoria_nombre,
        maxQty: 0,
        minQty: 0,
        sortingPosition: ordenCategoria.get(p.categoria_id),
      },
      children,
      // menu_productos no guarda imagen por producto (las imágenes del menú
      // viven aparte, para WhatsApp): se envía vacío como hasta hoy, nunca
      // una URL inventada.
      imageUrl: '',
      maxLimit: 0,
      sortingPosition: pos,
      description: p.descripcion || p.nombre,
    });
  }

  return { storeId, items };
}

// ─── Registro de webhooks ─────────────────────────────────────────────────────

/**
 * Registrar o actualizar la URL del webhook para un evento
 * event: 'NEW_ORDER' | 'ORDER_EVENT_CANCEL' | 'PING'
 */
/**
 * Consultar estado actual de un webhook en Rappi.
 * Devuelve null si no existe (404).
 */
export async function obtenerWebhook(event) {
  try {
    return await rappiRequest('GET', `/webhook/${event}`);
  } catch (e) {
    if (e.message && (e.message.includes('404') || e.message.includes('not found'))) return null;
    throw e;
  }
}

/**
 * Registrar o actualizar la URL del webhook para un evento.
 * Formato oficial Rappi: POST body = { event, data: [{ url, stores: [storeId] }] }
 */
export async function registrarWebhook(event, url) {
  if (!STORE_ID) throw new Error('RAPPI_STORE_ID no configurado en Railway');
  console.log(`[Rappi Webhook] ${event} → ${url} | store: ${STORE_ID}`);

  // 1. Intentar actualizar URL si ya existe
  try {
    const r = await rappiRequest('PUT', `/webhook/${event}/change-url`, { url });
    console.log(`[Rappi Webhook] PUT OK — ${event} actualizado`);
    return r;
  } catch (putErr) {
    console.warn(`[Rappi Webhook] PUT ${event}: ${putErr.message.slice(0, 80)} — intentando POST`);
  }

  // 2. Crear nuevo — formato oficial de la API de Rappi
  return rappiRequest('POST', '/webhook', {
    event,
    data: [{ url, stores: [STORE_ID] }]
  });
}

/**
 * Configurar todos los webhooks necesarios.
 * Verifica estado antes y después de registrar.
 * baseUrl: dominio público de Railway
 */
export async function configurarWebhooks(baseUrl) {
  if (!STORE_ID) throw new Error('RAPPI_STORE_ID no configurado en Railway');
  const webhookUrl = `${baseUrl}/webhook/rappi`;
  console.log(`[Rappi] Configurando webhooks → ${webhookUrl} | store: ${STORE_ID}`);

  const results = {};
  for (const event of ['NEW_ORDER', 'ORDER_EVENT_CANCEL', 'PING', 'MENU_APPROVED', 'MENU_REJECTED']) {
    try {
      const antes = await obtenerWebhook(event).catch(() => null);
      console.log(`[Rappi] ${event} antes:`, antes ? JSON.stringify(antes).slice(0, 120) : 'no existe');

      const registro = await registrarWebhook(event, webhookUrl);
      const despues  = await obtenerWebhook(event).catch(() => null);
      console.log(`[Rappi] ✅ ${event} despues:`, JSON.stringify(despues).slice(0, 120));

      results[event] = { registro, verificacion: despues };
    } catch (e) {
      results[event] = { error: e.message };
      console.error(`[Rappi] ❌ Error ${event}:`, e.message);
    }
  }
  return results;
}
