// ─── EL CATÁLOGO QUE PUEDE OFRECER EL AGENTE DE WHATSAPP ──────────────────
//
// El menú operativo (`menu_productos`) contiene lo que el POS y el inventario
// necesitan: extras sueltos, piezas, productos de cortesía. Un cliente de
// WhatsApp nunca debe verlos ni poder pedirlos. Este módulo entrega al agente
// una carta YA depurada: solo productos publicados para WhatsApp
// (`whatsapp_productos`, migración 098), de categorías activas, y sin
// categorías vacías.
//
// ── Dónde se aplica, y por qué ahí ───────────────────────────────────────
//
// La carta depurada es la ÚNICA que ve CUALQUIER bot de WhatsApp —el Agente v1
// y el bot legacy (brain.js), con sus simuladores—: prompt, búsqueda,
// herramientas, verificación de negativas, promociones, el menú de respaldo en
// texto y la validación del pedido. Un producto oculto no existe para ellos
// aunque el modelo adivine su nombre o su id. Y la puerta final
// (`validarOrdenPropuesta`) lo vuelve a comprobar contra la base para toda
// orden del canal WhatsApp.
//
// ── Lo que NO hace ───────────────────────────────────────────────────────
//
// No toca el menú del POS ni la voz. Desde el 2026-10-07 la publicación es
// una sola lista con la Tienda en línea (y Rappi): publicar o retirar aquí lo
// hace también allá, y al revés (ver publicacionUnica.js). Esta tabla queda
// como el espejo que leen los bots.
//
// ── Fallo cerrado ────────────────────────────────────────────────────────
//
// Si la tabla no existe o la lectura falla, la carta es VACÍA, nunca la
// completa: el agente responde «sin catálogo» y la conversación pasa a una
// persona. Vender algo interno por un error de lectura es el fallo caro.
import { pool, obtenerMenuCompleto } from './database.js';
import { publicarEnListaUnica } from './publicacionUnica.js';

// Los canales cuyo bot automático vende SOLO la carta publicada para WhatsApp.
// `simulador` es el del panel (Entrenamiento), que tiene que mostrar lo mismo
// que vería el cliente. La voz queda fuera a propósito: su carta la decide el
// dueño aparte (ver docs/mesero-pedido-canonico.md, transición del legacy).
export const CANALES_CON_CARTA_PUBLICADA = Object.freeze(['whatsapp', 'simulador']);
export const canalConCartaPublicada = (canal) =>
  CANALES_CON_CARTA_PUBLICADA.includes(String(canal || '').trim().toLowerCase());

const norm = (s) => String(s || '').toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ ]/g, ' ').replace(/\s+/g, ' ').trim();

const negocioValido = (negocioId) => typeof negocioId === 'string' && negocioId.trim() !== '';

/** Filtro PURO: no muta el menú recibido y descarta categorías que quedan vacías. */
export function filtrarMenuPublicadoEnWhatsapp(menu = [], productoIds = []) {
  const publicados = productoIds instanceof Set
    ? new Set([...productoIds].map(Number))
    : new Set((Array.isArray(productoIds) ? productoIds : []).map(Number));
  return (Array.isArray(menu) ? menu : [])
    .map((categoria) => ({
      ...categoria,
      productos: (Array.isArray(categoria?.productos) ? categoria.productos : [])
        .filter((producto) => publicados.has(Number(producto?.id))),
    }))
    .filter((categoria) => categoria.productos.length > 0);
}

/** Los nombres del menú operativo que NO están en la carta publicada. */
export function nombresOcultosDe(menuCompleto = [], cartaPublicada = []) {
  const visibles = new Set(cartaPublicada.flatMap((c) => (c.productos || []).map((p) => norm(p.nombre))));
  const ocultos = [];
  for (const c of (Array.isArray(menuCompleto) ? menuCompleto : [])) {
    for (const p of (c?.productos || [])) {
      const n = norm(p?.nombre);
      if (n && !visibles.has(n) && !ocultos.includes(p.nombre)) ocultos.push(String(p.nombre));
    }
  }
  return ocultos;
}

/** Ids publicados para WhatsApp de categorías activas. Lanza si la base falla. */
export async function idsPublicadosEnWhatsapp(negocioId, { db = pool } = {}) {
  if (!negocioValido(negocioId)) return new Set();
  const { rows } = await db.query(
    `SELECT wp.producto_id
       FROM whatsapp_productos wp
       JOIN menu_productos p
         ON p.id = wp.producto_id AND p.negocio_id = wp.negocio_id
       JOIN menu_categorias c
         ON c.id = p.categoria_id AND c.negocio_id = p.negocio_id
      WHERE wp.negocio_id = $1
        AND wp.publicado = TRUE
        AND c.activa = TRUE`,
    [negocioId.trim()],
  );
  return new Set(rows.map((r) => Number(r.producto_id)));
}

/**
 * La carta del agente y lo que se ocultó de ella.
 *
 * `nombresOcultos` sirve a la emisión segura: si la prosa del modelo nombra un
 * producto que existe en el menú operativo pero no en la carta publicada, esa
 * prosa no sale.
 */
