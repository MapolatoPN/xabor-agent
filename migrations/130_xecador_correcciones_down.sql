-- Reversa de la 130 (Xecador, correcciones de checadas).
--
-- ANTES DE CORRERLA: revertir primero el código que depende de la 130 (las
-- rutas /api/personal/checador/* leen y escriben las correcciones, y el
-- checador calcula con ellas qué le toca registrar a cada empleado).
--
-- Se corre con psql:  psql "$CONN" -f migrations/130_xecador_correcciones_down.sql
-- Todo o nada: ON_ERROR_STOP propio y BEGIN/COMMIT.
--
-- Falla (a propósito) si ya hay alguna corrección: son parte del registro de
-- jornada y no se borran para revertir código.
\set ON_ERROR_STOP on

BEGIN;

LOCK TABLE xecador_correcciones, xecador_checadas IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM xecador_correcciones) THEN
    RAISE EXCEPTION 'La reversa de la 130 no corre: ya hay correcciones de checadas que se perderían';
  END IF;
END $$;

DROP TABLE IF EXISTS xecador_correcciones;
DROP FUNCTION IF EXISTS xecador_correcciones_inmutable();
DROP FUNCTION IF EXISTS xecador_correcciones_objetivo_valido();
ALTER TABLE xecador_checadas DROP CONSTRAINT IF EXISTS xecador_checadas_empleado_id_key;

COMMIT;
