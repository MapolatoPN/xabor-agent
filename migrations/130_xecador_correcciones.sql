-- 130 · Xecador, Parte B2: correcciones de checadas.
--
-- Aprobado por el dueño el 6-nov-2026. Necesita la 129. Todo es aditivo:
-- ninguna fila existente cambia de valor.
--
-- Una corrección es un EVENTO NUEVO que apunta a lo que corrige, con motivo
-- obligatorio, autor y fecha. La checada original no se toca nunca (es de solo
-- inserción desde la 129) y los reportes muestran las dos.
--
--   · agregar    una checada que faltó (por ejemplo, la salida que no se
--                registró). No apunta a nada; trae tipo y hora.
--   · modificar  otro tipo u otra hora para una checada (o para una agregada).
--   · anular     la checada no cuenta (un duplicado, un botón equivocado).
--   · restaurar  deshace una anulación: vuelve a contar como era.
--
-- Para cada checada (o agregada) manda la corrección MÁS RECIENTE. Una
-- corrección equivocada se corrige con otra: tampoco se borra ni se cambia.
--
-- Las llaves son compuestas con el negocio Y el empleado: una corrección no
-- puede apuntar a la checada de otra persona ni de otro negocio.

-- La checada se identifica también con su empleado (para esa llave).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'xecador_checadas_empleado_id_key') THEN
    ALTER TABLE xecador_checadas ADD CONSTRAINT xecador_checadas_empleado_id_key UNIQUE (negocio_id, empleado_id, id);
  END IF;
END $$;

-- La tabla trae solo sus columnas y su llave primaria; las demás reglas van
-- abajo, fuera del CREATE TABLE, para que una 130 a la que le falte alguna
-- converja al reaplicarse (un CREATE TABLE IF NOT EXISTS no toca una tabla que
-- ya existe).
CREATE TABLE IF NOT EXISTS xecador_correcciones (
  id                      bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  negocio_id              uuid        NOT NULL,
  empleado_id             uuid        NOT NULL,
  accion                  text        NOT NULL,
  objetivo_checada_id     bigint      NULL,
  objetivo_correccion_id  bigint      NULL,
  tipo                    text        NULL,
  hora                    timestamptz NULL,
  motivo                  text        NOT NULL,
  creado_por              uuid        NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT NOW()
);

-- La llave primaria y la única de la que depende la llave a sí misma: solo si
-- faltan (no se pueden soltar).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'xecador_correcciones_pkey') THEN
    ALTER TABLE xecador_correcciones ADD CONSTRAINT xecador_correcciones_pkey PRIMARY KEY (id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'xecador_correcciones_empleado_id_key') THEN
    ALTER TABLE xecador_correcciones ADD CONSTRAINT xecador_correcciones_empleado_id_key UNIQUE (negocio_id, empleado_id, id);
  END IF;
END $$;

-- CHECK y llaves foráneas: DROP + ADD con su nombre de siempre.
ALTER TABLE xecador_correcciones
  DROP CONSTRAINT IF EXISTS xecador_correcciones_accion_check,
  ADD CONSTRAINT xecador_correcciones_accion_check CHECK (accion IN ('agregar', 'modificar', 'anular', 'restaurar')),
  DROP CONSTRAINT IF EXISTS xecador_correcciones_tipo_check,
  ADD CONSTRAINT xecador_correcciones_tipo_check
    CHECK (tipo IS NULL OR tipo IN ('entrada', 'salida', 'inicio_descanso', 'fin_descanso')),
  DROP CONSTRAINT IF EXISTS xecador_correcciones_motivo_check,
  ADD CONSTRAINT xecador_correcciones_motivo_check CHECK (btrim(motivo) <> '' AND char_length(motivo) <= 300),
  DROP CONSTRAINT IF EXISTS xecador_correcciones_creado_por_fkey,
  ADD CONSTRAINT xecador_correcciones_creado_por_fkey FOREIGN KEY (creado_por) REFERENCES usuarios(id) ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS xecador_correcciones_empleado_fkey,
  ADD CONSTRAINT xecador_correcciones_empleado_fkey
    FOREIGN KEY (negocio_id, empleado_id) REFERENCES xecador_empleados (negocio_id, id) ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS xecador_correcciones_checada_fkey,
  ADD CONSTRAINT xecador_correcciones_checada_fkey
    FOREIGN KEY (negocio_id, empleado_id, objetivo_checada_id)
    REFERENCES xecador_checadas (negocio_id, empleado_id, id) ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS xecador_correcciones_objetivo_fkey,
  ADD CONSTRAINT xecador_correcciones_objetivo_fkey
    FOREIGN KEY (negocio_id, empleado_id, objetivo_correccion_id)
    REFERENCES xecador_correcciones (negocio_id, empleado_id, id) ON DELETE RESTRICT;

