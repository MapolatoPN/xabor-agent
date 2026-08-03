-- Rollback de la migración 027. Guarda: aborta si ya existe alguna sesión
-- comercial real -- significaría que el asistente ya se usó en producción
-- y este down perdería esos datos.
-- Ejecutar con: psql "$CONN" -v ON_ERROR_STOP=1 -f 027_sesiones_comerciales_down.sql

BEGIN;

DO $$
DECLARE
  v_sesiones INTEGER;
BEGIN
  SELECT count(*) INTO v_sesiones FROM sesiones_comerciales;
  IF v_sesiones > 0 THEN
    RAISE EXCEPTION
      'Rollback 027 abortado: existen % sesión(es) comercial(es) reales. Este down las eliminaría.',
      v_sesiones;
  END IF;
END $$;

DROP TABLE IF EXISTS sesiones_comerciales_eventos;
DROP TABLE IF EXISTS sesiones_comerciales;

ALTER TABLE cotizaciones DROP CONSTRAINT IF EXISTS cotizaciones_origen_check;
ALTER TABLE cotizaciones DROP COLUMN IF EXISTS origen;

COMMIT;
