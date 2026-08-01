-- Verificación de solo lectura tras la migración 022.
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'negocio_plan_comercial'
ORDER BY ordinal_position;

SELECT conname FROM pg_constraint WHERE conname = 'negocio_plan_comercial_estado_check';

SELECT estado, count(*) FROM negocio_plan_comercial GROUP BY estado ORDER BY estado;
