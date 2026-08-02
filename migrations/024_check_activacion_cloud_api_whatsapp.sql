-- Verificación de solo lectura tras la migración 024.
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'integraciones_canal'
  AND column_name IN ('numero_registrado_cloud_api', 'app_suscrita_waba', 'ultimo_intento_activacion_at')
ORDER BY column_name;

SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'integraciones_canal_credenciales'
  AND column_name IN ('pin_verificacion_cifrado', 'pin_iv', 'pin_auth_tag', 'pin_formato_version')
ORDER BY column_name;

SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'integraciones_canal_estado_check';

-- Nunca debe cambiar el estado de filas existentes por esta migración.
SELECT estado, count(*) FROM integraciones_canal GROUP BY estado ORDER BY estado;
