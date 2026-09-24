-- 096 · Facturación de servicios/catering sin folio de venta.
--
-- Un servicio no se fuerza dentro de pedidos_activos ni facturas_pedido:
-- conserva su propio ledger, su referencia opcional y el snapshot cifrado
-- del request enviado a Facturapi para que un timeout nunca provoque un CFDI
-- duplicado.

CREATE TABLE IF NOT EXISTS facturacion_servicios (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id               uuid NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  referencia               text,
  descripcion              text NOT NULL CHECK (char_length(trim(descripcion)) BETWEEN 3 AND 500),
  clave_sat                text NOT NULL CHECK (clave_sat ~ '^[0-9]{8}$'),
  total                    numeric(12,2) NOT NULL CHECK (total > 0),
  forma_pago               text NOT NULL CHECK (forma_pago IN ('01','03','04','28')),
  estado                   text NOT NULL DEFAULT 'emitiendo'
                           CHECK (estado IN ('emitiendo','procesando','facturada','error','cancelada')),
  idempotency_key          text NOT NULL UNIQUE,
  factura_id               text,
  uuid                     text,
  proveedor_status         text,
  error_codigo             text,
  error_detalle            text,
  snapshot_cifrado         text,
  snapshot_iv              text,
  snapshot_auth_tag        text,
  snapshot_formato_version smallint,
  snapshot_sha256          text,
  email_enviado_at         timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_facturacion_servicios_referencia
  ON facturacion_servicios (negocio_id, referencia)
  WHERE referencia IS NOT NULL AND trim(referencia) <> '';
CREATE UNIQUE INDEX IF NOT EXISTS uq_facturacion_servicios_factura
  ON facturacion_servicios (negocio_id, factura_id)
  WHERE factura_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_facturacion_servicios_estado
  ON facturacion_servicios (negocio_id, estado, updated_at);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_updated_at_facturacion_servicios') THEN
    CREATE TRIGGER set_updated_at_facturacion_servicios
      BEFORE UPDATE ON facturacion_servicios
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;
