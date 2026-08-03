/**
 * imagenes.js — Validación, compresión y orquestación de imágenes de chat
 * (recepción desde WhatsApp y envío desde el panel). Mismo modelo que
 * documentos.js (PDFs): usa la tabla `documentos` (categoria='imagen') y
 * el mismo almacenamiento privado, pero con reglas propias de imagen
 * (tipos permitidos, límites, compresión/redimensión). No depende de
 * ningún negocio en particular -- permisos/módulo viven en server.js.
 *
 * Deliberadamente NO incluye: análisis por IA, generación de imágenes,
 * identificación de productos, catálogo visual, video, audio -- fuera de
 * alcance de este release por instrucción explícita.
 */
import { fileTypeFromBuffer } from 'file-type';
import sharp from 'sharp';
import { createHash } from 'crypto';
import {
  crearDocumentoPendiente, crearDocumentoSaliente, marcarDocumentoListo, marcarDocumentoError,
} from './database.js';
import { guardarArchivo } from './almacenamiento.js';

// Tipos permitidos explícitamente pedidos -- cualquier otro (gif, svg,
// heic sin convertir, etc.) se rechaza, sin importar la extensión del
// nombre declarado.
const MIME_A_EXTENSION = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

function tamanoMaximoAntesDeComprimirBytes() {
  return (Number(process.env.MEDIA_MAX_IMAGE_MB) || 8) * 1024 * 1024;
}

const LADO_MAXIMO_PX = 2048; // suficiente para producto/evidencia, no "máxima resolución posible"
const CALIDAD_COMPRESION = 82;
export const MAX_IMAGENES_POR_ENVIO = 5;

/**
 * Valida el MIME real por magic bytes (nunca el declarado ni la
 * extensión del nombre) y el tamaño máximo ANTES de comprimir -- un
 * archivo con extensión .jpg falsa que en realidad es un ejecutable, un
 * ZIP renombrado, o un SVG (vector de XSS conocido, ni siquiera tiene
 * firma binaria reconocible) se rechaza aquí, igual que un archivo
 * vacío (fileTypeFromBuffer no reconoce una firma válida y se trata
 * como mime_invalido).
 *
 * Segunda pasada de integridad real (no solo los primeros bytes): un
 * archivo puede tener una firma jpg/png/webp perfectamente válida en la
 * cabecera y aun así estar corrupto/truncado en el resto del contenido
 * -- fileTypeFromBuffer nunca lo detectaría porque solo mira los magic
 * bytes iniciales. sharp().metadata() sí decodifica lo suficiente de la
 * imagen real para confirmar que es reconstruible; si falla, se trata
 * como imagen corrupta en vez de dejar que el fallo ocurra más tarde
 * (al comprimir o al servir el archivo ya guardado).
 */
export async function validarImagenReal(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { valido: false, motivo: 'archivo_vacio' };
  }
  if (buffer.length > tamanoMaximoAntesDeComprimirBytes()) {
    return { valido: false, motivo: 'tamano_excedido' };
  }
  const tipo = await fileTypeFromBuffer(buffer);
  if (!tipo || !MIME_A_EXTENSION[tipo.mime]) {
    return { valido: false, motivo: 'mime_invalido' };
  }
  try {
    await sharp(buffer).metadata();
  } catch {
    return { valido: false, motivo: 'imagen_corrupta' };
  }
  return { valido: true, mime: tipo.mime, extension: MIME_A_EXTENSION[tipo.mime] };
}

/**
 * Redimensiona (si excede LADO_MAXIMO_PX de cualquier lado) y comprime.
 * Siempre re-encoda a un formato conocido de salida (jpeg para fotos,
 * png solo si el original ya era png con transparencia real, webp se
 * conserva como webp) -- nunca copia el buffer original tal cual, para
 * que cualquier metadata/EXIF sensible tampoco sobreviva.
 */
export async function comprimirImagen(buffer, mimeOriginal) {
  let pipeline = sharp(buffer).rotate() // aplica orientación EXIF y la descarta
    .resize({ width: LADO_MAXIMO_PX, height: LADO_MAXIMO_PX, fit: 'inside', withoutEnlargement: true });

  if (mimeOriginal === 'image/png') {
    const metadata = await sharp(buffer).metadata();
    if (metadata.hasAlpha) {
      const salida = await pipeline.png({ compressionLevel: 8 }).toBuffer();
      return { buffer: salida, mime: 'image/png', extension: 'png' };
    }
  }
  if (mimeOriginal === 'image/webp') {
    const salida = await pipeline.webp({ quality: CALIDAD_COMPRESION }).toBuffer();
    return { buffer: salida, mime: 'image/webp', extension: 'webp' };
  }
  const salida = await pipeline.jpeg({ quality: CALIDAD_COMPRESION, mozjpeg: true }).toBuffer();
  return { buffer: salida, mime: 'image/jpeg', extension: 'jpg' };
}

// Calidad alta a propósito -- a diferencia de comprimirImagen() (usada en
// envíos salientes, donde SÍ conviene reducir peso agresivamente), aquí
// el objetivo único es eliminar metadata sensible (EXIF/GPS) de una
// imagen que el cliente ya envió, sin degradar visiblemente su calidad.
const CALIDAD_LIMPIEZA_ENTRANTE = 92;

