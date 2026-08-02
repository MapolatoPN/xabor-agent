-- Rollback de la migración 024. Puramente aditivo -> el rollback solo
-- elimina las columnas/constraint nuevos, nunca borra datos de
-- integraciones_canal/credenciales que ya existían antes de esta migración.
BEGIN;

ALTER TABLE integraciones_canal DROP CONSTRAINT IF EXISTS integraciones_canal_estado_check;
ALTER TABLE integraciones_canal ADD CONSTRAINT integraciones_canal_estado_check
  CHECK (estado IN ('no_configurado','pendiente_configuracion','activo','suspendido','error'));

-- Si alguna fila quedó en 'pendiente_activacion' antes del rollback, no hay
-- forma segura de adivinar a qué estado anterior debería volver -- se dejan
-- intactas y el CHECK de arriba fallaría si existieran; en la práctica el
-- rollback solo se ejecuta antes de tener filas en ese estado.
ALTER TABLE integraciones_canal DROP COLUMN IF EXISTS numero_registrado_cloud_api;
ALTER TABLE integraciones_canal DROP COLUMN IF EXISTS app_suscrita_waba;
ALTER TABLE integraciones_canal DROP COLUMN IF EXISTS ultimo_intento_activacion_at;

ALTER TABLE integraciones_canal_credenciales DROP COLUMN IF EXISTS pin_verificacion_cifrado;
ALTER TABLE integraciones_canal_credenciales DROP COLUMN IF EXISTS pin_iv;
ALTER TABLE integraciones_canal_credenciales DROP COLUMN IF EXISTS pin_auth_tag;
ALTER TABLE integraciones_canal_credenciales DROP COLUMN IF EXISTS pin_formato_version;

COMMIT;
