-- Verificación de solo lectura tras la migración 031.
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'sesiones_comerciales'
  AND column_name IN ('ultimo_error_codigo', 'ultimo_error_at', 'intentos_fallidos')
ORDER BY column_name;

SELECT pg_get_constraintdef(con.oid) AS definicion
FROM pg_constraint con
JOIN pg_class rel ON rel.oid = con.conrelid
WHERE rel.relname = 'sesiones_comerciales' AND con.contype = 'c' AND pg_get_constraintdef(con.oid) ILIKE '%estado%';
