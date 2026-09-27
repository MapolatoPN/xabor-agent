/**
 * revisionMenuWhatsapp.js — ¿Puede salir el menú EN IMAGEN de este negocio?
 *
 * Una imagen del menú es opaca: Xabor no sabe qué productos muestra. Solo sale
 * si su administrador la revisó contra la carta de WhatsApp VIGENTE; si no, el
 * cliente recibe el menú en texto generado desde la carta (menuAutomatico.js).
 * La huella de la carta y la del conjunto de imágenes las calcula la base
 * (migración 100) en cada consulta, así que cualquier cambio —panel, SQL,
 * siembra de la 098, borrados en cascada, categorías— invalida la revisión sin
 * que nadie tenga que acordarse de marcarla.
 *
 * Nada de este módulo expone storage keys: el panel recibe huellas opacas.
 */
import { pool } from './database.js';

export const ESTADOS_REVISION = Object.freeze([
  'vigente', 'nunca_revisada', 'carta_cambio', 'imagenes_cambiaron',
  'sin_carta', 'sin_imagenes', 'sin_menu', 'error_lectura',
]);

const negocioValido = (n) => typeof n === 'string' && /^[0-9a-f-]{36}$/i.test(n.trim());

/**
 * Estado de la revisión para los objetos que se están por enviar. NUNCA lanza:
 * si no se puede comprobar, responde 'error_lectura' y el llamador no manda
 * imágenes (fallo cerrado).
 */
export async function estadoRevisionParaEnvio(negocioId, claves, { db = pool } = {}) {
  if (!negocioValido(negocioId)) return 'error_lectura';
  try {
    const { rows: [r] } = await db.query(
      'SELECT estado_revision_menu_whatsapp($1::uuid, $2::text[]) AS estado',
      [negocioId.trim(), Array.isArray(claves) ? claves.map(String) : null]);
    return ESTADOS_REVISION.includes(r?.estado) ? r.estado : 'error_lectura';
  } catch (e) {
    console.error(`[MenuAutomatico] negocio=${negocioId} no se pudo comprobar la revisión del menú: ${e?.message}`);
    return 'error_lectura';
  }
}

/** Qué cambió en la carta desde la revisión (para explicarlo en el panel). Pura. */
export function cambiosDeCarta(antes, ahora) {
  const mapa = (lista) => new Map((Array.isArray(lista) ? lista : []).map((p) => [Number(p.id), p]));
  const a = mapa(antes);
  const b = mapa(ahora);
  const retirados = [];
  const agregados = [];
  const cambiados = [];
  for (const [id, p] of a) {
    const q = b.get(id);
    if (!q) { retirados.push(String(p.nombre)); continue; }
    const detalles = [];
    if (String(p.nombre) !== String(q.nombre)) detalles.push(`nombre: «${p.nombre}» → «${q.nombre}»`);
    if (Number(p.precio) !== Number(q.precio)) detalles.push(`precio: $${p.precio} → $${q.precio}`);
    if (Boolean(p.disponible) !== Boolean(q.disponible)) detalles.push(q.disponible ? 'volvió a estar disponible' : 'ya no está disponible');
    if (detalles.length) cambiados.push(`${q.nombre} (${detalles.join('; ')})`);
  }
  for (const [id, q] of b) if (!a.has(id)) agregados.push(String(q.nombre));
  return { retirados, agregados, cambiados };
}

/**
 * Lo que el panel necesita para explicar la revisión. Nunca lanza.
 * `huellaCarta`/`huellaImagenes` vuelven al servidor al confirmar: si algo
 * cambió mientras el administrador miraba, la confirmación se rechaza.
 */
