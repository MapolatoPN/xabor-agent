-- Pantalla observada por el endpoint, sin contenido ni presencia en vivo.
-- Nullable para no inventar el detalle de los eventos anteriores.
ALTER TABLE agente_actividad_formulario ADD COLUMN IF NOT EXISTS pantalla text
  CHECK (pantalla IN ('MENU','CATEGORIA','PERSONALIZAR','PLATILLO','TACOS','CARRITO','EDITAR','ENTREGA','DIRECCION','FINAL'));
