-- 128 · Xecador, Parte A: el catálogo de empleados completo para el checador.
--
-- Aprobado por el dueño el 6-nov-2026. Todo es aditivo sobre la 127 (que tiene
-- que estar aplicada): ninguna fila existente cambia de valor.
--
--   1. La llave del empleado a su sucursal es compuesta (sucursal, negocio): un
--      empleado de Acuña no puede quedar ligado a una sucursal de Obispado
--      aunque alguien escriba directo en la base. Usa el índice único
--      idx_sucursales_id_negocio (id, negocio_id) que ya existe desde la 043
--      (lo usa también fk_impresoras_sucursal_negocio): la 128 NO toca la
--      tabla sucursales.
--
--   2. xecador_empleados gana:
--      - sucursal_id + puede_checar_otras_sucursales (solo dentro del MISMO
--        negocio: los negocios no comparten checadas);
--      - fecha_ingreso y nss (11 dígitos, opcional). Faltar no impide checar: la
--        pantalla marca el expediente como incompleto;
--      - baja_fecha (fecha efectiva) y baja_tipo (renuncia, despido, término de
--        contrato, otro; «otro» exige el motivo en texto);
--      - pin_hash (scrypt, nunca el PIN) y pin_actualizado_at;
--      - version: sube en cada cambio, para avisar si alguien más cambió el
--        expediente mientras otra persona lo editaba (en vez de pisarlo).
--
--   3. La bitácora (xecador_empleado_eventos) acepta dos tipos nuevos: 'jornada'
--      (cambio de jornada, antes y después) y 'pin' (asignado o restablecido,
--      nunca el PIN).
--
--   4. xecador_jornadas + xecador_jornada_dias — la jornada asignada CON
--      VIGENCIA: cambiarla agrega una versión nueva y la anterior se conserva, así
--      los cálculos de semanas pasadas no cambian. Un horario por día (ISO:
--      1 = lunes … 7 = domingo); un día ausente es de descanso; salida antes que
--      entrada = turno que cruza la medianoche. Solo inserción, como la bitácora.

-- ── 1 y 2. Expediente (con su sucursal del mismo negocio) ──────────────────
ALTER TABLE xecador_empleados
  ADD COLUMN IF NOT EXISTS sucursal_id                   uuid        NULL,
  ADD COLUMN IF NOT EXISTS puede_checar_otras_sucursales boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS fecha_ingreso                 date        NULL,
  ADD COLUMN IF NOT EXISTS nss                           text        NULL,
  ADD COLUMN IF NOT EXISTS baja_fecha                    date        NULL,
  ADD COLUMN IF NOT EXISTS baja_tipo                     text        NULL,
  ADD COLUMN IF NOT EXISTS pin_hash                      text        NULL,
  ADD COLUMN IF NOT EXISTS pin_actualizado_at            timestamptz NULL,
  ADD COLUMN IF NOT EXISTS version                       integer     NOT NULL DEFAULT 1;

-- DROP + ADD: una 128 aplicada a medias converge al reaplicarse.
ALTER TABLE xecador_empleados
  DROP CONSTRAINT IF EXISTS xecador_empleados_sucursal_fkey,
  ADD CONSTRAINT xecador_empleados_sucursal_fkey
    FOREIGN KEY (sucursal_id, negocio_id) REFERENCES sucursales (id, negocio_id) ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS xecador_empleados_nss_check,
  ADD CONSTRAINT xecador_empleados_nss_check CHECK (nss IS NULL OR nss ~ '^[0-9]{11}$'),
  DROP CONSTRAINT IF EXISTS xecador_empleados_baja_tipo_check,
  ADD CONSTRAINT xecador_empleados_baja_tipo_check
    CHECK (baja_tipo IS NULL OR baja_tipo IN ('renuncia', 'despido', 'termino_contrato', 'otro')),
  -- «Otro» sin explicación no dice nada.
  DROP CONSTRAINT IF EXISTS xecador_empleados_baja_otro_motivo,
  ADD CONSTRAINT xecador_empleados_baja_otro_motivo
    CHECK (baja_tipo IS DISTINCT FROM 'otro' OR (baja_motivo IS NOT NULL AND btrim(baja_motivo) <> '')),
  -- Un expediente activo no arrastra datos de una baja (la baja vive en la bitácora).
  DROP CONSTRAINT IF EXISTS xecador_empleados_activo_sin_baja,
  ADD CONSTRAINT xecador_empleados_activo_sin_baja
    CHECK (estatus = 'baja' OR (baja_fecha IS NULL AND baja_tipo IS NULL)),
  DROP CONSTRAINT IF EXISTS xecador_empleados_pin_check,
  ADD CONSTRAINT xecador_empleados_pin_check CHECK (pin_hash IS NULL OR pin_hash LIKE 'scrypt$%'),
  DROP CONSTRAINT IF EXISTS xecador_empleados_version_check,
  ADD CONSTRAINT xecador_empleados_version_check CHECK (version >= 1);

