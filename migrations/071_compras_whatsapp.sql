CREATE TABLE IF NOT EXISTS compras_whatsapp_autorizados (
  negocio_id uuid NOT NULL REFERENCES negocios(id),
  telefono text NOT NULL CHECK (telefono ~ '^52[0-9]{10}$'),
  responsable_id uuid NOT NULL,
  activo boolean NOT NULL DEFAULT true,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (negocio_id, telefono),
  FOREIGN KEY (negocio_id, responsable_id) REFERENCES compras_responsables(negocio_id,id)
);
CREATE TABLE IF NOT EXISTS compras_whatsapp_tickets (
  negocio_id uuid NOT NULL,
  telefono text NOT NULL,
  wamid text NOT NULL,
  compra_id uuid NOT NULL,
  version_mostrada integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (negocio_id, wamid),
  UNIQUE (negocio_id, compra_id),
  FOREIGN KEY (negocio_id,telefono) REFERENCES compras_whatsapp_autorizados(negocio_id,telefono),
  FOREIGN KEY (negocio_id,compra_id) REFERENCES compras_operativas(negocio_id,id)
);
