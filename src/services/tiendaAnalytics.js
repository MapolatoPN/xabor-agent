// ─── Google Analytics 4 de la tienda pública (por negocio) ─────────────────
//
// Cada negocio puede guardar su propio ID de medición de GA4 (G-XXXXXXX). Si
// no lo tiene, la tienda no carga nada de Google: ni gtag.js ni un evento.
//
// Dónde vive: `configuracion.ga4_measurement_id` (sin migración, como
// tienda_metodos_pago o tienda_banner). El valor se valida al GUARDAR y otra
// vez al LEER: una fila escrita a mano con basura queda inerte, nunca llega a
// un <script src> en el navegador.
//
// Qué NO sale de aquí hacia Analytics: nombre, teléfono, dirección, correo,
// notas del cliente ni el nombre de la persona de una orden por persona. El
// `purchase` se arma con datos de catálogo (producto, categoría, opciones,
// precio, cantidad) y montos del pedido, y nada más.
//
// El navegador NO es autoridad del `purchase`: lo arma el servidor desde el
// pedido guardado en pedidos_activos, y solo cuando el pedido ya quedó
// confirmado (pagado en línea, o aceptado para pagarse al recibir).
import { pool } from './database.js';
import { TiendaError } from './tiendaOnline.js';

export const CLAVE_GA4 = 'ga4_measurement_id';
export const GA4_REGEX = /^G-[A-Z0-9]+$/;
const GA4_LARGO_MAX = 32;
const MONEDA = 'MXN';
// Tope de GA4 para textos de parámetros estándar.
const LARGO_TEXTO = 100;

// Un pedido en estos estados todavía no es una compra (o ya no lo será).
const ESTADOS_SIN_COMPRA = new Set(['pendiente_pago', 'cancelado']);

// ── Validación ──────────────────────────────────────────────────────────────

/**
 * Lo que escribe el dueño en el panel → valor a guardar.
 * Vacío/null = quitar. Acepta minúsculas y espacios alrededor (los IDs de GA4
 * son siempre mayúsculas, así que corregirlo no cambia el significado).
 * Cualquier otra cosa lanza GA4_ID_INVALIDO con un mensaje para el dueño.
 */
export function normalizarGa4Id(valor) {
  if (valor === null || valor === undefined) return null;
  const s = String(valor).trim().toUpperCase();
  if (!s) return null;
  if (s.length > GA4_LARGO_MAX || !GA4_REGEX.test(s)) {
    throw new TiendaError(
      'El ID de medición de Google Analytics 4 debe verse así: G-XXXXXXXXXX',
      'GA4_ID_INVALIDO', 400);
  }
  return s;
}

/** Lo que hay guardado → ID utilizable o null. Nunca lanza: lectura estricta. */
export function ga4IdValido(valor) {
  if (typeof valor !== 'string') return null;
  const s = valor.trim();
  return s.length <= GA4_LARGO_MAX && GA4_REGEX.test(s) ? s : null;
}

// ── Lectura y guardado por negocio ──────────────────────────────────────────

/**
 * ID de medición del negocio, o null. Falla cerrado y en silencio: la
 * analítica jamás puede tumbar la tienda, así que un error de base aquí se
 * traduce en "sin analítica", no en un 500.
 */
export async function obtenerGa4Id(negocioId) {
  try {
    const { rows: [r] } = await pool.query(
      'SELECT valor FROM configuracion WHERE negocio_id = $1 AND clave = $2',
      [negocioId, CLAVE_GA4]);
    return ga4IdValido(r?.valor);
  } catch (e) {
    console.warn(`[Tienda/GA4] No se pudo leer el ID de ${negocioId}: ${e.message}`);
    return null;
  }
}

/** Guarda (o quita, con vacío) el ID del negocio. Devuelve lo que quedó. */
export async function guardarGa4Id(negocioId, valor) {
  const id = normalizarGa4Id(valor);
  if (!id) {
    await pool.query('DELETE FROM configuracion WHERE negocio_id = $1 AND clave = $2', [negocioId, CLAVE_GA4]);
    return null;
  }
  await pool.query(
    `INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1, $2, $3)
     ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = $3`,
    [negocioId, CLAVE_GA4, id]);
  return id;
}

// ── Purchase desde el pedido guardado ───────────────────────────────────────

const dinero = n => Math.round((Number(n) || 0) * 100) / 100;
const texto = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, LARGO_TEXTO);

/**
 * Un renglón del pedido (forma de recalcularItemsDesdeMenu) → item de GA4.
 * Se eligen campos uno por uno a propósito: `notas` (texto libre del cliente)
 * y `persona` (nombre de quien pidió) NUNCA se copian.
 */
