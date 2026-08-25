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
export const MARCA_IMAGEN = '[[xabor:imagen]]';

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
export function turnoDeImagen(caption) {
  const c = typeof caption === 'string' ? caption.trim() : '';
  return c ? `${MARCA_IMAGEN} ${c}` : MARCA_IMAGEN;
}

/** ¿El turno combinado trae SOLO fotos, sin una sola palabra del cliente? */
export function soloImagenes(textoCombinado) {
  return String(textoCombinado || '')
    .split('\n')
    .map(l => l.replace(MARCA_IMAGEN, '').trim())
    .every(l => l === '');
}

/** Reemplaza la marca por la nota, para que el modelo sepa qué pasó. */
export function prepararTurnoParaIA(textoCombinado) {
  return String(textoCombinado || '')
    .split('\n')
    .map(l => (l.includes(MARCA_IMAGEN) ? l.replace(MARCA_IMAGEN, NOTA_IMAGEN_PARA_IA).trim() : l))
    .join('\n')
    .trim();
}
