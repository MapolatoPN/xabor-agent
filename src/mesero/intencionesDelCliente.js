// ─── Preguntar no es pedir ────────────────────────────────────────────────
//
// Módulo puro. Clasifica QUÉ quiere hacer el cliente con este mensaje, sin
// decidir nada sobre el pedido y sin mirar el catálogo.
//
// ── La separación que importa ────────────────────────────────────────────
//
//   «¿Qué bebidas tienes?»        no agrega nada
//   «Ponme una coca»              agrega
//
// Los dos mensajes nombran una bebida. El bot de hoy no distingue: el modelo
// devuelve un borrador y, si el borrador trae la coca, la coca entra. El
// reconciliador la deja pasar con razón —«coca» está en lo que dijo el
// cliente— porque nadie le dijo que esa frase era una pregunta.
//
// Esta es la pieza que se lo dice.
//
// ── Por qué no hay nombres de productos aquí ─────────────────────────────
//
// Lo que separa una consulta de una orden no es el sustantivo, es el VERBO y la
// forma de la frase:
//
//   tener, haber, manejar, vender, incluir, traer(algo), costar, valer,
//   recomendar          → el cliente pregunta por la carta
//
//   querer, dar, poner, agregar, mandar, traer(me), servir, llevarme
//                       → el cliente pide
//
// Un catálogo nuevo no cambia una línea de este archivo. Es el mismo criterio
// que ya usa `evidenciaDeEleccion`: la gramática es nuestra, los productos son
// del negocio.
//
// ── Un mensaje, varias intenciones ───────────────────────────────────────
//
// «Dame dos chilaquiles verdes con pollo, uno sin cebolla, para recoger y pago
// en efectivo» es cuatro cosas a la vez. Se parte en cláusulas y cada una se
// clasifica por su cuenta, así que ninguna se traga a las otras. Lo que sale es
// una lista, nunca una sola etiqueta.
//
// ── Y qué NO hace ────────────────────────────────────────────────────────
//
// No dice QUÉ producto, ni CUÁNTOS, ni a qué renglón apunta. Eso es del
// catálogo, del reconciliador y de `referenciasDelCliente`. Aquí solo se
// responde «¿de qué tipo de acto es esta frase?».
import { hayVerboDeQuitar } from '../orders/carritoDelPedido.js';

export const INTENCIONES = Object.freeze([
  'SALUDO',
  'CONSULTA_MENU',
  'CONSULTA_PRODUCTO',
  'CONSULTA_PRECIO',
  'CONSULTA_INGREDIENTES',
  'CONSULTA_PROMOCION',
  'PEDIR_RECOMENDACION',
  'INICIAR_ORDEN',
  'AGREGAR_PRODUCTO',
  'MODIFICAR_PRODUCTO',
  'CAMBIAR_CANTIDAD',
  'CAMBIAR_MODIFICADOR',
  'AGREGAR_NOTA',
  'QUITAR',
  'DEFINIR_MODALIDAD',
  'DEFINIR_PAGO',
  'CONFIRMAR',
  'CANCELAR',
  'DESPEDIR',
  'PEDIR_HUMANO',
  'OTRO',
]);

/** Las que NO pueden tocar el pedido. Se consulta desde el orquestador. */
export const SON_CONSULTA = Object.freeze([
  'CONSULTA_MENU', 'CONSULTA_PRODUCTO', 'CONSULTA_PRECIO',
  'CONSULTA_INGREDIENTES', 'CONSULTA_PROMOCION', 'PEDIR_RECOMENDACION',
]);

const norm = (s) => String(s || '')
  .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9ñ¿?¡! ]/g, ' ').replace(/\s+/g, ' ').trim();

// ── Cláusulas ────────────────────────────────────────────────────────────
//
// Se corta por puntuación y por las conjunciones que en español separan actos
// («y», «pero», «además», «también»). No se corta por «con» ni por «sin»: esos
// pegan un modificador a lo que viene antes y separarlos perdería a qué van.
const SEPARADORES = /[,;.!?¿¡\n]+|\s+(?:y|pero|ademas|tambien|aparte de eso|luego|despues)\s+/;

/**
 * Parte el texto ORIGINAL, no el normalizado.
 *
 * Cada cláusula se clasifica con su versión sin acentos, pero lo que sale de
 * aquí conserva las letras del cliente: `textoQueAutoriza` devuelve fragmentos
 * de esta lista y esos fragmentos van a parar al reconciliador, que compara
 * contra el catálogo. Devolverle texto ya masticado sería cambiarle la entrada
 * sin avisarle.
 */
