// Mapeo de una orden de Rappi al contrato de pedido de Xabor.
//
// Entrada: el sobre del webhook NEW_ORDER (formato productivo
// `{ order_detail, customer, store }`, o el formato plano de sandbox) y el
// catálogo REAL del negocio ya cargado. Salida: la orden que `registrarPedido`
// entiende (items con `producto_id`, `modificadores` canónicos, precios,
// notas) más una AUDITORÍA de cómo se resolvió cada línea.
//
// Reglas de resolución de un item, en este orden y sin inventar nada:
//   1. SKU estable: el mismo que publica `construirCatalogoRappi`
//      (`menu_productos.codigo` o `XB-<id>`). Es la identidad que Rappi
//      conoce; si coincide, no hay ambigüedad posible.
//   2. Compatibilidad controlada: nombre recibido == nombre del catálogo
//      (normalizado), SOLO si ese nombre es único en el menú del negocio.
//      Cubre menús publicados antes de que existiera el SKU, o cargados a
//      mano en Rappi. Queda marcado como `mapeo: 'nombre'`.
//   3. Sin resolver: el item se conserva tal cual llegó (nombre, cantidad,
//      precio, comentarios) SIN `producto_id`, con `mapeo: 'sin_resolver'`,
//      y la orden lleva `mapeo.requiere_revision = true`. La venta ya
//      ocurrió y ya está cobrada: nunca se descarta ni se rechaza por esto.
//
// Subitems (toppings) siguen la misma lógica dentro de los grupos del
// producto resuelto: SKU `XB-op-<id>` o nombre único entre las opciones de
// ese producto. Lo que no resuelve NO se pierde: viaja como modificador
// "sin catálogo" (se imprime igual) y queda listado en
// `modificadores_sin_resolver` para revisarlo.
//
// PRECIOS: los importes son los que Rappi cobró al cliente (el pedido debe
// cuadrar con lo que Rappi liquida), y se conserva al lado el precio del
// catálogo de Xabor para comparar. Nunca se recalcula el total.
import { pool } from '../services/database.js';
import { skuDeProducto, skuDeOpcion, PREFIJO_SKU, PREFIJO_SKU_OPCION } from '../services/rappi-api.js';

export const CANAL = 'rappi';
const NOTAS_MAX = 300;

