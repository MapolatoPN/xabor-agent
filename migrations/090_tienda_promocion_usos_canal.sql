-- ─── 090: canal en tienda_promocion_usos (Fase 3A) ──────────────────────────
-- Idempotente y re-ejecutable.
--
-- POR QUÉ
--
-- El registro de uso de una promoción no llevaba de dónde vino (POS/
-- WhatsApp/tienda). Eso hacía imposible recuperar el canal de un uso
-- histórico si el pedido original se cancelaba y se purgaba de
-- pedidos_activos/pedidos -- ambas tablas mueren juntas en la misma
-- transacción de eliminarPedido() (database.js), y ninguna otra tabla
-- durable del sistema (compras_reales, impresion_trabajos,
-- notificaciones_repartidor, agente_operaciones) lleva un campo de canal
-- de venta genérico y universal a los tres canales. Se investigó y
-- confirmó contra código antes de agregar esta columna -- ver
-- docs/fase3a-registro-usos-promociones.md.
--
-- Sin CHECK a propósito: se quiere permitir canales futuros (voz, api, u
-- otros) sin otra migración el día que se decida incluirlos en el registro.
--
-- BACKFILL: hasta hoy la única llamante de reservarUsosPromociones /
-- registrarUsosPromociones es tiendaCheckout.js (confirmado por búsqueda
-- exhaustiva en src/ -- cero resultados en server.js, orderManager.js,
-- whatsapp-meta.js, canalDelAgente.js, restauranteService.js). Todo lo
-- histórico en esta tabla es, por construcción del código hasta esta
-- fecha, de tienda en línea.

ALTER TABLE tienda_promocion_usos ADD COLUMN IF NOT EXISTS canal text;

UPDATE tienda_promocion_usos SET canal = 'tienda_online' WHERE canal IS NULL;