export function partirEnClausulas(texto) {
  return String(texto || '')
    .split(SEPARADORES)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

// ── Verbos ───────────────────────────────────────────────────────────────

// Preguntar por la carta. `trae`/`lleva`/`viene` en tercera persona hablan del
// platillo; `traeme` es otra cosa y está en la lista de abajo.
const V_CONSULTA = /\b(tienes|tiene|tienen|hay|manejas|manejan|maneja|vendes|venden|vende|sirven|incluye|incluyen|trae|traen|lleva|llevan|viene|vienen|contiene|contienen|cuesta|cuestan|vale|valen|sale|salen|es|son|queda|quedan|puedo|puedes|podrias|podrian|habra|habria)\b/;

const V_PEDIR = /\b(quiero|quisiera|queria|quer[ií]a|me gustaria|dame|dam[eé]|me das|me da|deme|ponme|p[oó]nme|pon|ponle|agrega|agregame|agr[eé]game|agregale|a[nñ]ade|a[nñ]ademe|mandame|m[aá]ndame|manda|traeme|tr[aá]eme|sirveme|s[ií]rveme|echame|[eé]chame|sumale|s[uú]male|me llevo|llevame|ll[eé]vame|encargame|enc[aá]rgame|pideme|p[ií]deme|va|vale|sale|ordeno|ordename|quiero pedir|voy a querer|voy a pedir|se me antoja|antojo)\b/;

const INTERROGATIVO = /(^|\s)(que|qu[eé]|cual|cu[aá]l|cuales|cu[aá]les|cuanto|cu[aá]nto|cuanta|cu[aá]nta|cuantos|cu[aá]ntos|cuantas|cu[aá]ntas|como|c[oó]mo|donde|d[oó]nde|cuando|cu[aá]ndo)(\s|$)/;

// ── Familias temáticas. Vocabulario OPERATIVO, no de carta. ──────────────

const T_MENU = /\b(menu|men[uú]|carta|catalogo|cat[aá]logo|lista de precios|que tienen|que manejan|que hay|que venden|que ofrecen|opciones|variedades|de que tienen|que mas tienen)\b/;
const T_PRECIO = /\b(precio|precios|cuesta|cuestan|vale|valen|cuanto sale|cuanto es|cuanto seria|en cuanto|cobran|cobras|tarifa|costo)\b/;
const T_INGREDIENTES = /\b(que trae|que lleva|que incluye|que tiene|de que es|de que son|ingredientes|contiene|viene con|con que viene|es picante|lleva picante|es grande|que tan grande|porcion|porci[oó]n)\b/;
const T_PROMO = /\b(promocion|promoci[oó]n|promociones|promo|promos|oferta|ofertas|descuento|descuentos|combo|combos|paquete|paquetes|2x1|dos por uno|especial del dia|especiales)\b/;
const T_RECOMENDACION = /\b(recomiendas|recomienda|recomiendan|recomendacion|recomendaci[oó]n|recomiendame|recomi[eé]ndame|sugieres|sugieren|sugerencia|que me conviene|que esta bueno|que esta rico|que es lo mejor|lo mas pedido|lo mas vendido|sorprendeme|sorpr[eé]ndeme|tu que pedirias|algo rico|algo bueno|algo ligero|algo llenador|algo fuerte|algo economico|algo barato)\b/;

const T_MODALIDAD = /\b(para recoger|a recoger|recojo|recoger|paso por|yo paso|paso a|para llevar|me lo llevo|domicilio|a domicilio|envio|env[ií]o|enviar|entrega|entregar|me lo mandan|mandenmelo|para comer aqui|comer aqui|en el local|en sucursal|en la sucursal|para aca|mesa)\b/;
const T_PAGO = /\b(efectivo|en efectivo|tarjeta|con tarjeta|debito|d[eé]bito|credito|cr[eé]dito|transferencia|transferir|deposito|dep[oó]sito|terminal|clip|pago con|pagar con|pago en|contra entrega|al recibir)\b/;

const T_SALUDO = /^(hola|holi|buenas|buenos dias|buenas tardes|buenas noches|buen dia|que onda|que tal|hey|ola|saludos|disculpa|disculpe|oye|buenass?)\b/;
const T_DESPEDIDA = /\b(gracias|muchas gracias|adios|adi[oó]s|hasta luego|nos vemos|bye|hasta pronto|que esten bien|buen dia gracias)\b/;
const T_HUMANO = /\b(hablar con|persona|humano|encargado|gerente|dueno|due[nñ]o|alguien real|operador|atencion humana|no eres real|eres un bot|quiero hablar con alguien)\b/;

const T_CONFIRMAR = /\b(confirmo|confirmar|confirmado|asi esta bien|asi lo dejo|asi dejalo|esta bien asi|correcto|es correcto|todo bien|adelante|mandalo|m[aá]ndalo|enviar el pedido|ya esta|listo|dale ya|es todo|eso es todo|seria todo|ser[ií]a todo|nada mas|ya con eso|si asi esta bien)\b/;
const T_CANCELAR = /\b(cancela el pedido|cancelar el pedido|cancela todo|ya no quiero nada|olvidalo todo|olv[ií]dalo todo|mejor nada|ya no quiero el pedido|cancelo|cancelar todo|dejalo asi mejor no)\b/;

const T_INICIAR = /\b(quiero ordenar|quiero pedir|quiero hacer un pedido|voy a ordenar|voy a pedir|para ordenar|para pedir|hacer un pedido|tomar mi orden|puedo ordenar|puedo pedir|me tomas la orden|levantar un pedido)\b/;

const T_CANTIDAD = /\b(mejor (?:dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|una|uno|un|\d+)|hazlos|hazlas|haz(?:me)? (?:dos|tres|cuatro|cinco|\d+)|que sean|que sea (?:dos|tres|\d+)|ponme (?:otro|otra|uno mas|una mas)|uno mas|una mas|otro mas|otra mas|otra igual|otro igual|dos mas|tres mas|sube(?:le)? a|bajale a|b[aá]jale a|solo (?:uno|una|dos)|nada mas (?:uno|una|dos))\b/;

const T_MODIFICADOR = /\b(sin |con |mejor con|mejor sin|que sea de|que sean de|cambialo a|c[aá]mbialo a|cambiala a|en vez de|en lugar de|pero sin|pero con|extra |sin nada de|bien |poco |mucho )/;

const T_NOTA = /\b(nota|anota|anotale|an[oó]tale|apunta|diles que|digan que|avisales|av[ií]sales|por favor que|porfa que|si se puede que|es para regalo|va de regalo|sin cubiertos|con cubiertos|aparte por favor|todo aparte|bien caliente|no muy caliente|para nino|para ni[nñ]o|alergia|alergico|al[eé]rgico)\b/;

/** ¿Esta cláusula es una pregunta sobre la carta, y no una petición? */
function esConsulta(c) {
  const pide = V_PEDIR.test(c);
  const interroga = INTERROGATIVO.test(c) || /\?|^¿/.test(c);
  const verboDeConsulta = V_CONSULTA.test(c);
  // «¿me das dos cocas?» lleva signo de interrogación y es una orden: la
  // cortesía mexicana pregunta lo que pide. Lo que la separa de una consulta no
  // es el signo, es que no hay pronombre interrogativo NI verbo de existencia.
  //
  // Y al revés: «qué me recomiendas» no lleva signo y es una consulta.
  if (pide && !INTERROGATIVO.test(c)) return false;
  if (T_RECOMENDACION.test(c)) return true;
  if (!interroga && !verboDeConsulta) return false;
  return interroga || verboDeConsulta;
}

function intencionesDeClausula(c, { fase = null } = {}) {
  const fuera = new Set();
  const consulta = esConsulta(c);

  if (T_HUMANO.test(c)) fuera.add('PEDIR_HUMANO');
  if (T_SALUDO.test(c)) fuera.add('SALUDO');

  // ── CONSULTAS ──────────────────────────────────────────────────────────
  if (consulta) {
    if (T_RECOMENDACION.test(c)) fuera.add('PEDIR_RECOMENDACION');
    if (T_PROMO.test(c)) fuera.add('CONSULTA_PROMOCION');
    if (T_PRECIO.test(c)) fuera.add('CONSULTA_PRECIO');
    if (T_INGREDIENTES.test(c)) fuera.add('CONSULTA_INGREDIENTES');
    if (T_MENU.test(c)) fuera.add('CONSULTA_MENU');
    if (![...fuera].some((i) => SON_CONSULTA.includes(i))) fuera.add('CONSULTA_PRODUCTO');
    // UNA CONSULTA NO AGREGA. Se sale aquí a propósito: el resto del análisis
    // es sobre actos que tocan el pedido, y esta cláusula no es uno.
    return [...fuera];
  }

  // «me pasas el menú» pide, pero pide el menú, no comida.
  if (T_MENU.test(c) && !T_PRECIO.test(c)) { fuera.add('CONSULTA_MENU'); return [...fuera]; }
  if (T_PROMO.test(c)) { fuera.add('CONSULTA_PROMOCION'); return [...fuera]; }
  if (T_RECOMENDACION.test(c)) { fuera.add('PEDIR_RECOMENDACION'); return [...fuera]; }

  // ── ACTOS SOBRE EL PEDIDO ──────────────────────────────────────────────
  if (T_CANCELAR.test(c)) fuera.add('CANCELAR');
  else if (hayVerboDeQuitar(c)) fuera.add('QUITAR');

  if (T_CANTIDAD.test(c)) fuera.add('CAMBIAR_CANTIDAD');
  if (T_MODIFICADOR.test(c)) fuera.add('CAMBIAR_MODIFICADOR');
  if (T_NOTA.test(c)) fuera.add('AGREGAR_NOTA');
  if (T_MODALIDAD.test(c)) fuera.add('DEFINIR_MODALIDAD');
  if (T_PAGO.test(c)) fuera.add('DEFINIR_PAGO');
  if (T_CONFIRMAR.test(c)) fuera.add('CONFIRMAR');
  if (T_DESPEDIDA.test(c)) fuera.add('DESPEDIR');

  if (T_INICIAR.test(c)) fuera.add('INICIAR_ORDEN');
  else if (V_PEDIR.test(c) && !fuera.has('QUITAR') && !fuera.has('CAMBIAR_CANTIDAD')) {
    fuera.add('AGREGAR_PRODUCTO');
  } else if (!fuera.size && /\b(\d+|un|una|unos|unas|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\b/.test(c)
             && ['tomando_orden', 'completando_producto', 'revisando'].includes(fase)) {
    // «unos chilaquiles», a secas, en medio de una orden. Fuera de esa fase no
    // se asume: el mismo texto al principio de la conversación puede ser
    // cualquier cosa, y suponer que es un pedido es adivinar.
    fuera.add('AGREGAR_PRODUCTO');
  }

  if (!fuera.size) fuera.add('OTRO');
  return [...fuera];
}

/**
 * Las intenciones de un turno completo.
 *
 * Devuelve `{ intenciones, porClausula, soloConsulta }`.
 *
 *   intenciones   la lista sin repetir, en el orden en que aparecen
 *   porClausula   qué fragmento produjo cada cosa, para poder auditarlo
 *   soloConsulta  el turno NO puede tocar el pedido. Es la señal que usa el
 *                 orquestador para no pasarle el turno al reconciliador.
 */
export function clasificarIntenciones(texto, { fase = null } = {}) {
  const clausulas = partirEnClausulas(texto);
  const porClausula = [];
  const vistas = [];
  for (const original of clausulas) {
    const c = norm(original);
    if (!c) continue;
    const ints = intencionesDeClausula(c, { fase });
    porClausula.push({
      fragmento: original,
      intenciones: ints,
      esConsulta: ints.every((i) => SON_CONSULTA.includes(i)),
    });
    for (const i of ints) if (!vistas.includes(i)) vistas.push(i);
  }
  if (!vistas.length) { vistas.push('OTRO'); porClausula.push({ fragmento: '', intenciones: ['OTRO'], esConsulta: false }); }

  // Un turno es SOLO consulta cuando ninguna de sus cláusulas pide nada. Basta
  // una que pida para que el turno pueda mover el pedido — «¿qué bebidas
  // tienes? ponme una coca» son dos actos y el segundo vale.
  const tocanElPedido = vistas.filter((i) => !SON_CONSULTA.includes(i)
    && !['SALUDO', 'DESPEDIR', 'OTRO', 'PEDIR_HUMANO'].includes(i));
  return {
    intenciones: vistas,
    porClausula,
    tocaElPedido: tocanElPedido.length > 0,
    soloConsulta: tocanElPedido.length === 0 && vistas.some((i) => SON_CONSULTA.includes(i)),
  };
}

/**
 * EL TEXTO QUE PUEDE AUTORIZAR UN CAMBIO EN EL PEDIDO.
 *
 * Aquí es donde «consulta no es orden» deja de ser una intención y se vuelve
 * una garantía, y el sitio importa. La tentación era cerrarle el paso al
 * reconciliador cuando el turno parece una consulta; sería peor: una
 * clasificación fallida se comería un pedido de verdad.
 *
 * Lo que se hace es más pequeño y más seguro: se le entrega al reconciliador el
 * mismo texto de siempre MENOS las cláusulas que son preguntas. Él sigue
 * decidiendo con sus reglas. Si esta capa se equivoca de más, el cliente repite
 * su pedido; si se equivoca de menos, el reconciliador vuelve a ser exactamente
 * lo que era antes del mesero.
 *
 *   «¿tienes coca?»                 -> ''            no nombra nada que autorice
 *   «¿tienes coca? ponme una»       -> 'ponme una'   la segunda sí pide
 *   «ponme una coca»                -> 'ponme una coca'
 */
export function textoQueAutoriza(texto, { fase = null } = {}) {
  const { porClausula } = clasificarIntenciones(texto, { fase });
  return porClausula.filter((c) => !c.esConsulta).map((c) => c.fragmento).join(' ').trim();
}

/** ¿Este turno puede modificar el pedido? Orienta la respuesta; no es una compuerta. */
export const puedeTocarElPedido = (clasificacion) => !!clasificacion?.tocaElPedido;

/** ¿Aparece esta intención? */
export const tiene = (clasificacion, intencion) =>
  (clasificacion?.intenciones || []).includes(intencion);