/**
 * Re-encoda una imagen ENTRANTE sin tocar dimensiones, únicamente para
 * eliminar metadata EXIF (que puede incluir GPS -- la ubicación real del
 * cliente) antes de guardarla. sharp() nunca preserva metadata en la
 * salida a menos que se llame .withMetadata() explícitamente (no se
 * llama aquí a propósito), así que cualquier re-encode ya la elimina;
 * .rotate() además aplica la orientación EXIF visualmente antes de
 * descartar la etiqueta, para que la imagen se vea igual sin importar
 * en qué orientación la haya tomado la cámara del cliente.
 */
export async function limpiarMetadatosImagen(buffer, mime) {
  const pipeline = sharp(buffer).rotate();
  if (mime === 'image/png') return (await pipeline.png({ compressionLevel: 6 }).toBuffer());
  if (mime === 'image/webp') return (await pipeline.webp({ quality: CALIDAD_LIMPIEZA_ENTRANTE }).toBuffer());
  return pipeline.jpeg({ quality: CALIDAD_LIMPIEZA_ENTRANTE, mozjpeg: true }).toBuffer();
}

function calcularChecksum(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

// Además de rutas ('/','\\') se eliminan TODOS los caracteres de control
// (0x00-0x1F, incluidos \r\n) y comillas dobles -- el nombre termina
// dentro de un header HTTP Content-Disposition entre comillas dobles
// (ver /api/imagenes/:id/archivo en server.js); un \r\n sin escapar ahí
// sería una inyección de header (response splitting), y una comilla sin
// escapar rompería el valor del header. El storage_key real siempre es
// un UUID generado en almacenamiento.js -- este nombre es solo metadata
// cosmética, nunca se usa para construir una ruta de archivo real.
export function sanitizarNombreImagen(nombre, extension) {
  const base = String(nombre || 'imagen')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1F\x7F"\\/]/g, '_')
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/\s+/g, '')
    .trim()
    .slice(0, 150) || 'imagen';
  return `${base}.${extension}`;
}

/**
 * Pipeline completo para una imagen entrante ya descargada de Meta (el
 * llamador -- whatsapp-meta.js -- ya creó la fila 'pendiente' antes de
 * esta llamada). No se redimensiona (el cliente ya la envió en el
 * tamaño que Meta entrega; recomprimir agresivamente una imagen ya
 * comprimida por WhatsApp solo perdería calidad sin beneficio real de
 * espacio), pero SÍ se re-encoda a calidad alta para eliminar EXIF/GPS
 * -- un dato de ubicación real del cliente que de otro modo quedaría
 * guardado sin que nadie lo haya pedido ni lo sepa.
 */
export async function procesarImagenEntranteDescargada(documentoId, negocioId, telefono, buffer) {
  const validacion = await validarImagenReal(buffer);
  if (!validacion.valido) {
    await marcarDocumentoError(documentoId, validacion.motivo);
    return { ok: false, motivo: validacion.motivo };
  }
  let limpia;
  try {
    limpia = await limpiarMetadatosImagen(buffer, validacion.mime);
  } catch {
    // metadata() ya validó que sharp puede leerla, pero el re-encode es
    // una segunda pasada real sobre el contenido completo -- si aun así
    // falla, se trata como corrupta en vez de guardar un archivo a medio
    // procesar o dejar una excepción sin capturar.
    await marcarDocumentoError(documentoId, 'imagen_corrupta');
    return { ok: false, motivo: 'imagen_corrupta' };
  }
  const checksum = calcularChecksum(limpia);
  const storageKey = await guardarArchivo(limpia, {
    negocioId, extension: validacion.extension, mimeType: validacion.mime,
    categoria: 'imagen', conversacionId: telefono,
  });
  await marcarDocumentoListo(documentoId, { sizeBytes: limpia.length, storageKey, checksum });
  return { ok: true, storageKey, sizeBytes: limpia.length, checksum };
}

/**
 * Pipeline para una imagen saliente (subida desde el panel): valida,
 * comprime/redimensiona, sube, y devuelve los datos listos para
 * registrar en `documentos` y enviar por Meta.
 */
export async function procesarImagenSaliente({ negocioId, telefono, buffer, filename }) {
  const validacion = await validarImagenReal(buffer);
  if (!validacion.valido) return { ok: false, motivo: validacion.motivo };

  let comprimida;
  try {
    comprimida = await comprimirImagen(buffer, validacion.mime);
  } catch {
    return { ok: false, motivo: 'imagen_corrupta' };
  }
  const checksum = calcularChecksum(comprimida.buffer);
  const storageKey = await guardarArchivo(comprimida.buffer, {
    negocioId, extension: comprimida.extension, mimeType: comprimida.mime,
    categoria: 'imagen', conversacionId: telefono,
  });
  return {
    ok: true,
    buffer: comprimida.buffer,
    mimeType: comprimida.mime,
    storageKey,
    sizeBytes: comprimida.buffer.length,
    checksum,
    filename: sanitizarNombreImagen(filename, comprimida.extension),
  };
}

export async function crearRegistroImagenEntrante({ negocioId, telefono, filename, caption, wamid, mediaId }) {
  return crearDocumentoPendiente({
    negocioId, telefono, direccion: 'entrante', origen: 'cliente',
    filename: filename || 'imagen', caption: caption || null, wamid: wamid || null,
    categoria: 'imagen', mediaId: mediaId || null,
  });
}

export async function crearRegistroImagenSaliente({ negocioId, telefono, filename, mimeType, sizeBytes, storageKey, caption, wamid, createdBy, checksum }) {
  return crearDocumentoSaliente({
    negocioId, telefono, filename, mimeType, sizeBytes, storageKey, caption: caption || null,
    wamid: wamid || null, createdBy, categoria: 'imagen', checksum,
  });
}
