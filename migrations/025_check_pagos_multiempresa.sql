-- Verificación de solo lectura tras la migración 025.
SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'integraciones_canal_estado_check';

SELECT column_name, data_type, column_default FROM information_schema.columns
WHERE table_name = 'integraciones_canal' AND column_name IN ('principal','ambiente','ultima_prueba_at','ultima_prueba_ok');

SELECT table_name FROM information_schema.tables WHERE table_name IN ('metodos_pago','pagos');

SELECT indexname FROM pg_indexes WHERE tablename IN ('integraciones_canal','pagos') AND indexname LIKE '%principal%' OR indexname LIKE '%idempotency%' OR indexname LIKE '%vigente%';
