-- Verificación de solo lectura de la migración 040.
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name='restaurante_cuentas' AND column_name IN ('venta_folio','contabilizada_at','reversos');
SELECT indexname FROM pg_indexes WHERE indexname = 'idx_restaurante_venta_folio';
SELECT count(*) AS cuentas_contabilizadas FROM restaurante_cuentas WHERE venta_folio IS NOT NULL;
