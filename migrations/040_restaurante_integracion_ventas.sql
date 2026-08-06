-- ============================================================
-- XABOR — Migración 040 (LOCAL, no aplicada en producción)
-- Integración restaurante -> ventas/caja: el cierre de una cuenta genera
-- EXACTAMENTE UNA venta consolidada en pedidos_activos (fuente de verdad
-- actual de /api/ventas y el resumen), sin tocar cocina ni comandas.
-- Aditiva. Reejecutable. Sin backfill (las cuentas hoy están vacías en
-- producción; cuentas históricas de pruebas locales quedan sin contabilizar
-- a propósito -- solo el flujo nuevo contabiliza).
-- ============================================================

-- venta_folio: folio de la venta consolidada en pedidos_activos, DETERMINISTA
-- por cuenta ('RM-' + 8 hex del id + '-' + reversos), lo que convierte los
-- reintentos en no-ops (ON CONFLICT (folio) DO NOTHING + este UNIQUE).
-- Prefijo RM- a propósito: jamás colisiona con el contador XAB- de
-- orderManager (que solo parsea folios XAB-).
ALTER TABLE restaurante_cuentas ADD COLUMN IF NOT EXISTS venta_folio TEXT NULL;
ALTER TABLE restaurante_cuentas ADD COLUMN IF NOT EXISTS contabilizada_at TIMESTAMPTZ NULL;
-- reversos: cuántas veces se revirtió la venta de esta cuenta (admin).
-- Participa en el folio para que un re-cierre tras reverso genere un folio
-- NUEVO (el anterior queda cancelado en pedidos_activos, con historial).
ALTER TABLE restaurante_cuentas ADD COLUMN IF NOT EXISTS reversos INT NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS idx_restaurante_venta_folio
  ON restaurante_cuentas (venta_folio) WHERE venta_folio IS NOT NULL;
