/**
 * colaMensajes.js — Agrupamiento de mensajes seguidos de un mismo cliente.
 *
 * Un cliente que escribe tres frases seguidas no quiere tres respuestas. La
 * cola junta todo lo que llegue dentro de una ventana corta y entrega UN
 * turno. Es también la única fuente de verdad del "turno pendiente": si algo
 * entra tarde a esta cola, abre un turno nuevo y el cliente recibe dos
 * respuestas.
 *
 * Eso es exactamente lo que pasó con las imágenes (smoke C, 26-ago): la foto
 * solo se encolaba DESPUÉS de descargar la media de Meta (~7 s medidos), así
 * que el texto que la precedía ya había vencido su ventana. Quien encole
 * debe hacerlo al RECIBIR el mensaje, nunca después de una operación lenta.
 *
 * Sin dependencias (leaf util, igual que turnoImagen.js) para poder probar
 * el comportamiento temporal sin levantar el servidor.
 */

export const VENTANA_AGRUPAMIENTO_MS = 6000;

const bufferMensajes = new Map();

/**
 * Encola `texto` bajo `clave` y reinicia la ventana. Al vencer, entrega todo
 * lo acumulado —en orden de llegada, una línea por mensaje— a `procesarFn`.
 *
 * `ventanaMs` existe para las pruebas: en producción siempre es la de 6 s.
 */
export function encolarMensaje(clave, texto, procesarFn, ventanaMs = VENTANA_AGRUPAMIENTO_MS) {
  if (bufferMensajes.has(clave)) {
    const entry = bufferMensajes.get(clave);
    clearTimeout(entry.timer);
    entry.textos.push(texto);
  } else {
    bufferMensajes.set(clave, { textos: [texto] });
  }
  const entry = bufferMensajes.get(clave);
  entry.timer = setTimeout(() => {
    const textosCombinados = bufferMensajes.get(clave)?.textos.join('\n') || texto;
    bufferMensajes.delete(clave);
    procesarFn(textosCombinados);
  }, ventanaMs);
}

/** ¿Hay un turno abierto para esta conversación? (diagnóstico y pruebas) */
export function hayTurnoPendiente(clave) {
  return bufferMensajes.has(clave);
}

/** Solo para pruebas: deja la cola limpia entre casos. */
export function reiniciarCola() {
  for (const entry of bufferMensajes.values()) clearTimeout(entry.timer);
  bufferMensajes.clear();
}
