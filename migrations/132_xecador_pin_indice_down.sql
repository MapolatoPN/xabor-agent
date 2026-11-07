-- Reversa de la 132 (Xecador, checar solo con el PIN).
--
-- ANTES DE CORRERLA: revertir primero el código que depende de la 132 (la
-- tablet identifica al empleado solo con su PIN y el panel genera PIN únicos
-- con ese índice). El código anterior no usa la columna: revertir el código
-- basta para volver a número + PIN, y esta reversa es opcional.
--
-- Se corre con psql:  psql "$CONN" -f migrations/132_xecador_pin_indice_down.sql
-- Todo o nada: ON_ERROR_STOP propio y BEGIN/COMMIT.
--
-- No pierde nada que no se pueda reconstruir: los PIN siguen guardados en
-- pin_hash (con ellos se checa con número + PIN) y, si la 132 se vuelve a
-- aplicar, cada índice se repone solo la próxima vez que el empleado checa.
\set ON_ERROR_STOP on

BEGIN;

LOCK TABLE xecador_empleados IN ACCESS EXCLUSIVE MODE;

DROP INDEX IF EXISTS xecador_empleados_pin_indice_unico;

ALTER TABLE xecador_empleados
  DROP CONSTRAINT IF EXISTS xecador_empleados_pin_indice_check,
  DROP COLUMN IF EXISTS pin_indice;

COMMIT;
