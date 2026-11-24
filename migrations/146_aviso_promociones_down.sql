-- Reversa de la 146. Solo a mano, con psql y a propósito: ningún proceso la
-- ejecuta en automático. Para volver al código anterior NO hace falta: la 146
-- es aditiva y ese código no lee nada de lo que agrega.
--
-- No borra ninguna fila de cliente_consentimientos: las aceptaciones guardadas
-- al pedir en la tienda (fuente 'tienda_pedido') se quedan como aceptaciones.
-- Lo que se pierde es su folio, la versión del aviso que vieron y el historial
-- de textos. Si hay que conservarlos, respaldar antes:
--   \copy (SELECT * FROM cliente_consentimientos WHERE fuente = 'tienda_pedido') TO 'aceptaciones-tienda.csv' CSV HEADER
--   \copy (SELECT * FROM aviso_promociones) TO 'aviso-promociones.csv' CSV HEADER
BEGIN;
DROP INDEX IF EXISTS cliente_consentimientos_tienda_pedido_unica;
ALTER TABLE cliente_consentimientos
  DROP COLUMN IF EXISTS aviso_id,
  DROP COLUMN IF EXISTS referencia;
DROP TABLE IF EXISTS aviso_promociones;
COMMIT;