-- ── 3. Bitácora: eventos de jornada y de PIN ───────────────────────────────
-- Es DDL, no un UPDATE: los triggers de solo inserción no lo impiden. Valida
-- las filas existentes (todas de los cuatro tipos de la 127).
ALTER TABLE xecador_empleado_eventos
  DROP CONSTRAINT IF EXISTS xecador_empleado_eventos_tipo_check,
  ADD CONSTRAINT xecador_empleado_eventos_tipo_check
    CHECK (tipo IN ('alta', 'edicion', 'baja', 'reactivacion', 'jornada', 'pin'));

-- ── 4. Jornada con vigencia ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS xecador_jornadas (
  id             bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  negocio_id     uuid        NOT NULL,
  empleado_id    uuid        NOT NULL,
  vigente_desde  date        NOT NULL,
  tipo           text        NOT NULL CHECK (tipo IN ('diurna', 'nocturna', 'mixta')),
  creado_por     uuid        NULL CONSTRAINT xecador_jornadas_creado_por_fkey REFERENCES usuarios(id) ON DELETE RESTRICT,
  created_at     timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT xecador_jornadas_empleado_fkey
    FOREIGN KEY (negocio_id, empleado_id) REFERENCES xecador_empleados (negocio_id, id) ON DELETE RESTRICT
);

-- La vigente en una fecha = la de vigente_desde más reciente que no la pase; si
-- dos empatan, la última registrada (una corrección del mismo día).
CREATE INDEX IF NOT EXISTS idx_xecador_jornadas_vigencia
  ON xecador_jornadas (negocio_id, empleado_id, vigente_desde DESC, id DESC);

CREATE TABLE IF NOT EXISTS xecador_jornada_dias (
  jornada_id  bigint   NOT NULL CONSTRAINT xecador_jornada_dias_jornada_fkey REFERENCES xecador_jornadas(id) ON DELETE RESTRICT,
  dia         smallint NOT NULL CHECK (dia BETWEEN 1 AND 7),
  entrada     time     NOT NULL,
  salida      time     NOT NULL,
  PRIMARY KEY (jornada_id, dia),
  CONSTRAINT xecador_jornada_dias_duracion CHECK (salida <> entrada)
);

CREATE OR REPLACE FUNCTION xecador_jornadas_inmutable() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% es de solo inserción: una jornada no se reescribe, se agrega una versión nueva (operación %)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'P0001';
END
$$;

DROP TRIGGER IF EXISTS xecador_jornadas_sin_cambios ON xecador_jornadas;
CREATE TRIGGER xecador_jornadas_sin_cambios
  BEFORE UPDATE OR DELETE ON xecador_jornadas
  FOR EACH ROW EXECUTE FUNCTION xecador_jornadas_inmutable();
DROP TRIGGER IF EXISTS xecador_jornadas_sin_truncate ON xecador_jornadas;
CREATE TRIGGER xecador_jornadas_sin_truncate
  BEFORE TRUNCATE ON xecador_jornadas
  FOR EACH STATEMENT EXECUTE FUNCTION xecador_jornadas_inmutable();

DROP TRIGGER IF EXISTS xecador_jornada_dias_sin_cambios ON xecador_jornada_dias;
CREATE TRIGGER xecador_jornada_dias_sin_cambios
  BEFORE UPDATE OR DELETE ON xecador_jornada_dias
  FOR EACH ROW EXECUTE FUNCTION xecador_jornadas_inmutable();
DROP TRIGGER IF EXISTS xecador_jornada_dias_sin_truncate ON xecador_jornada_dias;
CREATE TRIGGER xecador_jornada_dias_sin_truncate
  BEFORE TRUNCATE ON xecador_jornada_dias
  FOR EACH STATEMENT EXECUTE FUNCTION xecador_jornadas_inmutable();
