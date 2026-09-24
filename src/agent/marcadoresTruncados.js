// ─── UN MARCADOR SIN CERRAR NO SE LIMPIA, Y SALE ENTERO AL CLIENTE ───────
//
// `limpiarTexto` borra los bloques de máquina con una regex por pareja:
//
//     /<ORDEN_PREVIEW>[\s\S]*?<\/ORDEN_PREVIEW>/g
//
// Es no codiciosa y EXIGE la etiqueta de cierre. Si el modelo se queda sin
// tokens a media JSON, el bloque no tiene cierre, la regex no casa, y lo que
// se manda por WhatsApp es el volcado.
//
// Pasó de verdad. Mapolato Obispado, 23 de septiembre de 2026, 12:55: un
// cliente que estaba pidiendo chilaquiles recibió 2807 caracteres acabados en
//
//     "subtotal": 660,
//     "costo_envio": 0,
//     "descuento": 0,
//     "total": 660,
//
// y la conversación se murió ahí. No hubo pedido.
//
// ── La regla ─────────────────────────────────────────────────────────────
//
// Después de quitar los bloques BIEN FORMADOS, cualquier etiqueta de apertura
// que siga en pie está, por definición, sin cerrar. Desde ahí hasta el final
// es carga de máquina: el modelo estaba escribiendo el bloque cuando se le
// acabó el presupuesto, así que no hay nada suyo después. Se corta entero.
//
// ── Por qué esto vive en su propio archivo ───────────────────────────────
//
// Para que `brain.js` —componente protegido y único camino a la respuesta del
// cliente— cambie en dos líneas y no en veinte, y para que esto se pueda
// probar sin arrancar el servidor: importar `brain.js` arrastra `server.js`
// entero por `getIntegracion`, y una garantía que solo se puede probar
// levantando la aplicación es una garantía que se prueba poco.

/**
 * Los bloques que llevan pareja. Los sueltos —`<ENVIAR_MENU>`,
 * `<ESCALAR_A_HUMANO>`, `<CONSULTA_PENDIENTE:…>`— no entran: no tienen cierre
 * que echar en falta, y `limpiarTexto` ya los quita por su cuenta. Meterlos
 * aquí haría que un `<ENVIAR_MENU>` al final del mensaje se comiera el texto
 * que lo acompaña.
 */
export const BLOQUES_CON_CIERRE = Object.freeze([
  'ORDEN_CONFIRMADA',
  'ORDEN_PREVIEW',
  'CONSULTA_PROMOS',
  'PEDIDO_BORRADOR',
  'SOLICITAR_FACTURA',
  // El asistente comercial también transporta JSON interno dentro de
  // parejas. Si el proveedor corta cualquiera de ellas, el payload es tan
  // privado e incompleto como una orden y debe fallar cerrado.
  'CAMPO_COMERCIAL_CAPTURADO',
  'OBJECION_DETECTADA',
]);

const tokensDe = (tag) => new RegExp(`<\\s*(/?)\\s*${tag}\\s*>`, 'gi');

/** Posiciones de aperturas que no encontraron cierre, en orden. */
function aperturasSinCerrar(texto, tag) {
  const abiertas = [];
  const re = tokensDe(tag);
  let match;
  while ((match = re.exec(texto)) !== null) {
    if (match[1]) {
      if (abiertas.length) abiertas.pop();
    } else {
      abiertas.push(match.index);
    }
  }
  return abiertas;
}

/**
 * ¿Qué bloque quedó abierto y sin cerrar? Devuelve su nombre, o `null`.
 *
 * Se cuenta aperturas contra cierres en vez de buscar «apertura sin cierre
 * después»: un mensaje puede traer un bloque bien formado Y otro truncado
 * —el modelo emite el preview y empieza la confirmación—, y ahí lo que falla
 * es el número, no el orden.
 *
 * Trabaja sobre el texto CRUDO del modelo, antes de limpiarlo.
 */
export function marcadorSinCerrar(texto) {
  const t = String(texto || '');
  for (const tag of BLOQUES_CON_CIERRE) {
    if (aperturasSinCerrar(t, tag).length) return tag;
  }
  return null;
}

/** Atajo booleano, para quien solo necesita decidir si escalar. */
export const hayMarcadorSinCerrar = (texto) => marcadorSinCerrar(texto) !== null;

/**
 * Quita parejas completas con la misma gramática tolerante del detector:
 * mayúsculas/minúsculas y espacios dentro de la etiqueta no cambian el
 * contrato. Debe correr antes de `cortarMarcadorSinCerrar`.
 */
export function quitarBloquesCerrados(texto) {
  return BLOQUES_CON_CIERRE.reduce((actual, tag) => actual.replace(
    new RegExp(`<\\s*${tag}\\s*>[\\s\\S]*?<\\s*/\\s*${tag}\\s*>`, 'gi'),
    '',
  ), String(texto || ''));
}

/**
 * CORTA desde la primera apertura sin pareja hasta el final.
 *
 * Se aplica DESPUÉS de haber quitado los bloques bien formados: si se
 * aplicara antes, un mensaje con un bloque cerrado y luego prosa perdería la
 * prosa. Ese orden no es un detalle de implementación, es la diferencia entre
 * cortar lo que sobra y cortar lo que el cliente tenía que leer.
 *
 * Puede dejar el texto vacío, y está bien: quien llama ya no manda mensajes
 * vacíos (`whatsapp-meta.js` lo comprueba antes de enviar) y el perfil de
 * catering los convierte en revisión humana. Callarse es feo; mandar el
 * volcado es peor, y mandar media respuesta sobre un pedido que el backend no
 * procesó es lo peor de los tres.
 */
export function cortarMarcadorSinCerrar(texto) {
  const t = String(texto || '');
  let corte = t.length;
  for (const tag of BLOQUES_CON_CIERRE) {
    const abiertas = aperturasSinCerrar(t, tag);
    if (abiertas.length) corte = Math.min(corte, abiertas[0]);
  }
  return t.slice(0, corte).trim();
}
