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

/**
 * ¿El cliente confirmó de forma inequívoca? Conservador a propósito: ante
 * cualquier duda devuelve false y el flujo normal (LLM) sigue su curso.
 */
export function esConfirmacionVerbal(texto) {
  const t = normalizar(texto);
  if (!t) return false;
  // Un mensaje largo casi nunca es un "sí" seco: es una instrucción.
  if (t.split(' ').length > 5) return false;
  // "sí, pero cámbiale la salsa" NO confirma el resumen anterior.
  if (SENALES_MUTACION.some((re) => re.test(t))) return false;
  if (SENALES_NEGACION.some((re) => re.test(t))) return false;
  return AFIRMACIONES.has(t);
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
