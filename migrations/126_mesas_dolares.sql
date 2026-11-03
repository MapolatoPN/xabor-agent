-- 126 · Dólares en Mesas (Fase 2, aprobada por Mario el 3-nov-2026).
--
-- Un pago de mesa en dólares es un renglón más de restaurante_cuenta_pagos
-- con metodo = 'dolares'. El abono (`monto`) sigue en pesos: es lo que la
-- cuenta consume. Lo nuevo es lo que entregó el cliente:
--
--   usd          dólares en billetes enteros;
--   tipo_cambio  el del negocio a la hora del pago (dolares_tipo_cambio, 125),
--                congelado en el renglón;
--   pesos_mxn    lo que completó en pesos (pago combinado), o NULL.
--
-- El cambio, como siempre, va en `cambio` y en pesos (D2). `recibido` queda
-- para el efectivo en pesos: un renglón en dólares no lo usa.
--
-- Aditiva: amplía el CHECK de metodo y agrega tres columnas vacías. No toca
-- ni un pago existente.

ALTER TABLE restaurante_cuenta_pagos
  DROP CONSTRAINT IF EXISTS restaurante_cuenta_pagos_metodo_check,
  ADD CONSTRAINT restaurante_cuenta_pagos_metodo_check
    CHECK (metodo IN ('efectivo','terminal','transferencia','enlace_pago','dolares'));

ALTER TABLE restaurante_cuenta_pagos ADD COLUMN IF NOT EXISTS usd         integer       NULL;
ALTER TABLE restaurante_cuenta_pagos ADD COLUMN IF NOT EXISTS tipo_cambio numeric(6,2)  NULL;
ALTER TABLE restaurante_cuenta_pagos ADD COLUMN IF NOT EXISTS pesos_mxn   numeric(10,2) NULL;

DO $$
BEGIN
  -- Un renglón en dólares trae sus dólares y su tipo de cambio; uno que no es
  -- en dólares no trae ninguno de los tres.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'restaurante_cuenta_pagos_dolares_check') THEN
    ALTER TABLE restaurante_cuenta_pagos ADD CONSTRAINT restaurante_cuenta_pagos_dolares_check
      CHECK (CASE WHEN metodo = 'dolares'
                  THEN usd IS NOT NULL AND usd > 0 AND tipo_cambio IS NOT NULL AND tipo_cambio > 0
                       AND (pesos_mxn IS NULL OR pesos_mxn > 0) AND recibido IS NULL
                  ELSE usd IS NULL AND tipo_cambio IS NULL AND pesos_mxn IS NULL END);
  END IF;
END $$;
