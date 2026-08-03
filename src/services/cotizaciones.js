/**
 * cotizaciones.js — Orquesta la generación/reutilización del PDF de una
 * cotización y su envío como documento en el chat. El CRUD y el
 * versionado viven en database.js (mismo criterio del resto del
 * archivo: database.js es la única capa que toca el pool de Postgres).
 */
import { obtenerCotizacion, guardarPdfCotizacion, marcarCotizacionEnviada, obtenerConfiguracion } from './database.js';
import { generarPdfCotizacion } from './cotizacionPdf.js';
import { guardarArchivo } from './almacenamiento.js';

const CLAVES_MARCA = ['nombre', 'rfc', 'direccion', 'telefono', 'logo_base64', 'color_primario'];

async function obtenerConfigMarca(negocioId) {
  const config = await obtenerConfiguracion(negocioId);
  const marca = {};
  for (const clave of CLAVES_MARCA) marca[clave] = config[clave] || null;
  return marca;
}

/**
 * Devuelve el PDF de la versión ACTUAL de la cotización -- lo genera
 * si no existe todavía (o si la última edición lo invalidó, ver
 * database.actualizarCotizacion que limpia pdf_storage_key al versionar)
 * y lo cachea en cotizaciones.pdf_storage_key para no regenerarlo en
 * cada apertura.
 */
export async function obtenerOGenerarPdfCotizacion(cotizacionId, negocioId) {
  const cotizacion = await obtenerCotizacion(cotizacionId, negocioId);
  if (!cotizacion) return null;
  if (cotizacion.pdf_storage_key) return { cotizacion, storageKey: cotizacion.pdf_storage_key, generado: false };

  const marca = await obtenerConfigMarca(negocioId);
  const buffer = await generarPdfCotizacion(cotizacion, marca);
  const storageKey = await guardarArchivo(buffer, { negocioId, extension: 'pdf' });
  await guardarPdfCotizacion(cotizacionId, storageKey);
  return { cotizacion, storageKey, generado: true, buffer };
}

/**
 * PDF con marca de agua "BORRADOR — NO ENVIAR AL CLIENTE" para notificar
 * al administrador (nunca al cliente). Deliberadamente NUNCA cachea en
 * cotizaciones.pdf_storage_key -- ese campo es solo para el PDF final
 * limpio que ve el cliente (obtenerOGenerarPdfCotizacion arriba). Si
 * este PDF borrador se guardara ahí, la aprobación reutilizaría por
 * error el PDF marcado como borrador en vez de regenerar uno limpio.
 * Se regenera cada vez que se pide (solo ocurre una vez por borrador
 * nuevo en el flujo automático, y ocasionalmente si el admin pide
 * reenviarlo manualmente) -- no vale la pena una segunda columna de
 * caché para un PDF que existe para dejar de existir en cuanto se
 * aprueba.
 */
export async function generarPdfBorradorParaAdmin(cotizacionId, negocioId) {
  const cotizacion = await obtenerCotizacion(cotizacionId, negocioId);
  if (!cotizacion) return null;
  const marca = await obtenerConfigMarca(negocioId);
  const buffer = await generarPdfCotizacion(cotizacion, marca, { esBorrador: true });
  return { cotizacion, buffer };
}

export { marcarCotizacionEnviada };
