-- Reversa de la 114 (a mano, con psql y a propósito; nadie la corre en
-- automático). Los eventos con paso TIENDA o DIRECCION conservan su tipo,
-- revisión y fecha; pierden el paso (queda NULL, como un paso desconocido).
-- Antes de correrla, apagar la tienda (activar-flows-tienda.mjs revertir):
-- con la regla vieja sus eventos vuelven a perderse dentro de su SAVEPOINT.
UPDATE agente_actividad_formulario SET paso = NULL WHERE paso IN ('TIENDA','DIRECCION');
ALTER TABLE agente_actividad_formulario DROP CONSTRAINT IF EXISTS agente_actividad_formulario_paso_check;
ALTER TABLE agente_actividad_formulario ADD CONSTRAINT agente_actividad_formulario_paso_check
  CHECK (paso IN ('MENU','PLATILLO','TACOS','ENTREGA','CARRITO','EDITAR','FINAL'));
