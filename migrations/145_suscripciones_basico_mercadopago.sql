-- 144 — Suscripciones SaaS Xabor Básico con Mercado Pago.
-- No afecta cobros de restaurantes ni tablas de Clip. Solo negocios
-- creados por el alta pública verificada (migración 143).
-- No ejecutar en producción hasta completar E2E y autorización.
BEGIN;

CREATE TABLE IF NOT EXISTS suscripciones_basico_mp (
  negocio_id UUID PRIMARY KEY REFERENCES negocios(id) ON DELETE RESTRICT,
  external_reference TEXT NOT NULL UNIQUE,
  preapproval_id TEXT UNIQUE,
  checkout_url TEXT,
  estado_mp TEXT NOT NULL DEFAULT 'creando'
    CHECK (estado_mp IN ('creando','pending','authorized','paused','cancelled','canceled','error')),
  creado_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actualizado_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ultima_consulta_at TIMESTAMPTZ,
  CONSTRAINT mp_basico_referencia CHECK (external_reference = 'xabor-basico:' || negocio_id::text)
);

CREATE TABLE IF NOT EXISTS pagos_suscripcion_basico_mp (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id UUID NOT NULL REFERENCES negocios(id) ON DELETE RESTRICT,
  preapproval_id TEXT NOT NULL REFERENCES suscripciones_basico_mp(preapproval_id),
  authorized_payment_id TEXT NOT NULL UNIQUE,
  payment_id TEXT NOT NULL UNIQUE,
  monto NUMERIC(10,2) NOT NULL CHECK (monto = 150.00),
  moneda TEXT NOT NULL DEFAULT 'MXN' CHECK (moneda = 'MXN'),
  aprobado_at TIMESTAMPTZ NOT NULL,
  acreditado_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS pagos_basico_negocio_fecha
  ON pagos_suscripcion_basico_mp (negocio_id, aprobado_at DESC);

COMMIT;
