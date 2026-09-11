-- Estado del asistente e inbox por negocio. No modifica pedidos ni folios.
CREATE TABLE IF NOT EXISTS whatsapp_conversaciones (
  negocio_id uuid NOT NULL REFERENCES negocios(id),
  telefono text NOT NULL,
  sesion jsonb,
  revision bigint NOT NULL DEFAULT 0,
  requiere_revision boolean NOT NULL DEFAULT false,
  motivo text,
  actualizado_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (negocio_id, telefono)
);
CREATE TABLE IF NOT EXISTS whatsapp_entradas (
  id bigserial PRIMARY KEY,
  negocio_id uuid NOT NULL REFERENCES negocios(id),
  telefono text NOT NULL,
  wamid text NOT NULL,
  payload jsonb NOT NULL,
  estado text NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente','procesando','completado','revision','revisado')),
  recibido_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  actualizado_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (negocio_id, wamid),
  FOREIGN KEY (negocio_id, telefono) REFERENCES whatsapp_conversaciones(negocio_id, telefono)
);
CREATE INDEX IF NOT EXISTS whatsapp_entradas_pendientes ON whatsapp_entradas(negocio_id,telefono,id)
  WHERE estado IN ('pendiente','procesando');
