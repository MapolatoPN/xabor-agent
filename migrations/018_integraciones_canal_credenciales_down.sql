-- Rollback de la migración 018.
--
-- Igual que en 016: el rollback NORMAL de esta fase es de código
-- (volver al commit anterior), que deja las columnas/tabla nuevas
-- intactas sin ningún efecto adverso -- el código anterior simplemente
-- no las usa. Este script (rollback de datos/esquema) es un recurso
-- EXTRA, con dos guardas obligatorias:
--
-- 1) Aborta si integraciones_canal_credenciales tiene alguna fila --
--    borrar la tabla en ese punto destruiría credenciales cifradas
--    reales sin ninguna forma de recuperarlas.
-- 2) Aborta si alguna fila de integraciones_canal tiene un valor de
--    `estado` que solo puede haberse originado desde el modelo nuevo
--    (pendiente_configuracion/suspendido/error) -- 'no_configurado' y
--    'activo' son los únicos valores que el backfill de la migración
--    pudo haber puesto, así que cualquier otro valor significa que
--    Fase B ya se usó de verdad y este down perdería esa información.
--
-- Ejecutar con: psql "$CONN" -v ON_ERROR_STOP=1 -f 018_integraciones_canal_credenciales_down.sql

BEGIN;

DO $$
DECLARE
  v_credenciales INTEGER;
  v_estados_nuevos INTEGER;
BEGIN
  SELECT count(*) INTO v_credenciales FROM integraciones_canal_credenciales;
  IF v_credenciales > 0 THEN
    RAISE EXCEPTION
      'Rollback 018 abortado: existen % fila(s) en integraciones_canal_credenciales. Borrar la tabla destruiría credenciales cifradas reales sin forma de recuperarlas. Elimínalas explícitamente primero (DELETE de credenciales, nunca del esquema) si de verdad se necesita revertir.',
      v_credenciales;
  END IF;

  SELECT count(*) INTO v_estados_nuevos
  FROM integraciones_canal WHERE estado NOT IN ('no_configurado','activo');
  IF v_estados_nuevos > 0 THEN
    RAISE EXCEPTION
      'Rollback 018 abortado: % fila(s) tienen un estado (pendiente_configuracion/suspendido/error) que solo pudo haberse fijado usando el modelo nuevo. Este down solo es seguro si Fase B nunca se usó realmente (todas las filas siguen en su valor de backfill).',
      v_estados_nuevos;
  END IF;
END $$;

DROP TABLE IF EXISTS integraciones_canal_credenciales;

DROP INDEX IF EXISTS idx_integraciones_canal_negocio_canal_proveedor;

ALTER TABLE integraciones_canal DROP COLUMN IF EXISTS proveedor;
ALTER TABLE integraciones_canal DROP COLUMN IF EXISTS estado;
ALTER TABLE integraciones_canal DROP COLUMN IF EXISTS waba_id;
ALTER TABLE integraciones_canal DROP COLUMN IF EXISTS business_id;
ALTER TABLE integraciones_canal DROP COLUMN IF EXISTS display_phone_number;
ALTER TABLE integraciones_canal DROP COLUMN IF EXISTS conectado_at;
ALTER TABLE integraciones_canal DROP COLUMN IF EXISTS actualizado_por;
ALTER TABLE integraciones_canal DROP COLUMN IF EXISTS ultimo_error_codigo;
ALTER TABLE integraciones_canal DROP COLUMN IF EXISTS ultimo_error_at;

COMMIT;
