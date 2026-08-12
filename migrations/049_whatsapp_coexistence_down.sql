-- Reverso de 049. Solo quita lo agregado; no toca datos de otras columnas.
-- Nota: antes de restaurar el CHECK anterior hay que reconvertir los
-- mensajes históricos a 'texto' (si no, el CHECK viejo no se puede crear).
BEGIN;
ALTER TABLE integraciones_canal DROP COLUMN IF EXISTS connection_mode;
ALTER TABLE clientes DROP COLUMN IF EXISTS human_takeover_until;
ALTER TABLE clientes DROP COLUMN IF EXISTS last_business_app_message_at;
UPDATE mensajes SET tipo = 'texto' WHERE tipo = 'texto_historico';
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mensajes_tipo_check') THEN
    ALTER TABLE mensajes DROP CONSTRAINT mensajes_tipo_check;
  END IF;
  ALTER TABLE mensajes ADD CONSTRAINT mensajes_tipo_check
    CHECK (tipo IN ('texto','documento','imagen'));
END $$;
UPDATE integraciones_canal SET estado = 'error' WHERE estado = 'desconectado';
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'integraciones_canal_estado_check') THEN
    ALTER TABLE integraciones_canal DROP CONSTRAINT integraciones_canal_estado_check;
  END IF;
  ALTER TABLE integraciones_canal ADD CONSTRAINT integraciones_canal_estado_check
    CHECK (estado IN ('no_configurado','pendiente_configuracion','pendiente_activacion','activo','suspendido','error','eliminado'));
END $$;
COMMIT;
