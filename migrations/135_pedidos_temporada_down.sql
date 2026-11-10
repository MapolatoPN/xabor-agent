-- Reversa de la 135 (pedidos de temporada).
--
-- ANTES DE CORRERLA: revertir primero el código que la usa (rutas
-- /api/temporada/*, /api/admin/temporada/* y la página /temporada). El resto
-- de Xabor no lee estas tablas.
--
-- BORRA los pedidos agendados con el formulario. Si ya hubo pedidos reales,
-- respaldarlos antes:
--   psql "$CONN" -c "\copy (SELECT * FROM temporada_pedidos) TO 'temporada_pedidos.csv' CSV HEADER"
--
-- Se corre con psql:  psql "$CONN" -f migrations/135_pedidos_temporada_down.sql
\set ON_ERROR_STOP on

BEGIN;

DROP TABLE IF EXISTS temporada_pedidos;
DROP TABLE IF EXISTS temporada_campanas;

COMMIT;
