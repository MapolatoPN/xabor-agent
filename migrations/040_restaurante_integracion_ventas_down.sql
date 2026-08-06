-- Rollback de la 040 — elimina las columnas aditivas. Las ventas
-- consolidadas ya insertadas en pedidos_activos NO se tocan (son filas de
-- venta reales; quitarles la referencia no las duplica ni las borra).
BEGIN;
DROP INDEX IF EXISTS idx_restaurante_venta_folio;
ALTER TABLE restaurante_cuentas DROP COLUMN IF EXISTS venta_folio;
ALTER TABLE restaurante_cuentas DROP COLUMN IF EXISTS contabilizada_at;
ALTER TABLE restaurante_cuentas DROP COLUMN IF EXISTS reversos;
COMMIT;
