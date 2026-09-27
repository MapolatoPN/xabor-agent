// Publica para WhatsApp (migración 098) productos de un negocio de prueba.
//
// Desde que TODO bot de WhatsApp —el Agente v1 y el legacy de brain.js— vende
// solo la carta publicada, un fixture que espera que el bot conozca sus
// productos, o que registra un pedido por el canal `whatsapp`, tiene que
// publicarlos, igual que lo hace el dueño en Menú › Productos para WhatsApp.
// Pasa por el mismo servicio que usa el panel (`publicarProductosWhatsapp`),
// así que respeta el aislamiento por negocio: un id de otro negocio no se
// publica.
//
// `productoIds` null publica TODOS los productos que el negocio tenga en este
// momento; los que se creen después nacen sin publicar, como en producción.
import { publicarProductosWhatsapp } from '../src/services/catalogoWhatsapp.js';

export async function publicarCartaWhatsapp(pool, negocioId, productoIds = null) {
  const ids = Array.isArray(productoIds)
    ? productoIds
    : (await pool.query('SELECT id FROM menu_productos WHERE negocio_id = $1', [negocioId])).rows.map((r) => r.id);
  if (!ids.length) return { actualizados: 0 };
  return publicarProductosWhatsapp(negocioId, ids, true, { db: pool });
}

/** Publica los productos del negocio con esos nombres exactos (fixtures sin ids a mano). */
export async function publicarPorNombre(pool, negocioId, nombres) {
  const { rows } = await pool.query(
    'SELECT id FROM menu_productos WHERE negocio_id = $1 AND nombre = ANY($2::text[])', [negocioId, nombres]);
  return publicarCartaWhatsapp(pool, negocioId, rows.map((r) => r.id));
}

export async function retirarDeWhatsapp(pool, negocioId, productoIds) {
  return publicarProductosWhatsapp(negocioId, productoIds, false, { db: pool });
}