export function itemGa4DeRenglon(renglon, categorias = new Map()) {
  if (!renglon || renglon.producto_id == null || !renglon.nombre) return null;
  const categoria = categorias.get(Number(renglon.categoria_id));
  const variante = (Array.isArray(renglon.modificadores) ? renglon.modificadores : [])
    .map(m => m?.opcion).filter(Boolean).join(', ');
  return {
    item_id: String(renglon.producto_id),
    item_name: texto(renglon.nombre),
    ...(categoria ? { item_category: texto(categoria) } : {}),
    ...(variante ? { item_variant: texto(variante) } : {}),
    price: dinero(renglon.precio_unitario),
    quantity: Math.max(1, parseInt(renglon.cantidad, 10) || 1),
  };
}

/**
 * Pedido confirmado → parámetros del evento `purchase`, o null si todavía no
 * es (o ya no será) una compra.
 *
 *   value    = productos después de promociones, SIN envío y SIN impuestos
 *              (así lo pide GA4). Los puntos de Rewards no se restan: en
 *              Xabor el punto es una forma de pago, no un descuento de
 *              mercancía (ver tiendaCheckout.js, "el punto sirve para pagar").
 *   shipping = envío realmente cobrado (0 si fue gratis).
 *   tax      = 0. Los precios de Xabor ya incluyen IVA y el pedido no lo
 *              desglosa; mandar un IVA calculado aquí sería inventarlo.
 *   coupon   = códigos de promoción aplicados, si hubo.
 */
export function compraGa4DePedido({ folio, estado, datos, categorias = new Map() }) {
  if (!folio || !estado || ESTADOS_SIN_COMPRA.has(estado)) return null;
  const d = datos || {};
  const items = (Array.isArray(d.items) ? d.items : [])
    .map(r => itemGa4DeRenglon(r, categorias)).filter(Boolean);
  if (!items.length) return null;

  const subtotalGuardado = d.subtotal == null ? NaN : Number(d.subtotal);
  const subtotal = Number.isFinite(subtotalGuardado)
    ? subtotalGuardado
    : items.reduce((s, i) => s + i.price * i.quantity, 0);
  const cupones = [...new Set((Array.isArray(d.tienda?.promociones) ? d.tienda.promociones : [])
    .map(p => p?.codigo).filter(Boolean).map(c => texto(c)))];

  return {
    transaction_id: String(folio),
    currency: MONEDA,
    value: dinero(Math.max(0, subtotal - (Number(d.descuento) || 0))),
    tax: 0,
    shipping: dinero(Math.max(0, Number(d.costo_envio) || 0)),
    ...(cupones.length ? { coupon: texto(cupones.join(',')) } : {}),
    items,
  };
}

/**
 * Lo que necesita la página (tienda o seguimiento) para la analítica de UN
 * pedido, resuelto SOLO por el token de seguimiento (192 bits, opaco).
 *
 *   ga4MeasurementId: ID del negocio dueño del pedido, o null.
 *   compra:           parámetros de `purchase` si el pedido ya está confirmado.
 *   pendiente:        true mientras el pedido espera su pago en línea.
 *
 * Sin ID de medición no se arma ni se devuelve compra alguna: un negocio que
 * no usa Analytics no expone ni un dato de más.
 */
export async function analyticsDeSeguimiento(trackingToken) {
  const token = String(trackingToken || '').trim();
  if (!/^[a-f0-9]{48}$/.test(token)) throw new TiendaError('Pedido no encontrado', 'TRACKING_INVALIDO', 404);
  const { rows: [r] } = await pool.query(
    `SELECT tp.negocio_id, tp.pedido_folio, pa.estado, pa.datos
       FROM tienda_pedidos tp
       LEFT JOIN pedidos_activos pa ON pa.folio = tp.pedido_folio AND pa.negocio_id = tp.negocio_id
      WHERE tp.tracking_token = $1`, [token]);
  if (!r || !r.pedido_folio) throw new TiendaError('Pedido no encontrado', 'TRACKING_NO_EXISTE', 404);

  const ga4MeasurementId = await obtenerGa4Id(r.negocio_id);
  const pendiente = r.estado === 'pendiente_pago';
  if (!ga4MeasurementId) return { ga4MeasurementId: null, compra: null, pendiente };

  const idsCategoria = [...new Set((r.datos?.items || [])
    .map(i => Number(i?.categoria_id)).filter(Number.isFinite))];
  let categorias = new Map();
  if (idsCategoria.length) {
    const { rows } = await pool.query(
      'SELECT id, nombre FROM menu_categorias WHERE negocio_id = $1 AND id = ANY($2::int[])',
      [r.negocio_id, idsCategoria]);
    categorias = new Map(rows.map(c => [Number(c.id), c.nombre]));
  }
  return {
    ga4MeasurementId,
    compra: compraGa4DePedido({ folio: r.pedido_folio, estado: r.estado, datos: r.datos, categorias }),
    pendiente,
  };
}
