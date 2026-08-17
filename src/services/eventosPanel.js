// ─── Identidad de los eventos que el panel recibe ───────────────────────────
//
// EL PROBLEMA
//
// La obligación financiera garantiza que un pedido se autoriza UNA vez. La
// emisión, no: `emitirPedido()` manda `nuevo_pedido` al panel y solo DESPUÉS se
// escribe la marca durable de derivación. Un proceso que muere en esa ventana
// deja el evento ya entregado y la marca sin escribir, así que el retry vuelve
// a emitir. El backend no puede prometer exactly-once sobre un WebSocket.
//
// Lo que sí se puede prometer es que el panel haga UN SOLO EFECTO LÓGICO. Para
// eso el evento necesita una identidad que sobreviva al crash, al reinicio, a
// la reconexión y a que lo emita otra instancia: la misma que tendría si se
// recuperara mañana.
//
// LA IDENTIDAD
//
//   <tipo>:<negocioId>:<folio>
//
// Determinística y nada más. NO entra el timestamp, ni un randomUUID, ni el id
// del socket, ni el pid: cualquiera de esos haría que el mismo pedido llegara
// con una identidad distinta en cada intento -- que es exactamente lo que
// permitía el efecto repetido.
//
// El `negocioId` va SIEMPRE. Dos negocios pueden tener el mismo folio, y sin él
// el panel de uno dedupearía -- o peor, silenciaría -- el pedido del otro.
//
// El tipo distingue la comanda del ticket de cuenta final: son dos efectos
// distintos sobre el mismo folio y ninguno debe tapar al otro.

/** Tipos de evento de panel que llevan identidad. */
export const EVENTO_PEDIDO = 'nuevo_pedido';
export const EVENTO_CUENTA_FINAL = 'cuenta_final';

/**
 * Identidad determinística de un evento de pedido para el panel.
 *
 * Devuelve null si falta negocio o folio: sin ellos no hay identidad posible y
 * es preferible que el panel trate el evento como no deduplicable a que use una
 * clave ambigua que pudiera colisionar con otro negocio.
 */
export function claveEventoPedido({ negocioId, folio, tipoComanda = null }) {
  const nid = typeof negocioId === 'string' ? negocioId.trim() : '';
  const f = folio == null ? '' : String(folio).trim();
  if (!nid || !f) return null;
  const tipo = tipoComanda === 'cuenta_final' ? EVENTO_CUENTA_FINAL : EVENTO_PEDIDO;
  return `${tipo}:${nid}:${f}`;
}

/**
 * Adjunta la identidad al mensaje que va al panel.
 *
 * Se usa en TODOS los productores de `nuevo_pedido` hacia el panel -- emisión
 * normal, pedidos programados y el volcado inicial de la reconexión -- para que
 * el mismo pedido llegue siempre con la misma clave, venga por donde venga.
 */
export function conIdentidadDePedido(mensaje, pedido) {
  const eventId = claveEventoPedido({
    negocioId: pedido?.negocioId,
    folio: pedido?.id,
    tipoComanda: pedido?.tipo_comanda,
  });
  return eventId ? { ...mensaje, eventId } : mensaje;
}
