BEGIN;

ALTER TABLE repartidores
  DROP COLUMN IF EXISTS modo_actual,
  DROP COLUMN IF EXISTS modo_actualizado_at;

COMMIT;
