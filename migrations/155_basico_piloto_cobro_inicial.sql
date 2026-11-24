-- Consentimiento individual del piloto; no acorta las pruebas de otros negocios.
BEGIN;
ALTER TABLE suscripciones_basico_mp
 ADD COLUMN IF NOT EXISTS cobro_sin_espera BOOLEAN NOT NULL DEFAULT FALSE,
 ADD COLUMN IF NOT EXISTS condiciones_cobro_version TEXT,
 ADD COLUMN IF NOT EXISTS condiciones_cobro_aceptadas_at TIMESTAMPTZ,
 ADD COLUMN IF NOT EXISTS solicitado_por_usuario_id UUID REFERENCES usuarios(id) ON DELETE RESTRICT,
 ADD COLUMN IF NOT EXISTS inicio_cobro_solicitado TIMESTAMPTZ;
ALTER TABLE suscripciones_basico_mp DROP CONSTRAINT IF EXISTS basico_mp_consentimiento_piloto;
ALTER TABLE suscripciones_basico_mp ADD CONSTRAINT basico_mp_consentimiento_piloto CHECK (
 NOT cobro_sin_espera OR (
  mensualidad=150 AND condiciones_cobro_version='piloto-150-sin-espera-v1'
  AND condiciones_cobro_version IS NOT NULL
  AND condiciones_cobro_aceptadas_at IS NOT NULL
  AND solicitado_por_usuario_id IS NOT NULL AND inicio_cobro_solicitado IS NOT NULL
 ));
COMMIT;
