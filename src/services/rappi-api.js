/**
 * Cliente Rappi API v2 (Restaurants Integrations Public API)
 * Sandbox: microservices.dev.rappi.com
 * Producción: services.mxgrability.rappi.com (órdenes, webhooks, menú) y
 *             api.rappi.com.mx (auth)
 *
 * Flujo de orden:
 *   Rappi → NEW_ORDER webhook → nosotros → PUT /orders/{id}/take → listo
 *
 * MULTITIENDA
 *
 * Este módulo ya no gira alrededor de UNA tienda. `crearClienteRappi()`
 * construye un cliente atado a un store y a unas credenciales concretas; todo
 * lo saliente (tomar/rechazar orden, ready-for-pickup, disponibilidad,
 * abrir/cerrar tienda, catálogo, webhooks) pasa por un cliente. Quién decide
 * qué cliente usar es `rappiIntegracion.js`, a partir de `integraciones_canal`:
 * el store de Obispado nunca se resuelve desde una variable global.
 *
 * Las funciones sueltas exportadas al final (`tomarOrden`, `subirCatalogo`,
 * ...) son el CAMINO LEGADO: delegan en un cliente construido desde las
 * variables de entorno (RAPPI_CLIENT_ID / RAPPI_CLIENT_SECRET /
 * RAPPI_STORE_ID, es decir, Nonna Maye). Se conservan para las rutas
 * `/api/rappi/*` y el job de horario, que siguen siendo de una sola tienda a
 * propósito -- ver docs/rappi-mapolato-obispado-auditoria.md, sección G.
 */

const BASE_URL  = process.env.RAPPI_BASE_URL  || 'https://services.mxgrability.rappi.com'; // Órdenes, webhooks, menú (API vieja)
const NEW_BASE_URL = process.env.RAPPI_NEW_BASE_URL || 'https://api.rappi.com.mx';           // Auth nueva
const AUTH_URL  = process.env.RAPPI_AUTH_URL  || `${NEW_BASE_URL}/restaurants/auth/v1/token/login/integrations`;
const STORE_ID  = process.env.RAPPI_STORE_ID || null; // PROD: 1930419809 (Nonna Maye) — null = camino legado apagado

const API_BASE = `${BASE_URL}/api/v2/restaurants-integrations-public-api`;

// ─── Token cache: uno por client_id ──────────────────────────────────────────
// Dos negocios con credenciales propias no comparten token; dos stores bajo
// el mismo client_id sí (el token es del integrador, no de la tienda).
const _tokens = new Map(); // clientId -> { token, expira }

function errorRappi(mensaje, codigo, extra = {}) {
  const e = new Error(mensaje);
  e.codigo = codigo;
  Object.assign(e, extra);
  return e;
}

/**
 * Cliente atado a UN store y UNAS credenciales.
 *
 * @param {{ storeId: string|null, clientId: string, clientSecret: string, etiqueta?: string }} ctx
 */
