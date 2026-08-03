-- Verificación de solo lectura tras la migración 027.
SELECT column_name, data_type, column_default, is_nullable
FROM information_schema.columns WHERE table_name = 'cotizaciones' AND column_name = 'impuestos_tasa';

SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'cotizaciones_impuestos_tasa_check';

SELECT impuestos_tasa, count(*) FROM cotizaciones GROUP BY impuestos_tasa ORDER BY impuestos_tasa;
