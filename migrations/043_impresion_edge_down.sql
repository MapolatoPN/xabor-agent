-- Reversa de la 043. Destructiva por definición: borra la configuración de
-- impresoras, sus reglas y el historial de trabajos. No toca ninguna tabla
-- anterior a esta migración -- `terminales`, `sucursales` y `negocios`
-- quedan exactamente como estaban.
--
-- El orden importa: rutas y trabajos referencian impresoras.
DROP TABLE IF EXISTS edge_emparejamientos;
DROP TABLE IF EXISTS impresion_rutas;
DROP TABLE IF EXISTS impresion_trabajos;
DROP TABLE IF EXISTS impresoras;

-- El índice único (id, negocio_id) de sucursales lo creó la 043 para poder
-- declarar la FK compuesta. Se retira también, ya que nada más lo usa.
DROP INDEX IF EXISTS idx_sucursales_id_negocio;
