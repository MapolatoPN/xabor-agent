-- ============================================================
-- XABOR — Migración 102: liberar una mesa sin consumo.
--
-- Auditoría del 28-sep-2026 (Mapolato Obispado): 60 de 274 cuentas
-- cerradas quedaron como venta de $0 (45 nunca tuvieron platillos, 11 con
-- todo cancelado). La única forma de liberar una mesa era «Cerrar cuenta»,
-- y cerrar siempre registra una venta.
--
-- Una cuenta liberada queda como 'cancelada' (estado que la 039 ya admitía
-- y que la Caja ya sabe leer), con quién la liberó (cerrada_por/cerrada_at)
-- y por qué. No crea venta.
--
-- Aditiva. Reejecutable. Sin backfill: las ventas de $0 que ya existen se
-- quedan como están; el panel las etiqueta al mostrarlas.
-- ============================================================

ALTER TABLE restaurante_cuentas ADD COLUMN IF NOT EXISTS liberada_motivo_codigo TEXT NULL;
ALTER TABLE restaurante_cuentas ADD COLUMN IF NOT EXISTS liberada_motivo TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'restaurante_cuentas_liberada_motivo_check') THEN
    ALTER TABLE restaurante_cuentas ADD CONSTRAINT restaurante_cuentas_liberada_motivo_check
      CHECK (liberada_motivo_codigo IS NULL OR liberada_motivo_codigo IN ('abierta_por_error','se_fueron','todo_cancelado','otro'));
  END IF;
END $$;
