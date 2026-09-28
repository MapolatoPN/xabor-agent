-- Reversa de la 102. Las cuentas liberadas siguen 'canceladas' (estado de la
-- 039) con quién y cuándo; pierden el motivo.
ALTER TABLE restaurante_cuentas DROP CONSTRAINT IF EXISTS restaurante_cuentas_liberada_motivo_check;
ALTER TABLE restaurante_cuentas DROP COLUMN IF EXISTS liberada_motivo;
ALTER TABLE restaurante_cuentas DROP COLUMN IF EXISTS liberada_motivo_codigo;
