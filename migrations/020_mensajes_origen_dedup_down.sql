-- Rollback de la migración 020. Puramente aditiva (columnas nuevas,
-- ambas nullable, ningún dato existente se modificó de forma
-- destructiva salvo backfillear 'origen' en entrantes) -- sin guardas
-- especiales, revertir nunca pierde información irrecuperable (origen
-- de entrantes se puede recalcular desde direccion, message_id_externo
-- nunca se usó para nada más que deduplicar en la app).
-- Ejecutar con: psql "$CONN" -v ON_ERROR_STOP=1 -f 020_mensajes_origen_dedup_down.sql

BEGIN;

DROP INDEX IF EXISTS idx_mensajes_message_id_externo;
ALTER TABLE mensajes DROP COLUMN IF EXISTS message_id_externo;
ALTER TABLE mensajes DROP COLUMN IF EXISTS origen;

COMMIT;
