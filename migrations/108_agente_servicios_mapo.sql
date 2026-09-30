-- Aditiva. No activa atención, no modifica pedidos ni emite CFDI.
ALTER TABLE agente_botones DROP CONSTRAINT IF EXISTS agente_botones_accion_check;
ALTER TABLE agente_botones ADD CONSTRAINT agente_botones_accion_check CHECK (accion IN
  ('confirmar','cambiar_algo','agregar_otro','aceptar','rechazar','elegir_producto','elegir_opcion',
   'agregar_a_grupo','cerrar_grupo','editar_grupo','conservar_grupo','reemplazar_grupo','modalidad','pago',
   'flow_productos','flow_configurar','menu_mapo','flow_facturacion','flow_evento'));
CREATE TABLE IF NOT EXISTS agente_solicitudes_servicio (
  id uuid PRIMARY KEY,
  negocio_id uuid NOT NULL REFERENCES negocios(id),
  telefono text NOT NULL,
  pregunta_id uuid NOT NULL UNIQUE REFERENCES agente_preguntas_interactivas(id),
  respuesta_clave text NOT NULL UNIQUE REFERENCES agente_outbox(evento_clave),
  servicio text NOT NULL CHECK (servicio IN ('facturacion','evento','humano')),
  datos jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agente_solicitudes_negocio
  ON agente_solicitudes_servicio(negocio_id,telefono,created_at DESC);
