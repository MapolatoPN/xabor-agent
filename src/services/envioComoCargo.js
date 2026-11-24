// ─── El envío es un cargo, no un producto (Fase 2.4, 23-nov-2026) ─────────
//
// Pedido de Mario: «El envío debe dejar de capturarse como producto y usar el
// campo de envío del pedido». En Obispado se capturaron ENVIO 60 / ENVIO 70
// como producto en el mostrador y el POS, y esa línea contaba como mercancía.
//
// Con la bandera por negocio `envio_solo_como_cargo` encendida:
//   · el catálogo de captura (/api/menu: POS, mostrador, Envíos, Mesas) y el
//     de la tienda pública ya no traen los productos de envío;
//   · el servidor rechaza un producto de envío en el mostrador, el POS de
//     Envíos y el pago de la tienda, con un mensaje que dice dónde se cobra.
// WhatsApp ya los ignoraba (validadorOrden.esProductoEnvio) y Rappi no los
// publica. Apagada, todo sigue como antes.
//
// «Producto de envío» es una marca ESTRUCTURAL del menú, nunca el nombre:
// menu_productos.tipo = 'envio' (el «Tipo» del editor, 151) o la marca vieja
// opciones.tipo_item = 'envio'.
import { pool } from './database.js';
import { esProductoDeEnvio } from './lineasEstructuradas.js';

export const BANDERA_ENVIO = 'envio_solo_como_cargo';
export const CODIGO_ENVIO_COMO_PRODUCTO = 'ENVIO_COMO_PRODUCTO';

export class EnvioComoProductoError extends Error {
  constructor(nombre) {
    super(`«${nombre}» es un envío: no se captura como producto. Cóbralo en el campo de envío del pedido (Envíos a domicilio).`);
    this.name = 'EnvioComoProductoError';
    this.codigo = CODIGO_ENVIO_COMO_PRODUCTO;
  }
}

export async function envioSoloComoCargo(negocioId, db = pool) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return false;
  try {
    const { rows } = await db.query(
      'SELECT valor FROM configuracion WHERE negocio_id = $1 AND clave = $2', [negocioId.trim(), BANDERA_ENVIO]);
    return String(rows[0]?.valor ?? '').trim() === 'true';
  } catch (e) {
    // Leer la bandera nunca tumba un pedido: si falla, se comporta como antes.
    console.error('[Envio] No se pudo leer envio_solo_como_cargo:', e.message);
    return false;
  }
}

// Lanza EnvioComoProductoError si alguno de los productos (por producto_id,
// del menú de ESE negocio) es un envío. Solo con la bandera encendida. Solo
// `producto_id`: el `id` de una línea del carrito puede ser otra cosa, y un
// número que coincidiera con un envío rechazaría un pedido legítimo.
export async function rechazarEnvioComoProducto(negocioId, items, { db = pool, bandera } = {}) {
  const activa = bandera ?? await envioSoloComoCargo(negocioId, db);
  if (!activa) return;
  const ids = [...new Set((Array.isArray(items) ? items : [])
    .map((i) => (i?.producto_id === null || i?.producto_id === undefined || i?.producto_id === '' ? NaN : Number(i.producto_id)))
    .filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) return;
  const { rows } = await db.query(
    `SELECT p.id, p.nombre, p.opciones, to_jsonb(p)->>'tipo' AS tipo
       FROM menu_productos p WHERE p.negocio_id = $1 AND p.id = ANY($2::int[])`, [negocioId, ids]);
  const envio = rows.find(esProductoDeEnvio);
  if (envio) throw new EnvioComoProductoError(envio.nombre);
}

// El menú de captura sin los productos de envío (y sin las categorías que se
// quedan vacías por eso). No muta el original.
export function menuSinEnvios(menu) {
  if (!Array.isArray(menu)) return menu;
  const salida = [];
  for (const c of menu) {
    const productos = Array.isArray(c?.productos) ? c.productos : [];
    const quedan = productos.filter((p) => !esProductoDeEnvio(p));
    if (productos.length && !quedan.length) continue;
    salida.push(quedan.length === productos.length ? c : { ...c, productos: quedan });
  }
  return salida;
}
