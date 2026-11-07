-- Reversa de la 131 (Xecador, checadas sin conexión y «para revisar»).
--
-- ANTES DE CORRERLA: revertir primero el código que depende de la 131 (la
-- tablet sincroniza checadas sin conexión y el panel lee y escribe revisiones).
--
-- Se corre con psql:  psql "$CONN" -f migrations/131_xecador_sin_conexion_down.sql
-- Todo o nada: ON_ERROR_STOP propio y BEGIN/COMMIT.
--
-- Falla (a propósito) si la 131 ya guardó algo que se perdería: una checada
-- sin conexión, una marcada para revisar, una con IP o una revisión.
\set ON_ERROR_STOP on

BEGIN;

LOCK TABLE xecador_revisiones, xecador_checadas IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM xecador_revisiones)
     OR EXISTS (SELECT 1 FROM xecador_checadas
                 WHERE origen <> 'en_linea' OR cardinality(revision) > 0 OR ip IS NOT NULL) THEN
    RAISE EXCEPTION 'La reversa de la 131 no corre: ya hay checadas sin conexión, marcadas para revisar, con IP o revisadas que se perderían';
  END IF;
END $$;

DROP TABLE IF EXISTS xecador_revisiones;
DROP FUNCTION IF EXISTS xecador_revisiones_inmutable();
DROP INDEX IF EXISTS idx_xecador_checadas_revision;
DROP INDEX IF EXISTS idx_xecador_checadas_ip;

ALTER TABLE xecador_checadas
  DROP CONSTRAINT IF EXISTS xecador_checadas_origen_check,
  DROP CONSTRAINT IF EXISTS xecador_checadas_revision_check,
  DROP CONSTRAINT IF EXISTS xecador_checadas_datos_sin_conexion,
  DROP CONSTRAINT IF EXISTS xecador_checadas_transcurrido_check,
  DROP COLUMN IF EXISTS origen,
  DROP COLUMN IF EXISTS revision,
  DROP COLUMN IF EXISTS ip,
  DROP COLUMN IF EXISTS sincronizada_at,
  DROP COLUMN IF EXISTS ref_servidor,
  DROP COLUMN IF EXISTS transcurrido_ms;

COMMIT;
