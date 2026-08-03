-- Verificación de solo lectura tras la migración 032.
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'notificaciones_repartidor'
ORDER BY ordinal_position;

SELECT pg_get_constraintdef(con.oid) AS definicion
FROM pg_constraint con
JOIN pg_class rel ON rel.oid = con.conrelid
WHERE rel.relname = 'notificaciones_repartidor' AND con.contype = 'c';

SELECT indexname FROM pg_indexes WHERE tablename = 'notificaciones_repartidor';
