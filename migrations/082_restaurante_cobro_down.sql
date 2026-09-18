-- Reverso de la 082. Solo quita columnas y constraints propios; no toca
-- pagos, cuentas ni ventas ya registradas en pedidos_activos.
ALTER TABLE restaurante_cuenta_pagos DROP CONSTRAINT IF EXISTS restaurante_cuenta_pagos_recibido_check;
ALTER TABLE restaurante_cuenta_pagos DROP CONSTRAINT IF EXISTS restaurante_cuenta_pagos_cambio_check;
ALTER TABLE restaurante_cuenta_pagos DROP COLUMN IF EXISTS recibido;
ALTER TABLE restaurante_cuenta_pagos DROP COLUMN IF EXISTS cambio;

ALTER TABLE restaurante_cuentas DROP CONSTRAINT IF EXISTS restaurante_cuentas_descuento_tipo_check;
ALTER TABLE restaurante_cuentas DROP CONSTRAINT IF EXISTS restaurante_cuentas_descuento_monto_check;
ALTER TABLE restaurante_cuentas DROP CONSTRAINT IF EXISTS restaurante_cuentas_ticket_impresiones_check;
ALTER TABLE restaurante_cuentas DROP COLUMN IF EXISTS descuento_tipo;
ALTER TABLE restaurante_cuentas DROP COLUMN IF EXISTS descuento_valor;
ALTER TABLE restaurante_cuentas DROP COLUMN IF EXISTS descuento_monto;
ALTER TABLE restaurante_cuentas DROP COLUMN IF EXISTS descuento_motivo;
ALTER TABLE restaurante_cuentas DROP COLUMN IF EXISTS descuento_por;
ALTER TABLE restaurante_cuentas DROP COLUMN IF EXISTS descuento_at;
ALTER TABLE restaurante_cuentas DROP COLUMN IF EXISTS ticket_impresiones;
