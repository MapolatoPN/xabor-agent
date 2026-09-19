-- Reverso de la 083. Quita la tabla de porciones y las columnas propias.
-- No toca pagos, cuentas ni ventas: los pagos vuelven a ser filas sin
-- agrupar, como antes de la 083.
DROP TABLE IF EXISTS restaurante_cuenta_porciones;
ALTER TABLE restaurante_cuentas DROP COLUMN IF EXISTS division_remanente;
DROP INDEX IF EXISTS idx_restaurante_pagos_cobro;
ALTER TABLE restaurante_cuenta_pagos DROP CONSTRAINT IF EXISTS restaurante_cuenta_pagos_tipo_cobro_check;
ALTER TABLE restaurante_cuenta_pagos DROP COLUMN IF EXISTS motivo_reverso;
ALTER TABLE restaurante_cuenta_pagos DROP COLUMN IF EXISTS revertido_por;
ALTER TABLE restaurante_cuenta_pagos DROP COLUMN IF EXISTS revertido_at;
ALTER TABLE restaurante_cuenta_pagos DROP COLUMN IF EXISTS tipo_cobro;
ALTER TABLE restaurante_cuenta_pagos DROP COLUMN IF EXISTS cobro_id;
