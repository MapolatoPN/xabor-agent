/**
 * vitrinaTienda.js — Lo visual del menú para el formulario «tienda» de
 * WhatsApp (contrato tienda_v1; propuesta, secciones 0.5 y 3).
 *
 * La vitrina es lo que el formulario DIBUJA y no lo que VENDE: descripción y
 * llave de la foto de cada producto, sus categorías y el orden comercial. Sale
 * de UNA sola consulta por negocio y se guarda 60 s en memoria.
 *
 * No entra a la foto del formulario (`agente_botones.datos`): la foto guarda
 * solo lo comercial y `formularioVigente` la compara completa, así que cambiar
 * una descripción o una foto nunca invalida un formulario abierto. Por la
 * misma razón la vitrina no decide qué se vende: quien la usa la consulta por
 * id de producto, y lo que no está en la foto no se muestra.
 *
 * Solo entran productos publicados para WhatsApp de categorías activas (la
 * misma regla que catalogoWhatsapp.js). Si la lectura falla, la vitrina sale
 * vacía y marcada con error, nunca lanza: el formulario se dibuja sin fotos ni
 * descripciones, que es exactamente lo de hoy.
 *
 * Aquí viven también los disparadores del precalentamiento de miniaturas, todos
 * sin esperar el resultado y solo para negocios con la bandera
 * whatsapp_flow_tienda_v1 encendida ('prueba' o 'true'). Con la bandera
 * apagada no se genera ninguna miniatura: todo se comporta como hoy.
 */
import { pool } from './database.js';
import { llaveDeAlmacenamientoValida, miniaturasMenu } from './miniaturasMenu.js';
import { BANDERA_TIENDA, FLOW_TIENDA_ID, TELEFONOS_TIENDA, modoTienda } from '../mesero-agente/contratoTienda.js';

export { BANDERA_TIENDA, FLOW_TIENDA_ID, TELEFONOS_TIENDA, modoTienda };
export const TTL_VITRINA_MS = 60_000;
const MAX_NEGOCIOS_EN_CACHE = 500;

// La llave se lee solo si es texto: un `storage_key` que no lo sea no es foto.
export const SQL_VITRINA = `
  SELECT p.id, p.descripcion, p.orden,
         CASE WHEN jsonb_typeof(p.opciones -> 'imagen' -> 'storage_key') = 'string'
              THEN p.opciones -> 'imagen' ->> 'storage_key' END AS storage_key,
         c.id AS categoria_id, c.nombre AS categoria, c.orden AS categoria_orden
    FROM whatsapp_productos wp
    JOIN menu_productos p ON p.id = wp.producto_id AND p.negocio_id = wp.negocio_id
    JOIN menu_categorias c ON c.id = p.categoria_id AND c.negocio_id = p.negocio_id
   WHERE wp.negocio_id = $1 AND wp.publicado = TRUE AND c.activa = TRUE
   ORDER BY c.orden, c.id, p.orden, p.id`;

// El mismo orden comercial que fotoFormulario: `orden` y, en empate, el id.
const comparar = (a, b) => (Number(a.orden) || 0) - (Number(b.orden) || 0)
  || String(a.id).localeCompare(String(b.id), 'es', { numeric: true });

const congelar = (vitrina) => Object.freeze(vitrina);
export const VITRINA_VACIA = congelar({ categorias: Object.freeze([]), productos: Object.freeze({}), error: null });
const VITRINA_CON_ERROR = congelar({ categorias: Object.freeze([]), productos: Object.freeze({}), error: 'lectura_vitrina' });

/**
 * Filas de SQL_VITRINA → vitrina inmutable:
 * { categorias: [{id, nombre, orden, productos:[id…]}], productos: {id: {id, descripcion, storageKey, categoriaId, orden}}, error }
 * Ordena por su cuenta: no depende del ORDER BY.
 */
export function armarVitrina(filas = []) {
  const categorias = new Map(), productos = {};
  for (const f of filas || []) {
    const categoriaId = String(f.categoria_id);
    if (!categorias.has(categoriaId)) {
      categorias.set(categoriaId, { id: categoriaId, nombre: String(f.categoria ?? ''), orden: Number(f.categoria_orden) || 0, filas: [] });
    }
    categorias.get(categoriaId).filas.push({ id: String(f.id), orden: Number(f.orden) || 0,
      descripcion: String(f.descripcion ?? '').trim(),
      storageKey: llaveDeAlmacenamientoValida(f.storage_key) ? f.storage_key : null, categoriaId });
  }
  const lista = [...categorias.values()].sort(comparar).map((c) => {
    const ordenados = c.filas.sort(comparar);
    for (const p of ordenados) productos[p.id] = Object.freeze(p);
    return Object.freeze({ id: c.id, nombre: c.nombre, orden: c.orden, productos: Object.freeze(ordenados.map((p) => p.id)) });
  });
  return congelar({ categorias: Object.freeze(lista), productos: Object.freeze(productos), error: null });
}

