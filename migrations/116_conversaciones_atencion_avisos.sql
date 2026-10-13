-- Ledger de avisos AL PERSONAL. Ningún efecto sobre pedidos ni mensajes.
CREATE TABLE IF NOT EXISTS conversaciones_atencion_avisos (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  negocio_id uuid NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  telefono text NOT NULL,
  mensaje_id integer NOT NULL REFERENCES mensajes(id) ON DELETE CASCADE,
  fase text NOT NULL CHECK (fase IN ('abierto','cerrado')),
  prioridad text NOT NULL CHECK (prioridad IN ('normal','alta','urgente')),
  lease_hasta timestamptz NOT NULL,
  enviado_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(negocio_id,telefono,mensaje_id,fase,prioridad)
);
