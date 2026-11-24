-- Staging primero. Conserva contratos cancelados y periodos por pago.
BEGIN;
ALTER TABLE suscripciones_basico_mp ADD COLUMN IF NOT EXISTS id UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE suscripciones_basico_mp DROP CONSTRAINT IF EXISTS suscripciones_basico_mp_pkey;
ALTER TABLE suscripciones_basico_mp ADD PRIMARY KEY (id);
ALTER TABLE suscripciones_basico_mp DROP CONSTRAINT IF EXISTS suscripciones_basico_mp_external_reference_key;
CREATE UNIQUE INDEX IF NOT EXISTS basico_mp_un_contrato_vigente
  ON suscripciones_basico_mp(negocio_id) WHERE estado_mp NOT IN ('canceled','cancelled');
ALTER TABLE suscripciones_basico_mp ADD COLUMN IF NOT EXISTS mensualidad NUMERIC(10,2);
UPDATE suscripciones_basico_mp mp SET mensualidad=pc.mensualidad
  FROM negocio_plan_comercial pc WHERE pc.negocio_id=mp.negocio_id AND mp.mensualidad IS NULL;
ALTER TABLE suscripciones_basico_mp ALTER COLUMN mensualidad SET NOT NULL;
ALTER TABLE suscripciones_basico_mp DROP CONSTRAINT IF EXISTS basico_mp_precio_positivo;
ALTER TABLE suscripciones_basico_mp ADD CONSTRAINT basico_mp_precio_positivo CHECK (mensualidad > 0);

ALTER TABLE pagos_suscripcion_basico_mp DROP CONSTRAINT IF EXISTS pagos_suscripcion_basico_mp_monto_check;
ALTER TABLE pagos_suscripcion_basico_mp DROP CONSTRAINT IF EXISTS basico_pago_monto_positivo;
ALTER TABLE pagos_suscripcion_basico_mp ADD CONSTRAINT basico_pago_monto_positivo CHECK(monto > 0);
ALTER TABLE pagos_suscripcion_basico_mp ADD COLUMN IF NOT EXISTS estado_pago TEXT NOT NULL DEFAULT 'approved';
ALTER TABLE pagos_suscripcion_basico_mp ADD COLUMN IF NOT EXISTS reembolsado NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE pagos_suscripcion_basico_mp ADD COLUMN IF NOT EXISTS periodo_desde TIMESTAMPTZ;
ALTER TABLE pagos_suscripcion_basico_mp ADD COLUMN IF NOT EXISTS periodo_hasta TIMESTAMPTZ;
ALTER TABLE pagos_suscripcion_basico_mp ADD COLUMN IF NOT EXISTS revisado_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
UPDATE pagos_suscripcion_basico_mp SET periodo_desde=aprobado_at,periodo_hasta=aprobado_at+INTERVAL '1 month'
  WHERE periodo_desde IS NULL;
ALTER TABLE pagos_suscripcion_basico_mp ALTER COLUMN periodo_desde SET NOT NULL;
ALTER TABLE pagos_suscripcion_basico_mp ALTER COLUMN periodo_hasta SET NOT NULL;
ALTER TABLE pagos_suscripcion_basico_mp DROP CONSTRAINT IF EXISTS basico_pago_periodo;
ALTER TABLE pagos_suscripcion_basico_mp ADD CONSTRAINT basico_pago_periodo CHECK(periodo_hasta > periodo_desde);
ALTER TABLE pagos_suscripcion_basico_mp DROP CONSTRAINT IF EXISTS basico_pago_devolucion;
ALTER TABLE pagos_suscripcion_basico_mp ADD CONSTRAINT basico_pago_devolucion CHECK(reembolsado >= 0 AND reembolsado <= monto);

CREATE TABLE IF NOT EXISTS facturas_suscripcion_basico_mp (
  authorized_payment_id TEXT PRIMARY KEY,
  negocio_id UUID NOT NULL REFERENCES negocios(id) ON DELETE RESTRICT,
  preapproval_id TEXT NOT NULL REFERENCES suscripciones_basico_mp(preapproval_id),
  payment_id TEXT,
  estado_pago TEXT NOT NULL,
  consultado_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS basico_facturas_negocio ON facturas_suscripcion_basico_mp(negocio_id,consultado_at DESC);
COMMIT;
