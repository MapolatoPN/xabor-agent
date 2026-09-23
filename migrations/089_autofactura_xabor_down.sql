DROP TRIGGER IF EXISTS set_updated_at ON autofacturas;
DROP INDEX IF EXISTS idx_autofacturas_estado_expira;
DROP INDEX IF EXISTS uq_autofacturas_negocio_factura;
DROP TABLE IF EXISTS autofacturas;
