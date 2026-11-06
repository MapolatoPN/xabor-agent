-- Reversa de la 129 (Xecador, checadas y tablets).
--
-- ANTES DE CORRERLA: revertir primero el código que depende de la 129 (las
-- rutas /api/checador/* y /api/personal/checador/* leen y escriben estas
-- tablas y columnas).
--
-- Se corre con psql:  psql "$CONN" -f migrations/129_xecador_checadas_down.sql
-- Todo o nada: ON_ERROR_STOP propio y BEGIN/COMMIT.
--
-- Falla (a propósito) si la 129 ya guardó algo que se perdería: una checada,
-- una foto, una tablet (aunque esté revocada), un aviso o un negocio con la
-- foto al checar encendida. Las checadas son el registro de jornada: no se
-- borran nunca para revertir código.
\set ON_ERROR_STOP on

BEGIN;

LOCK TABLE xecador_checadas, xecador_checada_fotos, xecador_dispositivos, xecador_avisos, xecador_config,
  xecador_empleados IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM xecador_checadas)
     OR EXISTS (SELECT 1 FROM xecador_checada_fotos)
     OR EXISTS (SELECT 1 FROM xecador_dispositivos)
     OR EXISTS (SELECT 1 FROM xecador_avisos)
     OR EXISTS (SELECT 1 FROM xecador_config WHERE foto_al_checar) THEN
    RAISE EXCEPTION 'La reversa de la 129 no corre: ya hay checadas, tablets, avisos o configuración que se perderían';
  END IF;
END $$;

DROP TABLE IF EXISTS xecador_checada_fotos;
DROP TABLE IF EXISTS xecador_checadas;
DROP TABLE IF EXISTS xecador_avisos;
DROP TABLE IF EXISTS xecador_dispositivos;
DROP TABLE IF EXISTS xecador_config;
DROP FUNCTION IF EXISTS xecador_checadas_inmutable();

ALTER TABLE xecador_empleados
  DROP CONSTRAINT IF EXISTS xecador_empleados_pin_fallos_check,
  DROP COLUMN IF EXISTS pin_fallos,
  DROP COLUMN IF EXISTS pin_ultimo_fallo_at,
  DROP COLUMN IF EXISTS pin_bloqueado_hasta;

COMMIT;
