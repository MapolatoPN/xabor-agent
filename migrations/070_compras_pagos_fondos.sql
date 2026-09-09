-- Pagos reales separados de las compras. No se infiere dinero del tipo contado.
-- Compatible con datos de la 069: los registros existentes quedan por revisar.
CREATE TABLE IF NOT EXISTS compras_responsables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id uuid NOT NULL REFERENCES negocios(id) ON DELETE RESTRICT,
  nombre text NOT NULL CHECK (length(trim(nombre)) BETWEEN 1 AND 180),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (negocio_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS compras_responsables_nombre
  ON compras_responsables (negocio_id, lower(trim(nombre)));

ALTER TABLE compras_operativas ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE compras_operativas ADD COLUMN IF NOT EXISTS pagos_revisados boolean NOT NULL DEFAULT false;
ALTER TABLE compras_operativas ADD COLUMN IF NOT EXISTS cancelacion_motivo text;
ALTER TABLE compras_operativas ADD COLUMN IF NOT EXISTS cancelado_por text;
ALTER TABLE compras_operativas ADD COLUMN IF NOT EXISTS cancelado_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS compras_operativas_negocio_id ON compras_operativas (negocio_id, id);

ALTER TABLE fondos_compras ADD COLUMN IF NOT EXISTS responsable_id uuid;
ALTER TABLE fondos_compras ADD COLUMN IF NOT EXISTS tipo text NOT NULL DEFAULT 'entrega';
ALTER TABLE fondos_compras ADD COLUMN IF NOT EXISTS clave_operacion uuid;
ALTER TABLE fondos_compras ADD COLUMN IF NOT EXISTS revertido_at timestamptz;
ALTER TABLE fondos_compras ADD COLUMN IF NOT EXISTS revertido_por text;
ALTER TABLE fondos_compras ADD COLUMN IF NOT EXISTS motivo_reversion text;
CREATE UNIQUE INDEX IF NOT EXISTS fondos_compras_operacion ON fondos_compras (negocio_id, clave_operacion);
DO $$ BEGIN
  ALTER TABLE fondos_compras ADD CONSTRAINT fondos_compras_responsable_fk
    FOREIGN KEY (negocio_id, responsable_id) REFERENCES compras_responsables (negocio_id, id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE fondos_compras ADD CONSTRAINT fondos_compras_tipo CHECK (tipo IN ('entrega','devolucion'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS compras_pagos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id uuid NOT NULL REFERENCES negocios(id) ON DELETE RESTRICT,
  compra_id uuid NOT NULL,
  fecha date NOT NULL,
  monto numeric(12,2) NOT NULL CHECK (monto > 0),
  origen text NOT NULL CHECK (origen IN ('fondo','otra_cuenta')),
  responsable_id uuid,
  cuenta text,
  referencia text,
  notas text,
  clave_operacion uuid NOT NULL,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  revertido_at timestamptz,
  revertido_por text,
  motivo_reversion text,
  FOREIGN KEY (negocio_id, compra_id) REFERENCES compras_operativas (negocio_id, id),
  FOREIGN KEY (negocio_id, responsable_id) REFERENCES compras_responsables (negocio_id, id),
  CHECK ((origen='fondo' AND responsable_id IS NOT NULL AND cuenta IS NULL)
      OR (origen='otra_cuenta' AND responsable_id IS NULL AND length(trim(cuenta)) > 0)),
  UNIQUE (negocio_id, clave_operacion)
);
CREATE INDEX IF NOT EXISTS compras_pagos_compra ON compras_pagos (negocio_id, compra_id);
CREATE INDEX IF NOT EXISTS compras_pagos_fondo ON compras_pagos (negocio_id, responsable_id, fecha)
  WHERE revertido_at IS NULL AND origen='fondo';

CREATE TABLE IF NOT EXISTS compras_factura_cambios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id uuid NOT NULL,
  compra_id uuid NOT NULL,
  anterior jsonb NOT NULL,
  nuevo jsonb NOT NULL,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (negocio_id,compra_id) REFERENCES compras_operativas (negocio_id,id)
);
