// ─── Banner promocional de la tienda en línea, por negocio ─────────────────
//
// La portada del diseño v2 era UNA foto con un texto fijo en el código («Tu
// mañana, a tu gusto»), el mismo para todos los negocios. Aquí cada negocio
// arma de 1 a MAX_DIAPOSITIVAS diapositivas con su foto, su texto y su botón,
// y opcionalmente las fechas en que se muestran (platillos de temporada).
//
// Vive en `configuracion` (clave `tienda_banner`), igual que `tienda_diseno`:
// sin migración. Sin fila, o con una fila vacía, la tienda pinta la portada de
// siempre: nada cambia para quien no lo configure.
//
//   valor = {
//     diapositivas: [{ activo, ceja, titulo, texto, boton,
//                      destino: { tipo: 'menu' } | { tipo: 'producto', productoId },
//                      foto: { tipo: 'url', url } | { tipo: 'subida', id } | null,
//                      desde: 'YYYY-MM-DD' | null, hasta: 'YYYY-MM-DD' | null }],
//     fotos: { <id>: { storage_key, mime, bytes, subida_at } }
//   }
//
// Tres reglas que no se negocian:
//
//   · Lo que sale a la API pública pasa por listas blancas y topes de largo;
//     la página además lo escapa. Una liga de foto solo puede ser https:// o
//     una foto de producto de Xabor.
//   · `configuracion` también se escribe con PUT /api/config (clave libre), así
//     que el `storage_key` guardado NO se cree: solo se sirve o se borra un
//     archivo que esté bajo la carpeta de tienda de ESTE negocio. Sin eso, un
//     valor copiado o escrito a mano podría servir o borrar archivos ajenos.
//   · Las fechas son días de calendario en la zona del negocio, comparados
//     como texto contra «hoy» en esa zona. Nunca medianoche UTC (ver
//     vigenciaPromos.js: «hasta el 30» vencía el 29 a las 7 de la noche).
//
// La lectura pública NUNCA lanza: un banner roto se traduce en «sin banner» y
// la tienda pinta la portada de siempre.
import { randomBytes } from 'crypto';
import { pool } from './database.js';
import { validarImagenReal, comprimirImagen } from './imagenes.js';
import { guardarArchivo, leerArchivo, eliminarArchivo } from './almacenamiento.js';
import { fechaDeVigencia } from './vigenciaPromos.js';
import { TiendaError } from './tiendaOnline.js';

export const CLAVE_BANNER = 'tienda_banner';
export const MAX_DIAPOSITIVAS = 5;
// Fotos subidas que todavía no usa ninguna diapositiva (el dueño subió y no
// ha guardado). Pasado el tope se descartan las más viejas.
const MAX_FOTOS_SUELTAS = 10;
// Una foto suelta sobrevive a un guardado durante este tiempo: así guardar
// desde otra pestaña no borra la que alguien acaba de subir.
const GRACIA_FOTO_SUELTA_MS = 6 * 60 * 60 * 1000;

export const LARGOS = Object.freeze({ ceja: 40, titulo: 70, texto: 160, boton: 28, url: 600 });
const MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ID_FOTO = /^[a-f0-9]{16}$/;
const FECHA = /^(\d{4})-(\d{2})-(\d{2})$/;
const PRODUCTO_XABOR = /^\/img\/producto\/\d{1,12}(\?v=[A-Za-z0-9]{1,40})?$/;

const vacio = () => ({ diapositivas: [], fotos: {} });

// ── Limpieza de texto ───────────────────────────────────────────────────────
// Sin caracteres de control; el título admite UN salto de línea (dos
// renglones, como la portada original), el resto ninguno.
function limpiarTexto(v, max, { saltos = false } = {}) {
  let s = String(v ?? '').replace(/\r\n?/g, '\n');
  s = s.replace(/[\u0000-\u0009\u000B-\u001F\u007F‎‏‪-‮⁦-⁩]/g, '');
  if (saltos) {
    const renglones = s.split('\n').map(r => r.replace(/\s+/g, ' ').trim()).filter(Boolean);
    s = renglones.length > 2 ? `${renglones[0]}\n${renglones.slice(1).join(' ')}` : renglones.join('\n');
  } else {
    s = s.replace(/\s+/g, ' ').trim();
  }
  return s.slice(0, max).trim();
}

// 'YYYY-MM-DD' real (rechaza 2026-02-30) o null.
export function fechaValida(v) {
  const m = FECHA.exec(String(v ?? '').trim());
  if (!m) return null;
  const [Y, M, D] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(Date.UTC(Y, M - 1, D));
  return d.getUTCFullYear() === Y && d.getUTCMonth() === M - 1 && d.getUTCDate() === D ? m[0] : null;
}

