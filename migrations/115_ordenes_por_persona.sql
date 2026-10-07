-- Nullable: las cuentas anteriores continúan sin asignación de persona.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';
ALTER TABLE restaurante_cuenta_items ADD COLUMN IF NOT EXISTS persona JSONB;
COMMIT;
