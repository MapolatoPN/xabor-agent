-- 069_compras_operativas.sql
-- Compras de insumos/proveedores del negocio. NO confundir con `compras_reales`,
-- que registra pedidos de clientes reconocidos como compra.
--
-- Este módulo separa deliberadamente:
--   1) dinero entregado al responsable de compras (`fondos_compras`), y
--   2) compras/gastos documentados (`compras_operativas`).
-- Una transferencia no es un gasto por sí misma; evita contar dos veces el dinero.

CREATE TABLE IF NOT EXISTS fondos_compras (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id    uuid NOT NULL REFERENCES negocios(id) ON DELETE RESTRICT,
  fecha         date NOT NULL DEFAULT CURRENT_DATE,
  monto         numeric(12,2) NOT NULL CHECK (monto > 0),
  responsable   text,
  notas         text,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT NOW(),
  updated_at    timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fondos_compras_negocio_fecha
  ON fondos_compras (negocio_id, fecha DESC);

CREATE TABLE IF NOT EXISTS compras_operativas (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id            uuid NOT NULL REFERENCES negocios(id) ON DELETE RESTRICT,
  proveedor              text,
  fecha                   date,
  subtotal                numeric(12,2) CHECK (subtotal IS NULL OR subtotal >= 0),
  impuestos               numeric(12,2) CHECK (impuestos IS NULL OR impuestos >= 0),
  total                   numeric(12,2) CHECK (total IS NULL OR total >= 0),
  tipo_pago               text NOT NULL DEFAULT 'contado',
  estado_factura          text NOT NULL DEFAULT 'no_facturado',
  cfdi_uuid               text,
  estado                  text NOT NULL DEFAULT 'borrador',
  origen                  text NOT NULL DEFAULT 'manual',
  ticket_storage_key      text,
  ticket_mime             text,
  ticket_checksum         text,
  ticket_nombre           text,
  confidence              numeric(5,4) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  advertencias            jsonb NOT NULL DEFAULT '[]'::jsonb,
  notas                   text,
  numero_ticket           text,
  created_by              text,
  created_at              timestamptz NOT NULL DEFAULT NOW(),
  updated_at              timestamptz NOT NULL DEFAULT NOW(),
  confirmed_at            timestamptz,
  CONSTRAINT chk_compra_operativa_tipo_pago
    CHECK (tipo_pago IN ('contado','credito')),
  CONSTRAINT chk_compra_operativa_estado_factura
    CHECK (estado_factura IN ('no_facturado','pendiente','facturado')),
  CONSTRAINT chk_compra_operativa_estado
    CHECK (estado IN ('borrador','confirmada','cancelada')),
  CONSTRAINT chk_compra_operativa_origen
    CHECK (origen IN ('manual','ticket_ia'))
);

-- El checksum se calcula sobre la imagen normalizada (sin EXIF). Evita que un
-- mismo ticket se registre dos veces dentro del mismo negocio. El mismo archivo
-- en dos tenants es independiente por diseño.
CREATE UNIQUE INDEX IF NOT EXISTS idx_compras_operativas_ticket_checksum
  ON compras_operativas (negocio_id, ticket_checksum)
  WHERE ticket_checksum IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_compras_operativas_negocio_fecha
  ON compras_operativas (negocio_id, fecha DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_compras_operativas_factura
  ON compras_operativas (negocio_id, estado_factura, fecha DESC);
CREATE INDEX IF NOT EXISTS idx_compras_operativas_estado
  ON compras_operativas (negocio_id, estado, created_at DESC);

CREATE TABLE IF NOT EXISTS compras_operativas_items (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  compra_id           uuid NOT NULL REFERENCES compras_operativas(id) ON DELETE CASCADE,
  descripcion         text NOT NULL,
  cantidad            numeric(12,3) CHECK (cantidad IS NULL OR cantidad >= 0),
  unidad              text,
  precio_unitario     numeric(12,2) CHECK (precio_unitario IS NULL OR precio_unitario >= 0),
  importe             numeric(12,2) CHECK (importe IS NULL OR importe >= 0),
  categoria           text,
  categoria_sugerida  text,
  confianza           numeric(5,4) CHECK (confianza IS NULL OR (confianza >= 0 AND confianza <= 1)),
  orden               integer NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_compras_operativas_items_compra
  ON compras_operativas_items (compra_id, orden, created_at);
