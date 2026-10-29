/**
 * turnoImagen.js — Cómo se convierte una foto de WhatsApp en un turno de
 * conversación. Sin dependencias (leaf util, igual que elegibilidadRepartidor.js).
 *
 * Xabor NO interpreta imágenes: el cerebro es de texto. Eso no autoriza a
 * dejar al cliente en silencio, que es exactamente lo que pasaba -- el
 * webhook archivaba la foto para el chat del panel y hacía `return` sin
 * contestar nada. Caso real (Nonna Maye, 26-ago): un cliente mandó dos fotos
 * preguntando por escrito "¿Tienen este combo?" y no recibió ni una palabra.
 *
 * La foto entra ahora a la MISMA cola de 6 segundos que el texto, marcada.
 * Eso resuelve el agrupamiento gratis: "foto con caption", "foto y luego
 * texto" y "texto y luego foto" terminan en un solo turno con todo el
 * contexto. Si al vencer la cola no hay más que la marca (foto sola, muda),
 * se responde con un texto determinista, sin pasar por el modelo -- que no
 * puede ver la imagen y podría inventar lo que hay en ella.
 */

// Marca interna. Nunca se le muestra al cliente ni al modelo.
// Puede llevar el id del documento archivado ([[xabor:imagen:<uuid>]]):
// es lo que le permite a Vision V1 saber QUE archivo analizar cuando el
// turno vence. Una marca sin id (modulo apagado, MIME no soportado, o
// llamadores previos) sigue siendo valida y cae a la nota de siempre.
export const MARCA_IMAGEN = '[[xabor:imagen]]';
export const RE_MARCA_IMAGEN = /\[\[xabor:imagen(?::([0-9a-fA-F-]{8,36}))?\]\]/g;

// Lo que ve el modelo en lugar de la marca. Es una instrucción, no un dato:
// le dice que hay una foto que NO puede ver, para que pregunte en vez de
// suponer, y que jamás confirme una promoción basándose en ella.
export const NOTA_IMAGEN_PARA_IA =
  '(el cliente envió una foto que no puedo ver; no supongas su contenido ni confirmes promociones basándote en ella)';

/**
 * Fallback determinista. Se usa cuando la foto llega sola, cuando el módulo
 * de imágenes está apagado, cuando el tipo no se soporta o cuando falla la
 * descarga. Nunca afirma qué hay en la foto ni que una promoción siga
 * vigente: pregunta, que es lo único honesto sin verla.
 */
export const TEXTO_FALLBACK_IMAGEN =
  'Recibí tu imagen 😊 pero no puedo verla desde aquí. ¿Me dices con palabras qué necesitas? ' +
  'Si es por una promoción, dime cuál viste y con gusto te confirmo si está disponible.';

/** El turno que genera una foto: la marca, más el caption si vino con uno. */
export function turnoDeImagen(caption, documentoId = null) {
  const marca = (typeof documentoId === 'string' && documentoId.trim())
    ? `[[xabor:imagen:${documentoId.trim()}]]`
    : MARCA_IMAGEN;
  const c = typeof caption === 'string' ? caption.trim() : '';
  return c ? `${marca} ${c}` : marca;
}

/** Los ids de documento de las fotos de este turno, en orden de llegada. */
export function documentosDelTurno(textoCombinado) {
  const ids = [];
  for (const m of String(textoCombinado || '').matchAll(RE_MARCA_IMAGEN)) {
    if (m[1]) ids.push(m[1]);
  }
  return ids;
}

/** ¿El turno combinado trae SOLO fotos, sin una sola palabra del cliente? */
export function soloImagenes(textoCombinado) {
  return String(textoCombinado || '')
    .split('\n')
    .map(l => l.replace(RE_MARCA_IMAGEN, '').trim())
    .every(l => l === '');
}

/**
 * Reemplaza cada marca por lo que el modelo debe ver:
 *   - con `contextosPorDocumento` (Map id -> bloque de Vision) y analisis
 *     disponible para esa foto: el bloque de CONTEXTO VISUAL completo.
 *   - sin analisis (vision apagada, fallo, marca sin id): la nota de
 *     siempre -- hay una foto que no puede ver. Comportamiento intacto.
 * La marca interna jamas llega al modelo en ninguna de las dos rutas.
 */
export function prepararTurnoParaIA(textoCombinado, contextosPorDocumento = null) {
  return String(textoCombinado || '')
    .split('\n')
    .map(l => l.replace(RE_MARCA_IMAGEN, (marca, docId) => {
      const ctx = (docId && contextosPorDocumento && contextosPorDocumento.get) ? contextosPorDocumento.get(docId) : null;
      return ctx || NOTA_IMAGEN_PARA_IA;
    }).trim())
    .join('\n')
    .trim();
}

const RE_BLOQUE_VISUAL = /\[CONTEXTO VISUAL\][\s\S]*?(?:\[\/CONTEXTO VISUAL\]|$)/g;

/**
 * Lo que ESCRIBIÓ el cliente en un turno ya preparado: sin los bloques de
 * visión, sin la nota de «foto que no puedo ver» y sin marcas. Vacío = el
 * turno era solo fotos.
 */
export function textoSinImagenes(turno) {
  return String(turno || '')
    .replace(RE_BLOQUE_VISUAL, ' ')
    .split(NOTA_IMAGEN_PARA_IA).join(' ')
    .replace(RE_MARCA_IMAGEN, ' ')
    .split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

/**
 * Los hechos de cada bloque [CONTEXTO VISUAL] de un turno, leídos del texto
 * que arma construirBloqueContextoVisual (vision.js, v1 y v2; la prueba de ida
 * y vuelta está en fase-recepcion-imagenes). Solo lo que sirve para buscar en
 * la carta: tipo, nombres de lo que se ve, texto visible, marcas y confianza.
 * Nunca decide nada: quien la usa contrasta contra la carta y las promociones.
 */
export function leerContextosVisuales(turno) {
  const vistos = [];
  for (const [bloque] of String(turno || '').matchAll(RE_BLOQUE_VISUAL)) {
    const v = { tipo: null, nombres: [], textoVisible: [], marcas: [], confianza: null };
    for (const linea of bloque.split('\n')) {
      const m = linea.match(/^- ([^:]+): (.*)$/);
      if (!m) continue;
      const [, clave, valor] = m;
      if (clave === 'tipo') v.tipo = valor.trim();
      else if (clave === 'objetos' || clave === 'productos que parecen aparecer') {
        v.nombres = valor.split(/\),\s*/).map((x) => x.replace(/\s*\(confianza [^)]*\)?\s*$/, '').trim()).filter(Boolean);
      } else if (clave.startsWith('texto visible en la imagen')) {
        try { v.textoVisible = JSON.parse(`[${valor}]`).filter((x) => typeof x === 'string'); } catch { v.textoVisible = []; }
      } else if (clave === 'marcas visibles') v.marcas = valor.split(',').map((x) => x.trim()).filter(Boolean);
      else if (clave === 'marca visible' && valor.trim() !== 'no visible') v.marcas = [valor.trim()];
      else if (clave === 'confianza general') v.confianza = Number(valor);
    }
    vistos.push(v);
  }
  return vistos;
}
