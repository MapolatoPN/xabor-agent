-- Rollback de la migración 025. Guarda: aborta si ya existe algún pago
-- real registrado -- significaría que la función ya se usó en
-- producción y este down perdería esos datos.
-- Ejecutar con: psql "$CONN" -v ON_ERROR_STOP=1 -f 025_pagos_multiempresa_down.sql

BEGIN;

DO $$
DECLARE
  v_pagos INTEGER;
  v_metodos INTEGER;
BEGIN
  SELECT count(*) INTO v_pagos FROM pagos;
  SELECT count(*) INTO v_metodos FROM metodos_pago;
  IF v_pagos > 0 THEN
    RAISE EXCEPTION 'Rollback 025 abortado: existen % pago(s) reales. Este down los eliminaría.', v_pagos;
  END IF;
END $$;

DROP TABLE IF EXISTS pagos;
DROP TABLE IF EXISTS metodos_pago;

DROP INDEX IF EXISTS idx_integraciones_canal_principal_unico;
ALTER TABLE integraciones_canal DROP COLUMN IF EXISTS ultima_prueba_ok;
ALTER TABLE integraciones_canal DROP COLUMN IF EXISTS ultima_prueba_at;
ALTER TABLE integraciones_canal DROP COLUMN IF EXISTS ambiente;
ALTER TABLE integraciones_canal DROP COLUMN IF EXISTS principal;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM integraciones_canal WHERE estado = 'eliminado'
  ) THEN
    RAISE EXCEPTION 'Rollback 025 abortado: hay integraciones con estado ''eliminado'' -- ese valor dejaría de ser válido.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'integraciones_canal_estado_check') THEN
    ALTER TABLE integraciones_canal DROP CONSTRAINT integraciones_canal_estado_check;
  END IF;
  ALTER TABLE integraciones_canal ADD CONSTRAINT integraciones_canal_estado_check
    CHECK (estado IN ('no_configurado','pendiente_configuracion','pendiente_activacion','activo','suspendido','error'));
END $$;

COMMIT;