// https:// o una foto de producto servida por Xabor; cualquier otra cosa
// (javascript:, data:, http:, rutas relativas arbitrarias) se descarta.
export function urlFotoValida(v) {
  const s = String(v ?? '').trim();
  if (!s || s.length > LARGOS.url) return null;
  if (PRODUCTO_XABOR.test(s)) return s;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' && u.hostname ? u.href : null;
  } catch { return null; }
}

// ¿Este storage_key es una foto de tienda de ESTE negocio? Mismo saneo de
// segmento que almacenamiento.js usa al generar la clave.
export function claveDeTiendaDelNegocio(negocioId, clave) {
  const partes = String(clave || '').split('/');
  const negocio = String(negocioId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  return partes.length === 5
    && /^[a-z0-9_-]+$/.test(partes[0])
    && partes[1] === 'negocios'
    && !!negocio && partes[2] === negocio
    && partes[3] === 'tienda'
    && /^[0-9a-f-]{36}\.(jpg|png|webp)$/.test(partes[4]);
}

function normalizarFotos(crudas) {
  const fotos = {};
  if (!crudas || typeof crudas !== 'object' || Array.isArray(crudas)) return fotos;
  for (const [id, f] of Object.entries(crudas)) {
    if (!ID_FOTO.test(id) || !f || typeof f !== 'object') continue;
    if (typeof f.storage_key !== 'string' || !f.storage_key) continue;
    fotos[id] = {
      storage_key: f.storage_key,
      mime: MIMES.has(f.mime) ? f.mime : 'image/jpeg',
      bytes: Number.isFinite(Number(f.bytes)) ? Number(f.bytes) : 0,
      subida_at: typeof f.subida_at === 'string' ? f.subida_at : null,
    };
  }
  return fotos;
}

function normalizarFoto(f, fotos) {
  if (!f || typeof f !== 'object') return null;
  if (f.tipo === 'subida') return ID_FOTO.test(String(f.id)) && fotos[f.id] ? { tipo: 'subida', id: f.id } : null;
  if (f.tipo === 'url') {
    const url = urlFotoValida(f.url);
    return url ? { tipo: 'url', url } : null;
  }
  return null;
}

function normalizarDestino(d) {
  const id = Number(d?.productoId);
  return d?.tipo === 'producto' && Number.isInteger(id) && id > 0
    ? { tipo: 'producto', productoId: id } : { tipo: 'menu' };
}

// Una diapositiva sin título no se puede pintar: se descarta.
function normalizarDiapositiva(d, fotos) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  const titulo = limpiarTexto(d.titulo, LARGOS.titulo, { saltos: true });
  if (!titulo) return null;
  return {
    activo: d.activo !== false,
    ceja: limpiarTexto(d.ceja, LARGOS.ceja),
    titulo,
    texto: limpiarTexto(d.texto, LARGOS.texto),
    boton: limpiarTexto(d.boton, LARGOS.boton),
    destino: normalizarDestino(d.destino),
    foto: normalizarFoto(d.foto, fotos),
    desde: fechaValida(d.desde),
    hasta: fechaValida(d.hasta),
  };
}

// Normaliza lo guardado. Pura y tolerante: nunca lanza. Exportada para
// probarla sin base.
export function normalizarBanner(crudo) {
  let v = crudo;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { return vacio(); }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return vacio();
  const fotos = normalizarFotos(v.fotos);
  const diapositivas = (Array.isArray(v.diapositivas) ? v.diapositivas : [])
    .map(d => normalizarDiapositiva(d, fotos)).filter(Boolean).slice(0, MAX_DIAPOSITIVAS);
  return { diapositivas, fotos };
}

