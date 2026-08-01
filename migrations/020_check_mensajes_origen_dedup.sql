-- Verificación de solo lectura tras la migración 020.
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'mensajes' AND column_name IN ('origen','message_id_externo')
ORDER BY column_name;

SELECT indexname FROM pg_indexes WHERE tablename = 'mensajes' AND indexname = 'idx_mensajes_message_id_externo';

SELECT direccion, origen, count(*) FROM mensajes GROUP BY direccion, origen ORDER BY direccion, origen;
