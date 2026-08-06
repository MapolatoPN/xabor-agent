-- Rollback de la migración 037 — elimina lo aditivo.
-- sesiones_soporte se pierde (es auditoría de soporte, no datos de negocio);
-- onboarding_estado/implementacion se pierden (acompañamiento operativo,
-- recalculable parcialmente con el backfill de la 037 al reaplicar).
BEGIN;

DROP TABLE IF EXISTS sesiones_soporte;
ALTER TABLE negocios DROP CONSTRAINT IF EXISTS chk_negocios_onboarding_estado;
ALTER TABLE negocios DROP COLUMN IF EXISTS onboarding_estado;
ALTER TABLE negocios DROP COLUMN IF EXISTS implementacion;

COMMIT;
