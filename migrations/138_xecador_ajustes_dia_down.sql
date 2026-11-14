-- Reversa de la 138 (Xecador, extra autorizada y faltas justificadas).
--
-- ANTES DE CORRERLA: revertir primero el código que depende de la 138 (la
-- pestaña Checador lee y escribe estos ajustes en «Horas de la semana»). El
-- código anterior no usa la tabla: revertir el código basta, y esta reversa
-- es opcional.
--
-- Se corre con psql:  psql "$CONN" -f migrations/138_xecador_ajustes_dia_down.sql
-- Todo o nada: ON_ERROR_STOP propio y BEGIN/COMMIT.
--
-- Falla (a propósito) si ya hay algún ajuste guardado: se perdería quién
-- autorizó qué extra o justificó qué falta, y por qué.
\set ON_ERROR_STOP on

BEGIN;

LOCK TABLE xecador_ajustes_dia IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM xecador_ajustes_dia) THEN
    RAISE EXCEPTION 'La reversa de la 138 no corre: ya hay extra autorizada o faltas justificadas que se perderían';
  END IF;
END $$;

DROP TABLE IF EXISTS xecador_ajustes_dia;
DROP FUNCTION IF EXISTS xecador_ajustes_dia_inmutable();

COMMIT;
