// Proyeccion canonica de una fila durable al objeto que usa el tablero.
//
// `datos` es una fotografia del pedido. La columna SQL `estado` es la fuente
// de verdad porque las transiciones de pago, cancelacion y entrega ocurren en
// esa columna. Si ambas difieren despues de un reinicio, confiar en la
// fotografia puede ocultar del tablero un pedido ya pagado y enviado a cocina.
export function pedidoActivoDesdeFila(fila = {}) {
  const datos = fila.datos && typeof fila.datos === 'object' ? fila.datos : {};
  return {
    ...datos,
    estado: fila.estado ?? datos.estado ?? null,
    entregado_at: fila.entregado_at || datos.entregado_at || null,
    negocioId: datos.negocioId || fila.negocio_id || null,
  };
}
