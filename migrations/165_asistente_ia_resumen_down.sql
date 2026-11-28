-- Reversa MANUAL de la 165 (nadie la ejecuta en automático: solo con psql y a
-- propósito). Antes de correrla, regresa al binario anterior (e64c2349): el
-- nuevo escribe aquí cada mañana y cada noche.
--
-- Borra el registro de resúmenes y de gasto de la IA, la marca de la IA en
-- cada corrida y los avisos de la campanita de los dos tipos del asistente
-- (sin borrarlos, la lista de antes no se podría volver a poner). Son avisos y
-- registros, no ventas, cortes ni facturas: nada más los lee.

DELETE FROM avisos_panel WHERE tipo IN ('asistente_resumen_fallo', 'asistente_tope_ia');
ALTER TABLE avisos_panel DROP CONSTRAINT IF EXISTS avisos_panel_tipo;
ALTER TABLE avisos_panel ADD CONSTRAINT avisos_panel_tipo
  CHECK (tipo IN ('cliente_esperando', 'revision_humana', 'bot_retomo',
                  'fallas_bot', 'negativa_falsa', 'pago_sin_proveedor'));
DROP TABLE IF EXISTS asistente_restaurante_gasto_ia;
DROP TABLE IF EXISTS asistente_restaurante_resumenes;
ALTER TABLE asistente_restaurante_corridas DROP CONSTRAINT IF EXISTS asistente_restaurante_corridas_ia;
ALTER TABLE asistente_restaurante_corridas DROP COLUMN IF EXISTS ia;
