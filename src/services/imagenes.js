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
 * archivo con extensión .jpg falsa que en realidad es un ejecutable u
 * otro binario se rechaza aquí, igual que un archivo vacío o corrupto
 * (fileTypeFromBuffer no reconoce una firma válida y se trata como
 * mime_invalido).
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

function calcularChecksum(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function sanitizarNombreImagen(nombre, extension) {
  const base = String(nombre || 'imagen')
    .replace(/[\\/]/g, '_')
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/\s+/g, '')
    .trim()
    .slice(0, 150) || 'imagen';
  return `${base}.${extension}`;
}

/**
 * Pipeline completo para una imagen entrante ya descargada de Meta (el
 * llamador -- whatsapp-meta.js -- ya creó la fila 'pendiente' antes de
 * esta llamada). A diferencia del envío desde el panel, NO se
 * recomprime la imagen recibida -- el cliente ya la envió en el tamaño
 * que Meta entrega; recomprimir una imagen ya comprimida por WhatsApp
 * solo perdería calidad sin beneficio real de espacio.
 */
export async function procesarImagenEntranteDescargada(documentoId, negocioId, telefono, buffer) {
  const validacion = await validarImagenReal(buffer);
  if (!validacion.valido) {
    await marcarDocumentoError(documentoId, validacion.motivo);
    return { ok: false, motivo: validacion.motivo };
  }
  const checksum = calcularChecksum(buffer);
  const storageKey = await guardarArchivo(buffer, {
    negocioId, extension: validacion.extension, mimeType: validacion.mime,
    categoria: 'imagen', conversacionId: telefono,
  });
  await marcarDocumentoListo(documentoId, { sizeBytes: buffer.length, storageKey, checksum });
  return { ok: true, storageKey, sizeBytes: buffer.length, checksum };
}

/**
 * Pipeline para una imagen saliente (subida desde el panel): valida,
 * comprime/redimensiona, sube, y devuelve los datos listos para
 * registrar en `documentos` y enviar por Meta.
 */
export async function procesarImagenSaliente({ negocioId, telefono, buffer, filename }) {
  const validacion = await validarImagenReal(buffer);
  if (!validacion.valido) return { ok: false, motivo: validacion.motivo };

  const comprimida = await comprimirImagen(buffer, validacion.mime);
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
