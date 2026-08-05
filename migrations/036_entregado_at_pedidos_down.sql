-- Rollback de la migración 036 — elimina la columna aditiva.
-- No hay pérdida de datos derivables: entregado_at solo existe hacia
-- adelante desde que se aplicó la migración 036, nunca fue la única
-- fuente de verdad de ningún otro campo.
BEGIN;

ALTER TABLE pedidos_activos
  DROP COLUMN IF EXISTS entregado_at;

COMMIT;
