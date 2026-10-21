-- Cancelación de CFDI desde Xabor. Una fila por CFDI con la solicitud ante el
-- SAT (vía Facturapi) y su estado. Tabla aparte: el ledger de facturas
-- (facturas_pedido) y facturacion_servicios no cambian de forma.
CREATE TABLE IF NOT EXISTS facturacion_cancelaciones (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id          uuid NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  factura_id          text NOT NULL,
  uuid                text,
  origen              text NOT NULL CHECK (origen IN ('venta','servicio')),
  referencia          text,
  motivo              text NOT NULL CHECK (motivo IN ('01','02','03','04')),
  sustitucion         text,
  estado              text NOT NULL DEFAULT 'solicitando'
                      CHECK (estado IN ('solicitando','en_proceso','cancelada','rechazada','expirada','error')),
  cancellation_status text,
  error_codigo        text,
  error_detalle       text,
  solicitada_por      text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (negocio_id, factura_id)
);
CREATE INDEX IF NOT EXISTS idx_facturacion_cancelaciones_en_proceso
  ON facturacion_cancelaciones (updated_at) WHERE estado IN ('solicitando','en_proceso');
