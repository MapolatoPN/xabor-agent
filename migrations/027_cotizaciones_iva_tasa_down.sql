-- Rollback de la migración 027 (impuestos_tasa). Segura de correr
-- siempre -- solo quita la columna y su CHECK; nunca borra ninguna
-- cotización ni cambia subtotal/impuestos/total ya guardados (esos
-- campos existen desde la migración 026, no se tocan aquí).
BEGIN;

ALTER TABLE cotizaciones DROP CONSTRAINT IF EXISTS cotizaciones_impuestos_tasa_check;
ALTER TABLE cotizaciones DROP COLUMN IF EXISTS impuestos_tasa;

COMMIT;
