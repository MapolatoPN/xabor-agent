/**
 * pdfTexto.js — Extracción de texto POR PÁGINA de un PDF NATIVO (Fase 1 del
 * importador de menús). Aísla la dependencia pdfjs-dist: se importa de forma
 * perezosa (dynamic import) SOLO cuando se llama, para que el resto del
 * sistema y los tests que no tocan PDFs no dependan de la librería.
 *
 * Fase 1 = SOLO PDF con texto real. Si el PDF prácticamente no trae texto
 * (menú escaneado / hecho de imágenes) NO se adivina: se lanza el error
 * PDF_REQUIERE_VISION para que la UI ofrezca el flujo de Fase 2 (aún no
 * disponible). NO hay OCR ni render de páginas aquí.
 */

// Umbral: caracteres alfanuméricos mínimos en TODO el documento para
// considerarlo "PDF con texto". Por debajo de esto asumimos escaneado/imagen
// (un menú escaneado no trae capa de texto: da ~0 caracteres). Un menú nativo,
// aun mínimo, supera holgadamente este piso.
const MIN_CHARS_SIGNIFICATIVOS = 12;

// pdfjs (legacy build) se resuelve una vez y se cachea.
let _pdfjs = null;
let _standardFontDataUrl = null;
async function cargarPdfjs() {
  if (!_pdfjs) {
    // Legacy build = funciona en Node sin worker ni canvas (solo texto).
    _pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    // Ruta a las fuentes estándar (silencia el warning de fetchStandardFontData;
    // no es necesaria para extraer texto). Falla en silencio si no se resuelve.
    try {
      const { createRequire } = await import('module');
      const require = createRequire(import.meta.url);
      const pkg = require.resolve('pdfjs-dist/package.json');
      const { pathToFileURL } = await import('url');
      const { dirname, join } = await import('path');
      _standardFontDataUrl = pathToFileURL(join(dirname(pkg), 'standard_fonts') + '/').href;
    } catch { _standardFontDataUrl = null; }
  }
  return _pdfjs;
}

/** Reconstruye el texto de una página respetando saltos de línea (hasEOL). */
function textoDePagina(items) {
  const lineas = [];
  let actual = [];
  for (const it of items) {
    if (typeof it.str === 'string' && it.str.length) actual.push(it.str);
    if (it.hasEOL) {
      const linea = actual.join(' ').replace(/\s+/g, ' ').trim();
      if (linea) lineas.push(linea);
      actual = [];
    }
  }
  const cola = actual.join(' ').replace(/\s+/g, ' ').trim();
  if (cola) lineas.push(cola);
  return lineas.join('\n');
}

/**
 * Extrae el texto por página de un PDF nativo.
 * @param {Buffer|Uint8Array} buffer  bytes del PDF (ya validado como PDF real).
 * @returns {Promise<{ paginas: {pagina:number, texto:string}[], totalPaginas:number, totalChars:number }>}
 * @throws {Error} con .codigo === 'PDF_REQUIERE_VISION' si no hay texto útil,
 *                 o .codigo === 'PDF_ILEGIBLE' si pdfjs no puede abrirlo.
 */
export async function extraerTextoPorPagina(buffer) {
  const pdfjs = await cargarPdfjs();
  // pdfjs 4.x exige un Uint8Array "plano" (rechaza Buffer, que es subclase).
  const datos = buffer && buffer.constructor === Uint8Array ? buffer : Uint8Array.from(buffer);
  let doc;
  try {
    doc = await pdfjs.getDocument({
      data: datos,
      useWorkerFetch: false,
      isEvalSupported: false,
      disableFontFace: true,
      ...(_standardFontDataUrl ? { standardFontDataUrl: _standardFontDataUrl } : {}),
      // Sin worker: en Node corre en el mismo hilo (Fase 1 solo lee texto).
    }).promise;
  } catch (e) {
    const err = new Error('No se pudo abrir el PDF: ' + (e?.message || 'desconocido'));
    err.codigo = 'PDF_ILEGIBLE';
    throw err;
  }

  const paginas = [];
  let totalChars = 0;
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      const texto = textoDePagina(tc.items || []);
      totalChars += (texto.match(/[\p{L}\p{N}]/gu) || []).length;
      paginas.push({ pagina: i, texto });
      // Liberar recursos de la página (buena práctica en pdfjs).
      page.cleanup?.();
    }
  } finally {
    await doc.cleanup?.().catch(() => {});
    doc.destroy?.().catch(() => {});
  }

  if (totalChars < MIN_CHARS_SIGNIFICATIVOS) {
    const err = new Error('El PDF prácticamente no contiene texto.');
    err.codigo = 'PDF_REQUIERE_VISION';
    err.totalChars = totalChars;
    throw err;
  }

  return { paginas, totalPaginas: doc.numPages, totalChars };
}

export const _internos = { textoDePagina, MIN_CHARS_SIGNIFICATIVOS };
