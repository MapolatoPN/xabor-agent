-- ============================================================
-- XABOR — Migración 083: división de cuenta por consumo real.
--   · cobro_id: agrupa uno o varios pagos de la misma persona/cobro (un pago
--     mixto efectivo + terminal es UN cobro con dos filas);
--   · tipo_cobro: abono (pago suelto), consumo (cubre porciones de renglones)
--     o parte (partes iguales del remanente);
--   · reverso de pagos con auditoría (nunca se borra: revertido_at/por/motivo);
--   · restaurante_cuenta_porciones: qué fracción de cada renglón cubre cada
--     cobro, con su importe neto en centavos. Un renglón está cubierto
--     cuando sus porciones vigentes suman exactamente 1;
--   · division_remanente: la división del remanente en partes iguales, una
--     vez formalizada, ya no se puede volver a consumo.
-- Aditiva. Reejecutable. Sin backfill: los pagos existentes quedan como
-- 'abono' sin cobro_id y ninguna cuenta tiene porciones.
-- ============================================================

ALTER TABLE restaurante_cuenta_pagos ADD COLUMN IF NOT EXISTS cobro_id       UUID NULL;
ALTER TABLE restaurante_cuenta_pagos ADD COLUMN IF NOT EXISTS tipo_cobro     TEXT NOT NULL DEFAULT 'abono';
ALTER TABLE restaurante_cuenta_pagos ADD COLUMN IF NOT EXISTS revertido_at   TIMESTAMPTZ NULL;
ALTER TABLE restaurante_cuenta_pagos ADD COLUMN IF NOT EXISTS revertido_por  UUID NULL REFERENCES usuarios(id) ON DELETE SET NULL;
ALTER TABLE restaurante_cuenta_pagos ADD COLUMN IF NOT EXISTS motivo_reverso TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'restaurante_cuenta_pagos_tipo_cobro_check') THEN
    ALTER TABLE restaurante_cuenta_pagos ADD CONSTRAINT restaurante_cuenta_pagos_tipo_cobro_check
      CHECK (tipo_cobro IN ('abono','consumo','parte'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_restaurante_pagos_cobro
  ON restaurante_cuenta_pagos (cuenta_id, cobro_id) WHERE cobro_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS restaurante_cuenta_porciones (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cuenta_id        UUID NOT NULL REFERENCES restaurante_cuentas(id) ON DELETE CASCADE,
  negocio_id       UUID NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  item_id          UUID NOT NULL REFERENCES restaurante_cuenta_items(id) ON DELETE CASCADE,
  cobro_id         UUID NOT NULL,
  -- Fracción del RENGLÓN completo que cubre esta porción (2 de 3 tacos =
  -- 2/3; media pizza = 1/2). Nunca se guarda como importe solamente: la
  -- fracción es lo que decide qué queda pendiente.
  numerador        INT NOT NULL CHECK (numerador > 0),
  denominador      INT NOT NULL CHECK (denominador > 0 AND denominador <= 1000),
  -- Importe NETO en centavos (con el descuento de la cuenta ya prorrateado).
  importe_centavos INT NOT NULL CHECK (importe_centavos >= 0),
  registrado_por   UUID NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revertido_at     TIMESTAMPTZ NULL,
  revertido_por    UUID NULL REFERENCES usuarios(id) ON DELETE SET NULL,
  motivo_reverso   TEXT NULL
);
CREATE INDEX IF NOT EXISTS idx_restaurante_porciones_cuenta
  ON restaurante_cuenta_porciones (cuenta_id) WHERE revertido_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_restaurante_porciones_item
  ON restaurante_cuenta_porciones (item_id) WHERE revertido_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_restaurante_porciones_cobro
  ON restaurante_cuenta_porciones (cobro_id);

ALTER TABLE restaurante_cuentas ADD COLUMN IF NOT EXISTS division_remanente JSONB NULL;
