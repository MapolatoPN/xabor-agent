-- Reversa de la 142. Borra las columnas nuevas: el historial de campañas con
-- plantilla (a quién se mandó, wamid, entregas) se pierde. Las campañas de
-- texto anteriores quedan como estaban.
DROP INDEX IF EXISTS campanas_plantilla_enviando;
DROP INDEX IF EXISTS campana_envios_wamid;
DROP INDEX IF EXISTS campana_envios_cola_por_mandar;
DROP INDEX IF EXISTS campana_envios_cola_unica;
ALTER TABLE campana_envios DROP CONSTRAINT IF EXISTS campana_envios_estado_check;
ALTER TABLE campana_envios
  DROP COLUMN IF EXISTS no_entregado_at,
  DROP COLUMN IF EXISTS leido_at,
  DROP COLUMN IF EXISTS entregado_at,
  DROP COLUMN IF EXISTS error_codigo,
  DROP COLUMN IF EXISTS wamid,
  DROP COLUMN IF EXISTS intento_at,
  DROP COLUMN IF EXISTS telefono_envio,
  DROP COLUMN IF EXISTS cola_at;
ALTER TABLE campanas DROP CONSTRAINT IF EXISTS campanas_tipo_check;
ALTER TABLE campanas
  DROP COLUMN IF EXISTS reanudar_at,
  DROP COLUMN IF EXISTS detenida_motivo,
  DROP COLUMN IF EXISTS detenida_at,
  DROP COLUMN IF EXISTS creada_por,
  DROP COLUMN IF EXISTS plantilla,
  DROP COLUMN IF EXISTS tipo;
