-- Aditiva: no activa botones para ningún negocio. Requiere 099.
CREATE TABLE IF NOT EXISTS agente_preguntas_interactivas (
  id uuid PRIMARY KEY,
  negocio_id uuid NOT NULL REFERENCES negocios(id),
  session_id text NOT NULL,
  ciclo text NOT NULL,
  dialogo_id text NOT NULL,
  outbox_clave text NOT NULL REFERENCES agente_outbox(evento_clave),
  huella text NOT NULL,
  total_mostrado numeric NOT NULL,
  estado text NOT NULL DEFAULT 'disponible'
    CHECK (estado IN ('disponible','reservada','terminada','incierta')),
  reserva_id uuid,
  comando jsonb,
  resultado jsonb,
  respuesta_clave text,
  created_at timestamptz NOT NULL DEFAULT now(),
  reservado_at timestamptz,
  terminado_at timestamptz,
  UNIQUE (negocio_id,session_id,ciclo,dialogo_id)
);
CREATE TABLE IF NOT EXISTS agente_botones (
  token text PRIMARY KEY CHECK (token ~ '^xb1:[A-Za-z0-9_-]{22}$'),
  pregunta_id uuid NOT NULL REFERENCES agente_preguntas_interactivas(id),
  accion text NOT NULL CHECK (accion IN ('confirmar','cambiar_algo')),
  UNIQUE (pregunta_id,accion)
);
CREATE INDEX IF NOT EXISTS idx_agente_preguntas_reservadas
  ON agente_preguntas_interactivas(negocio_id,session_id) WHERE estado='reservada';
