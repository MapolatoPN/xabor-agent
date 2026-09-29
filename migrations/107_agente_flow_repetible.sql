-- Borrador de la ventana, separado del carrito y de los pedidos operativos.
-- No activa Flows ni cambia configuración. Dependencia: 103–106.
CREATE TABLE IF NOT EXISTS agente_flows_borradores (
  pregunta_id uuid PRIMARY KEY REFERENCES agente_preguntas_interactivas(id) ON DELETE CASCADE,
  contenido jsonb NOT NULL CHECK (jsonb_typeof(contenido)='object'),
  ultimo_hash text,
  actualizado_at timestamptz NOT NULL DEFAULT now()
);
