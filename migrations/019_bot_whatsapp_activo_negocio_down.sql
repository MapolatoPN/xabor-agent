-- Rollback de la migración 019. Guarda: aborta si algún negocio
-- DISTINTO de Nonna Maye tiene bot_whatsapp_activo = TRUE -- significaría
-- que el interruptor ya se usó de verdad (algún negocio fue activado)
-- y este down perdería esa información.
-- Ejecutar con: psql "$CONN" -v ON_ERROR_STOP=1 -f 019_bot_whatsapp_activo_negocio_down.sql

BEGIN;

DO $$
DECLARE
  v_activados_no_nonna INTEGER;
BEGIN
  SELECT count(*) INTO v_activados_no_nonna
  FROM negocios WHERE bot_whatsapp_activo = TRUE AND slug <> 'nonna-maye';
  IF v_activados_no_nonna > 0 THEN
    RAISE EXCEPTION
      'Rollback 019 abortado: % negocio(s) distinto(s) de Nonna Maye tienen bot_whatsapp_activo = TRUE. El interruptor ya se usó en producción -- este down perdería esa información.',
      v_activados_no_nonna;
  END IF;
END $$;

ALTER TABLE negocios DROP COLUMN IF EXISTS bot_whatsapp_activo;

COMMIT;
