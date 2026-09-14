// ─── Agregar, reemplazar o quitar: lo dice el cliente, no el modelo ───────
//
// Módulo puro. Mira el texto del cliente y dice qué clase de cambio pidió sobre
// un grupo de modificadores. No conoce ningún producto, grupo ni opción: sólo
// la forma en que la gente pide un cambio.
//
// ── Por qué hace falta ───────────────────────────────────────────────────
//
// Un grupo de modificadores se venía tratando siempre igual: lo propuesto
// SUSTITUÍA a lo que hubiera. Con eso, «también chipotle» borraba la suiza que
// el cliente había pedido un turno antes, y era imposible pedir dos salsas en
// dos mensajes.
//
// La corrección de eso —dejar sobrevivir lo que ya estaba— es correcta para
// «también» y PELIGROSA para «mejor»: si el modelo propone las dos salsas y el
// cliente dijo «mejor chipotle», conservar la suiza le sirve al cliente algo
// que pidió quitar.
//
// Así que la operación no se hereda del modelo ni se supone: se lee del texto.
// El modelo puede sugerirla; esto la comprueba.
//
// ── Lo que NO se hace aquí ───────────────────────────────────────────────
//
// No se decide QUÉ opción entra ni si existe: eso es del catálogo y del
// reconciliador. Aquí sólo se responde «¿esto suma, sustituye o resta?».

const norm = (s) => String(s || '')
  .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9ñ ]/g, ' ').replace(/\s+/g, ' ').trim();

// SUMA. «también», «además», «agrégale», «y ponle». Lo que tienen en común es
// que presuponen lo anterior: nadie dice «también» de algo que empieza de cero.
const AGREGA = new RegExp('(^|\\s)('
  + [
    'tambien', 'tambien con', 'ademas', 'aparte', 'agregale', 'agrega', 'agregame',
    'anade', 'anadele', 'ponle tambien', 'y ponle', 'y agregale', 'y tambien',
    'sumale', 'echale tambien', 'con.* tambien', 'y de paso',
  ].join('|') + ')(\\s|$)');

// Y la «y» que ABRE un mensaje, que es otra forma de decir «además»: «y
// chipotle» continúa el turno anterior. A media frase no: en «chilaquiles y
// unas papas» la «y» sólo enumera, y tomarla por suma haría que cualquier
// mensaje con dos cosas conservara selecciones viejas.
const ABRE_SUMANDO = /^\s*(y|e)\s+\S/;

// SUSTITUYE. «mejor», «en vez de», «cambia». Aquí lo nuevo desplaza a lo viejo.
const REEMPLAZA = new RegExp('(^|\\s)('
  + [
    'mejor', 'en vez de', 'en lugar de', 'cambia', 'cambiale', 'cambiame',
    'sustituye', 'sustituyele', 'cambialo por', 'que sea', 'hazlo con',
    'ya no.* sino', 'no.* sino',
  ].join('|') + ')(\\s|$)');

// RESTA. Se reutiliza la misma familia de verbos que ya usa el carrito para
// quitar una opción: si aquí se escribiera otra lista, las dos se irían
// separando y un «quítale» dejaría de significar lo mismo en dos sitios.
const QUITA = new RegExp('(^|\\s)('
  + [
    'sin', 'quita', 'quitar', 'quitame', 'quitale', 'elimina', 'borra', 'saca',
    'sacale', 'retira', 'ya no quiero', 'ya no', 'no le pongas', 'no le ponga',
    'dejalo sin', 'dejala sin',
  ].join('|') + ')(\\s|$)');

export const OPERACIONES = Object.freeze(['agregar', 'reemplazar', 'quitar']);

/**
 * QUÉ PIDIÓ EL CLIENTE SOBRE UN GRUPO, SEGÚN SU TEXTO.
 *
 * Devuelve `null` cuando el texto no lo dice, y eso NO es un fallo: es la
 * respuesta honesta. Quien llama decide qué hacer sin esa señal — y lo que hace
 * es lo conservador de siempre, sustituir, que es el comportamiento que había
 * antes de que esto existiera.
 *
 * El orden importa. «mejor sin chipotle» quita, no sustituye; «ya no quiero
 * chipotle, mejor roja» sustituye. Se mira primero lo que resta, luego lo que
 * sustituye, y sumar es lo último porque es lo más débil: «con chipotle
 * también» suma, pero «mejor con chipotle también» ya no.
 */
export function operacionSobreElGrupo(texto) {
  const t = norm(texto);
  if (!t) return null;
  if (QUITA.test(t) && !REEMPLAZA.test(t)) return 'quitar';
  if (REEMPLAZA.test(t)) return 'reemplazar';
  if (AGREGA.test(t) || ABRE_SUMANDO.test(t)) return 'agregar';
  return null;
}

/**
 * ¿El texto respalda SUMAR esta opción a las que ya había?
 *
 * Es la única pregunta que hace falta para decidir si lo ya elegido sobrevive
 * al turno. Se separa de `operacionSobreElGrupo` porque la respuesta por
 * omisión tiene que ser NO: sin señal explícita de suma, un grupo se sustituye,
 * como siempre. Equivocarse hacia sumar deja en el pedido algo que el cliente
 * creía haber cambiado, y eso llega a la cocina.
 */
export const pidioSumar = (texto) => operacionSobreElGrupo(texto) === 'agregar';

/** ¿El texto respalda QUITAR? Se usa para no confundir un «sin» con un cambio. */
export const pidioQuitar = (texto) => operacionSobreElGrupo(texto) === 'quitar';
