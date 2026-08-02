-- Verificación de solo lectura tras la migración 026.
SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'negocio_modulos_modulo_check';

SELECT modulo, estado, count(*) FROM negocio_modulos
WHERE modulo IN ('chat_imagenes','chat_documentos_pdf','cotizaciones','generador_cotizaciones','pagos','repartidores')
GROUP BY modulo, estado ORDER BY modulo, estado;

SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns WHERE table_name = 'mensajes' AND column_name IN ('tipo','documento_id');

SELECT table_name FROM information_schema.tables
WHERE table_name IN ('documentos','cotizaciones','cotizacion_items','cotizaciones_historial');
