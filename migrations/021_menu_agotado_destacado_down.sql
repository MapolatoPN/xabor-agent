-- Rollback de la migración 021. Puramente aditiva (columnas nuevas con
-- default seguro) -- revertir nunca pierde información irrecuperable,
-- solo el estado agotado/destacado que se haya capturado desde que se
-- aplicó.
-- Ejecutar con: psql "$CONN" -v ON_ERROR_STOP=1 -f 021_menu_agotado_destacado_down.sql

BEGIN;

ALTER TABLE menu_productos DROP COLUMN IF EXISTS agotado;
ALTER TABLE menu_productos DROP COLUMN IF EXISTS destacado;

COMMIT;
