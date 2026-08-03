-- Verificación de solo lectura tras la migración 029.
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns WHERE table_name = 'documentos' AND column_name IN ('categoria','media_id','checksum');

SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'documentos_categoria_check';

SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'mensajes_tipo_check';

SELECT categoria, count(*) FROM documentos GROUP BY categoria ORDER BY categoria;
