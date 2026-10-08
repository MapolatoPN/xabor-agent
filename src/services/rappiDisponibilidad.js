// ─── RAPPI QUEDA IGUAL A LA LISTA ÚNICA ──────────────────────────────────
//
// POST /menu de Rappi crea o actualiza los productos que recibe, pero NO borra
// los que ya estaban (comprobado el 2026-10-08: tras subir 60 productos,
// siguieron los 34 de una subida anterior). La única forma de quitarlos es
// APAGARLOS por SKU. Y un producto apagado no vuelve solo con otra subida:
// hay que prenderlo (FAQ de Rappi).
//
// Así que al subir el menú se apaga todo producto del negocio que no va en el
// catálogo (no publicado en la tienda, agotado, no disponible, cargo de envío)
// y se prende lo que sí va. Xabor manda: si alguien apagó en Rappi algo que en
// Xabor está publicado y disponible, la subida lo vuelve a prender.
import { pool } from './database.js';
import { skuDeProducto, actualizarDisponibilidadTienda } from './rappi-api.js';

/** SKUs de los productos del negocio que NO van en el catálogo. */
export async function skusFueraDelCatalogo(negocioId, catalogo, { db = pool } = {}) {
  const dentro = new Set((catalogo?.items || []).map((i) => String(i.sku)));
  const { rows } = await db.query(
    'SELECT id, codigo FROM menu_productos WHERE negocio_id = $1', [negocioId]);
  return [...new Set(rows.map(skuDeProducto))].filter((sku) => !dentro.has(sku));
}

/** Apaga lo de fuera y prende lo de dentro. Devuelve { apagados, encendidos, errores[] }. */
export async function sincronizarDisponibilidadRappi(negocioId, storeId, catalogo, opts = {}) {
  const apagar = await skusFueraDelCatalogo(negocioId, catalogo, opts);
  const encender = (catalogo?.items || []).map((i) => String(i.sku));
  return actualizarDisponibilidadTienda(storeId, { encender, apagar });
}
