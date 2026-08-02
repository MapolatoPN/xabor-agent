/**
 * documentos.js — Validación y orquestación de documentos PDF en el chat
 * (recepción desde WhatsApp y envío desde el panel). No depende de
 * ningún negocio en particular; toda la lógica de negocio-específico
 * (permisos, módulo habilitado) vive en server.js.
 */
import { fileTypeFromBuffer } from 'file-type';
import {
  crearDocumentoPendiente, marcarDocumentoListo, marcarDocumentoError,
} from './database.js';
import { guardarArchivo } from './almacenamiento.js';

function tamanoMaximoBytes() {
  return (Number(process.env.PDF_TAMANO_MAXIMO_MB) || 15) * 1024 * 1024;
}

/**
 * Valida el MIME real por magic bytes (nunca confia en el Content-Type
 * declarado por Meta ni en la extension del nombre de archivo) y el
 * tamano maximo. Cubre "rechazar ejecutables disfrazados" y "rechazar
 * archivos corruptos" -- un PDF corrupto/truncado no produce una firma
 * %PDF valida reconocible por file-type y se rechaza igual.
 */
export async function validarPdfReal(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { valido: false, motivo: 'archivo_vacio' };
  }
  if (buffer.length > tamanoMaximoBytes()) {
    return { valido: false, motivo: 'tamano_excedido' };
  }
  const tipo = await fileTypeFromBuffer(buffer);
  if (!tipo || tipo.mime !== 'application/pdf') {
    return { valido: false, motivo: 'mime_invalido' };
  }
  return { valido: true };
}

// Nunca usa el nombre tal cual (podria contener rutas, caracteres de
// control, o intentar escapar del directorio de almacenamiento -- el
// storage_key real ya es un UUID generado en almacenamiento.js, esto
// solo sanea el nombre VISIBLE que se guarda como metadato).
export function sanitizarNombreArchivo(nombre) {
  const base = String(nombre || 'documento.pdf')
    .replace(/[\\/]/g, '_')
    .replace(/\s+/g, '')
    .trim()
    .slice(0, 200);
  return base.toLowerCase().endsWith('.pdf') ? base : `${base}.pdf`;
}

/**
 * Pipeline completo para un documento entrante ya descargado de Meta
 * (el llamador -- whatsapp-meta.js -- ya creo la fila 'pendiente' antes
 * de esta llamada, por el principio de guardar primero). Valida y
 * guarda el archivo, y deja el documento en 'listo' o 'error'.
 */
export async function procesarDocumentoEntranteDescargado(documentoId, negocioId, buffer) {
  const validacion = await validarPdfReal(buffer);
  if (!validacion.valido) {
    await marcarDocumentoError(documentoId, validacion.motivo);
    return { ok: false, motivo: validacion.motivo };
  }
  const storageKey = await guardarArchivo(buffer, { negocioId, extension: 'pdf' });
  await marcarDocumentoListo(documentoId, { sizeBytes: buffer.length, storageKey });
  return { ok: true, storageKey, sizeBytes: buffer.length };
}

/** Pipeline para un documento saliente (subido desde el panel). */
export async function procesarDocumentoSaliente({ negocioId, buffer, filename }) {
  const validacion = await validarPdfReal(buffer);
  if (!validacion.valido) return { ok: false, motivo: validacion.motivo };
  const storageKey = await guardarArchivo(buffer, { negocioId, extension: 'pdf' });
  return { ok: true, storageKey, sizeBytes: buffer.length, filename: sanitizarNombreArchivo(filename) };
}

export async function crearRegistroDocumentoEntrante({ negocioId, telefono, filename, caption, wamid }) {
  return crearDocumentoPendiente({
    negocioId, telefono, direccion: 'entrante', origen: 'cliente',
    filename: sanitizarNombreArchivo(filename), caption: caption || null, wamid: wamid || null,
  });
}
