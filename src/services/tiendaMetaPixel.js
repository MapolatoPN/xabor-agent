// ─── Meta Pixel de la tienda pública (por negocio) ─────────────────────────
//
// Cada negocio puede guardar el ID de su píxel de Meta (Facebook/Instagram):
// 15 o 16 dígitos. Si no lo tiene, la tienda no carga nada de Meta: ni
// fbevents.js ni un evento. Mismo diseño que Google Analytics 4
// (tiendaAnalytics.js), con su propia clave y su propia marca de entrega,
// para que un canal nunca gaste ni tape al otro.
//
// Dónde vive: `configuracion.meta_pixel_id` (sin migración). El valor se
// valida al GUARDAR y otra vez al LEER: una fila escrita a mano con basura
// queda inerte y nunca llega al navegador.
//
// Qué NO sale de aquí hacia Meta: nombre, teléfono, dirección, correo, notas
// del cliente ni el nombre de la persona de una orden por persona. La compra
// se arma con ids de producto, cantidades, precios y el total, y nada más.
//
// El navegador NO es autoridad del `Purchase`: lo arma el servidor desde el
// pedido guardado, solo cuando ya quedó confirmado (pagado en línea, o
// aceptado para pagarse al recibir), y lo entrega UNA vez por folio a un solo
// navegador (entregarCompraMeta).
import { pool } from './database.js';
import { TiendaError } from './tiendaOnline.js';

export const CLAVE_META_PIXEL = 'meta_pixel_id';
export const META_PIXEL_REGEX = /^\d{15,16}$/;
const MONEDA = 'MXN';
const LARGO_TEXTO = 100;
const MAX_CONTENIDOS = 200;

// Un pedido en estos estados todavía no es una compra (o ya no lo será).
const ESTADOS_SIN_COMPRA = new Set(['pendiente_pago', 'cancelado']);

const dinero = n => Math.round((Number(n) || 0) * 100) / 100;
const texto = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, LARGO_TEXTO);

// ── Validación ──────────────────────────────────────────────────────────────

const idInvalido = () => new TiendaError(
  'El Meta Pixel ID son 15 o 16 dígitos, sin letras, guiones ni espacios',
  'META_PIXEL_ID_INVALIDO', 400);

/**
 * Lo que escribe el dueño en el panel → valor a guardar.
 * Vacío/null = quitar. Solo se toleran espacios alrededor. Tiene que llegar
 * como TEXTO: un número de 16 dígitos ya perdió precisión al pasar por JSON
 * (9007199254740993 se lee 9007199254740992), y guardarlo mandaría los datos
 * a un píxel ajeno sin que nadie lo note.
 */
export function normalizarMetaPixelId(valor) {
  if (valor === null || valor === undefined) return null;
  if (typeof valor !== 'string') throw idInvalido();
  const s = valor.trim();
  if (!s) return null;
  if (!META_PIXEL_REGEX.test(s)) throw idInvalido();
  return s;
}

/** Lo que hay guardado → ID utilizable o null. Nunca lanza: lectura estricta. */
export function metaPixelIdValido(valor) {
  if (typeof valor !== 'string') return null;
  const s = valor.trim();
  return META_PIXEL_REGEX.test(s) ? s : null;
}

// ── Lectura y guardado por negocio ──────────────────────────────────────────

/**
 * ID del píxel del negocio, o null. Falla cerrado y en silencio: la
 * medición jamás puede tumbar la tienda, así que un error de base aquí se
 * traduce en "sin píxel", no en un 500.
 */
export async function obtenerMetaPixelId(negocioId) {
  try {
    const { rows: [r] } = await pool.query(
      'SELECT valor FROM configuracion WHERE negocio_id = $1 AND clave = $2',
      [negocioId, CLAVE_META_PIXEL]);
    return metaPixelIdValido(r?.valor);
  } catch (e) {
    console.warn(`[Tienda/MetaPixel] No se pudo leer el ID de ${negocioId}: ${e.message}`);
    return null;
  }
}

/** Guarda (o quita, con vacío) el ID del negocio. Devuelve lo que quedó. */
export async function guardarMetaPixelId(negocioId, valor) {
  const id = normalizarMetaPixelId(valor);
  if (!id) {
    await pool.query('DELETE FROM configuracion WHERE negocio_id = $1 AND clave = $2', [negocioId, CLAVE_META_PIXEL]);
    return null;
  }
  await pool.query(
    `INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1, $2, $3)
     ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = $3`,
    [negocioId, CLAVE_META_PIXEL, id]);
  return id;
}

/**
 * Lo que la API pública de la tienda publica: { pixelId, sucursal } o null.
 * `sucursal` es el nombre visible de la tienda («Mapolato Obispado»): con un
 * mismo píxel en varias sucursales, es lo que las distingue en Meta.
 */
export async function metaPixelPublico(negocioId, sucursal) {
  const pixelId = await obtenerMetaPixelId(negocioId);
  return pixelId ? { pixelId, sucursal: texto(sucursal) } : null;
}

// Nombre visible y slug de la tienda de un negocio, con la misma regla que
// resolverTienda (titular, o el nombre del negocio; slug propio de la tienda,
// o el del negocio).
async function identidadTienda(negocioId) {
  const { rows: [r] } = await pool.query(
    `SELECT COALESCE(NULLIF(t.titular, ''), n.nombre) AS sucursal,
            COALESCE(NULLIF(t.slug_publico, ''), n.slug) AS slug
       FROM negocios n LEFT JOIN tienda_config t ON t.negocio_id = n.id
      WHERE n.id = $1`, [negocioId]);
  return { sucursal: texto(r?.sucursal), slug: r?.slug ? String(r.slug).toLowerCase() : null };
}

