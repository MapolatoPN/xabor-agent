-- Rollback de la migración 028 (renumerada de 027 -- ver 028_sesiones_comerciales.sql).
-- Guarda: aborta si ya existe alguna sesión comercial real -- significaría
-- que el asistente ya se usó en producción y este down perdería esos datos.
-- Ejecutar con: psql "$CONN" -v ON_ERROR_STOP=1 -f 028_sesiones_comerciales_down.sql

BEGIN;

DO $$
DECLARE
  v_sesiones INTEGER;
BEGIN
  SELECT count(*) INTO v_sesiones FROM sesiones_comerciales;
  IF v_sesiones > 0 THEN
    RAISE EXCEPTION
      'Rollback 028 abortado: existen % sesión(es) comercial(es) reales. Este down las eliminaría.',
      v_sesiones;
  END IF;
END $$;

DROP TABLE IF EXISTS sesiones_comerciales_eventos;
DROP TABLE IF EXISTS sesiones_comerciales;

ALTER TABLE cotizaciones DROP CONSTRAINT IF EXISTS cotizaciones_origen_check;
ALTER TABLE cotizaciones DROP COLUMN IF EXISTS origen;

-- Módulo asistente_comercial_cotizaciones: aborta si algún negocio ya lo
-- activó/configuró (estado distinto del default 'no_contratado' sembrado
-- por esta misma migración) -- ese cambio de estado es una decisión real
-- de un admin/superadmin, este down nunca la descarta en silencio.
DO $$
DECLARE
  v_activos INTEGER;
BEGIN
  SELECT count(*) INTO v_activos
  FROM negocio_modulos WHERE modulo = 'asistente_comercial_cotizaciones' AND estado <> 'no_contratado';
  IF v_activos > 0 THEN
    RAISE EXCEPTION
      'Rollback 028 abortado: % negocio(s) ya activaron/configuraron asistente_comercial_cotizaciones.',
      v_activos;
  END IF;
END $$;

DELETE FROM negocio_modulos WHERE modulo = 'asistente_comercial_cotizaciones';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'negocio_modulos_modulo_check'
  ) THEN
    ALTER TABLE negocio_modulos DROP CONSTRAINT negocio_modulos_modulo_check;
  END IF;
  ALTER TABLE negocio_modulos ADD CONSTRAINT negocio_modulos_modulo_check
    CHECK (modulo IN (
      'pos','usuarios','caja','menu','impresion','whatsapp','voz','rappi','facturacion','rewards',
      'chat_imagenes','chat_documentos_pdf','cotizaciones','generador_cotizaciones','pagos','repartidores'
    ));
END $$;

COMMIT;
