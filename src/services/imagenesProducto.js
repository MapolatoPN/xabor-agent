/**
 * imagenesProducto.js — Foto principal de un producto del menú.
 *
 * NO es un sistema de imágenes nuevo. Reutiliza, sin duplicar nada:
 *   - imagenes.js       validación por magic bytes + sharp, compresión,
 *                       saneo de nombre (JPEG/PNG/WebP; SVG rechazado)
 *   - almacenamiento.js drivers local y S3/R2, claves con UUID no
 *                       adivinable, borrado
 * Es el mismo camino que ya usa el menú automático de WhatsApp.
 *
 * DÓNDE VIVE LA REFERENCIA: en `menu_productos.opciones.imagen`, no en una
 * columna ni una tabla nuevas. Ese JSONB ya guarda marcas estructurales del
 * producto (`tipo_item`, la del cargo de envío) y este es el segundo caso.
 * Evita una migración para un dato que es, literalmente, un atributo del
 * producto. La contrapartida es real y por eso está atendida: `opciones`
 * guarda TAMBIÉN opciones comerciales legadas que el bot imprime en el
 * menú, así que toda clave técnica nueva debe registrarse en
 * CLAVES_OPCIONES_TECNICAS (prompts.js) o termina en el mensaje que lee el
 * cliente -- eso ya tumbó el bot una vez.
 *
 * Nunca se guarda el binario en la base: en `opciones` solo va la clave de
 * almacenamiento y unos metadatos.
 */
import { validarImagenReal, comprimirImagen, sanitizarNombreImagen } from './imagenes.js';
import { guardarArchivo, leerArchivo, eliminarArchivo } from './almacenamiento.js';
import { pool } from './database.js';

/** Tope antes de comprimir. Mismo criterio (y misma variable) que el resto del media. */
export function tamanoMaximoBytes() {
  return (Number(process.env.MEDIA_MAX_IMAGE_MB) || 8) * 1024 * 1024;
}

const MOTIVOS = {
  archivo_vacio: 'No recibimos ninguna imagen',
  tamano_excedido: 'La imagen pesa demasiado',
  mime_invalido: 'Sube una imagen JPG, PNG o WEBP',
  imagen_corrupta: 'Esa imagen está dañada o incompleta',
};

/**
 * Lee la marca de imagen de un producto ya cargado (fila o su `opciones`).
 * Tolera JSON en texto y cualquier forma inesperada: un catálogo con
 * `opciones` raro nunca puede tumbar el render de un menú.
 */
export function imagenDeProducto(productoUOpciones) {
  let opciones = productoUOpciones;
  if (opciones && typeof opciones === 'object' && 'opciones' in opciones) opciones = opciones.opciones;
  if (typeof opciones === 'string') {
    try { opciones = JSON.parse(opciones); } catch { return null; }
  }
  const img = opciones && typeof opciones === 'object' && !Array.isArray(opciones) ? opciones.imagen : null;
  if (!img || typeof img !== 'object' || typeof img.storage_key !== 'string' || !img.storage_key) return null;
  return img;
}

/**
 * URL pública de la foto, o null si el producto no tiene.
 *
 * `v` es la huella de la versión: al reemplazar la foto cambia la clave de
 * almacenamiento y con ella la URL, así que ningún caché puede seguir
 * sirviendo la anterior. Sin eso, cambiar la foto de un platillo no se
 * vería hasta que al cliente se le venciera el caché.
 */
export function urlImagenProducto(producto) {
  const img = imagenDeProducto(producto);
  if (!img) return null;
  const id = producto?.id ?? producto?.producto_id;
  if (id === undefined || id === null) return null;
  const version = String(img.storage_key).slice(-12).replace(/[^a-zA-Z0-9]/g, '');
  return `/img/producto/${encodeURIComponent(id)}?v=${version}`;
}

async function productoDelNegocio(productoId, negocioId) {
  const id = Number(productoId);
  if (!Number.isInteger(id)) return null;
  const { rows } = await pool.query(
    `SELECT id, opciones FROM menu_productos WHERE id = $1 AND negocio_id = $2`,
    [id, negocioId]);
  return rows[0] || null;
}

/**
 * Sube o REEMPLAZA la foto principal de un producto.
 *
 * El archivo viejo se borra sólo DESPUÉS de que el UPDATE quedó firme: al
 * revés, un fallo al escribir en la base dejaría al producto apuntando a un
 * archivo que ya no existe. Y si el borrado del viejo falla, se registra
 * pero no se propaga: un archivo huérfano en el almacenamiento es mucho
 * menos grave que una foto que el dueño cree haber cambiado y no cambió.
 */
