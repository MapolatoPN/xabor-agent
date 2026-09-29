-- Nuevas acciones, ninguna activación automática ni cambio de datos del pedido.
ALTER TABLE agente_botones DROP CONSTRAINT IF EXISTS agente_botones_accion_check;
ALTER TABLE agente_botones ADD CONSTRAINT agente_botones_accion_check CHECK (accion IN
  ('confirmar','cambiar_algo','agregar_otro','aceptar','rechazar','elegir_producto','elegir_opcion',
   'agregar_a_grupo','cerrar_grupo','editar_grupo','conservar_grupo','reemplazar_grupo','modalidad','pago',
   'flow_productos','flow_configurar'));
