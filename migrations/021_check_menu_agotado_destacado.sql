-- Verificación de solo lectura tras la migración 021.
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'menu_productos' AND column_name IN ('agotado','destacado')
ORDER BY column_name;

SELECT count(*) AS total_productos, count(*) FILTER (WHERE agotado) AS agotados, count(*) FILTER (WHERE destacado) AS destacados
FROM menu_productos;
