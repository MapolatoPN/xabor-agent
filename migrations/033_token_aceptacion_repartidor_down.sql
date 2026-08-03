BEGIN;

DROP INDEX IF EXISTS idx_notificaciones_repartidor_token_aceptacion;

ALTER TABLE notificaciones_repartidor
  DROP COLUMN IF EXISTS token_aceptacion,
  DROP COLUMN IF EXISTS token_expira_at,
  DROP COLUMN IF EXISTS token_usado_at;

COMMIT;
