BEGIN;
ALTER TABLE suscripciones_basico_mp ADD COLUMN IF NOT EXISTS conciliacion_offset INTEGER NOT NULL DEFAULT 0 CHECK(conciliacion_offset>=0);
CREATE UNIQUE INDEX IF NOT EXISTS contrato_basico_tenant ON suscripciones_basico_mp(preapproval_id,negocio_id);
ALTER TABLE pagos_suscripcion_basico_mp DROP CONSTRAINT IF EXISTS pago_basico_tenant;
ALTER TABLE pagos_suscripcion_basico_mp ADD CONSTRAINT pago_basico_tenant FOREIGN KEY(preapproval_id,negocio_id)
  REFERENCES suscripciones_basico_mp(preapproval_id,negocio_id);
ALTER TABLE facturas_suscripcion_basico_mp DROP CONSTRAINT IF EXISTS factura_basico_tenant;
ALTER TABLE facturas_suscripcion_basico_mp ADD CONSTRAINT factura_basico_tenant FOREIGN KEY(preapproval_id,negocio_id)
  REFERENCES suscripciones_basico_mp(preapproval_id,negocio_id);
CREATE TABLE IF NOT EXISTS alertas_facturacion_basico (
  clave TEXT PRIMARY KEY,
  negocio_id UUID REFERENCES negocios(id) ON DELETE RESTRICT,
  tipo TEXT NOT NULL,
  ocurrencias INTEGER NOT NULL DEFAULT 1,
  primera_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ultima_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resuelta_at TIMESTAMPTZ
);
COMMIT;
