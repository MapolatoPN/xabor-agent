-- Reversa de la 150. Solo a mano, con psql y a propósito: ningún proceso la
-- ejecuta en automático. Para volver al código anterior NO hace falta borrar
-- la columna (es aditiva y ese código no la lee), pero SÍ conviene la primera
-- parte: el código anterior no sabe arrancar una campaña 'programada' y la
-- enseñaría como terminada. Aquí se cancelan con su motivo, igual que
-- «Detener» (lo que no salió queda 'cancelado'). No borra ninguna fila.
BEGIN;
UPDATE campana_envios SET estado = 'cancelado'
 WHERE estado = 'pendiente'
   AND campana_id IN (SELECT id FROM campanas WHERE tipo = 'plantilla' AND estado = 'programada');
UPDATE campanas SET estado = 'detenida', detenida_at = now(),
       detenida_motivo = 'Se canceló antes de salir: se retiró la función de programar'
 WHERE tipo = 'plantilla' AND estado = 'programada';
DROP INDEX IF EXISTS campanas_programadas_por_hora;
ALTER TABLE campanas DROP COLUMN IF EXISTS programada_para;
COMMIT;
