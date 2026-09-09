// Intención de confirmación / cambio sobre un preview ya mostrado.
//
// Módulo PURO (sin I/O, sin LLM) para que la decisión transaccional sea
// determinista y testeable: una vez que Xabor mostró un resumen oficial, un
// "sí" del cliente confirma ESE pedido canónico. Antes esto dependía de que el
// modelo volviera a emitir <ORDEN_CONFIRMADA>; cuando no lo hacía, el bot
// declaraba el pedido confirmado y NO existía (caso real de Mapolato: preview
// de $255, "Sí" del cliente, cero folio).
//
// Criterio: FAIL-CLOSED. Solo se consideran confirmaciones las frases
// inequívocas y cortas. Cualquier señal de cambio, duda o pregunta gana sobre
// la afirmación ("sí pero cámbiale la salsa" NO es una confirmación).

function normalizar(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')  // sin acentos
    .toLowerCase()
    .replace(/[¡!¿?.,;:()"'*_~-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Afirmaciones inequívocas. Se comparan contra el mensaje COMPLETO normalizado
// (no por inclusión) para que "no, así no" jamás pase por contener "asi".
const AFIRMACIONES = new Set([
  'si', 'sí', 'sip', 'sii', 'siii', 'simon', 'sale', 'va', 'vale', 'ok', 'okey', 'okay',
  'confirmo', 'confirmado', 'confirma', 'lo confirmo',
  'correcto', 'exacto', 'asi es', 'eso es', 'ese es',
  'adelante', 'dale', 'listo', 'perfecto', 'excelente',
  'esta bien', 'asi esta bien', 'todo bien', 'todo correcto', 'esta correcto',
  'de acuerdo', 'claro', 'claro que si', 'si por favor', 'si porfa', 'porfa',
  'si esta bien', 'si correcto', 'si confirmo', 'asi lo quiero', 'lo quiero asi',
  'si adelante', 'si dale', 'si gracias', 'esta perfecto', 'me parece bien',
]);

// MUTACIÓN: el cliente quiere que el pedido sea distinto. Se clasifica por la
// INTENCIÓN (verbos de cambio), NUNCA por la puntuación: "¿me los puedes
// cambiar a rojos?" es una pregunta Y una mutación, mientras que "¿cuánto
// tarda?" es solo una consulta y no debe tocar el pedido.
const SENALES_MUTACION = [
  /\bcambi/, /\bmodific/, /\bquit/, /\bagreg/, /\banad/, /\bborr/, /\belimin/,
  /\bmejor\b/, /\ben lugar\b/, /\ben vez\b/, /\bsin\b/,
  /\bponle\b/, /\bpongale\b/, /\bponme\b/, /\bponlos\b/, /\bponlas\b/,
  /\bhazlo\b/, /\bhazme\b/, /\bque sea\b/, /\bsera\b/, /\ba domicilio\b/,
  /\botro\b/, /\botra\b/, /\bmas\b/, /\bmenos\b/, /\bcancel/, /\bolvid/,
  /\bespera\b/,
];

// NEGACIÓN pura: el cliente rechaza el resumen. No describe un cambio concreto,
// pero el pedido deja de estar listo para confirmarse.
const SENALES_NEGACION = [/^no$/, /^no gracias$/, /^asi no$/, /^nel$/, /^nop$/, /^para nada$/, /\bno\b/];

// Muletillas de ÉNFASIS que envuelven un sí sin cambiar su sentido. Un cliente
// que ya dijo que sí y a quien se le vuelve a preguntar no repite "sí" seco:
// sube el tono ("que sí", "ya te dije que sí", "¡que siiiiii!"). Ese fue el
// final del caso Edna — el bot no las reconocía, marcaba el turno como
// indeterminado y volvía a preguntar, hasta que la clienta se fue.
//
// Es una regla de FORMA, no una colección de frases: se quita el envoltorio y
// se vuelve a mirar el mismo núcleo afirmativo de siempre.
const MULETILLAS_ENFASIS = /^(?:ya\s+(?:te\s+)?(?:lo\s+)?dije\s+que|ya\s+dije\s+que|que|pues|bueno|orale|obvio)\s+(?=\S)/;

// ── Un sí envuelto en cortesía sigue siendo un sí ───────────────────────────
// La lista AFIRMACIONES se compara ENTERA contra el mensaje, así que solo
// reconocía la frase exacta. "confirmalo por favor" (tres palabras) o "listo,
// mandalo" (dos) no pasaban, y caían en 'indeterminado': el resumen dejaba de
// ser confirmable y el cliente recibía el mismo resumen otra vez. En
// producción (negocio 5de544d8…, 2026-09-08 08:22 CDT) eso obligó a un cliente
// a confirmar dos veces con 67 segundos de diferencia; el evento aparece cinco
// veces entre el 2 y el 8 de septiembre, en dos negocios.
//
// La tolerancia se abre por VOCABULARIO, no por longitud: se acepta el mensaje
// mientras cada palabra sea o un núcleo afirmativo o relleno de cortesía. En
// cuanto aparece una palabra con CONTENIDO —una cantidad, un producto, una
// modalidad— deja de ser un sí limpio y vuelve a fail-closed, porque entonces
// el cliente podría estar reformulando el pedido en vez de confirmarlo.

// Verbos con los que el cliente pide explícitamente que se registre: por sí
// solos ya son un sí ("confírmalo").
const VERBOS_CONFIRMAR = new Set([
  'confirmo', 'confirma', 'confirmalo', 'confirmala', 'confirmame', 'confirmenlo',
  'confirmado', 'confirmada', 'procede', 'mandalo', 'mandala',
  'envialo', 'enviala', 'registralo', 'registrala', 'anotalo', 'anotala',
]);

// Afirmaciones de UNA palabra (las de varias siguen resolviéndose por
// AFIRMACIONES, que se compara contra el mensaje completo).
const AFIRMACIONES_TOKEN = new Set([
  'si', 'sip', 'sii', 'simon', 'sale', 'va', 'vale', 'ok', 'okey', 'okay',
  'correcto', 'exacto', 'adelante', 'dale', 'listo', 'perfecto', 'excelente',
  'claro', 'bien', 'acuerdo',
]);

// Cortesía, muletillas y referencias al pedido que ya está en pantalla. Nada
// de esto puede cambiar lo que el cliente lleva; por eso puede acompañar a un
// sí sin volverlo ambiguo.
const RELLENO_CORTES = new Set([
  'por', 'favor', 'porfa', 'porfavor', 'gracias', 'ya', 'pues', 'bueno', 'orale',
  'todo', 'asi', 'esta', 'este', 'ese', 'esa', 'eso', 'es', 'lo', 'la', 'los', 'las',
  'le', 'me', 'mi', 'el', 'un', 'una', 'y', 'que', 'de', 'del', 'al', 'a',
  'pedido', 'orden', 'compra', 'quiero', 'dije', 'te',
]);

function nucleoAfirmativo(t) {
  let s = t;
  // Hasta dos capas ("pues que sí"), nunca en bucle.
  for (let i = 0; i < 2 && MULETILLAS_ENFASIS.test(s); i++) s = s.replace(MULETILLAS_ENFASIS, '');
  // Alargamiento enfático: "siiiiii" → "si", "daleee" → "dale". Solo a partir de
  // TRES repeticiones, para no tocar las dobles legítimas del español
  // ("correcto", "perro") ni romper afirmaciones ya conocidas como "sii".
  s = s.replace(/([a-z])\1{2,}/g, '$1');
  return s.trim();
}

/**
 * ¿El cliente confirmó de forma inequívoca? Conservador a propósito: ante
 * cualquier duda devuelve false y el flujo normal (LLM) sigue su curso.
 *
 * El orden importa: mutación y negación se evalúan sobre el texto COMPLETO y
 * ANTES de quitar muletillas, para que "que sea grande" siga siendo un cambio y
 * no se convierta en un "sí" al desnudarlo.
 */
export function esConfirmacionVerbal(texto) {
  const t = normalizar(texto);
  if (!t) return false;
  // "sí, pero cámbiale la salsa" NO confirma el resumen anterior. Va primero y
  // sobre el texto COMPLETO: cualquier señal de cambio gana sobre el sí.
  if (SENALES_MUTACION.some((re) => re.test(t))) return false;
  if (SENALES_NEGACION.some((re) => re.test(t))) return false;
  if (AFIRMACIONES.has(t) || AFIRMACIONES.has(nucleoAfirmativo(t))) return true;

  // Ninguna palabra puede aportar contenido al pedido, y al menos una tiene que
  // ser afirmativa: "por favor" solo, sin ningún sí, no confirma nada.
  const palabras = nucleoAfirmativo(t).split(' ').filter(Boolean);
  if (!palabras.length) return false;
  let hayNucleo = false;
  for (const w of palabras) {
    if (AFIRMACIONES_TOKEN.has(w) || VERBOS_CONFIRMAR.has(w)) { hayNucleo = true; continue; }
    if (RELLENO_CORTES.has(w)) continue;
    return false;
  }
  return hayNucleo;
}

/**
 * ¿El cliente quiere que el pedido CAMBIE (o lo rechaza)? Solo en ese caso el
 * resumen anterior queda obsoleto.
 *
 * Deliberadamente NO mira si la frase es interrogativa: una pregunta sobre el
 * pedido ("¿y la promo?", "¿cuánto tarda?", "¿aceptan tarjeta?") no modifica
 * nada y el cliente debe poder decir "sí" después. Lo que invalida es la
 * intención de cambio, la traiga o no un signo de interrogación.
 */
export function esMutacionDePedido(texto) {
  const t = normalizar(texto);
  if (!t) return false;
  if (SENALES_MUTACION.some((re) => re.test(t))) return true;
  return SENALES_NEGACION.some((re) => re.test(t));
}

// CONSULTA SEGURA: intención informativa RECONOCIBLE sobre un pedido que ya
// está armado. Es una lista POSITIVA a propósito — "no encontré ninguna palabra
// de cambio" no basta para dar por seguro que el mensaje no modifica nada.
// Cubre las preguntas reales que un cliente hace frente a un resumen: promoción
// o descuento, tiempo, horario, ubicación, formas de pago y el total mostrado.
const CONSULTAS_SEGURAS = [
  /\bpromo/, /\bdescuent/, /\boferta\b/, /\bcupon/,
  /\bcuanto (tarda|se tarda|hace|demora|tiempo)\b/, /\btarda/, /\bdemora/, /\bcuanto tiempo\b/,
  /\ba que hora\b/, /\bque hora\b/, /\bhorario\b/, /\bestaria listo\b/, /\bcuando esta/, /\bcuando lo/,
  /\bdonde (recojo|es|estan|queda|los recojo|lo recojo)\b/, /\bdireccion\b/, /\bubicacion\b/,
  /\bacepta[ns]?\b/, /\bpuedo pagar\b/, /\bformas? de pago\b/, /\bmetodos? de pago\b/,
  /\btarjeta\b/, /\befectivo\b/, /\btransferencia\b/, /\bterminal\b/,
  /\bcuanto (es|seria|queda|sale|me sale|va a ser)\b/, /\bcual es el total\b/, /\bel total\b/,
  /\bcuanto me (estas )?(descontand|cobran|cobras)/, /\bque incluye\b/,
];

/**
 * Clasifica el turno POSTERIOR a un preview oficial. Cuatro estados, y el
 * cuarto es el que hace seguro al sistema:
 *
 *  'confirmacion'     → confirmar el snapshot.
 *  'mutacion'         → el snapshot deja de ser confirmable; hace falta uno nuevo.
 *  'consulta_segura'  → intención informativa reconocida: el snapshot sigue
 *                       confirmable y el cliente puede decir "sí" después.
 *  'indeterminado'    → NO sabemos si modifica el pedido ("los quiero rojos",
 *                       "quiero pollo en el segundo"). No se borra el snapshot
 *                       —el flujo normal puede resolverlo y generar un preview
 *                       nuevo— pero deja de ser directamente confirmable: jamás
 *                       se registra un pedido que quizá ya no es el que el
 *                       cliente quiere.
 *
 * La regla arquitectónica, deliberadamente, NO es una lista exhaustiva del
 * español: sabemos que es consulta → conservar; sabemos que es mutación →
 * invalidar; no sabemos → no ejecutar el snapshot viejo.
 */
export function clasificarTurnoPostPreview(texto) {
  // Un TURNO puede traer varios mensajes. `colaMensajes` agrupa lo que el
  // cliente escriba dentro de la ventana y los une con '\n', así que lo que
  // llega aquí no siempre es una frase: cuando alguien contesta la forma de
  // pago y enseguida confirma, el texto es "efectivo\nsi".
  //
  // Clasificado en bloque, ese turno hacía match con la consulta segura de
  // formas de pago y NUNCA con la confirmación: el "sí" se perdía dentro del
  // turno y el pedido no se registraba. Caso real 2026-09-09, dos veces en la
  // misma tarde, con la clienta viendo "¿Confirmas?" después de haber dicho
  // que sí (ver test/fase-confirmacion-agrupada.mjs).
  //
  // La combinación es FAIL-CLOSED y en este orden: basta UNA línea que cambie
  // el pedido para invalidar, y una que no se entienda para no registrar. Solo
  // se confirma cuando ninguna línea es peligrosa y alguna es afirmación
  // inequívoca.
  const lineas = String(texto || '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (lineas.length <= 1) return clasificarFrase(texto);
  const clases = lineas.map(clasificarFrase);
  if (clases.includes('mutacion')) return 'mutacion';
  if (clases.includes('indeterminado')) return 'indeterminado';
  if (clases.includes('confirmacion')) return 'confirmacion';
  return 'consulta_segura';
}

/** Clasifica UNA frase. Antes era el cuerpo entero de la función de arriba. */
function clasificarFrase(texto) {
  const t = normalizar(texto);
  if (!t) return 'indeterminado';
  if (esConfirmacionVerbal(texto)) return 'confirmacion';
  if (esMutacionDePedido(texto)) return 'mutacion';
  if (CONSULTAS_SEGURAS.some((re) => re.test(t))) return 'consulta_segura';
  return 'indeterminado';
}

/** ¿Es una consulta informativa reconocida (que conserva el snapshot)? */
export function esConsultaNoMutante(texto) {
  return clasificarTurnoPostPreview(texto) === 'consulta_segura';
}

// Nombre anterior, conservado para no romper llamadores existentes.
export const esCambioSobrePreview = esMutacionDePedido;
