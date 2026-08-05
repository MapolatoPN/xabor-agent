-- ============================================================
-- XABOR Multiempresa — Migración 036
-- Timestamp explícito del momento en que un pedido pasó a 'entregado',
-- para poder calcular "tiempo de entrega" con precisión en Fase D
-- (Red de Repartidores — Métricas y ranking).
--
-- Por qué es necesaria: pedidos_activos.updated_at se sobrescribe en
-- CADA actualización del pedido (cambio de estado, edición de pago,
-- etc.) -- hoy "funciona" para inferir el momento de entrega solo
-- porque 'entregado' suele ser la última escritura sobre esa fila, pero
-- eso no está garantizado por diseño. Se revisó el esquema completo de
-- pedidos_activos y notificaciones_repartidor antes de proponer esta
-- columna (ver docs/plan-fase-d-metricas-ranking.md) -- no existe
-- ningún timestamp equivalente ya capturado.
--
-- Cómo se puebla: exclusivamente hacia adelante, en el mismo UPDATE que
-- ya hace la transición de estado (actualizarEstadoPedidoDB,
-- src/services/database.js) -- NUNCA se backfillea con una fecha
-- inventada para pedidos ya entregados antes de esta migración. Esos
-- registros históricos permanecen con entregado_at = NULL
-- indefinidamente; las consultas de métricas deben tratar ese NULL como
-- "dato no disponible", nunca como "no entregado" ni como "entregado en
-- una fecha desconocida asumida".
--
-- Aditiva, reversible (ver 036_entregado_at_pedidos_down.sql),
-- reejecutable: IF NOT EXISTS en todo.
-- ============================================================

BEGIN;

ALTER TABLE pedidos_activos
  ADD COLUMN IF NOT EXISTS entregado_at TIMESTAMPTZ;

COMMIT;
