// ─── UNA SOLA LISTA DE PRODUCTOS PUBLICADOS ──────────────────────────────
//
// Lo que el negocio publica en su Tienda en línea (`tienda_productos`) es lo
// mismo que ofrece por WhatsApp y lo que sube a Rappi. Decisión de Mario del
// 2026-10-07: «lo que tenemos en tienda en línea, también en Rappi, también
// en el formulario de WhatsApp»; si las listas difieren, manda la tienda.
//
// ── Por qué un espejo y no una lectura nueva ─────────────────────────────
//
// WhatsApp (bot, formulario, validación del pedido y huella de la carta) lee
// `whatsapp_productos` (migración 098). Repuntar todas esas lecturas tocaría
// el camino crítico del pedido. En su lugar, TODA escritura de publicación
// pasa por aquí y cambia las dos tablas en la MISMA sentencia: no hay ventana
// en la que una quede cambiada y la otra no. Rappi lee directamente la tienda
// (`construirCatalogoRappi`).
//
// Las filas de WhatsApp conservan su forma: retirar guarda FALSE (no borra),
// origen 'panel'. Una fila cuyo estado ya coincide no se reescribe.
import { pool } from './database.js';

/**
 * Espejo hacia WhatsApp de las filas que devolvió el CTE `tienda`
 * (negocio_id, producto_id, publicado). `actor` es el parámetro SQL del
 * usuario que hizo el cambio, o NULL.
 */
export const sqlEspejoWhatsapp = (actor = 'NULL::uuid') => `
  INSERT INTO whatsapp_productos (negocio_id, producto_id, publicado, origen, actualizado_por)
  SELECT negocio_id, producto_id, publicado, 'panel', ${actor} FROM tienda
  ON CONFLICT (negocio_id, producto_id) DO UPDATE
    SET publicado = EXCLUDED.publicado, origen = 'panel',
        actualizado_por = EXCLUDED.actualizado_por, updated_at = NOW()
    WHERE whatsapp_productos.publicado IS DISTINCT FROM EXCLUDED.publicado`;

/**
 * Publica o retira productos en la lista única (tienda + WhatsApp).
 * Se eligen por `productoIds` o por `categoriaId` (una categoría entera); el
 * negocio sale SIEMPRE de la sesión y un id ajeno no coincide con nada.
 */
export async function publicarEnListaUnica(negocioId, { productoIds = null, categoriaId = null, publicado, actor = null } = {}, { db = pool } = {}) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) throw new Error('publicarEnListaUnica: negocioId requerido');
  if (typeof publicado !== 'boolean') throw new Error('publicarEnListaUnica: publicado debe ser booleano');
  let filtro, valor;
  if (categoriaId !== null && categoriaId !== undefined) {
    const id = Number(categoriaId);
    if (!Number.isInteger(id) || id <= 0) return { actualizados: 0 };
    filtro = 'p.categoria_id = $2'; valor = id;
  } else {
    const ids = [...new Set((Array.isArray(productoIds) ? productoIds : [])
      .map(Number).filter((id) => Number.isInteger(id) && id > 0))];
    if (!ids.length) return { actualizados: 0 };
    filtro = 'p.id = ANY($2::int[])'; valor = ids;
  }
  const { rows } = await db.query(
    `WITH tienda AS (
       INSERT INTO tienda_productos (negocio_id, producto_id, publicado)
       SELECT $1, p.id, $3 FROM menu_productos p
        WHERE p.negocio_id = $1 AND ${filtro}
       ON CONFLICT (negocio_id, producto_id)
         DO UPDATE SET publicado = EXCLUDED.publicado, updated_at = NOW()
       RETURNING negocio_id, producto_id, publicado
     ), espejo AS (${sqlEspejoWhatsapp('$4::uuid')})
     SELECT count(*)::int AS actualizados FROM tienda`,
    [negocioId.trim(), valor, publicado, actor || null]);
  return { actualizados: rows[0]?.actualizados || 0 };
}
