-- Reverso de la 089. La columna es nueva y nadie la lee para decidir nada.
DROP INDEX IF EXISTS idx_configuracion_updated;
DROP TRIGGER IF EXISTS set_updated_at ON configuracion;
ALTER TABLE configuracion DROP COLUMN IF EXISTS updated_at;