// Lo que pide el dueño al guardar: estricta, con el mensaje que necesita
// para corregirlo. Lo que pasa, se normaliza igual que la lectura.
export function validarDiapositivas(entrada, fotos) {
  if (!Array.isArray(entrada)) throw new TiendaError('Formato de banner inválido', 'BANNER_INVALIDO');
  if (entrada.length > MAX_DIAPOSITIVAS) {
    throw new TiendaError(`El banner admite hasta ${MAX_DIAPOSITIVAS} diapositivas`, 'BANNER_DEMASIADAS');
  }
  return entrada.map((d, i) => {
    const n = i + 1;
    if (!d || typeof d !== 'object' || Array.isArray(d)) {
      throw new TiendaError(`La diapositiva ${n} no es válida`, 'BANNER_INVALIDO');
    }
    if (!limpiarTexto(d.titulo, LARGOS.titulo, { saltos: true })) {
      throw new TiendaError(`La diapositiva ${n} necesita un título`, 'BANNER_SIN_TITULO');
    }
    if (d.foto?.tipo === 'url' && !urlFotoValida(d.foto.url)) {
      throw new TiendaError(`La liga de la foto de la diapositiva ${n} no es válida: debe empezar con https://`, 'BANNER_FOTO_INVALIDA');
    }
    if (d.foto?.tipo === 'subida' && !(ID_FOTO.test(String(d.foto.id)) && fotos[d.foto.id])) {
      throw new TiendaError(`La foto de la diapositiva ${n} ya no está disponible: súbela de nuevo`, 'BANNER_FOTO_PERDIDA');
    }
    for (const extremo of ['desde', 'hasta']) {
      if (d[extremo] && !fechaValida(d[extremo])) {
        throw new TiendaError(`La fecha de la diapositiva ${n} no es válida`, 'BANNER_FECHA_INVALIDA');
      }
    }
    const desde = fechaValida(d.desde), hasta = fechaValida(d.hasta);
    if (desde && hasta && desde > hasta) {
      throw new TiendaError(`En la diapositiva ${n} la fecha de inicio es posterior a la de fin`, 'BANNER_FECHAS_AL_REVES');
    }
    if (d.destino?.tipo === 'producto' && normalizarDestino(d.destino).tipo !== 'producto') {
      throw new TiendaError(`El platillo del botón de la diapositiva ${n} no es válido`, 'BANNER_DESTINO_INVALIDO');
    }
    return normalizarDiapositiva(d, fotos);
  });
}

// ¿Se muestra hoy? `hoy` es 'YYYY-MM-DD' en la zona del negocio.
export function vigenteHoy(d, hoy) {
  if (d.activo === false) return false;
  if (d.desde && hoy < d.desde) return false;
  if (d.hasta && hoy > d.hasta) return false;
  return true;
}

export const urlFotoSubida = (slug, id) => `/img/tienda/${encodeURIComponent(slug)}/${id}`;

function urlDeFoto(foto, slug) {
  if (!foto) return null;
  return foto.tipo === 'url' ? foto.url : urlFotoSubida(slug, foto.id);
}

const BOTON_POR_OMISION = { menu: 'Explorar el menú', producto: 'Ordenar' };

// Lo que ve el cliente: solo lo vigente hoy, sin nada interno.
export function bannerParaCliente(banner, { slug, hoy }) {
  return banner.diapositivas.filter(d => vigenteHoy(d, hoy)).map(d => ({
    ceja: d.ceja,
    titulo: d.titulo,
    texto: d.texto,
    boton: d.boton || BOTON_POR_OMISION[d.destino.tipo],
    productoId: d.destino.tipo === 'producto' ? d.destino.productoId : null,
    foto: urlDeFoto(d.foto, slug),
  }));
}

// ── Base ────────────────────────────────────────────────────────────────────
async function leerBanner(negocioId, cliente = pool) {
  const { rows } = await cliente.query(
    `SELECT valor FROM configuracion WHERE negocio_id = $1 AND clave = $2 LIMIT 1`,
    [negocioId, CLAVE_BANNER]);
  return normalizarBanner(rows[0]?.valor);
}

// API pública de la tienda. Nunca lanza.
export async function bannerPublico(negocioId, { slug, zona, ahora = new Date() }) {
  try {
    const banner = await leerBanner(negocioId);
    if (!banner.diapositivas.length) return [];
    return bannerParaCliente(banner, { slug, hoy: fechaDeVigencia(ahora, zona) });
  } catch (e) {
    console.error('[Tienda] banner:', e?.message || e);
    return [];
  }
}

// Para el editor del panel: todo lo guardado (también lo pausado o fuera de
// fechas), con la vista previa de cada foto.
export async function bannerParaEditor(negocioId, slug) {
  const banner = await leerBanner(negocioId);
  return {
    maxDiapositivas: MAX_DIAPOSITIVAS,
    largos: LARGOS,
    diapositivas: banner.diapositivas.map(d => ({ ...d, fotoUrl: urlDeFoto(d.foto, slug) })),
  };
}

// Lee y bloquea la fila del banner dentro de una transacción. La fila se crea
// vacía si no existía, para que dos escrituras simultáneas se formen.
async function conBannerBloqueado(negocioId, fn) {
  const cliente = await pool.connect();
  let paraBorrar = [];
  try {
    await cliente.query('BEGIN');
    await cliente.query(
      `INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1, $2, '{}')
       ON CONFLICT (negocio_id, clave) DO NOTHING`, [negocioId, CLAVE_BANNER]);
    const { rows } = await cliente.query(
      `SELECT valor FROM configuracion WHERE negocio_id = $1 AND clave = $2 FOR UPDATE`,
      [negocioId, CLAVE_BANNER]);
    const actual = normalizarBanner(rows[0]?.valor);
    const { nuevo, borrar = [], resultado } = await fn(actual);
    await cliente.query(
      `UPDATE configuracion SET valor = $3 WHERE negocio_id = $1 AND clave = $2`,
      [negocioId, CLAVE_BANNER, JSON.stringify(nuevo)]);
    await cliente.query('COMMIT');
    paraBorrar = borrar;
    return resultado;
  } catch (e) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    cliente.release();
    // Los archivos se borran DESPUÉS del commit: al revés, un fallo dejaría
    // una diapositiva apuntando a una foto que ya no existe.
    for (const f of paraBorrar) borrarFotoArchivo(negocioId, f);
  }
}

