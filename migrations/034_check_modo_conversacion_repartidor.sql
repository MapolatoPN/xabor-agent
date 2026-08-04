-- Verificación de solo lectura tras la migración 034.
SELECT column_name, data_type, column_default FROM information_schema.columns
WHERE table_name = 'repartidores'
  AND column_name IN ('modo_actual', 'modo_actualizado_at')
ORDER BY column_name;
