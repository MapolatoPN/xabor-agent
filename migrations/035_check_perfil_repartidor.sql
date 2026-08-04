-- Verificación de solo lectura tras la migración 035.
SELECT column_name, data_type, column_default FROM information_schema.columns
WHERE table_name = 'repartidores'
  AND column_name IN ('estado', 'ciudad', 'zona', 'vehiculo')
ORDER BY column_name;