export function normalizarClaveMapeo(s) {
  return String(s ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9ñ ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function num(v, porDefecto = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : porDefecto;
}

// ─── Sobre ──────────────────────────────────────────────────────────────────

/**
 * Reconoce los dos formatos de NEW_ORDER y devuelve una vista uniforme, o
 * null si el cuerpo no es una orden. No decide nada de negocio.
 */
export function normalizarSobreRappi(body) {
  if (!body || typeof body !== 'object') return null;
  const od = body.order_detail;
  if (od && typeof od === 'object' && od.order_id != null && Array.isArray(od.items)) {
    return {
      formato: 'order_detail',
      orderId: String(od.order_id),
      storeId: body.store?.internal_id != null ? String(body.store.internal_id) : null,
      detalle: od,
      items: od.items,
      totals: od.totals || {},
      deliveryMethod: od.delivery_method ?? null,
      paymentMethod: od.payment_method ?? null,
      cookingTime: od.cooking_time ?? null,
      createdAt: od.created_at ?? null,
      delivery: od.delivery_information || {},
      customer: body.customer || {},
      store: body.store || {},
    };
  }
  // Formato plano (sandbox / implementaciones previas): el pedido viene en la
  // raíz. Sin `store.internal_id` no hay forma confiable de saber de qué
  // negocio es -- quien llama decide qué hacer con storeId null.
  if ((body.id != null || body.order_id != null) && (Array.isArray(body.items) || Array.isArray(body.products))) {
    return {
      formato: 'plano',
      orderId: String(body.id ?? body.order_id),
      storeId: body.store?.internal_id != null ? String(body.store.internal_id)
        : (body.store_id != null ? String(body.store_id) : null),
      detalle: body,
      items: body.items || body.products || [],
      totals: body.totals || body.total || {},
      deliveryMethod: body.delivery_method ?? null,
      paymentMethod: body.payment_method ?? null,
      cookingTime: body.cooking_time ?? null,
      createdAt: body.created_at ?? null,
      delivery: body.delivery || body.delivery_information || body.address || {},
      customer: body.customer || {},
      store: body.store || {},
    };
  }
  return null;
}

// ─── Catálogo ───────────────────────────────────────────────────────────────

/**
 * Índices del menú REAL del negocio para resolver una orden. Incluye TODO el
 * menú (también agotados y no disponibles): una orden ya cobrada por Rappi
 * de un producto que aquí está agotado sigue siendo ese producto -- se
 * resuelve y se marca `no_disponible`, no se pierde.
 */
export async function cargarCatalogoParaRappi(negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    const e = new Error('cargarCatalogoParaRappi: negocioId requerido');
    e.code = 'TENANT_CONTEXT_REQUIRED';
    throw e;
  }
  const nid = negocioId.trim();
  const { rows: productos } = await pool.query(
    `SELECT p.id, p.codigo, p.nombre, p.precio, p.disponible, p.agotado, p.opciones, p.categoria_id, c.nombre AS categoria
       FROM menu_productos p JOIN menu_categorias c ON c.id = p.categoria_id AND c.negocio_id = p.negocio_id
      WHERE p.negocio_id = $1`, [nid]);
  const { rows: grupos } = await pool.query(
    `SELECT id, producto_id, nombre, requerido, minimo, maximo FROM menu_modificadores_grupos WHERE negocio_id = $1`, [nid]);
  const { rows: opciones } = grupos.length
    ? await pool.query(`SELECT id, grupo_id, nombre, precio_extra, disponible FROM menu_modificadores_opciones WHERE negocio_id = $1`, [nid])
    : { rows: [] };

  const productosPorSku = new Map();
  const productosPorId = new Map();
  const conteoNombre = new Map();
  for (const p of productos) {
    productosPorSku.set(skuDeProducto(p).toUpperCase(), p);
    productosPorId.set(Number(p.id), p);
    const k = normalizarClaveMapeo(p.nombre);
    if (!k) continue;
    const prev = conteoNombre.get(k);
    if (prev) prev.n += 1; else conteoNombre.set(k, { p, n: 1 });
  }
  const productosPorNombreUnico = new Map();
  for (const [k, v] of conteoNombre) if (v.n === 1) productosPorNombreUnico.set(k, v.p);

  const gruposPorId = new Map(grupos.map(g => [Number(g.id), { ...g, opciones: [] }]));
  const opcionesPorId = new Map();
  for (const o of opciones) {
    const g = gruposPorId.get(Number(o.grupo_id));
    if (!g) continue;
    g.opciones.push(o);
    opcionesPorId.set(Number(o.id), { opcion: o, grupo: g });
  }
  const gruposPorProducto = new Map();
  for (const g of gruposPorId.values()) {
    const pid = Number(g.producto_id);
    if (!gruposPorProducto.has(pid)) gruposPorProducto.set(pid, []);
    gruposPorProducto.get(pid).push(g);
  }

  return { negocioId: nid, productosPorSku, productosPorId, productosPorNombreUnico, gruposPorProducto, opcionesPorId };
}

// ─── Resolución de una línea ────────────────────────────────────────────────

function resolverProducto(itemRappi, catalogo) {
  const sku = itemRappi.sku != null ? String(itemRappi.sku).trim() : '';
  if (sku) {
    const p = catalogo.productosPorSku.get(sku.toUpperCase());
    if (p) return { producto: p, mapeo: 'sku' };
    // `XB-<id>` con un código escrito a mano que lo pisó: la PK sigue siendo
    // la identidad (misma regla que skuDeProducto).
    const m = new RegExp(`^${PREFIJO_SKU}(\\d+)$`, 'i').exec(sku);
    if (m) {
      const p2 = catalogo.productosPorId.get(Number(m[1]));
      if (p2) return { producto: p2, mapeo: 'sku' };
    }
  }
  const nombre = itemRappi.name ?? itemRappi.product_name ?? '';
  const k = normalizarClaveMapeo(nombre);
  if (k) {
    const p = catalogo.productosPorNombreUnico.get(k);
    if (p) return { producto: p, mapeo: 'nombre' };
  }
  return { producto: null, mapeo: 'sin_resolver' };
}

function resolverOpcion(subitem, producto, catalogo) {
  const grupos = producto ? (catalogo.gruposPorProducto.get(Number(producto.id)) || []) : [];
  const sku = subitem.sku != null ? String(subitem.sku).trim() : '';
  if (sku) {
    const m = new RegExp(`^${PREFIJO_SKU_OPCION}(\\d+)$`, 'i').exec(sku);
    if (m) {
      const hit = catalogo.opcionesPorId.get(Number(m[1]));
      // La opción debe ser de ESTE producto: un XB-op- de otro producto (o de
      // otro negocio) no se acepta aunque exista.
      if (hit && grupos.some(g => Number(g.id) === Number(hit.grupo.id))) return { ...hit, mapeo: 'sku' };
      if (hit) return { opcion: null, grupo: null, mapeo: 'sin_resolver', motivo: 'opcion_de_otro_producto' };
    }
  }
  const k = normalizarClaveMapeo(subitem.name ?? subitem.topping_name ?? '');
  if (k && grupos.length) {
    const candidatos = [];
    for (const g of grupos) for (const o of g.opciones) if (normalizarClaveMapeo(o.nombre) === k) candidatos.push({ opcion: o, grupo: g });
    if (candidatos.length === 1) return { ...candidatos[0], mapeo: 'nombre' };
    if (candidatos.length > 1) return { opcion: null, grupo: null, mapeo: 'sin_resolver', motivo: 'nombre_ambiguo' };
  }
  return { opcion: null, grupo: null, mapeo: 'sin_resolver', motivo: producto ? 'no_en_catalogo' : 'producto_sin_resolver' };
}

function cantidadDe(x) {
  const n = Number(x?.quantity ?? x?.units ?? 1);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

function mapearItem(itemRappi, catalogo) {
  const { producto, mapeo } = resolverProducto(itemRappi, catalogo);
  const cantidad = cantidadDe(itemRappi);
  const precioRappi = num(itemRappi.price ?? itemRappi.unit_price, 0);
  const nombreRecibido = String(itemRappi.name ?? itemRappi.product_name ?? '').trim() || 'Producto Rappi';
  const subitems = Array.isArray(itemRappi.subitems) ? itemRappi.subitems
    : Array.isArray(itemRappi.toppings) ? itemRappi.toppings
    : Array.isArray(itemRappi.sub_items) ? itemRappi.sub_items : [];

  const modificadores = [];
  const sinResolver = [];
  let extrasRappi = 0;
  for (const s of subitems) {
    const r = resolverOpcion(s, producto, catalogo);
    const cant = cantidadDe(s);
    const precio = num(s.price ?? s.unit_price, 0);
    extrasRappi += precio * cant;
    const nombreSub = String(s.name ?? s.topping_name ?? '').trim();
    if (r.opcion) {
      for (let i = 0; i < cant; i++) {
        modificadores.push({
          grupo_id: r.grupo.id, grupo: r.grupo.nombre,
          opcion_id: r.opcion.id, opcion: r.opcion.nombre,
          precio_extra: precio,                       // lo que cobró Rappi
          precio_extra_catalogo: num(r.opcion.precio_extra, 0),
          mapeo: r.mapeo,
          rappi: { sku: s.sku ?? null, id: s.id ?? null },
        });
      }
    } else {
      // Sin catálogo: se conserva y se imprime tal cual (el renderer lee
      // `opcion`), y queda auditado aparte. Nunca se descarta.
      modificadores.push({
        grupo_id: null, grupo: null, opcion_id: null, opcion: nombreSub || 'Extra Rappi',
        precio_extra: precio, sin_catalogo: true, mapeo: 'sin_resolver', motivo: r.motivo,
        rappi: { sku: s.sku ?? null, id: s.id ?? null, cantidad: cant },
      });
      sinResolver.push({ nombre: nombreSub, sku: s.sku ?? null, cantidad: cant, precio, motivo: r.motivo });
    }
  }

  const comentarios = String(itemRappi.comments ?? itemRappi.comment ?? '').trim().slice(0, NOTAS_MAX);
  const item = {
    producto_id: producto ? Number(producto.id) : null,
    categoria_id: producto ? (producto.categoria_id ?? null) : null,
    nombre: producto ? producto.nombre : nombreRecibido,
    nombre_recibido: nombreRecibido,
    cantidad,
    precio_unitario: precioRappi,
    precio_base_catalogo: producto ? num(producto.precio, 0) : null,
    precio_extras: extrasRappi,
    modificadores,
    modificadores_sin_resolver: sinResolver.length ? sinResolver : undefined,
    notas: comentarios || undefined,
    mapeo,
    no_disponible: producto ? (producto.disponible === false || producto.agotado === true) || undefined : undefined,
    rappi: { id: itemRappi.id ?? null, sku: itemRappi.sku ?? null, quantity: cantidad, price: precioRappi },
  };
  return item;
}

// ─── Orden completa ─────────────────────────────────────────────────────────

/**
 * @param {ReturnType<typeof normalizarSobreRappi>} sobre
 * @param {Awaited<ReturnType<typeof cargarCatalogoParaRappi>>} catalogo
 * @param {{ negocioId: string, negocioSlug?: string, sucursalId?: string|null }} negocio
 */
export function mapearOrdenRappi(sobre, catalogo, negocio) {
  if (!sobre) throw new Error('mapearOrdenRappi: sobre requerido');
  if (!negocio || typeof negocio.negocioId !== 'string' || !negocio.negocioId.trim()) {
    const e = new Error('mapearOrdenRappi: negocioId requerido');
    e.code = 'TENANT_CONTEXT_REQUIRED';
    throw e;
  }
  const orderId = sobre.orderId;
  const items = sobre.items.map(i => mapearItem(i, catalogo));

  const t = sobre.totals || {};
  const total = num(t.total_order ?? t.total ?? sobre.detalle?.total_price, NaN);
  const subtotal = num(t.total_products, NaN);
  const descuento = num(t.total_discounts, 0);
  // Si Rappi no manda totales (formato plano viejo), se suman las líneas tal
  // cual llegaron -- sigue siendo lo que Rappi cobró, no un precio nuestro.
  const sumaLineas = items.reduce((s, i) => s + i.precio_unitario * i.cantidad + i.precio_extras, 0);

  const c = sobre.customer || {};
  const nombreCliente = [c.name, c.first_name ?? c.firstName, c.last_name ?? c.lastName].filter(Boolean).join(' ').trim()
    || `Cliente Rappi #${orderId}`;
  const d = sobre.delivery || {};
  const modalidad = String(sobre.deliveryMethod || '').toLowerCase() === 'pickup' ? 'recoger en tienda' : 'entrega a domicilio';

  const resumen = {
    resueltos: items.filter(i => i.mapeo === 'sku').length,
    por_nombre: items.filter(i => i.mapeo === 'nombre').length,
    sin_resolver: items.filter(i => i.mapeo === 'sin_resolver').map(i => ({ nombre: i.nombre_recibido, sku: i.rappi.sku })),
    modificadores_sin_resolver: items.flatMap(i => (i.modificadores_sin_resolver || []).map(m => ({ producto: i.nombre_recibido, ...m }))),
    no_disponibles: items.filter(i => i.no_disponible).map(i => i.nombre),
  };
  resumen.requiere_revision = resumen.sin_resolver.length > 0 || resumen.modificadores_sin_resolver.length > 0 || resumen.no_disponibles.length > 0;

  const orden = {
    rappi_order_id: orderId,
    canal: CANAL,
    pago: 'rappi_pay',            // Pago ya procesado por Rappi
    cliente: {
      nombre: nombreCliente,
      // Teléfono SINTÉTICO a propósito (clientes.telefono es PK global y el
      // número de Rappi suele ser un proxy): identifica a la orden, no a la
      // persona. El número real, si viene, queda en `rappi.customer`.
      telefono: `rappi-${orderId}`,
      calle: d.complete_address || [d.street_name, d.street_number].filter(Boolean).join(' ') || 'Dirección Rappi',
      colonia: d.neighborhood || '',
      entre_calles: d.complement || '',
    },
    modalidad,
    items,
    subtotal: Number.isFinite(subtotal) ? subtotal : (Number.isFinite(total) ? total : sumaLineas),
    costo_envio: 0,               // Rappi cobra su propio envío
    descuento,
    total: Number.isFinite(total) ? total : sumaLineas,
    negocioId: negocio.negocioId.trim(),
    negocioSlug: negocio.negocioSlug,
    sucursalId: negocio.sucursalId ?? null,
    mapeo: resumen,
    rappi: {
      order_id: orderId,
      store_id: sobre.storeId,
      formato: sobre.formato,
      delivery_method: sobre.deliveryMethod,
      payment_method: sobre.paymentMethod,
      cooking_time: sobre.cookingTime,
      created_at: sobre.createdAt,
      totals: t,
      customer: { first_name: c.first_name ?? c.name ?? null, last_name: c.last_name ?? null, phone_number: c.phone_number ?? c.phone ?? null },
      delivery_information: d,
    },
  };
  return { orden, auditoria: resumen };
}