export async function leerRevisionParaPanel(negocioId, { db = pool, claves = null } = {}) {
  if (!negocioValido(negocioId)) return { estado: 'error_lectura' };
  // `claves`: las storage keys de las páginas que el panel va a pintar. Con
  // ellas, la huella que el admin devuelve al confirmar corresponde EXACTAMENTE
  // a lo que vio (una página agregada entre dos lecturas no se cuela).
  const lista = Array.isArray(claves) ? claves.map(String) : null;
  try {
    const { rows: [r] } = await db.query(
      `SELECT estado_revision_menu_whatsapp($1::uuid, $2::text[])                              AS estado,
              huella_carta_whatsapp($1::uuid)                                                  AS huella_carta,
              huella_imagenes_menu(COALESCE($2::text[], imagenes_menu_whatsapp($1::uuid)))     AS huella_imagenes,
              carta_whatsapp_canonica($1::uuid)                                                AS carta,
              m.revision_carta, m.revisado_at, u.nombre AS revisado_por_nombre
         FROM (SELECT 1) uno
         LEFT JOIN whatsapp_menu_automatico m ON m.negocio_id = $1::uuid
         LEFT JOIN usuarios u ON u.id = m.revisado_por`,
      [negocioId.trim(), lista]);
    const carta = Array.isArray(r.carta) ? r.carta : [];
    return {
      estado: ESTADOS_REVISION.includes(r.estado) ? r.estado : 'error_lectura',
      huellaCarta: r.huella_carta,
      huellaImagenes: r.huella_imagenes,
      revisadoEn: r.revisado_at || null,
      revisadoPor: r.revisado_por_nombre || null,
      cambios: r.revision_carta ? cambiosDeCarta(r.revision_carta, carta) : null,
      carta: carta.map((p) => ({ nombre: p.nombre, precio: p.precio, disponible: p.disponible })),
    };
  } catch (e) {
    console.error(`[MenuAutomatico] negocio=${negocioId} no se pudo leer la revisión del menú: ${e?.message}`);
    return { estado: 'error_lectura' };
  }
}

/**
 * El administrador confirma que las imágenes muestran solo lo que ofrece por
 * WhatsApp. Compare-and-set en UNA sentencia: se registra solo si la carta y
 * las imágenes siguen siendo las que él vio (sus huellas).
 */
export async function registrarRevisionMenu(negocioId, usuarioId, { huellaCarta, huellaImagenes } = {}, { db = pool } = {}) {
  if (!negocioValido(negocioId)) return { ok: false, codigo: 'NEGOCIO_INVALIDO' };
  if (!usuarioId) return { ok: false, codigo: 'SIN_USUARIO' };
  if (typeof huellaCarta !== 'string' || typeof huellaImagenes !== 'string') {
    return { ok: false, codigo: 'HUELLAS_REQUERIDAS' };
  }
  const { rows } = await db.query(
    `UPDATE whatsapp_menu_automatico
        SET revision_carta_huella    = huella_carta_whatsapp(negocio_id),
            revision_imagenes_huella = huella_imagenes_menu(imagenes_menu_whatsapp(negocio_id)),
            revision_carta           = carta_whatsapp_canonica(negocio_id),
            revisado_at              = NOW(),
            revisado_por             = $2
      WHERE negocio_id = $1::uuid
        AND huella_carta_whatsapp(negocio_id) = $3
        AND huella_imagenes_menu(imagenes_menu_whatsapp(negocio_id)) = $4
        AND cardinality(imagenes_menu_whatsapp(negocio_id)) > 0
        AND jsonb_array_length(carta_whatsapp_canonica(negocio_id)) > 0
      RETURNING negocio_id`,
    [negocioId.trim(), usuarioId, huellaCarta, huellaImagenes]);
  if (rows.length) return { ok: true, revision: await leerRevisionParaPanel(negocioId, { db }) };
  // ¿Por qué no? Se explica con el estado actual, sin revelar nada más.
  const revision = await leerRevisionParaPanel(negocioId, { db });
  const codigo = revision.estado === 'sin_menu' ? 'SIN_MENU'
    : revision.estado === 'sin_imagenes' ? 'SIN_IMAGENES'
      : revision.estado === 'sin_carta' ? 'SIN_CARTA'
        : 'CAMBIO_DURANTE_REVISION';
  return { ok: false, codigo, revision };
}
