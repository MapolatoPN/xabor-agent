-- Verificación de solo lectura de la migración 038.
SELECT count(*) AS tabla_existe FROM information_schema.tables WHERE table_name = 'red_repartidores_config';
SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'red_repartidores_config' ORDER BY ordinal_position;
SELECT count(*) AS filas FROM red_repartidores_config;
