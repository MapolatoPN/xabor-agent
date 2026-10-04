-- 114 — Telemetría del formulario «tienda» (contrato tienda_v1).
--
-- agente_actividad_formulario (110) guarda el paso de cada evento del
-- endpoint con una lista cerrada. La tienda registra sus etapas: TIENDA (el
-- menú, la ficha y el carrito) y DIRECCION (que la 110 no tenía). Esta
-- migración SOLO amplía esa lista; no toca filas, índices ni otras columnas.
--
-- Va ANTES del binario nuevo. Sin ella el binario funciona igual: un paso
-- fuera de la lista falla dentro de su SAVEPOINT (registrarActividadFormulario)
-- y el borrador del formulario se guarda de todos modos, sin el evento.
-- Idempotente: quitar y volver a poner la regla deja lo mismo.
ALTER TABLE agente_actividad_formulario DROP CONSTRAINT IF EXISTS agente_actividad_formulario_paso_check;
ALTER TABLE agente_actividad_formulario ADD CONSTRAINT agente_actividad_formulario_paso_check
  CHECK (paso IN ('MENU','PLATILLO','TACOS','ENTREGA','CARRITO','EDITAR','FINAL','TIENDA','DIRECCION'));