function borrarFotoArchivo(negocioId, foto) {
  if (!claveDeTiendaDelNegocio(negocioId, foto?.storage_key)) return;
  eliminarArchivo(foto.storage_key).catch(e =>
    console.warn('[Tienda] banner: no se pudo borrar una foto:', e.message));
}

// Fotos que se quedan: las que usa alguna diapositiva y las sueltas recién
// subidas (dentro de la gracia y del tope). El resto se borra.
function repartirFotos(fotos, diapositivas, ahora = Date.now()) {
  const usadas = new Set(diapositivas.filter(d => d.foto?.tipo === 'subida').map(d => d.foto.id));
  const quedan = {}, borrar = [];
  const sueltas = Object.entries(fotos).filter(([id]) => !usadas.has(id))
    .sort(([, a], [, b]) => String(b.subida_at).localeCompare(String(a.subida_at)));
  for (const [id, f] of Object.entries(fotos)) if (usadas.has(id)) quedan[id] = f;
  sueltas.forEach(([id, f], i) => {
    const edad = ahora - Date.parse(f.subida_at || 0);
    if (i < MAX_FOTOS_SUELTAS && edad < GRACIA_FOTO_SUELTA_MS) quedan[id] = f;
    else borrar.push(f);
  });
  return { quedan, borrar };
}

export async function guardarBanner(negocioId, entrada) {
  return conBannerBloqueado(negocioId, async (actual) => {
    const diapositivas = validarDiapositivas(entrada, actual.fotos);
    const { quedan, borrar } = repartirFotos(actual.fotos, diapositivas);
    return { nuevo: { diapositivas, fotos: quedan }, borrar };
  });
}

const MOTIVOS_FOTO = {
  archivo_vacio: 'No recibimos ninguna imagen',
  tamano_excedido: 'La imagen pesa demasiado',
  mime_invalido: 'Sube una imagen JPG, PNG o WEBP',
  imagen_corrupta: 'Esa imagen está dañada o incompleta',
};

// Sube una foto suelta. La diapositiva la toma al guardarse con
// { tipo: 'subida', id }; mientras tanto vive en el banner como suelta.
export async function subirFotoBanner(negocioId, buffer) {
  const validacion = await validarImagenReal(buffer);
  if (!validacion.valido) {
    throw new TiendaError(MOTIVOS_FOTO[validacion.motivo] || MOTIVOS_FOTO.mime_invalido, 'BANNER_FOTO_INVALIDA');
  }
  const comprimida = await comprimirImagen(buffer, validacion.mime);
  const storageKey = await guardarArchivo(comprimida.buffer, {
    negocioId, extension: comprimida.extension, mimeType: comprimida.mime, categoria: 'tienda',
  });
  const id = randomBytes(8).toString('hex');
  const foto = {
    storage_key: storageKey, mime: comprimida.mime,
    bytes: comprimida.buffer.length, subida_at: new Date().toISOString(),
  };
  try {
    return await conBannerBloqueado(negocioId, async (actual) => {
      const { quedan, borrar } = repartirFotos({ ...actual.fotos, [id]: foto }, actual.diapositivas);
      return { nuevo: { diapositivas: actual.diapositivas, fotos: quedan }, borrar, resultado: { id } };
    });
  } catch (e) {
    borrarFotoArchivo(negocioId, foto);
    throw e;
  }
}

// Bytes de una foto subida. Público como las fotos de producto (es lo que la
// tienda ya enseña a cualquiera); solo resuelve fotos de ESTE negocio.
export async function leerFotoBanner(negocioId, id) {
  if (!ID_FOTO.test(String(id))) return null;
  const banner = await leerBanner(negocioId);
  const foto = banner.fotos[id];
  if (!foto || !claveDeTiendaDelNegocio(negocioId, foto.storage_key)) return null;
  try {
    return { buffer: await leerArchivo(foto.storage_key), mimeType: foto.mime };
  } catch (e) {
    console.warn('[Tienda] banner: foto no disponible', id, '-', e.message);
    return null;
  }
}
