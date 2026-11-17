-- 138 · Xecador, Parte B4: extra autorizada y faltas justificadas por día.
--
-- Pedido de Mario del 14-nov-2026 (horas y faltas). Necesita la 128
-- (expedientes y jornadas). Aditiva: una tabla nueva; ninguna fila existente
-- cambia. Es la 138: la 134 la tiene apartada feat/xecador-cara y la 137
-- feat/numero-por-sucursal.
--
-- Las horas de la semana se calculan al leer (checadas + jornada) y no se
-- guardan. Lo único que se guarda es lo que decide el administrador sobre un
-- día de un empleado:
--
--   tipo 'extra'  cuántos minutos de lo checado fuera de la jornada cuentan
--                 como extra (minutos; 0 = ninguno, para retirar una
--                 autorización).
--   tipo 'falta'  si la falta de ese día está justificada (justificada; false
--                 = se retira la justificación).
--
-- Siempre con motivo y autor. Solo inserción: un cambio es un renglón nuevo y
-- manda el más reciente de cada empleado, día y tipo; así queda quién decidió
-- qué y cuándo.
--
-- La tabla nace solo con columnas y llave primaria; las reglas van después
-- (DROP + ADD con su nombre de siempre) para que una 138 a medias converja.

CREATE TABLE IF NOT EXISTS xecador_ajustes_dia (
  id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  negocio_id   uuid        NOT NULL,
  empleado_id  uuid        NOT NULL,
  fecha        date        NOT NULL,
  tipo         text        NOT NULL,
  minutos      integer     NULL,
  justificada  boolean     NULL,
  motivo       text        NOT NULL,
  creado_por   uuid        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'xecador_ajustes_dia_pkey') THEN
    ALTER TABLE xecador_ajustes_dia ADD CONSTRAINT xecador_ajustes_dia_pkey PRIMARY KEY (id);
  END IF;
END $$;

ALTER TABLE xecador_ajustes_dia
  DROP CONSTRAINT IF EXISTS xecador_ajustes_dia_empleado_fkey,
  ADD CONSTRAINT xecador_ajustes_dia_empleado_fkey
    FOREIGN KEY (negocio_id, empleado_id) REFERENCES xecador_empleados (negocio_id, id) ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS xecador_ajustes_dia_creado_por_fkey,
  ADD CONSTRAINT xecador_ajustes_dia_creado_por_fkey FOREIGN KEY (creado_por) REFERENCES usuarios(id) ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS xecador_ajustes_dia_tipo_check,
  ADD CONSTRAINT xecador_ajustes_dia_tipo_check CHECK (tipo = ANY (ARRAY['extra', 'falta']::text[])),
  DROP CONSTRAINT IF EXISTS xecador_ajustes_dia_forma_check,
  ADD CONSTRAINT xecador_ajustes_dia_forma_check CHECK (
    (tipo = 'extra' AND minutos IS NOT NULL AND minutos BETWEEN 0 AND 1440 AND justificada IS NULL)
    OR (tipo = 'falta' AND minutos IS NULL AND justificada IS NOT NULL)),
  DROP CONSTRAINT IF EXISTS xecador_ajustes_dia_motivo_check,
  ADD CONSTRAINT xecador_ajustes_dia_motivo_check CHECK (char_length(btrim(motivo)) BETWEEN 1 AND 300);

CREATE INDEX IF NOT EXISTS idx_xecador_ajustes_dia_semana
  ON xecador_ajustes_dia (negocio_id, fecha, empleado_id, id);

CREATE OR REPLACE FUNCTION xecador_ajustes_dia_inmutable() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'xecador_ajustes_dia es de solo inserción: un ajuste no se cambia ni se borra, se agrega otro (operación %)', TG_OP
    USING ERRCODE = 'P0001';
END
$$;

DROP TRIGGER IF EXISTS xecador_ajustes_dia_sin_cambios ON xecador_ajustes_dia;
CREATE TRIGGER xecador_ajustes_dia_sin_cambios
  BEFORE UPDATE OR DELETE ON xecador_ajustes_dia
  FOR EACH ROW EXECUTE FUNCTION xecador_ajustes_dia_inmutable();
DROP TRIGGER IF EXISTS xecador_ajustes_dia_sin_truncate ON xecador_ajustes_dia;
CREATE TRIGGER xecador_ajustes_dia_sin_truncate
  BEFORE TRUNCATE ON xecador_ajustes_dia
  FOR EACH STATEMENT EXECUTE FUNCTION xecador_ajustes_dia_inmutable();
