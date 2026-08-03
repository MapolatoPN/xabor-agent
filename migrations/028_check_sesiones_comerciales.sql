-- Verificación de solo lectura tras la migración 028 (renumerada de 027).
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns WHERE table_name = 'cotizaciones' AND column_name = 'origen';

SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'cotizaciones_origen_check';

SELECT table_name FROM information_schema.tables
WHERE table_name IN ('sesiones_comerciales', 'sesiones_comerciales_eventos');

SELECT indexname FROM pg_indexes WHERE tablename = 'sesiones_comerciales';

SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'negocio_modulos_modulo_check';

SELECT estado, count(*) FROM negocio_modulos WHERE modulo = 'asistente_comercial_cotizaciones' GROUP BY estado;
