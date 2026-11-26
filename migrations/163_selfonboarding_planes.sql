-- Aditiva. Las altas anteriores conservan Básico, siete días y su precio
-- comercial existente. No cambia negocios, módulos, contratos ni cobros.
ALTER TABLE solicitudes_registro_basico
  ADD COLUMN IF NOT EXISTS plan_solicitado TEXT NOT NULL DEFAULT 'basico'
    CHECK (plan_solicitado IN ('basico','pro')),
  ADD COLUMN IF NOT EXISTS dias_prueba INTEGER NOT NULL DEFAULT 7
    CHECK (dias_prueba IN (0,7)),
  ADD COLUMN IF NOT EXISTS mensualidad_solicitada NUMERIC(10,2)
    CHECK (mensualidad_solicitada > 0);
ALTER TABLE suscripciones_basico_mp DROP CONSTRAINT IF EXISTS mp_basico_referencia;
ALTER TABLE suscripciones_basico_mp ADD CONSTRAINT mp_basico_referencia
  CHECK (external_reference IN ('xabor-basico:' || negocio_id::text,'xabor-pro:' || negocio_id::text));
