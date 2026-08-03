-- Verificación de solo lectura tras la migración 033.
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'notificaciones_repartidor'
  AND column_name IN ('token_aceptacion', 'token_expira_at', 'token_usado_at')
ORDER BY column_name;

SELECT indexname FROM pg_indexes
WHERE tablename = 'notificaciones_repartidor' AND indexname LIKE '%token_aceptacion%';
