// ─── Vista previa de promociones para el carrito del POS ────────────────────
//
// La promoción automática se aplica al CREAR el pedido. Hasta entonces el
// carrito del POS mostraba el precio completo, y quien atiende le decía al
// cliente un total que no era el que iba a pagar (la promo aparecía después,
// en la tarjeta o en Cobrar).
//
// Aquí se calcula, SIN escribir nada, lo mismo que calculará el alta:
//   · Para llevar (mostrador) → promocionesParaMostrador, igual que
//     POST /api/pedido-presencial (bandera, canal 'pos', cliente identificado).
//   · Recoger / Domicilio (envíos) → calcularPromociones con los mismos
//     argumentos que POST /api/pos/pedidos.
// Es una ESTIMACIÓN para la pantalla: el total que vale lo fija el alta.
// También devuelve las «oportunidades» del motor (falta 1 para el 2x1) con los
// nombres de los productos que participan, para que el carrito las diga.
import { pool } from './database.js';
import { resolverProductoConModificadores } from './modificadores.js';
import { recalcularItemsDesdeMenu } from './posEnvios.js';
import { calcularPromociones } from './tiendaPromociones.js';
import { promocionesParaMostrador } from './promocionesMostrador.js';
import { redondear } from './descuentos.js';

export const MODALIDADES_CARRITO = new Set(['llevar', 'recoger', 'domicilio']);
const MAX_LINEAS = 100;

export class PreviewCarritoError extends Error {
  constructor(mensaje, codigo) { super(mensaje); this.codigo = codigo; this.status = 400; }
}

// Igual que /api/pedido-presencial: lo del menú lo resuelve el servidor (nombre,
// precio, modificadores); lo libre pasa con su precio, como en el alta.
async function itemsDeMostrador(negocioId, crudos) {
  const items = [];
  for (const it of crudos) {
    if (it && it.producto_id !== undefined && it.producto_id !== null && it.producto_id !== '') {
      const r = await resolverProductoConModificadores(negocioId, it.producto_id, it.modificadores);
      items.push({
        producto_id: r.producto.id, nombre: r.producto.nombre,
        cantidad: Math.max(1, Math.min(99, parseInt(it.cantidad, 10) || 1)),
        precio_unitario: r.precioUnitario, precio_base: r.precioBase, modificadores: r.modificadores,
      });
    } else {
      items.push(it);
    }
  }
  const subtotal = items.reduce((s, i) => s + (i.precio_unitario || 0) * (i.cantidad || 1), 0);
  return { items, subtotal };
}

// Nombres de los productos que participan en cada promoción con oportunidad.
// Solo adorna el aviso: si falla, el aviso sale sin nombres.
async function productosDePromos(negocioId, ids) {
  if (!ids.length) return new Map();
  try {
    const { rows } = await pool.query(
      `SELECT tp.id::text AS id, array_agg(mp.nombre ORDER BY mp.nombre) AS nombres
         FROM tienda_promociones tp
         JOIN LATERAL jsonb_array_elements_text(
                CASE WHEN jsonb_typeof(tp.productos) = 'array' THEN tp.productos ELSE '[]'::jsonb END) pid ON TRUE
         JOIN menu_productos mp ON mp.negocio_id = tp.negocio_id AND mp.id::text = pid
        WHERE tp.negocio_id = $1 AND tp.id = ANY($2::uuid[])
        GROUP BY tp.id`,
      [negocioId, ids]);
    return new Map(rows.map(r => [r.id, r.nombres || []]));
  } catch (e) {
    console.error(`[Promo carrito] No se leyeron los productos de las promociones: ${e.message}`);
    return new Map();
  }
}

/**
 * @returns {{ subtotal, descuento, envio, envioGratis, total,
 *             promociones: {id, nombre, descuento, envioGratis}[],
 *             oportunidades: {promocionId, nombre, unidadesFaltantes, productos}[] }}
 */
export async function previsualizarPromosCarrito(negocioId, {
  items, modalidad, telefono = null, costoEnvio = 0,
} = {}) {
  if (!MODALIDADES_CARRITO.has(modalidad)) throw new PreviewCarritoError('Modalidad inválida', 'MODALIDAD_INVALIDA');
  const vacio = { subtotal: 0, descuento: 0, envio: 0, envioGratis: false, total: 0, promociones: [], oportunidades: [] };
  if (!Array.isArray(items) || !items.length) return vacio;
  if (items.length > MAX_LINEAS) throw new PreviewCarritoError('Demasiados productos', 'DEMASIADOS_ITEMS');
  const tel = String(telefono || '').trim() || null;

  let subtotal, descuento = 0, envio = 0, envioGratis = false, promociones = [], oportunidades = [];
  if (modalidad === 'llevar') {
    const r = await itemsDeMostrador(negocioId, items);
    subtotal = r.subtotal;
    const p = await promocionesParaMostrador({ negocioId, items: r.items, subtotal, telefono: tel });
    descuento = p.descuento;
    promociones = p.promociones.map(x => ({ id: x.id, nombre: x.nombre, descuento: x.descuento, envioGratis: false }));
    oportunidades = p.oportunidades;
  } else {
    const r = await recalcularItemsDesdeMenu(negocioId, items);
    subtotal = r.subtotal;
    const costo = Math.max(0, Number(costoEnvio) || 0);
    envio = modalidad === 'domicilio' ? costo : 0;
    try {
      // Mismos argumentos que POST /api/pos/pedidos: lo que se ve es lo que crea.
      const p = await calcularPromociones({
        negocioId, subtotal, items: r.items, costoEnvio: costo,
        modalidad: modalidad === 'domicilio' ? 'domicilio' : 'recoger', canal: 'pos', telefono: tel,
      });
      descuento = Math.min(subtotal, Math.max(0, Number(p.descuento) || 0));
      envio = Math.max(0, Number(p.envio) || 0);
      envioGratis = p.envioGratis === true;
      promociones = (p.aplicadas || [])
        .filter(a => Number(a.descuento) > 0 || a.envioGratis === true)
        .map(a => ({ id: a.id, nombre: a.nombre, descuento: Number(a.descuento) || 0, envioGratis: a.envioGratis === true }));
      oportunidades = Array.isArray(p.oportunidades) ? p.oportunidades : [];
    } catch (e) {
      // Igual que el alta del POS: si el motor falla, el pedido sale sin promoción.
      console.error(`[Promo carrito] El motor falló (negocio=${negocioId}): ${e.message}`);
    }
  }

  const nombres = await productosDePromos(negocioId, oportunidades.map(o => String(o.promocionId)));
  return {
    subtotal: redondear(subtotal),
    descuento: redondear(descuento),
    envio: redondear(envio),
    envioGratis,
    total: redondear(Math.max(0, subtotal - descuento) + envio),
    promociones,
    oportunidades: oportunidades.map(o => ({
      promocionId: o.promocionId, nombre: o.nombre,
      unidadesFaltantes: Number(o.unidadesFaltantes) || 0,
      productos: nombres.get(String(o.promocionId)) || [],
    })),
  };
}
