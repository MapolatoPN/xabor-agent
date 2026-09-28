-- Aditiva respecto de 103. No activa ninguna función ni cambia catálogos.
ALTER TABLE agente_botones ADD COLUMN IF NOT EXISTS datos jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE agente_botones DROP CONSTRAINT IF EXISTS agente_botones_pregunta_id_accion_key;
ALTER TABLE agente_botones DROP CONSTRAINT IF EXISTS agente_botones_accion_check;
ALTER TABLE agente_botones ADD CONSTRAINT agente_botones_accion_check CHECK (accion IN
  ('confirmar','cambiar_algo','aceptar','rechazar','elegir_producto','elegir_opcion','agregar_a_grupo','cerrar_grupo','modalidad','pago'));
ALTER TABLE agente_preguntas_interactivas ALTER COLUMN total_mostrado DROP NOT NULL;
