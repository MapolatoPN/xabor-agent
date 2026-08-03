-- Verificación de solo lectura tras la migración 030.
SELECT column_name, data_type, is_nullable FROM information_schema.columns
WHERE table_name = 'cotizaciones' AND column_name = 'enviado_por';