/**
 * La foto de la categoría (menu_categorias no tiene imagen): la del primer
 * producto con foto en orden comercial. `visibles` (ids) limita a los que el
 * formulario muestra.
 */
export function portadaDeCategoria(vitrina, categoriaId, visibles = null) {
  const c = (vitrina?.categorias || []).find((x) => x.id === String(categoriaId));
  if (!c) return null;
  const permitidos = visibles ? new Set([...visibles].map(String)) : null;
  for (const id of c.productos) {
    const llave = vitrina.productos[id]?.storageKey;
    if (llave && (!permitidos || permitidos.has(id))) return llave;
  }
  return null;
}

const negocioValido = (negocioId) => typeof negocioId === 'string' && negocioId.trim() !== '';

/**
 * Caché de vitrinas por negocio. `consultar(negocioId)` devuelve las filas.
 * Dos peticiones a la vez comparten la misma consulta; `invalidar` descarta
 * también la que esté en vuelo, para que una lectura anterior a un cambio no
 * se guarde después de él.
 */
export function crearVitrinas({
  consultar = async (negocioId) => (await pool.query(SQL_VITRINA, [negocioId])).rows,
  ttlMs = TTL_VITRINA_MS, ahora = Date.now, avisar = (m) => console.warn(m),
} = {}) {
  const entradas = new Map(), enCurso = new Map(), generaciones = new Map();
  const generacion = (id) => generaciones.get(id) || 0;

  function obtener(negocioId) {
    if (!negocioValido(negocioId)) return Promise.resolve(VITRINA_VACIA);
    const id = negocioId.trim(), e = entradas.get(id);
    if (e && ahora() < e.vence) return Promise.resolve(e.vitrina);
    if (enCurso.has(id)) return enCurso.get(id).promesa;
    const vuelo = { generacion: generacion(id) };
    vuelo.promesa = (async () => {
      await null; // la consulta nunca corre dentro de esta llamada
      try {
        const vitrina = armarVitrina(await consultar(id));
        if (generacion(id) === vuelo.generacion) {
          entradas.set(id, { vitrina, vence: ahora() + ttlMs });
          if (entradas.size > MAX_NEGOCIOS_EN_CACHE) entradas.delete(entradas.keys().next().value);
        }
        return vitrina;
      } catch (err) {
        avisar(`[Vitrina] negocio=${id}: ${err?.message}`);
        return VITRINA_CON_ERROR;
      } finally {
        if (enCurso.get(id) === vuelo) enCurso.delete(id);
      }
    })();
    enCurso.set(id, vuelo);
    return vuelo.promesa;
  }
  function invalidar(negocioId) {
    if (!negocioValido(negocioId)) return;
    const id = negocioId.trim();
    entradas.delete(id); enCurso.delete(id); generaciones.set(id, generacion(id) + 1);
  }
  function vaciar() { for (const id of new Set([...entradas.keys(), ...enCurso.keys()])) invalidar(id); }
  return { obtener, invalidar, vaciar };
}

/** La caché del servidor. */
export const vitrinasTienda = crearVitrinas();
export const obtenerVitrina = (negocioId) => vitrinasTienda.obtener(negocioId);

// ── Precalentamiento ─────────────────────────────────────────────────────

/**
 * Encola las miniaturas de una vitrina en orden comercial. Síncrono; devuelve
 * cuántas encoló. `visibles` (ids) limita a los platillos que un formulario
 * muestra, y la portada de cada categoría se busca entre ellos.
 */
export function precalentarVitrina(vitrina, { miniaturas = miniaturasMenu, visibles = null } = {}) {
  const permitidos = visibles ? new Set([...visibles].map(String)) : null;
  let n = 0;
  for (const c of vitrina?.categorias || []) {
    const portada = portadaDeCategoria(vitrina, c.id, permitidos);
    if (portada) n += miniaturas.encolar(portada, ['cat128']);
    for (const id of c.productos) {
      if (permitidos && !permitidos.has(id)) continue;
      const llave = vitrina.productos[id]?.storageKey;
      if (llave) n += miniaturas.encolar(llave, ['lista96', 'ficha480']);
    }
  }
  return n;
}

// ── El formulario «tienda» ───────────────────────────────────────────────

// Lo más que el endpoint espera a la vitrina: Meta pide responder en menos de
// un segundo y la caché de 60 s casi siempre contesta en el acto. Si tarda, el
// formulario se dibuja sin fotos ni descripciones (la consulta sigue y llena
// la caché para el siguiente toque).
export const ESPERA_VITRINA_MS = 1500;

/**
 * La vitrina para dibujar la tienda, con su lector de miniaturas (solo la
 * caché: lo que falta se encola). null si falla o tarda: nunca lanza.
 */