-- Cada acción con su forma: agregar no apunta a nada y trae tipo y hora;
-- modificar apunta a UNA cosa y trae tipo y hora; anular y restaurar apuntan a
-- una cosa y no traen ni tipo ni hora.
ALTER TABLE xecador_correcciones
  DROP CONSTRAINT IF EXISTS xecador_correcciones_forma,
  ADD CONSTRAINT xecador_correcciones_forma CHECK (
    (accion = 'agregar' AND objetivo_checada_id IS NULL AND objetivo_correccion_id IS NULL
       AND tipo IS NOT NULL AND hora IS NOT NULL)
    OR (accion = 'modificar' AND num_nonnulls(objetivo_checada_id, objetivo_correccion_id) = 1
       AND tipo IS NOT NULL AND hora IS NOT NULL)
    OR (accion IN ('anular', 'restaurar') AND num_nonnulls(objetivo_checada_id, objetivo_correccion_id) = 1
       AND tipo IS NULL AND hora IS NULL));

CREATE INDEX IF NOT EXISTS idx_xecador_correcciones_checada
  ON xecador_correcciones (negocio_id, objetivo_checada_id) WHERE objetivo_checada_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_xecador_correcciones_objetivo
  ON xecador_correcciones (negocio_id, objetivo_correccion_id) WHERE objetivo_correccion_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_xecador_correcciones_hora
  ON xecador_correcciones (negocio_id, empleado_id, hora) WHERE hora IS NOT NULL;

-- Solo inserción, y una corrección de otra corrección solo puede apuntar a
-- una checada AGREGADA (las de la tablet se corrigen apuntando a la checada).
CREATE OR REPLACE FUNCTION xecador_correcciones_inmutable() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'xecador_correcciones es de solo inserción: una corrección no se cambia ni se borra; se corrige con otra (operación %)', TG_OP
    USING ERRCODE = 'P0001';
END
$$;

CREATE OR REPLACE FUNCTION xecador_correcciones_objetivo_valido() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.objetivo_correccion_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM xecador_correcciones c
        WHERE c.id = NEW.objetivo_correccion_id AND c.negocio_id = NEW.negocio_id AND c.accion = 'agregar') THEN
    RAISE EXCEPTION 'Una corrección solo puede apuntar a una checada agregada, no a otra corrección'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS xecador_correcciones_sin_cambios ON xecador_correcciones;
CREATE TRIGGER xecador_correcciones_sin_cambios
  BEFORE UPDATE OR DELETE ON xecador_correcciones
  FOR EACH ROW EXECUTE FUNCTION xecador_correcciones_inmutable();
DROP TRIGGER IF EXISTS xecador_correcciones_sin_truncate ON xecador_correcciones;
CREATE TRIGGER xecador_correcciones_sin_truncate
  BEFORE TRUNCATE ON xecador_correcciones
  FOR EACH STATEMENT EXECUTE FUNCTION xecador_correcciones_inmutable();
DROP TRIGGER IF EXISTS xecador_correcciones_objetivo ON xecador_correcciones;
CREATE TRIGGER xecador_correcciones_objetivo
  BEFORE INSERT ON xecador_correcciones
  FOR EACH ROW EXECUTE FUNCTION xecador_correcciones_objetivo_valido();
