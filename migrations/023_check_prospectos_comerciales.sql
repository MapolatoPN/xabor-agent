-- Verificación de solo lectura tras la migración 023.
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'prospectos_comerciales'
ORDER BY ordinal_position;

SELECT indexname FROM pg_indexes WHERE tablename = 'prospectos_comerciales' ORDER BY indexname;

SELECT count(*) AS total_prospectos, count(*) FILTER (WHERE estado = 'nuevo') AS nuevos
FROM prospectos_comerciales;
