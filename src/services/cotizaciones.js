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

export { marcarCotizacionEnviada };
