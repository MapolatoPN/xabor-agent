// Maneja los pedidos confirmados
// Guarda en DB (persistente) y en memoria para el panel via WebSocket

import {
  guardarPedidoActivo,
  actualizarEstadoPedidoDB,
  archivarPedidoActivo,
  obtenerPedidosActivos
} from '../services/database.js';

let wsBroadcast = null;
const pedidos = [];
let contadorPedidos = 1;

export function setWsBroadcast(fn) {
  wsBroadcast = fn;
}

// Carga pedidos activos desde la DB al arrancar el servidor
export async function cargarPedidosDesdeDB() {
  try {
    const activos = await obtenerPedidosActivos();
    pedidos.length = 0;
    for (const p of activos) {
      pedidos.push(p);
      // Mantener el contador por encima del folio más alto
      const num = parseInt(p.id?.replace('XAB-', '')) || 0;
      if (num >= contadorPedidos) contadorPedidos = num + 1;
    }
    console.log(`[OrderManager] ${pedidos.length} pedidos activos cargados desde DB`);
  } catch (e) {
    console.error('[OrderManager] Error cargando pedidos desde DB:', e.message);
  }
}

export function registrarPedido(orden, canal = 'test') {
  const pedido = {
    ...orden,
    id: `XAB-${String(contadorPedidos).padStart(4, '0')}`,
    canal,
    timestamp: new Date().toISOString(),
    estado: 'nuevo'
  };

  pedidos.push(pedido);
  contadorPedidos++;

  // Guardar en DB para que sobreviva reinicios
  guardarPedidoActivo(pedido);

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

  // Persistir en DB
  if (nuevoEstado === 'entregado') {
    archivarPedidoActivo(id);
  } else {
    actualizarEstadoPedidoDB(id, nuevoEstado);
  }

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