export async function guardarImagenProducto(negocioId, productoId, buffer, nombreOriginal = null) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return { ok: false, error: 'negocioId inválido' };
  const producto = await productoDelNegocio(productoId, negocioId.trim());
  if (!producto) return { ok: false, error: 'Ese producto no existe', codigo: 404 };
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return { ok: false, error: MOTIVOS.archivo_vacio };
  if (buffer.length > tamanoMaximoBytes()) {
    return { ok: false, error: `La imagen pesa más de ${Math.round(tamanoMaximoBytes() / 1024 / 1024)} MB`, codigo: 413 };
  }

  const validacion = await validarImagenReal(buffer);
  if (!validacion.valido) return { ok: false, error: MOTIVOS[validacion.motivo] || MOTIVOS.mime_invalido };

  const comprimida = await comprimirImagen(buffer, validacion.mime);
  const bytes = comprimida.buffer;
  const anterior = imagenDeProducto(producto);

  const storageKey = await guardarArchivo(bytes, {
    negocioId: negocioId.trim(), extension: comprimida.extension,
    mimeType: comprimida.mime, categoria: 'producto',
  });

  const marca = {
    storage_key: storageKey,
    mime: comprimida.mime,
    bytes: bytes.length,
    nombre: sanitizarNombreImagen(nombreOriginal || 'producto', comprimida.extension),
    actualizado_at: new Date().toISOString(),
  };

  // jsonb_set sobre COALESCE: un producto cuyo `opciones` es NULL (la
  // mayoría) recibe {} antes del merge, y las demás claves -- tipo_item,
  // opciones comerciales legadas -- se conservan intactas.
  const { rows } = await pool.query(
    `UPDATE menu_productos
        SET opciones = COALESCE(opciones, '{}'::jsonb) || jsonb_build_object('imagen', $3::jsonb)
      WHERE id = $1 AND negocio_id = $2
      RETURNING id, opciones`,
    [Number(productoId), negocioId.trim(), JSON.stringify(marca)]);
  if (!rows[0]) return { ok: false, error: 'Ese producto no existe', codigo: 404 };

  if (anterior?.storage_key && anterior.storage_key !== storageKey) {
    await eliminarArchivo(anterior.storage_key).catch(e =>
      console.warn('[ImagenProducto] no se pudo borrar la foto anterior:', e.message));
  }
  return { ok: true, producto: rows[0], url: urlImagenProducto(rows[0]) };
}

/**
 * Quita la foto. Primero se suelta la referencia y después el archivo, por
 * la misma razón: la UI nunca debe quedar apuntando a algo inexistente.
 */
export async function eliminarImagenProducto(negocioId, productoId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return { ok: false, error: 'negocioId inválido' };
  const producto = await productoDelNegocio(productoId, negocioId.trim());
  if (!producto) return { ok: false, error: 'Ese producto no existe', codigo: 404 };
  const actual = imagenDeProducto(producto);

  const { rows } = await pool.query(
    `UPDATE menu_productos SET opciones = COALESCE(opciones, '{}'::jsonb) - 'imagen'
      WHERE id = $1 AND negocio_id = $2 RETURNING id, opciones`,
    [Number(productoId), negocioId.trim()]);
  if (!rows[0]) return { ok: false, error: 'Ese producto no existe', codigo: 404 };

  if (actual?.storage_key) {
    await eliminarArchivo(actual.storage_key).catch(e =>
      console.warn('[ImagenProducto] no se pudo borrar el archivo:', e.message));
  }
  return { ok: true, producto: rows[0] };
}

/**
 * Bytes de la foto para servirla.
 *
 * Deliberadamente NO pide negocio: la foto de un platillo publicado es
 * contenido público (ya se muestra en la tienda a cualquier visitante y se
 * podría publicar en Rappi). Exigir sesión aquí obligaría a inventar un
 * segundo camino para la tienda pública. Lo que sí se cuida es que la ruta
 * no revele nada más: solo se resuelve por id de producto y solo devuelve
 * la imagen, nunca datos del negocio. Escribir y borrar, en cambio, sí van
 * siempre filtrados por negocio.
 *
 * Una referencia rota (archivo borrado del almacenamiento) devuelve null en
 * vez de lanzar: el catálogo se ve sin foto, nunca se cae.
 */
export async function leerImagenProducto(productoId) {
  const id = Number(productoId);
  if (!Number.isInteger(id)) return null;
  const { rows } = await pool.query(`SELECT id, opciones FROM menu_productos WHERE id = $1`, [id]);
  const img = imagenDeProducto(rows[0]);
  if (!img) return null;
  try {
    const buffer = await leerArchivo(img.storage_key);
    return { buffer, mimeType: img.mime || 'image/jpeg', bytes: img.bytes || buffer.length };
  } catch (e) {
    console.warn('[ImagenProducto] referencia rota, producto', id, '-', e.message);
    return null;
  }
}
