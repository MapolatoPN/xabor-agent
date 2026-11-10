-- Reversa de la 133 (Xecador, «Revisada» para las alertas de secuencia).
--
-- ANTES DE CORRERLA: revertir primero el código que depende de la 133 (el
-- panel lee y escribe estas revisiones en «Para revisar»). El código anterior
-- no usa la tabla: revertir el código basta, y esta reversa es opcional.
--
-- Se corre con psql:  psql "$CONN" -f migrations/133_xecador_revisiones_secuencia_down.sql
-- Todo o nada: ON_ERROR_STOP propio y BEGIN/COMMIT.
--
-- Falla (a propósito) si ya hay alguna revisión guardada: se perdería quién
-- revisó qué y por qué.
\set ON_ERROR_STOP on

BEGIN;

LOCK TABLE xecador_revisiones_secuencia IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM xecador_revisiones_secuencia) THEN
    RAISE EXCEPTION 'La reversa de la 133 no corre: ya hay alertas marcadas como revisadas que se perderían';
  END IF;
END $$;

DROP TABLE IF EXISTS xecador_revisiones_secuencia;
DROP FUNCTION IF EXISTS xecador_revisiones_secuencia_inmutable();

COMMIT;
