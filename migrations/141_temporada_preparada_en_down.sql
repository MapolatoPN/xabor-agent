-- Reversa de la 141 (pedidos de temporada: «se prepara en»).
--
-- ANTES DE CORRERLA: revertir primero el código que la usa (/temporada y
-- /api/admin/temporada/*). El código anterior no lee preparada_en: revertir
-- el código basta, y esta reversa es opcional.
--
-- Se corre con psql:  psql "$CONN" -f migrations/141_temporada_preparada_en_down.sql
-- Todo o nada: ON_ERROR_STOP propio y BEGIN/COMMIT.
--
-- Al quitar la columna se pierde qué campaña se prepara en qué sucursal (la
-- sucursal que prepara deja de ver esos pedidos). Para respaldarlo antes:
--   psql "$CONN" -c "\copy (SELECT id, negocio_id, preparada_en FROM temporada_campanas WHERE preparada_en IS NOT NULL) TO 'temporada_preparada_en.csv' CSV HEADER"
\set ON_ERROR_STOP on

BEGIN;

DROP INDEX IF EXISTS temporada_campanas_preparada_en;
ALTER TABLE temporada_campanas
  DROP CONSTRAINT IF EXISTS temporada_campanas_preparada_en_otra,
  DROP CONSTRAINT IF EXISTS temporada_campanas_preparada_en_fkey,
  DROP COLUMN IF EXISTS preparada_en;

COMMIT;
