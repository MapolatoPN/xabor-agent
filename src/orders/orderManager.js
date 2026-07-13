// Maneja los pedidos confirmados
// Guarda en memoria y emite eventos al panel via WebSocket

let wsBroadcast = null; // función inyectada por server.js
const pedidos = [];
let contadorPedidos = 1;

// El servidor inyecta la función de broadcast al arrancar
export function setWsBroadcast(fn) {
  wsBroadcast = fn;
}

export function registrarPedido(orden, canal = 'test') {
  const pedido = {
    ...orden,
    id: `XAB-${String(contadorPedidos).padStart(4, '0')}`,
    canal,
    timestamp: new Date().toISOString(),
    estado: 'nuevo' // 'nuevo' | 'en_preparacion' | 'listo' | 'entregado'
  };

  pedidos.push(pedido);
  contadorPedidos++;

  console.log('\n' + '='.repeat(50));
  console.log(`🎉 NUEVO PEDIDO: ${pedido.id} [${canal}]`);
  console.log(`   Cliente: ${pedido.cliente?.nombre} — $${pedido.total} MXN`);
  console.log('='.repeat(50) + '\n');

  return pedido;
}

export function emitirPedido(pedido) {
  if (wsBroadcast) {
    wsBroadcast({ tipo: 'nuevo_pedido', pedido });
  }
}

export function actualizarEstadoPedido(id, nuevoEstado) {
  const pedido = pedidos.find(p => p.id === id);
  if (!pedido) return null;
  pedido.estado = nuevoEstado;
  if (wsBroadcast) {
    wsBroadcast({ tipo: 'actualizar_estado', id, estado: nuevoEstado });
  }
  return pedido;
}

export function obtenerPedidos() {
  return pedidos;
}

export function obtenerPedidoPorId(id) {
  return pedidos.find(p => p.id === id);
}
