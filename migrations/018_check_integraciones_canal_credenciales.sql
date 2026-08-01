-- Verificación de solo lectura tras la migración 018. Nunca muestra
-- material cifrado ni ningún valor de la tabla de credenciales -- solo
-- confirma estructura y existencia.

SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'integraciones_canal'
  AND column_name IN ('proveedor','estado','waba_id','business_id','display_phone_number','conectado_at','actualizado_por','ultimo_error_codigo','ultimo_error_at')
ORDER BY column_name;

SELECT indexname FROM pg_indexes WHERE tablename = 'integraciones_canal' AND indexname = 'idx_integraciones_canal_negocio_canal_proveedor';

SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'integraciones_canal_credenciales'
ORDER BY ordinal_position;

-- Confirmar que ninguna fila existente quedó con estado NULL o inválido
SELECT canal, estado, count(*) FROM integraciones_canal GROUP BY canal, estado ORDER BY canal, estado;

-- Confirmar que la tabla de credenciales está vacía (no se migró ningún
-- secreto real en esta migración)
SELECT count(*) AS credenciales_existentes FROM integraciones_canal_credenciales;
