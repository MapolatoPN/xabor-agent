// Elegibilidad de un pedido para la Red de Repartidores de Xabor — única
// fuente de verdad para TODOS los consumidores actuales y futuros
// (notificación automática, reenvío manual, botón "Buscar repartidor",
// rollout piloto/completo, historial de "servicios de reparto" en
// Superadmin, pruebas).
//
// Deliberadamente sin dependencias (leaf util, igual que telefono.js): tanto
// orderManager.js como database.js necesitan esta lógica, y orderManager.js
// ya importa de forma estática desde database.js — si database.js importara
// de vuelta desde orderManager.js sería un ciclo de imports. Viviendo aquí,
// ambos importan del mismo lugar sin ciclo.
//
// Regla crítica: un pedido de Rappi NUNCA debe entrar a la red de
// repartidores de Xabor -- Rappi ya administra y asigna sus propios
// repartidores. Se verifica canal='rappi' Y la presencia de rappi_order_id
// por separado (defensa en profundidad: un pedido de Rappi con el canal mal
// etiquetado por error igual queda excluido porque mapearOrdenRappi siempre
// pobla rappi_order_id).

// Subconjunto reutilizable: ¿este pedido pertenece a una plataforma externa
// (Rappi)? Separado de esPedidoElegibleParaRedRepartidores para que
// consultas de solo-lectura (p.ej. historial de "servicios de reparto" en
// Superadmin) puedan excluir Rappi de la lista de la Red Xabor SIN excluir
// también pedidos cancelado/entregado (que sí deben verse en el historial).
export function esPedidoDeRedExterna(pedido) {
  if (!pedido) return false;
  if (pedido.canal === 'rappi') return true;
  if (pedido.rappi_order_id) return true;
  if (pedido.repartidor_externo || pedido.integracion_externa === 'rappi') return true;
  return false;
}

export function esPedidoElegibleParaRedRepartidores(pedido) {
  if (!pedido) return false;
  if (pedido.modalidad !== 'entrega a domicilio') return false;
  if (['cancelado', 'entregado'].includes(pedido.estado)) return false;
  if (esPedidoDeRedExterna(pedido)) return false;
  return true;
}
