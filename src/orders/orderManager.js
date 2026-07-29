// Maneja los pedidos confirmados
// Guarda en DB (persistente) y en memoria para el panel via WebSocket

import {
  guardarPedidoActivo,
  actualizarEstadoPedidoDB,
  archivarPedidoActivo,
  obtenerPedidosActivos,
  obtenerMaxFolioNum,
  obtenerNegocioIdPorSlug,
  eliminarPedido as eliminarPedidoDB
} from '../services/database.js';

let wsBroadcast = null;
const pedidos = [];
let contadorPedidos = 1;

export function setWsBroadcast(fn) {
  wsBroadcast = fn;
}

// ─── Respaldo temporal de negocio (Fase 5 — threading operativo) ───────────
// WhatsApp y Voz todavía NO resuelven su propio negocioId en el borde del
// canal (a diferencia de Rappi, que ya lo hace vía obtenerIntegracionCanal
// en rappi.js) — sus pedidos siguen llegando a registrarPedido sin
// negocioId. Para no romper su funcionamiento actual mientras se migran,
// se cachea aquí UNA sola vez, al arrancar, el negocio por defecto (Nonna
// Maye) y se usa como respaldo SOLO para canales distintos de 'rappi'. Si
// no se puede resolver (p. ej. migraciones 003/004 aún no aplicadas),
// queda en null y esos canales simplemente siguen sin negocio_id, EXACTO
// el comportamiento de hoy — nunca se bloquea un pedido de WhatsApp/Voz
// por esto.
//
// Rappi NUNCA usa este respaldo: si un pedido de canal 'rappi' llega sin
// negocioId ya resuelto, registrarPedido lo rechaza explícitamente (ver
// abajo) en vez de adivinar un negocio.
//
// PENDIENTE DE ELIMINAR: cuando WhatsApp y Voz resuelvan su propio
// negocioId en el borde del canal (mismo patrón que Rappi), esta variable,
// su carga en cargarPedidosDesdeDB() y su uso en registrarPedido deben
// eliminarse por completo.
let _negocioFallbackId = null;

// Carga pedidos activos desde la DB al arrancar el servidor
export async function cargarPedidosDesdeDB() {
  try {
    const [activos, maxFolio, negocioFallback] = await Promise.all([
      obtenerPedidosActivos(),
      obtenerMaxFolioNum(),
      obtenerNegocioIdPorSlug('nonna-maye')
    ]);
    _negocioFallbackId = negocioFallback;

    pedidos.length = 0;
    for (const p of activos) {
      pedidos.push(p);
    }

    // El contador siempre arranca por encima del folio más alto en DB
    // Esto previene duplicados aunque haya pedidos entregados/archivados
    const maxDesdeActivos = activos.reduce((max, p) => {
      const num = parseInt(p.id?.replace('XAB-', '')) || 0;
      return num > max ? num : max;
    }, 0);
    contadorPedidos = Math.max(maxFolio, maxDesdeActivos) + 1;

    console.log(`[OrderManager] ${pedidos.length} pedidos activos cargados desde DB — próximo folio: XAB-${String(contadorPedidos).padStart(4, '0')}`);
  } catch (e) {
    console.error('[OrderManager] Error cargando pedidos desde DB:', e.message);
  }
}

export function registrarPedido(orden, canal = 'test') {
  // Rappi ya resuelve negocioId de forma confiable en el borde del canal
  // (rappi.js, vía obtenerIntegracionCanal, nunca desde datos manipulables
  // del payload) y SIEMPRE debe traerlo en orden.negocioId al llegar aquí.
  // Si falta, es un error real -- no un caso a rellenar -- y se rechaza
  // ANTES de tocar memoria, DB o WebSocket.
  if (canal === 'rappi' && !orden.negocioId) {
    throw new Error('registrarPedido: pedido de canal "rappi" sin negocioId resuelto — se rechaza antes de persistir o emitir');
  }

  // negocioId final: el que ya trae la orden (Rappi, siempre; otros
  // canales, cuando se migren) o el respaldo temporal solo para canales
  // no-Rappi todavía sin migrar (ver comentario junto a _negocioFallbackId).
  const negocioId = orden.negocioId || (canal !== 'rappi' ? _negocioFallbackId : null);

  const pedido = {
    ...orden,
    negocioId,
    id: `XAB-${String(contadorPedidos).padStart(4, '0')}`,
    canal,
    timestamp: new Date().toISOString(),
    estado: 'nuevo'
  };

  pedidos.push(pedido);
  contadorPedidos++;

  // Guardar en DB para que sobreviva reinicios
  guardarPedidoActivo(pedido, negocioId).catch(e =>
    console.error(`[OrderManager] ❌ Error guardando ${pedido.id} en DB:`, e.message)
  );

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
  // Notificar a repartidores si es entrega a domicilio (por WhatsApp) — excluir Rappi
  if (pedido.modalidad === 'entrega a domicilio' && pedido.canal !== 'rappi') {
    import('../channels/whatsapp-meta.js').then(({ notificarRepartidoresPorWA }) => {
      notificarRepartidoresPorWA(pedido).catch(() => {});
    }).catch(() => {});
  }
}

export function actualizarEstadoPedido(id, nuevoEstado) {
  const pedido = pedidos.find(p => p.id === id);
  if (!pedido) return null;
  pedido.estado = nuevoEstado;

  // Persistir en DB
  if (nuevoEstado === 'entregado') {
    archivarPedidoActivo(id);
    // Rewards — fire-and-forget, nunca bloquea el flujo crítico
    import('../services/rewardsService.js')
      .then(({ acumularPuntos }) => acumularPuntos(id, pedido, 'xabor-principal'))
      .catch(e => console.error('[Rewards] Error en hook de acumulación:', e.message));
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

// Agrega un pedido al array en memoria sin generar folio ni guardar en DB.
// Usado por el job de activación de pedidos programados.
export function agregarPedidoAMemoria(pedido) {
  if (!pedidos.find(p => p.id === pedido.id)) {
    pedidos.push(pedido);
  }
}

export async function eliminarPedido(id) {
  const idx = pedidos.findIndex(p => p.id === id);
  if (idx === -1) return false;
  pedidos.splice(idx, 1);
  await eliminarPedidoDB(id);
  if (wsBroadcast) wsBroadcast({ tipo: 'eliminar_pedido', id });
  return true;
}
