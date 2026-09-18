-- Verificación de solo lectura de la migración 082.
SELECT column_name FROM information_schema.columns
 WHERE table_name = 'restaurante_cuentas'
   AND column_name IN ('descuento_tipo','descuento_valor','descuento_monto','descuento_motivo','descuento_por','descuento_at','ticket_impresiones')
 ORDER BY column_name;
SELECT column_name FROM information_schema.columns
 WHERE table_name = 'restaurante_cuenta_pagos' AND column_name IN ('recibido','cambio')
 ORDER BY column_name;
SELECT conname FROM pg_constraint
 WHERE conname IN ('restaurante_cuentas_descuento_tipo_check','restaurante_cuentas_descuento_monto_check',
                   'restaurante_cuentas_ticket_impresiones_check','restaurante_cuenta_pagos_recibido_check',
                   'restaurante_cuenta_pagos_cambio_check')
 ORDER BY conname;
