-- Reversa de la 124. Solo a mano, con psql y a propósito: borra el registro
-- de las globales que Xabor haya timbrado (los CFDI siguen en Facturapi).
ALTER TABLE facturacion_configuracion DROP CONSTRAINT IF EXISTS chk_facturacion_formas_pago;
ALTER TABLE facturacion_configuracion
  DROP COLUMN IF EXISTS forma_rappi,
  DROP COLUMN IF EXISTS forma_mixto,
  DROP COLUMN IF EXISTS forma_tarjeta,
  DROP COLUMN IF EXISTS global_incluir_rappi;
ALTER TABLE facturacion_recibos DROP COLUMN IF EXISTS forma_pago;
DROP TABLE IF EXISTS facturacion_global_recibos;
DROP TABLE IF EXISTS facturacion_globales;
