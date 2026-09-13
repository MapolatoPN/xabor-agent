// ─── En qué punto de la atención vamos ────────────────────────────────────
//
// Módulo puro. Deriva la fase de la conversación de lo que ya se sabe: qué hizo
// el cliente en este turno, qué hay en el pedido y qué falta.
//
// ── No es un wizard, y la diferencia es todo ─────────────────────────────
//
// La fase NO decide qué puede hacer el cliente. El cliente puede darlo todo en
// un mensaje —«dos chilaquiles verdes para recoger y pago en efectivo»— y pasar
// de `inicio` a `revisando` de un salto, y puede volverse atrás en cualquier
// momento. Un flujo que obligue a pasar por pasos convierte una conversación en
// un formulario, que es exactamente lo que la gente evita cuando escribe por
// WhatsApp.
//
// Lo único que hace la fase es ORIENTAR al que redacta:
//
//   qué preguntar        lo que falta, no lo que ya está
//   qué no repetir       lo que ya se preguntó
//   cuándo recomendar    no mientras corrige, no después de «es todo»
//   cuándo confirmar     cuando no queda nada bloqueando
//
// Se recalcula cada turno desde cero. No hay transiciones prohibidas ni estados
// de los que no se pueda salir: una máquina de estados estricta aquí se
// convertiría, el día que el cliente diga algo raro, en un bot atascado.

export const FASE_INICIAL = 'inicio';

/**
 * La fase que corresponde a este turno.
 *
 * `entrada`:
 *   intenciones      las de `clasificarIntenciones`
 *   carrito          para saber si hay pedido
 *   datos            { modalidad, pago } de lo que ya se sabe
 *   aclaraciones     las que bloquean, si las hay
 *   confirmado       si la orden ya salió
 *   escalado         si se pasó a una persona
 *   requierePago     si este negocio pide forma de pago antes de cerrar
 */
export function faseDelTurno({
  intenciones = [], carrito = null, datos = {}, aclaraciones = [],
  confirmado = false, escalado = false, requierePago = true,
} = {}) {
  const tiene = (i) => intenciones.includes(i);
  const hayPedido = Array.isArray(carrito?.items) && carrito.items.length > 0;

  if (escalado || tiene('PEDIR_HUMANO')) return 'escalado_humano';
  if (confirmado) return 'confirmado';
  if (tiene('CANCELAR')) return 'inicio';

  // Algo impide avanzar: la fase lo dice, para que el que redacta pregunte eso
  // y no otra cosa.
  if (aclaraciones.some((a) => a.tipo === 'grupo_requerido')) return 'completando_producto';
  if (aclaraciones.length && hayPedido) return 'completando_producto';

  if (!hayPedido) {
    if (tiene('CONSULTA_MENU') || tiene('CONSULTA_PRODUCTO') || tiene('CONSULTA_PRECIO')
        || tiene('CONSULTA_INGREDIENTES') || tiene('CONSULTA_PROMOCION') || tiene('PEDIR_RECOMENDACION')) {
      return 'explorando_menu';
    }
    if (tiene('INICIAR_ORDEN')) return 'tomando_orden';
    return 'inicio';
  }

  if (tiene('CONFIRMAR') && !aclaraciones.length) return 'confirmando';
  if (!datos?.modalidad) return 'esperando_modalidad';
  if (requierePago && !datos?.pago) return 'esperando_pago';
  return 'revisando';
}

/**
 * Qué falta para poder cerrar, en el orden en que conviene pedirlo.
 *
 * Devuelve claves, no frases: quien redacte decide cómo se pregunta, y el
 * contexto sabe cuáles ya se preguntaron.
 */
export function loQueFalta({ carrito = null, datos = {}, aclaraciones = [], requierePago = true } = {}) {
  const falta = [];
  const hayPedido = Array.isArray(carrito?.items) && carrito.items.length > 0;
  if (!hayPedido) { falta.push('productos'); return falta; }
  for (const a of aclaraciones) if (a.tipo === 'grupo_requerido') falta.push(`grupo:${a.grupo}`);
  if (!datos?.modalidad) falta.push('modalidad');
  if (requierePago && !datos?.pago) falta.push('pago');
  return falta;
}

/** ¿Se puede pasar a confirmar? Solo si no hay nada abierto. */
export const listoParaConfirmar = (entrada) => loQueFalta(entrada).length === 0
  && !(entrada?.aclaraciones || []).length;

/**
 * Lo siguiente que conviene preguntar, sin repetir.
 *
 * `preguntadoYa` es la lista de claves que el contexto ya tiene como
 * pendientes preguntadas en los últimos turnos. Volver a preguntar lo mismo dos
 * turnos seguidos es la queja más común contra los bots de pedidos, y aquí se
 * arregla mirando el contexto en vez de esperando que el modelo se acuerde.
 */
export function siguientePregunta(entrada, preguntadoYa = []) {
  const pendientes = loQueFalta(entrada);
  const nueva = pendientes.find((p) => !preguntadoYa.includes(p));
  // Si TODO lo que falta ya se preguntó, se repite lo primero: el cliente no
  // contestó y hay que insistir, pero una vez y por lo más importante.
  return nueva || pendientes[0] || null;
}
