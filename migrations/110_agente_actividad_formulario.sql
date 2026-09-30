-- Evidencia mínima del endpoint. No guarda tokens, respuestas, notas ni precios.
-- La captura nace apagada: whatsapp_trazabilidad_formularios_v1=true por negocio.
CREATE TABLE IF NOT EXISTS agente_actividad_formulario (
  pregunta_id uuid NOT NULL REFERENCES agente_preguntas_interactivas(id) ON DELETE CASCADE,
  clave text NOT NULL CHECK (clave ~ '^[a-f0-9]{64}$'),
  tipo text NOT NULL CHECK (tipo IN ('apertura','paso','validacion','error_cliente')),
  paso text CHECK (paso IN ('MENU','PLATILLO','TACOS','ENTREGA','CARRITO','EDITAR','FINAL')),
  revision integer NOT NULL CHECK (revision >= 0),
  observado_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (pregunta_id,clave)
);
CREATE INDEX IF NOT EXISTS agente_actividad_formulario_retencion
  ON agente_actividad_formulario(observado_at);
COMMENT ON TABLE agente_actividad_formulario IS
  'Eventos del servidor, no presencia en vivo. Retención propuesta: 30 días; purga explícita. Sin contenido del cliente.';
