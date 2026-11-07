-- Reversa de la 128 (Xecador, catálogo completo).
--
-- ANTES DE CORRERLA: revertir primero el código que depende de la 128 (las
-- rutas /api/personal/* leen y escriben estas columnas y tablas).
--
-- Se corre con psql:  psql "$CONN" -f migrations/128_xecador_catalogo_down.sql
-- Todo o nada: ON_ERROR_STOP propio y BEGIN/COMMIT (igual que la reversa de la 127).
--
-- Falla (a propósito) si la 128 ya guardó algo que se perdería: una jornada, un
-- PIN, la sucursal, la fecha de ingreso, el NSS o los datos de una baja de algún
-- expediente, o un evento de jornada o de PIN en la bitácora (que es de solo
-- inserción: no se pueden borrar, y sin ellos no se puede restaurar el CHECK).
\set ON_ERROR_STOP on

BEGIN;

LOCK TABLE xecador_empleados, xecador_jornadas, xecador_jornada_dias, xecador_empleado_eventos IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM xecador_jornadas)
     OR EXISTS (SELECT 1 FROM xecador_empleados
                 WHERE sucursal_id IS NOT NULL OR fecha_ingreso IS NOT NULL OR nss IS NOT NULL
                    OR baja_fecha IS NOT NULL OR baja_tipo IS NOT NULL OR pin_hash IS NOT NULL
                    OR puede_checar_otras_sucursales)
     OR EXISTS (SELECT 1 FROM xecador_empleado_eventos WHERE tipo IN ('jornada', 'pin')) THEN
    RAISE EXCEPTION 'La reversa de la 128 no corre: ya hay jornadas, PIN o datos del catálogo que se perderían';
  END IF;
END $$;

DROP TABLE IF EXISTS xecador_jornada_dias;
DROP TABLE IF EXISTS xecador_jornadas;
DROP FUNCTION IF EXISTS xecador_jornadas_inmutable();

ALTER TABLE xecador_empleado_eventos
  DROP CONSTRAINT IF EXISTS xecador_empleado_eventos_tipo_check,
  ADD CONSTRAINT xecador_empleado_eventos_tipo_check
    CHECK (tipo IN ('alta', 'edicion', 'baja', 'reactivacion'));

ALTER TABLE xecador_empleados
  DROP CONSTRAINT IF EXISTS xecador_empleados_sucursal_fkey,
  DROP CONSTRAINT IF EXISTS xecador_empleados_nss_check,
  DROP CONSTRAINT IF EXISTS xecador_empleados_baja_tipo_check,
  DROP CONSTRAINT IF EXISTS xecador_empleados_baja_otro_motivo,
  DROP CONSTRAINT IF EXISTS xecador_empleados_activo_sin_baja,
  DROP CONSTRAINT IF EXISTS xecador_empleados_pin_check,
  DROP CONSTRAINT IF EXISTS xecador_empleados_version_check,
  DROP COLUMN IF EXISTS sucursal_id,
  DROP COLUMN IF EXISTS puede_checar_otras_sucursales,
  DROP COLUMN IF EXISTS fecha_ingreso,
  DROP COLUMN IF EXISTS nss,
  DROP COLUMN IF EXISTS baja_fecha,
  DROP COLUMN IF EXISTS baja_tipo,
  DROP COLUMN IF EXISTS pin_hash,
  DROP COLUMN IF EXISTS pin_actualizado_at,
  DROP COLUMN IF EXISTS version;

COMMIT;
