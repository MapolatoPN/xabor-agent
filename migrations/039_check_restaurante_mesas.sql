-- Verificación de solo lectura de la migración 039.
SELECT count(*) AS tablas FROM information_schema.tables
WHERE table_name IN ('restaurante_cuentas','restaurante_cuenta_items','restaurante_cuenta_pagos');
SELECT indexname FROM pg_indexes WHERE indexname = 'idx_restaurante_mesa_abierta';
SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'negocio_modulos_modulo_check';
