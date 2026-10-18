// El cierre de venta en panel entrega el pedido al repartidor. La recepción
// final tiene su propia evidencia; asignar un repartidor no acredita salida.
export function esPedidoDomicilio(pedido = {}) {
  const d = pedido.datos || pedido;
  return /domicilio|delivery/.test(String(d.modalidad || d.formaEntrega || '').toLowerCase());
}

export function estadoParaCliente(pedido = {}) {
  const d = pedido.datos || pedido;
  const estado = pedido.estado || d.estado;
  if (estado === 'cancelado' || !esPedidoDomicilio(pedido)) return estado;
  if (!['nuevo','en_preparacion','listo','entregado','en_camino','en_reparto'].includes(estado)) return estado;
  if (d.entrega_estado === 'entregado') return 'entregado';
  if (estado === 'entregado' || ['recogido', 'en_camino'].includes(d.entrega_estado)) return 'en_camino';
  return estado;
}