export async function obtenerCatalogoDelAgente(negocioId, {
  db = pool, cargarMenu = obtenerMenuCompleto,
} = {}) {
  if (!negocioValido(negocioId)) return { carta: [], nombresOcultos: [], error: 'negocio_invalido' };
  const menu = await cargarMenu(negocioId.trim());
  let ids;
  try {
    ids = await idsPublicadosEnWhatsapp(negocioId, { db });
  } catch (e) {
    console.error(`[Catalogo WA] negocio=${negocioId} no se pudo leer la publicación: ${e?.message}`);
    return { carta: [], nombresOcultos: nombresOcultosDe(menu, []), error: 'lectura_publicacion' };
  }
  const carta = filtrarMenuPublicadoEnWhatsapp(menu, ids);
  // `obtenerMenuCompleto` se traga sus errores y devuelve []: con productos
  // publicados y un menú vacío, lo que falló es la lectura del menú, no la
  // carta. Sigue siendo una carta vacía (fallo cerrado), con su causa real.
  const error = ids.size > 0 && (!Array.isArray(menu) || menu.length === 0) ? 'lectura_menu' : null;
  return { carta, nombresOcultos: nombresOcultosDe(menu, carta), error };
}

/** Compatibilidad: solo la carta publicada. */
export async function obtenerMenuWhatsapp(negocioId, opciones = {}) {
  return (await obtenerCatalogoDelAgente(negocioId, opciones)).carta;
}

/**
 * ¿Puede un bot de WhatsApp conversar sobre productos en este negocio?
 *
 * Solo si su carta publicada —la MISMA que verían el agente y el legacy— trae
 * al menos un producto. Vacía o ilegible es lo mismo: no hay carta, y el
 * catálogo operativo NO es un respaldo. Nunca lanza: un error de lectura
 * cuenta como «sin carta».
 */
export async function estadoCartaWhatsapp(negocioId, opciones = {}) {
  try {
    const { carta, error } = await obtenerCatalogoDelAgente(negocioId, opciones);
    const productos = (Array.isArray(carta) ? carta : [])
      .reduce((n, c) => n + (Array.isArray(c?.productos) ? c.productos.length : 0), 0);
    return { publicada: !error && productos > 0, productos, error: error || null };
  } catch (e) {
    return { publicada: false, productos: 0, error: `lectura_menu: ${e?.message}` };
  }
}

/**
 * LA CARTA QUE VE UN BOT EN ESTE CANAL. WhatsApp (y su simulador): la
 * publicada, con fallo cerrado (vacía si no se puede leer). Cualquier otro
 * canal: el menú operativo de siempre.
 */
export async function cartaDelCanal(negocioId, canal, opciones = {}) {
  if (!canalConCartaPublicada(canal)) return obtenerMenuCompleto(negocioId);
  return obtenerMenuWhatsapp(negocioId, opciones);
}

/** Lo que ve el panel: TODO el menú operativo con su marca de publicación. */
export async function listarProductosWhatsapp(negocioId, { db = pool } = {}) {
  if (!negocioValido(negocioId)) throw new Error('listarProductosWhatsapp: negocioId requerido');
  const { rows } = await db.query(
    `SELECT p.id, p.nombre, p.precio, p.disponible, p.agotado,
            c.id AS categoria_id, c.nombre AS categoria, c.activa AS categoria_activa,
            COALESCE(wp.publicado, FALSE) AS publicado, wp.origen
       FROM menu_productos p
       JOIN menu_categorias c
         ON c.id = p.categoria_id AND c.negocio_id = p.negocio_id
       LEFT JOIN whatsapp_productos wp
         ON wp.producto_id = p.id AND wp.negocio_id = p.negocio_id
      WHERE p.negocio_id = $1
      ORDER BY c.orden, c.nombre, p.orden, p.nombre`,
    [negocioId.trim()],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    nombre: r.nombre,
    precio: Number(r.precio),
    categoriaId: Number(r.categoria_id),
    categoria: r.categoria,
    categoriaActiva: r.categoria_activa === true,
    publicado: r.publicado === true,
    origen: r.origen || null,
    agotado: r.agotado === true || r.disponible === false,
  }));
}

const errorPublicacion = (mensaje) => Object.assign(new Error(mensaje), { codigo: 'PUBLICACION_INVALIDA' });

/**
 * Publica o retira productos. El negocio sale SIEMPRE de la sesión: un id de
 * otro negocio simplemente no aparece en el SELECT que alimenta el INSERT, y la
 * FK compuesta lo impediría de todos modos.
 */
export async function publicarProductosWhatsapp(negocioId, productoIds, publicado, {
  db = pool, actor = null,
} = {}) {
  if (!negocioValido(negocioId)) throw new Error('publicarProductosWhatsapp: negocioId requerido');
  if (typeof publicado !== 'boolean') throw errorPublicacion('El estado de publicación debe ser verdadero o falso');
  // Lista única: publicar aquí es publicar en la tienda (y en Rappi al subir
  // el menú). Ver publicacionUnica.js.
  return publicarEnListaUnica(negocioId, { productoIds, publicado, actor }, { db });
}

/**
 * Ofrecer o retirar una CATEGORÍA entera es ofrecer o retirar sus productos.
 * No hay una segunda marca por categoría: una sola fuente de verdad por
 * producto, y la categoría aparece en WhatsApp si y solo si le queda alguno.
 */
export async function publicarCategoriaWhatsapp(negocioId, categoriaId, publicado, {
  db = pool, actor = null,
} = {}) {
  if (!negocioValido(negocioId)) throw new Error('publicarCategoriaWhatsapp: negocioId requerido');
  if (typeof publicado !== 'boolean') throw errorPublicacion('El estado de publicación debe ser verdadero o falso');
  const id = Number(categoriaId);
  if (!Number.isInteger(id) || id <= 0) throw errorPublicacion('Categoría inválida');
  return publicarEnListaUnica(negocioId, { categoriaId: id, publicado, actor }, { db });
}