export async function vitrinaParaFormulario(negocioId, { vitrinas = vitrinasTienda, miniaturas = miniaturasMenu, esperaMs = ESPERA_VITRINA_MS } = {}) {
  let reloj = null;
  try {
    // El reloj se cancela en cuanto la vitrina llega (finally): nunca retiene más de esperaMs.
    const tarde = new Promise((r) => { reloj = setTimeout(() => r(null), esperaMs); });
    const v = await Promise.race([vitrinas.obtener(negocioId), tarde]);
    if (!v || v.error) return null;
    return { ...v, miniatura: (llave, variante) => miniaturas.obtener(llave, variante) };
  } catch {
    return null;
  } finally {
    if (reloj) clearTimeout(reloj);
  }
}

/**
 * Al mandar una tienda (canalDelAgente.js): encola las miniaturas de los
 * platillos de SU foto mientras el cliente abre el formulario. Nunca lanza ni
 * hace esperar (no devuelve nada).
 */
export function precalentarFormularioTienda(negocioId, foto, {
  vitrinas = vitrinasTienda, miniaturas = miniaturasMenu, avisar = (m) => console.warn(m),
} = {}) {
  try {
    const visibles = (Array.isArray(foto?.productos) ? foto.productos : []).map((p) => String(p?.id));
    if (!visibles.length) return;
    const p = Promise.resolve(vitrinas.obtener(negocioId))
      .then((v) => { precalentarVitrina(v, { miniaturas, visibles }); }) // con error, la vitrina viene vacía
      .catch((e) => avisar(`[Vitrina] precalentar formulario de negocio=${negocioId}: ${e?.message}`))
      .finally(() => precalentamientos.delete(p));
    precalentamientos.add(p);
  } catch (e) {
    avisar(`[Vitrina] precalentar formulario de negocio=${negocioId}: ${e?.message}`);
  }
}

/** El modo de la tienda de un negocio, leído de su configuración. */
export async function leerModoTienda(negocioId, { db = pool } = {}) {
  if (!negocioValido(negocioId)) return null;
  const { rows } = await db.query('SELECT valor FROM configuracion WHERE negocio_id = $1 AND clave = $2',
    [negocioId.trim(), BANDERA_TIENDA]);
  return modoTienda({ [BANDERA_TIENDA]: rows[0]?.valor });
}

/** Al armar el formulario o cuando haga falta: solo con la bandera encendida. */
export async function precalentarNegocio(negocioId, { vitrinas = vitrinasTienda, miniaturas = miniaturasMenu, leerModo = leerModoTienda } = {}) {
  if (!await leerModo(negocioId)) return 0;
  return precalentarVitrina(await vitrinas.obtener(negocioId), { miniaturas });
}

/** Al arrancar el proceso: los negocios con la bandera encendida, uno tras otro. */
export async function precalentarAlArrancar({ db = pool, vitrinas = vitrinasTienda, miniaturas = miniaturasMenu, avisar = (m) => console.warn(m) } = {}) {
  const { rows } = await db.query(`SELECT negocio_id FROM configuracion WHERE clave = $1 AND valor IN ('prueba', 'true')`, [BANDERA_TIENDA]);
  let n = 0;
  for (const { negocio_id: negocioId } of rows) {
    try { n += await precalentarNegocio(String(negocioId), { vitrinas, miniaturas, leerModo: async () => 'arranque' }); }
    catch (e) { avisar(`[Vitrina] precalentar negocio=${negocioId}: ${e?.message}`); }
  }
  return n;
}

const precalentamientos = new Set();
/**
 * Tras guardar o quitar la foto de un producto (imagenesProducto.js). Nunca
 * lanza ni hace esperar a quien la llama (no devuelve nada): descarta la
 * vitrina del negocio para que la llave nueva se vea ya, y con la bandera
 * encendida encola las miniaturas de la foto nueva. `storageKey` null = la foto
 * se quitó.
 */
export function fotoDeProductoCambiada(negocioId, storageKey, {
  vitrinas = vitrinasTienda, miniaturas = miniaturasMenu, leerModo = leerModoTienda, avisar = (m) => console.warn(m),
} = {}) {
  try {
    vitrinas.invalidar(negocioId);
    if (!storageKey) return;
    const p = (async () => { if (await leerModo(negocioId)) miniaturas.encolar(storageKey); })()
      .catch((e) => avisar(`[Vitrina] precalentar foto de negocio=${negocioId}: ${e?.message}`))
      .finally(() => precalentamientos.delete(p));
    precalentamientos.add(p);
  } catch (e) {
    avisar(`[Vitrina] foto cambiada en negocio=${negocioId}: ${e?.message}`);
  }
}

/** Para scripts y pruebas: espera los precalentamientos lanzados y la cola de miniaturas. */
export async function esperarPrecalentamiento({ miniaturas = miniaturasMenu } = {}) {
  while (precalentamientos.size) await Promise.allSettled([...precalentamientos]);
  await miniaturas.esperar();
}
