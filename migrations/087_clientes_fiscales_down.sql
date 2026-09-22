DROP TABLE IF EXISTS facturacion_whatsapp_estado;
DROP TABLE IF EXISTS facturacion_recibos;
DROP TABLE IF EXISTS facturacion_configuracion;
DROP INDEX IF EXISTS idx_clientes_fiscales_negocio_nombre;
DROP INDEX IF EXISTS idx_clientes_fiscales_negocio_telefono;
DROP TABLE IF EXISTS clientes_fiscales;
DROP INDEX IF EXISTS uq_facturas_pedido_negocio_factura;

DO $$
BEGIN
  IF to_regclass('public.facturas_pedido') IS NOT NULL THEN
    ALTER TABLE facturas_pedido DROP CONSTRAINT IF EXISTS facturas_pedido_fuente_check;
    ALTER TABLE facturas_pedido ADD CONSTRAINT facturas_pedido_fuente_check
      CHECK (fuente IN ('panel','whatsapp'));
  END IF;
END $$;
