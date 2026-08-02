-- Rollback de la migración 026. Guarda: aborta si ya existe alguna fila
-- real en documentos o cotizaciones -- significaría que la función ya
-- se usó en producción y este down perdería esos datos.
-- Ejecutar con: psql "$CONN" -v ON_ERROR_STOP=1 -f 026_documentos_cotizaciones_down.sql

BEGIN;

DO $$
DECLARE
  v_documentos INTEGER;
  v_cotizaciones INTEGER;
BEGIN
  SELECT count(*) INTO v_documentos FROM documentos;
  SELECT count(*) INTO v_cotizaciones FROM cotizaciones;
  IF v_documentos > 0 OR v_cotizaciones > 0 THEN
    RAISE EXCEPTION
      'Rollback 026 abortado: existen % documento(s) y % cotización(es) reales. Este down las eliminaría.',
      v_documentos, v_cotizaciones;
  END IF;
END $$;

DROP TABLE IF EXISTS cotizaciones_historial;
DROP TABLE IF EXISTS cotizacion_items;
ALTER TABLE mensajes DROP COLUMN IF EXISTS documento_id;
DROP TABLE IF EXISTS documentos;
DROP TABLE IF EXISTS cotizaciones;

ALTER TABLE mensajes DROP CONSTRAINT IF EXISTS mensajes_tipo_check;
ALTER TABLE mensajes DROP COLUMN IF EXISTS tipo;

DELETE FROM negocio_modulos WHERE modulo IN (
  'chat_imagenes','chat_documentos_pdf','cotizaciones','generador_cotizaciones','pagos','repartidores'
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'negocio_modulos_modulo_check'
  ) THEN
    ALTER TABLE negocio_modulos DROP CONSTRAINT negocio_modulos_modulo_check;
  END IF;
  ALTER TABLE negocio_modulos ADD CONSTRAINT negocio_modulos_modulo_check
    CHECK (modulo IN ('pos','usuarios','caja','menu','impresion','whatsapp','voz','rappi','facturacion','rewards'));
END $$;

COMMIT;
