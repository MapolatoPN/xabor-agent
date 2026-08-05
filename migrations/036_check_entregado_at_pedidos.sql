-- Verificación de solo lectura de la migración 036.
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'pedidos_activos' AND column_name = 'entregado_at';
