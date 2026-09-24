-- 087 · Facturación por negocio, libreta fiscal y recibos autofacturables.
-- La migración es aditiva y puede ejecutarse más de una vez.

CREATE TABLE IF NOT EXISTS clientes_fiscales (
  id            bigserial PRIMARY KEY,
  negocio_id    uuid NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  rfc           text NOT NULL CHECK (rfc ~ '^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$'),
  razon_social  text NOT NULL CHECK (char_length(trim(razon_social)) > 0),
  regimen       text NOT NULL CHECK (regimen ~ '^[0-9]{3}$'),
  uso_cfdi      text NOT NULL CHECK (uso_cfdi ~ '^[A-Z0-9]{3}$'),
  cp            text NOT NULL CHECK (cp ~ '^[0-9]{5}$'),
  email         text,
  telefono      text,
  notas         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (negocio_id, rfc)
);

-- Compatibilidad si se alcanzó a ejecutar el borrador de Claude: retira sus
-- defaults inseguros y añade la validación nombrada sin borrar fichas.
ALTER TABLE clientes_fiscales ALTER COLUMN regimen DROP DEFAULT;
ALTER TABLE clientes_fiscales ALTER COLUMN uso_cfdi DROP DEFAULT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='clientes_fiscales_rfc_formato') THEN
    ALTER TABLE clientes_fiscales ADD CONSTRAINT clientes_fiscales_rfc_formato
      CHECK (rfc ~ '^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$') NOT VALID;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_clientes_fiscales_negocio_telefono
  ON clientes_fiscales (negocio_id, telefono) WHERE telefono IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_clientes_fiscales_negocio_nombre
  ON clientes_fiscales (negocio_id, lower(razon_social));

-- El IVA cambia por zona y por situación fiscal; nunca se adivina. La tasa
-- queda NULL hasta que el administrador la confirme. Las claves SAT sí son
-- las oficiales para restaurante y alimentos preparados para llevar.
CREATE TABLE IF NOT EXISTS facturacion_configuracion (
  negocio_id                 uuid PRIMARY KEY REFERENCES negocios(id) ON DELETE CASCADE,
  iva_tasa                   numeric(5,4) CHECK (iva_tasa IN (0, 0.08, 0.16)),
  autoemitir_recibo          boolean NOT NULL DEFAULT true,
  clave_producto_restaurante text NOT NULL DEFAULT '90101501',
  clave_producto_para_llevar text NOT NULL DEFAULT '90101800',
  serie                      text,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

-- Un solo recibo remoto por venta. La fila local se crea antes de llamar al
-- proveedor y la llave de idempotencia evita duplicados si hay reintentos.
CREATE TABLE IF NOT EXISTS facturacion_recibos (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id        uuid NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  folio             text NOT NULL,
  proveedor         text NOT NULL DEFAULT 'facturapi',
  recibo_id         text,
  clave             text,
  url_autofactura   text,
  expires_at        timestamptz,
  estado            text NOT NULL DEFAULT 'creando'
                    CHECK (estado IN ('creando','abierto','facturado','global','cancelado','error')),
  factura_id        text,
  uuid              text,
  total             numeric(12,2) NOT NULL CHECK (total >= 0),
  idempotency_key   text NOT NULL,
  error_codigo      text,
  error_detalle     text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (negocio_id, folio),
  UNIQUE (proveedor, idempotency_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_facturacion_recibos_remoto
  ON facturacion_recibos (negocio_id, recibo_id) WHERE recibo_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_facturacion_recibos_reconciliar
  ON facturacion_recibos (estado, updated_at)
  WHERE estado IN ('creando','abierto','error');

-- Estado mínimo y durable para solicitudes de factura por WhatsApp.
CREATE TABLE IF NOT EXISTS facturacion_whatsapp_estado (
  negocio_id   uuid NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  telefono     text NOT NULL,
  estado       text NOT NULL CHECK (estado IN ('esperando_folio')),
  folio        text,
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (negocio_id, telefono)
);

-- Las nuevas fuentes conservan el vínculo pedido → CFDI que ya usa el cierre.
DO $$
BEGIN
  IF to_regclass('public.facturas_pedido') IS NOT NULL THEN
    ALTER TABLE facturas_pedido DROP CONSTRAINT IF EXISTS facturas_pedido_fuente_check;
    ALTER TABLE facturas_pedido ADD CONSTRAINT facturas_pedido_fuente_check
      CHECK (fuente IN ('panel','whatsapp','restaurante','autofactura'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_facturas_pedido_negocio_factura
  ON facturas_pedido (negocio_id, factura_id) WHERE factura_id IS NOT NULL;