// ── Purchase desde el pedido guardado ───────────────────────────────────────

/**
 * Pedido confirmado → evento `Purchase` de Meta, o null si todavía no es (o
 * ya no será) una compra.
 *
 *   eventID     = folio (único en toda la plataforma): Meta lo usa para
 *                 deduplicar la misma compra.
 *   value       = total del pedido, lo que se cobró (con envío, después de
 *                 promociones y de los puntos de Rewards).
 *   content_ids = ids de producto; contents con cantidad y precio unitario
 *                 (con extras); num_items = piezas.
 *
 * Los renglones se leen campo por campo: `notas` (texto libre del cliente) y
 * `persona` (nombre de quien pidió) NUNCA se copian.
 */
export function compraMetaDePedido({ folio, estado, datos, sucursal = '' }) {
  if (!folio || !estado || ESTADOS_SIN_COMPRA.has(estado)) return null;
  const d = datos || {};
  const contents = (Array.isArray(d.items) ? d.items : [])
    .filter(r => r && r.producto_id != null)
    .slice(0, MAX_CONTENIDOS)
    .map(r => ({
      id: String(r.producto_id),
      quantity: Math.max(1, parseInt(r.cantidad, 10) || 1),
      item_price: dinero(r.precio_unitario),
    }));
  if (!contents.length) return null;

  const totalGuardado = d.total == null ? NaN : Number(d.total);
  const total = Number.isFinite(totalGuardado)
    ? totalGuardado
    : contents.reduce((s, c) => s + c.item_price * c.quantity, 0)
      - (Number(d.descuento) || 0) + (Number(d.costo_envio) || 0);

  return {
    eventID: String(folio),
    params: {
      value: dinero(Math.max(0, total)),
      currency: MONEDA,
      content_ids: [...new Set(contents.map(c => c.id))],
      content_type: 'product',
      contents,
      num_items: contents.reduce((s, c) => s + c.quantity, 0),
      ...(texto(sucursal) ? { sucursal: texto(sucursal) } : {}),
    },
  };
}

// Pedido de tienda resuelto SOLO por el token de seguimiento (192 bits, opaco),
// activo o reserva programada (tiendaPedidoPorToken.js).
async function pedidoDeToken(trackingToken) {
  const token = String(trackingToken || '').trim();
  if (!/^[a-f0-9]{48}$/.test(token)) throw new TiendaError('Pedido no encontrado', 'TRACKING_INVALIDO', 404);
  const { pedidoDeTiendaPorToken } = await import('./tiendaPedidoPorToken.js');
  const r = await pedidoDeTiendaPorToken(token);
  if (!r) throw new TiendaError('Pedido no encontrado', 'TRACKING_NO_EXISTE', 404);
  return r;
}

/**
 * Lectura: { metaPixelId, pendiente }. Nunca entrega la compra, así que
 * abrir el seguimiento (cualquier dispositivo, cualquier número de veces) no
 * gasta ni reporta nada. Va por el limitador de LECTURA: el navegador la usa
 * en cada sondeo para saber si ya puede reclamar, sin gastar el cupo del
 * limitador de checkout que comparte con la verificación del pago.
 */
export async function metaPixelDeSeguimiento(trackingToken) {
  const r = await pedidoDeToken(trackingToken);
  return { metaPixelId: await obtenerMetaPixelId(r.negocio_id), pendiente: r.estado === 'pendiente_pago' };
}

// Marca en tienda_pedidos.derivaciones (el ledger por pedido del checkout):
// sin migración, distinta de la de GA4 (`ga4_purchase`).
export const MARCA_COMPRA_META = 'meta_purchase';

/**
 * Entrega el `Purchase` UNA sola vez por folio, a un solo navegador, para
 * siempre. Reclamo atómico: el UPDATE solo escribe si la marca no existe, y
 * Postgres re-evalúa la condición al soltar el candado de la fila, así que de
 * dos reclamos simultáneos exactamente uno recibe la compra.
 *
 * Un pedido pendiente de pago, cancelado o de una tienda sin píxel no gasta
 * la entrega. Si el navegador que la recibió no llega a mandarla (pestaña
 * cerrada en ese instante), esa compra se pierde: se prefiere perder una a
 * duplicarla.
 *
 *   { metaPixelId, compra, pendiente, slug, motivo? }
 *   motivo: 'sin_pixel' | 'pendiente_pago' | 'sin_compra' | 'ya_entregada'
 *   slug: para el marco del seguimiento (ver panel/tienda-meta-pixel.js).
 */
export async function entregarCompraMeta(trackingToken) {
  const r = await pedidoDeToken(trackingToken);
  const pendiente = r.estado === 'pendiente_pago';
  const metaPixelId = await obtenerMetaPixelId(r.negocio_id);
  if (!metaPixelId) return { metaPixelId: null, compra: null, pendiente, motivo: 'sin_pixel' };

  const { sucursal, slug } = await identidadTienda(r.negocio_id);
  const compra = compraMetaDePedido({ folio: r.pedido_folio, estado: r.estado, datos: r.datos, sucursal });
  if (!compra) return { metaPixelId, compra: null, pendiente, motivo: pendiente ? 'pendiente_pago' : 'sin_compra' };

  const { rowCount } = await pool.query(
    `UPDATE tienda_pedidos
        SET derivaciones = derivaciones || jsonb_build_object($2::text, NOW()::text)
      WHERE tracking_token = $1 AND NOT jsonb_exists(derivaciones, $2::text)`,
    [r.token, MARCA_COMPRA_META]);
  if (!rowCount) return { metaPixelId, compra: null, pendiente: false, motivo: 'ya_entregada' };
  return { metaPixelId, compra, pendiente: false, slug };
}