export function crearClienteRappi(ctx) {
  if (!ctx || typeof ctx !== 'object') throw errorRappi('crearClienteRappi: contexto requerido', 'RAPPI_CONTEXTO_REQUERIDO');
  const clientId = typeof ctx.clientId === 'string' ? ctx.clientId.trim() : '';
  const clientSecret = typeof ctx.clientSecret === 'string' ? ctx.clientSecret.trim() : '';
  if (!clientId || !clientSecret) throw errorRappi('crearClienteRappi: credenciales requeridas', 'RAPPI_NO_CONFIGURADO');
  const storeId = ctx.storeId != null && String(ctx.storeId).trim() ? String(ctx.storeId).trim() : null;
  const etiqueta = ctx.etiqueta || (storeId ? `store …${storeId.slice(-4)}` : 'sin store');

  async function obtenerToken() {
    const cache = _tokens.get(clientId);
    if (cache && Date.now() < cache.expira - 60_000) return cache.token;

    console.log(`[Rappi Auth] POST ${AUTH_URL} | client_id: …${clientId.slice(-4)} | ${etiqueta}`);
    const resp = await fetch(AUTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret })
    });
    const authText = await resp.text();
    if (!resp.ok) {
      // Nunca se loguea ni se propaga el cuerpo crudo de la respuesta -- puede
      // contener detalles de depuración de Rappi. El código HTTP alcanza.
      console.error(`[Rappi Auth] HTTP ${resp.status} — fallo de autenticación (${etiqueta})`);
      throw errorRappi(`[Rappi Auth] Fallo de autenticación (HTTP ${resp.status})`, 'RAPPI_AUTH', { status: resp.status });
    }
    const data = JSON.parse(authText);
    const expira = Date.now() + (data.expires_in || 3600) * 1000;
    _tokens.set(clientId, { token: data.access_token, expira });
    console.log(`[Rappi Auth] token obtenido, expira en ${data.expires_in || 3600} seg (${etiqueta})`);
    return data.access_token;
  }

  async function request(method, path, body = null) {
    const token = await obtenerToken();
    const opts = { method, headers: { 'x-authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const fullUrl = `${API_BASE}${path}`;
    console.log(`[Rappi] ${method} ${fullUrl} (${etiqueta})`);
    const resp = await fetch(fullUrl, opts);
    const text = await resp.text();
    console.log(`[Rappi] HTTP ${resp.status}:`, text.slice(0, 300));
    if (!resp.ok) throw errorRappi(`[Rappi] ${method} ${path} → ${resp.status}: ${text.slice(0, 300)}`, 'RAPPI_HTTP', { status: resp.status });
    try { return JSON.parse(text); } catch { return text; }
  }

  function exigirStore() {
    if (!storeId) throw errorRappi('Esta operación necesita un store de Rappi y el cliente no tiene ninguno', 'RAPPI_STORE_REQUERIDO');
    return storeId;
  }

  return {
    storeId,
    clientId,
    etiqueta,
    obtenerToken,

    // ── Órdenes ──
    /** SENT → TAKEN. cookingTime en minutos. */
    tomarOrden: (orderId, cookingTime = 20) => request('PUT', `/orders/${orderId}/take/${cookingTime}`),

    /**
     * SENT → REJECTED. La doc pide `reason` y `cancel_type`; cuando el tipo es
     * de item (`ITEM_NOT_FOUND`, `ITEM_OUT_OF_STOCK`, `ITEM_WRONG_PRICE`)
     * también `items_skus`. NUNCA se invoca automáticamente por un error de
     * Xabor -- ver rappi.js.
     */
    rechazarOrden: (orderId, motivo = 'Producto no disponible', { cancelType = 'OTHER', itemsSkus = [] } = {}) => {
      const body = { reason: motivo, cancel_type: cancelType };
      if (itemsSkus.length > 0) body.items_skus = itemsSkus.map(String);
      return request('PUT', `/orders/${orderId}/reject`, body);
    },

    /** Orden lista para que la recoja el repartidor. Rappi corta a la tercera llamada por orden. */
    ordenListaParaRecoger: (orderId) => request('POST', `/orders/${orderId}/ready-for-pickup`),

    /** Órdenes nuevas del store (solo si no se usa webhook). */
    // Todas `async`: un cliente sin store RECHAZA la promesa (nunca lanza en
    // seco), para que cualquier llamador con try/await lo capture igual.
    obtenerOrdenesNuevas: async () => request('GET', `/orders?storeId=${exigirStore()}`),

    // ── Disponibilidad ──
    actualizarDisponibilidad: async (turnOn = [], turnOff = []) => {
      const body = [{ store_integration_id: exigirStore(), items: {} }];
      if (turnOn.length > 0)  body[0].items.turn_on  = turnOn.map(String);
      if (turnOff.length > 0) body[0].items.turn_off = turnOff.map(String);
      return request('PUT', '/availability/stores/items', body);
    },
    consultarAprobacionMenu: async () => request('GET', `/menu/approved/${exigirStore()}`),
    consultarDisponibilidad: async (skus) => request('POST', '/availability/items/status', { store_id: exigirStore(), item_ids: skus.map(String) }),
    actualizarEstadoTienda: async (activa) => request('PUT', '/availability/stores/enable', { stores: [{ store_id: exigirStore(), is_enabled: activa }] }),

    // ── Catálogo ──
    /**
     * Sube o reemplaza el catálogo completo del store. El catálogo DEBE
     * venir construido para este mismo store: publicar el menú de un negocio
     * en la tienda de otro es exactamente el accidente que este cliente
     * existe para impedir.
     */
    subirCatalogo: async (catalogoRappi) => {
      const sid = exigirStore();
      if (!catalogoRappi || String(catalogoRappi.storeId) !== sid) {
        throw errorRappi(`El catálogo va dirigido al store ${catalogoRappi?.storeId ?? '(ninguno)'} y este cliente es del store ${sid}`, 'RAPPI_STORE_NO_COINCIDE');
      }
      const token = await obtenerToken();
      const menuUrl = `${API_BASE}/menu`;
      console.log(`[Rappi Menu] POST ${menuUrl} (${etiqueta}, ${catalogoRappi.items?.length ?? 0} items)`);
      const resp = await fetch(menuUrl, {
        method: 'POST',
        headers: { 'x-authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(catalogoRappi)
      });
      const text = await resp.text();
      console.log(`[Rappi Menu] HTTP ${resp.status}:`, text.slice(0, 300));
      if (!resp.ok) throw errorRappi(`[Rappi] POST /menu → ${resp.status}: ${text.slice(0, 300)}`, 'RAPPI_HTTP', { status: resp.status });
      try { return JSON.parse(text); } catch { return text; }
    },

    // ── Webhooks ──
    obtenerWebhook: async (event) => {
      try {
        return await request('GET', `/webhook/${event}`);
      } catch (e) {
        if (e.status === 404 || /not found/i.test(e.message)) return null;
        throw e;
      }
    },
    /** Registrar o actualizar la URL del webhook para un evento, SOLO para este store. */
    registrarWebhook: async (event, url) => {
      const sid = exigirStore();
      console.log(`[Rappi Webhook] ${event} → ${url} | ${etiqueta}`);
      try {
        const r = await request('PUT', `/webhook/${event}/change-url`, { url, stores: [sid] });
        console.log(`[Rappi Webhook] PUT OK — ${event} actualizado`);
        return r;
      } catch (putErr) {
        console.warn(`[Rappi Webhook] PUT ${event}: ${putErr.message.slice(0, 80)} — intentando POST`);
      }
      return request('POST', '/webhook', { event, data: [{ url, stores: [sid] }] });
    },
    configurarWebhooks: async function (baseUrl) {
      const webhookUrl = `${baseUrl}/webhook/rappi`;
      console.log(`[Rappi] Configurando webhooks → ${webhookUrl} | ${etiqueta}`);
      const results = {};
      for (const event of ['NEW_ORDER', 'ORDER_EVENT_CANCEL', 'PING', 'MENU_APPROVED', 'MENU_REJECTED']) {
        try {
          const antes = await this.obtenerWebhook(event).catch(() => null);
          console.log(`[Rappi] ${event} antes:`, antes ? JSON.stringify(antes).slice(0, 120) : 'no existe');
          const registro = await this.registrarWebhook(event, webhookUrl);
          const despues  = await this.obtenerWebhook(event).catch(() => null);
          console.log(`[Rappi] ✅ ${event} despues:`, JSON.stringify(despues).slice(0, 120));
          results[event] = { registro, verificacion: despues };
        } catch (e) {
          results[event] = { error: e.message };
          console.error(`[Rappi] ❌ Error ${event}:`, e.message);
        }
      }
      return results;
    },
  };
}

// ─── Camino legado: cliente desde variables de entorno ──────────────────────
// Devuelve null cuando Rappi no está configurado por entorno. Los llamadores
// legados lo tratan como "Rappi apagado", igual que antes con STORE_ID null.
let _clienteEntorno = null;
export function clienteRappiDesdeEntorno() {
  const clientId = process.env.RAPPI_CLIENT_ID;
  const clientSecret = process.env.RAPPI_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  if (!_clienteEntorno || _clienteEntorno.clientId !== clientId || _clienteEntorno.storeId !== (STORE_ID || null)) {
    _clienteEntorno = crearClienteRappi({ clientId, clientSecret, storeId: STORE_ID, etiqueta: 'entorno' });
  }
  return _clienteEntorno;
}
function legado() {
  const c = clienteRappiDesdeEntorno();
  if (!c) throw errorRappi('Rappi no está configurado por entorno (RAPPI_CLIENT_ID / RAPPI_CLIENT_SECRET)', 'RAPPI_NO_CONFIGURADO');
  return c;
}
export async function obtenerToken() { return legado().obtenerToken(); }
export async function tomarOrden(orderId, cookingTime = 20) { return legado().tomarOrden(orderId, cookingTime); }
export async function rechazarOrden(orderId, motivo, opciones) { return legado().rechazarOrden(orderId, motivo, opciones); }
export async function ordenListaParaRecoger(orderId) { return legado().ordenListaParaRecoger(orderId); }
export async function obtenerOrdenesNuevas() { return legado().obtenerOrdenesNuevas(); }
export async function actualizarDisponibilidad(turnOn = [], turnOff = []) { return legado().actualizarDisponibilidad(turnOn, turnOff); }
export async function consultarAprobacionMenu() { return legado().consultarAprobacionMenu(); }
export async function consultarDisponibilidad(skus) { return legado().consultarDisponibilidad(skus); }
export async function actualizarEstadoTienda(activa) { return legado().actualizarEstadoTienda(activa); }
export async function subirCatalogo(catalogoRappi) { return legado().subirCatalogo(catalogoRappi); }
export async function obtenerWebhook(event) { return legado().obtenerWebhook(event); }
export async function registrarWebhook(event, url) { return legado().registrarWebhook(event, url); }
export async function configurarWebhooks(baseUrl) { return legado().configurarWebhooks(baseUrl); }

/**
 * Sube el catálogo completo (alias para re-subir desde el panel). Camino
 * legado: el store es el del entorno.
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
//
// El camino de VUELTA (SKU de una orden entrante → producto_id / opcion_id)
// vive en src/channels/rappiMapeo.js y usa exactamente estas mismas reglas:
// si esto cambia, aquello cambia con ello (la suite de mapeo lo detecta).
export const PREFIJO_SKU = 'XB-';
export const PREFIJO_SKU_OPCION = `${PREFIJO_SKU}op-`;
export const PREFIJO_SKU_GRUPO = `${PREFIJO_SKU}grp-`;
export const PREFIJO_SKU_CATEGORIA = `${PREFIJO_SKU}cat-`;
export function skuDeProducto(p) {
  const codigo = typeof p.codigo === 'string' ? p.codigo.trim() : '';
  if (codigo && !codigo.toUpperCase().startsWith(PREFIJO_SKU)) return codigo;
  return `${PREFIJO_SKU}${p.id}`;
}
export function skuDeOpcion(o) { return `${PREFIJO_SKU_OPCION}${o.id}`; }

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
 *
 * `storeId`: el store al que va dirigido. Por defecto el del entorno (camino
 * legado); el camino multitienda pasa SIEMPRE el de la integración del
 * negocio, y el cliente se niega a publicarlo en otro store.
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
          sku: skuDeOpcion(o),
          name: o.nombre,
          description: o.nombre,
          categoryId: `${PREFIJO_SKU_GRUPO}${g.id}`,
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
        id: `${PREFIJO_SKU_CATEGORIA}${p.categoria_id}`,
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
