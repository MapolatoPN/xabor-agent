-- Descarga masiva del SAT por negocio (satSync.js):
--   - códigos y estado del SAT por solicitud, y número de reintentos;
--   - el XML de cada CFDI en la base (el disco de Railway se borra al desplegar);
--   - invoice_items.unidad sin límite de 20 caracteres;
--   - lo guardado bajo 'default' pasa al único negocio con e.firma cargada.
-- Las tablas SAT las crea initDB (database.js); si no existen, no hay nada que
-- migrar todavía.
DO $$
DECLARE
  dueno text;
  n int;
BEGIN
  IF to_regclass('public.sat_download_requests') IS NOT NULL THEN
    -- Antes la agregaba satSync.js en cada sincronización (migrarTablas).
    EXECUTE 'ALTER TABLE sat_download_requests ADD COLUMN IF NOT EXISTS tipo_solicitud varchar(20) DEFAULT ''CFDI''';
    EXECUTE 'ALTER TABLE sat_download_requests ADD COLUMN IF NOT EXISTS cod_estatus varchar(10)';
    EXECUTE 'ALTER TABLE sat_download_requests ADD COLUMN IF NOT EXISTS mensaje text';
    EXECUTE 'ALTER TABLE sat_download_requests ADD COLUMN IF NOT EXISTS estado_solicitud varchar(5)';
    EXECUTE 'ALTER TABLE sat_download_requests ADD COLUMN IF NOT EXISTS numero_cfdis integer';
    EXECUTE 'ALTER TABLE sat_download_requests ADD COLUMN IF NOT EXISTS intentos integer NOT NULL DEFAULT 0';
  END IF;
  IF to_regclass('public.invoices') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE invoices ADD COLUMN IF NOT EXISTS xml text';
  END IF;
  IF to_regclass('public.invoice_items') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE invoice_items ALTER COLUMN unidad TYPE text';
  END IF;

  SELECT count(DISTINCT negocio_id), min(negocio_id::text) INTO n, dueno
    FROM configuracion WHERE clave = 'sat_cert_base64_db' AND negocio_id IS NOT NULL;
  IF n = 1 THEN
    IF to_regclass('public.sat_accounts') IS NOT NULL THEN
      EXECUTE 'UPDATE sat_accounts a SET negocio_id = $1 WHERE a.negocio_id = ''default''
                 AND NOT EXISTS (SELECT 1 FROM sat_accounts b WHERE b.negocio_id = $1 AND b.rfc = a.rfc)' USING dueno;
    END IF;
    IF to_regclass('public.sat_download_requests') IS NOT NULL THEN
      EXECUTE 'UPDATE sat_download_requests SET negocio_id = $1 WHERE negocio_id = ''default''' USING dueno;
    END IF;
    IF to_regclass('public.invoices') IS NOT NULL THEN
      EXECUTE 'UPDATE invoices i SET negocio_id = $1 WHERE i.negocio_id = ''default''
                 AND NOT EXISTS (SELECT 1 FROM invoices j WHERE j.negocio_id = $1 AND j.uuid = i.uuid)' USING dueno;
    END IF;
  END IF;
END $$;
