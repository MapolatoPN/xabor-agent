BEGIN;
DROP INDEX IF EXISTS idx_push_subscriptions_usuario;
ALTER TABLE push_subscriptions DROP COLUMN IF EXISTS usuario_id;
COMMIT;
