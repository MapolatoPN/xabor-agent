-- Rollback de la migración 016.
--
-- IMPORTANTE (instrucción explícita): el rollback NORMAL de esta fase es
-- un rollback de CÓDIGO (volver al commit anterior), que deja la columna
-- negocio_id intacta en la base -- el código anterior simplemente no la
-- usa, sin ningún efecto adverso. Este script (rollback de DATOS/ESQUEMA,
-- que elimina la columna) es un recurso EXTRA, no el camino esperado, y
-- solo es seguro ANTES de que exista más de un negocio con overrides
-- propios (es decir, antes de que la Fase B/C conecte un segundo
-- tenant con overrides). Por eso incluye una guarda explícita que
-- ABORTA si detecta overrides de más de un negocio -- en ese punto,
-- eliminar la columna borraría la única forma de distinguir a quién le
-- pertenece cada override, y NO hay forma de deshacer eso.
--
-- Ejecutar con: psql "$CONN" -v ON_ERROR_STOP=1 -f 016_prompt_overrides_negocio_down.sql

BEGIN;

DO $$
DECLARE
  v_negocios_distintos INTEGER;
BEGIN
  SELECT count(DISTINCT negocio_id) INTO v_negocios_distintos FROM prompt_overrides;
  IF v_negocios_distintos > 1 THEN
    RAISE EXCEPTION
      'Rollback 016 abortado: existen overrides de % negocios distintos. Eliminar negocio_id en este punto perdería la única forma de saber a quién pertenece cada override -- irreversible. Este down solo es seguro cuando todos los overrides existentes pertenecen a un único negocio (antes de conectar un segundo tenant con overrides propios).',
      v_negocios_distintos;
  END IF;
END $$;

DROP INDEX IF EXISTS idx_prompt_overrides_negocio;
ALTER TABLE prompt_overrides ALTER COLUMN negocio_id DROP NOT NULL;
ALTER TABLE prompt_overrides DROP COLUMN IF EXISTS negocio_id;

COMMIT;
