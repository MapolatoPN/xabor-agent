-- Reversa de la 126. Falla (a propósito) si ya hay pagos de mesa en dólares:
-- primero hay que revertirlos o decidir qué hacer con ellos.
ALTER TABLE restaurante_cuenta_pagos DROP CONSTRAINT IF EXISTS restaurante_cuenta_pagos_dolares_check;
ALTER TABLE restaurante_cuenta_pagos
  DROP CONSTRAINT IF EXISTS restaurante_cuenta_pagos_metodo_check,
  ADD CONSTRAINT restaurante_cuenta_pagos_metodo_check
    CHECK (metodo IN ('efectivo','terminal','transferencia','enlace_pago'));
ALTER TABLE restaurante_cuenta_pagos DROP COLUMN IF EXISTS pesos_mxn;
ALTER TABLE restaurante_cuenta_pagos DROP COLUMN IF EXISTS tipo_cambio;
ALTER TABLE restaurante_cuenta_pagos DROP COLUMN IF EXISTS usd;
