-- ============================================================
-- XABOR — Migración 082: cobro de Restaurante.
--   · descuento de cuenta (porcentaje o importe) con motivo y auditoría;
--   · efectivo recibido y cambio por pago (informativos: la venta es `monto`);
--   · contador de reimpresiones del ticket pagado.
-- Aditiva. Reejecutable. Sin backfill: las cuentas existentes quedan con
-- descuento 0 y pagos sin efectivo recibido, exactamente como estaban.
-- ============================================================

ALTER TABLE restaurante_cuentas ADD COLUMN IF NOT EXISTS descuento_tipo     TEXT NULL;
ALTER TABLE restaurante_cuentas ADD COLUMN IF NOT EXISTS descuento_valor    NUMERIC(10,2) NULL;
ALTER TABLE restaurante_cuentas ADD COLUMN IF NOT EXISTS descuento_monto    NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE restaurante_cuentas ADD COLUMN IF NOT EXISTS descuento_motivo   TEXT NULL;
ALTER TABLE restaurante_cuentas ADD COLUMN IF NOT EXISTS descuento_por      UUID NULL REFERENCES usuarios(id) ON DELETE SET NULL;
ALTER TABLE restaurante_cuentas ADD COLUMN IF NOT EXISTS descuento_at       TIMESTAMPTZ NULL;
ALTER TABLE restaurante_cuentas ADD COLUMN IF NOT EXISTS ticket_impresiones INT NOT NULL DEFAULT 0;

ALTER TABLE restaurante_cuenta_pagos ADD COLUMN IF NOT EXISTS recibido NUMERIC(10,2) NULL;
ALTER TABLE restaurante_cuenta_pagos ADD COLUMN IF NOT EXISTS cambio   NUMERIC(10,2) NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'restaurante_cuentas_descuento_tipo_check') THEN
    ALTER TABLE restaurante_cuentas ADD CONSTRAINT restaurante_cuentas_descuento_tipo_check
      CHECK (descuento_tipo IS NULL OR descuento_tipo IN ('porcentaje','importe'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'restaurante_cuentas_descuento_monto_check') THEN
    ALTER TABLE restaurante_cuentas ADD CONSTRAINT restaurante_cuentas_descuento_monto_check
      CHECK (descuento_monto >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'restaurante_cuentas_ticket_impresiones_check') THEN
    ALTER TABLE restaurante_cuentas ADD CONSTRAINT restaurante_cuentas_ticket_impresiones_check
      CHECK (ticket_impresiones >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'restaurante_cuenta_pagos_recibido_check') THEN
    ALTER TABLE restaurante_cuenta_pagos ADD CONSTRAINT restaurante_cuenta_pagos_recibido_check
      CHECK (recibido IS NULL OR recibido >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'restaurante_cuenta_pagos_cambio_check') THEN
    ALTER TABLE restaurante_cuenta_pagos ADD CONSTRAINT restaurante_cuenta_pagos_cambio_check
      CHECK (cambio IS NULL OR cambio >= 0);
  END IF;
END $$;
