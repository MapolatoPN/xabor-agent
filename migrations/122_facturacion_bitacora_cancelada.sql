-- Facturación, fase 1.
--
-- facturas_pedido.cancelada_at: un CFDI de venta cancelado ante el SAT deja de
-- contar como timbrado. Antes la cancelación solo quedaba en
-- facturacion_cancelaciones y la venta seguía «Timbrada».
--
-- facturacion_bitacora: quién hizo cada acción de facturación (timbrar,
-- cancelar, reenviar, configurar). Solo identificadores, nunca datos fiscales
-- del cliente.
ALTER TABLE facturas_pedido ADD COLUMN IF NOT EXISTS cancelada_at timestamptz;

CREATE TABLE IF NOT EXISTS facturacion_bitacora (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id  uuid NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  usuario_id  text,
  rol         text,
  accion      text NOT NULL,
  folio       text,
  factura_id  text,
  detalle     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_facturacion_bitacora_negocio
  ON facturacion_bitacora (negocio_id, created_at DESC);

-- Cancelaciones de venta ya aceptadas antes de esta migración.
UPDATE facturas_pedido f SET cancelada_at = c.updated_at
  FROM facturacion_cancelaciones c
 WHERE c.negocio_id = f.negocio_id AND c.factura_id = f.factura_id
   AND c.origen = 'venta' AND c.estado = 'cancelada' AND f.cancelada_at IS NULL;
UPDATE facturacion_recibos r SET estado = 'cancelado', updated_at = now()
  FROM facturacion_cancelaciones c
 WHERE c.negocio_id = r.negocio_id AND c.factura_id = r.factura_id
   AND c.origen = 'venta' AND c.estado = 'cancelada' AND r.estado = 'facturado';
