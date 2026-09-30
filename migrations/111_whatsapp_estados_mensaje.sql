-- Evidencias de transporte, nunca estados de pedido/pago ni contenido del chat.
CREATE TABLE IF NOT EXISTS whatsapp_estados_mensaje (
  negocio_id uuid NOT NULL REFERENCES negocios(id),
  wamid text NOT NULL CHECK(length(wamid) BETWEEN 1 AND 512),
  destinatario text NOT NULL CHECK(destinatario ~ '^[0-9]{8,15}$'),
  estado text NOT NULL CHECK(estado IN ('sent','delivered','read','failed')),
  ocurrido_at timestamptz NOT NULL,
  observado_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  error_codigo integer,
  PRIMARY KEY(negocio_id,wamid,destinatario,estado)
);
CREATE INDEX IF NOT EXISTS whatsapp_estados_mensaje_retencion ON whatsapp_estados_mensaje(observado_at);
COMMENT ON TABLE whatsapp_estados_mensaje IS 'Estados de webhooks autenticados. Retención 30 días; sin contenido, credenciales ni efectos de negocio.';
ALTER TABLE agente_actividad_formulario DROP CONSTRAINT IF EXISTS agente_actividad_formulario_tipo_check;
ALTER TABLE agente_actividad_formulario ADD CONSTRAINT agente_actividad_formulario_tipo_check
  CHECK(tipo IN ('apertura','paso','validacion','error_cliente','no_disponible','error_servidor'));
COMMENT ON TABLE agente_actividad_formulario IS 'Evidencia del servidor, no presencia en vivo. Retención 30 días; purga acotada de esta telemetría, nunca del pedido.';
