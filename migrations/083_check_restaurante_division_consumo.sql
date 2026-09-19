-- Verificación de solo lectura de la migración 083.
SELECT column_name FROM information_schema.columns
 WHERE table_name = 'restaurante_cuenta_pagos'
   AND column_name IN ('cobro_id','tipo_cobro','revertido_at','revertido_por','motivo_reverso')
 ORDER BY column_name;
SELECT count(*) AS tabla_porciones FROM information_schema.tables WHERE table_name = 'restaurante_cuenta_porciones';
SELECT column_name FROM information_schema.columns
 WHERE table_name = 'restaurante_cuentas' AND column_name = 'division_remanente';
SELECT conname FROM pg_constraint WHERE conname = 'restaurante_cuenta_pagos_tipo_cobro_check';
SELECT indexname FROM pg_indexes
 WHERE indexname IN ('idx_restaurante_pagos_cobro','idx_restaurante_porciones_cuenta','idx_restaurante_porciones_item','idx_restaurante_porciones_cobro')
 ORDER BY indexname;
