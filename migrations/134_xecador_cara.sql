-- 134 · Xecador: PIN + cara (fase 1).
--
-- Pedido del dueño el 10-nov-2026. Los empleados firmaron el consentimiento
-- de reconocimiento facial y datos biométricos. Necesita la 132. Aditiva:
-- ninguna fila existente cambia de valor, y todo nace apagado.
--
-- Cómo funciona: el empleado sigue checando con su PIN. Si el negocio lo
-- enciende y el empleado tiene su cara registrada, la tablet toma unas fotos
-- (de frente y con un pequeño giro de la cabeza) y el servidor las compara
-- con la cara registrada. La checada se registra SIEMPRE: si la cara no
-- coincide, o no se pudo verificar, queda «para revisar». Nunca se pierde una
-- checada por la cámara.
--
-- Cinco cosas:
--
--   1. El consentimiento en el expediente: la fecha en que el empleado firmó
--      el consentimiento (xecador_empleados.consentimiento_cara_fecha). Sin
--      ella no se guarda su cara. Solo la tiene un empleado activo: con la
--      baja se retira sola.
--
--   2. xecador_caras: la cara registrada de cada empleado. Lo que se guarda
--      está cifrado (los vectores con que se compara y una foto de
--      referencia para que el administrador revise). Es la ÚNICA tabla de
--      Xecador que se borra: con la baja, al retirar el consentimiento o al
--      volver a registrar la cara. La base lo garantiza con triggers, sin
--      depender del código: no se puede guardar una cara sin consentimiento
--      o de un empleado de baja, y al retirar uno se borra la otra.
--
--   3. La bitácora del expediente gana dos tipos: 'consentimiento_cara'
--      (cuándo se registró o retiró) y 'cara' (cuándo se registró o borró).
--      Los borrados que hace la base también quedan escritos.
--
--   4. xecador_config.cara_al_checar: 'apagado' (como hoy, el valor de todos
--      los negocios) o 'confirmar' (PIN + cara).
--
--   5. Cada checada guarda cómo salió la cara: cara, cara_detalle y
--      cara_similitud (para medir los aciertos antes de decidir «solo cara»),
--      y dos motivos nuevos para revisar: 'cara_no_coincide' y
--      'cara_no_verificada'. El aviso 'cara_no_coincide' le llega al
--      administrador. Las columnas nacen con su valor por omisión: agregar
--      una columna no dispara los triggers de solo inserción de las checadas.

-- ── 1. Consentimiento en el expediente ──────────────────────────────────────
ALTER TABLE xecador_empleados ADD COLUMN IF NOT EXISTS consentimiento_cara_fecha date NULL;

-- Solo un empleado activo tiene consentimiento vigente, y la fecha es real.
-- El trigger de la sección 2 lo retira con la baja, en el mismo UPDATE.
ALTER TABLE xecador_empleados
  DROP CONSTRAINT IF EXISTS xecador_empleados_consentimiento_cara_check,
  ADD CONSTRAINT xecador_empleados_consentimiento_cara_check CHECK (
    consentimiento_cara_fecha IS NULL OR (estatus = 'activo' AND consentimiento_cara_fecha >= DATE '2020-01-01'));

-- ── 2. La cara registrada ───────────────────────────────────────────────────
-- Una por empleado. Volver a registrarla reemplaza la anterior.
--   modelo    con qué motor se calcularon los vectores; los de otro modelo no
--             sirven para comparar y hay que volver a registrar.
--   llave     huella (8 hex) de la llave con que se cifró. Si la llave del
--             servidor cambia, la cara queda sin usar y se vuelve a registrar.
--   vectores  cifrados: lo que el motor saca de cada foto buena del registro.
--   foto      cifrada: la mejor foto del registro, para revisar a mano.
CREATE TABLE IF NOT EXISTS xecador_caras (
  negocio_id   uuid        NOT NULL,
  empleado_id  uuid        NOT NULL,
  modelo       text        NOT NULL,
  llave        text        NOT NULL,
  vectores     bytea       NOT NULL,
  muestras     smallint    NOT NULL,
  foto         bytea       NOT NULL,
  foto_mime    text        NOT NULL,
  creado_por   uuid        NULL,
  created_at   timestamptz NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid
                  WHERE cl.relname = 'xecador_caras' AND c.conname = 'xecador_caras_pkey') THEN
    ALTER TABLE xecador_caras ADD CONSTRAINT xecador_caras_pkey PRIMARY KEY (negocio_id, empleado_id);
  END IF;
END $$;

-- La referencia al expediente con la llave (negocio_id, id): la cara de un
-- empleado del negocio A no puede quedar a nombre de uno de B.
ALTER TABLE xecador_caras
  DROP CONSTRAINT IF EXISTS xecador_caras_empleado_fkey,
  ADD CONSTRAINT xecador_caras_empleado_fkey
    FOREIGN KEY (negocio_id, empleado_id) REFERENCES xecador_empleados (negocio_id, id) ON DELETE CASCADE,
  DROP CONSTRAINT IF EXISTS xecador_caras_creado_por_fkey,
  ADD CONSTRAINT xecador_caras_creado_por_fkey FOREIGN KEY (creado_por) REFERENCES usuarios(id) ON DELETE SET NULL,
  DROP CONSTRAINT IF EXISTS xecador_caras_modelo_check,
  ADD CONSTRAINT xecador_caras_modelo_check CHECK (modelo ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  DROP CONSTRAINT IF EXISTS xecador_caras_llave_check,
  ADD CONSTRAINT xecador_caras_llave_check CHECK (llave ~ '^[0-9a-f]{8}$'),
  DROP CONSTRAINT IF EXISTS xecador_caras_muestras_check,
  ADD CONSTRAINT xecador_caras_muestras_check CHECK (muestras BETWEEN 1 AND 10),
  DROP CONSTRAINT IF EXISTS xecador_caras_vectores_check,
  ADD CONSTRAINT xecador_caras_vectores_check CHECK (octet_length(vectores) BETWEEN 1 AND 65536),
  DROP CONSTRAINT IF EXISTS xecador_caras_foto_check,
  ADD CONSTRAINT xecador_caras_foto_check CHECK (octet_length(foto) BETWEEN 1 AND 262144),
  DROP CONSTRAINT IF EXISTS xecador_caras_foto_mime_check,
  ADD CONSTRAINT xecador_caras_foto_mime_check CHECK (foto_mime IN ('image/jpeg', 'image/webp'));

-- Sin consentimiento, o de un empleado de baja, la cara no se guarda. El
-- FOR SHARE espera a un retiro de consentimiento en curso: si se retiró, el
-- registro falla; si el registro llegó primero, el retiro la borra.
CREATE OR REPLACE FUNCTION xecador_caras_con_consentimiento() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM xecador_empleados e
    WHERE e.negocio_id = NEW.negocio_id AND e.id = NEW.empleado_id
      AND e.estatus = 'activo' AND e.consentimiento_cara_fecha IS NOT NULL
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sin el consentimiento firmado, o con el empleado de baja, no se guarda su cara'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS xecador_caras_consentimiento ON xecador_caras;
CREATE TRIGGER xecador_caras_consentimiento
  BEFORE INSERT OR UPDATE ON xecador_caras
  FOR EACH ROW EXECUTE FUNCTION xecador_caras_con_consentimiento();

-- Con la baja se retira el consentimiento, y sin consentimiento se borra la
-- cara. Las dos cosas quedan en la bitácora (sin autor: las hizo la base; el
-- autor de la baja o del retiro está en su propio evento).
CREATE OR REPLACE FUNCTION xecador_empleados_cara_al_cambiar() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  borradas integer;
BEGIN
  IF NEW.estatus IS DISTINCT FROM 'activo' AND NEW.consentimiento_cara_fecha IS NOT NULL THEN
    INSERT INTO xecador_empleado_eventos (negocio_id, empleado_id, tipo, cambios, motivo)
    VALUES (NEW.negocio_id, NEW.id, 'consentimiento_cara',
            jsonb_build_object('consentimiento_cara_fecha',
              jsonb_build_object('antes', to_char(NEW.consentimiento_cara_fecha, 'YYYY-MM-DD'), 'despues', NULL)),
            'Se retira con la baja');
    NEW.consentimiento_cara_fecha := NULL;
  END IF;
  IF NEW.consentimiento_cara_fecha IS NULL THEN
    DELETE FROM xecador_caras WHERE negocio_id = NEW.negocio_id AND empleado_id = NEW.id;
    GET DIAGNOSTICS borradas = ROW_COUNT;
    IF borradas > 0 THEN
      INSERT INTO xecador_empleado_eventos (negocio_id, empleado_id, tipo, cambios, motivo)
      VALUES (NEW.negocio_id, NEW.id, 'cara', '{"cara": {"antes": true, "despues": false}}'::jsonb,
              CASE WHEN NEW.estatus IS DISTINCT FROM 'activo' THEN 'Se borra con la baja'
                   ELSE 'Se borra al retirar el consentimiento' END);
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- Solo cuando hay un consentimiento que se va: los demás cambios del
-- expediente (los fallos del PIN, una edición) no lo disparan.
DROP TRIGGER IF EXISTS xecador_empleados_cara ON xecador_empleados;
CREATE TRIGGER xecador_empleados_cara
  BEFORE UPDATE ON xecador_empleados
  FOR EACH ROW
  WHEN (OLD.consentimiento_cara_fecha IS NOT NULL
        AND (NEW.consentimiento_cara_fecha IS NULL OR NEW.estatus IS DISTINCT FROM 'activo'))
  EXECUTE FUNCTION xecador_empleados_cara_al_cambiar();

-- ── 3. Bitácora del expediente ──────────────────────────────────────────────
-- Misma lista que dejó la 128 (última que tocó este CHECK) más los dos tipos.
ALTER TABLE xecador_empleado_eventos
  DROP CONSTRAINT IF EXISTS xecador_empleado_eventos_tipo_check,
  ADD CONSTRAINT xecador_empleado_eventos_tipo_check
    CHECK (tipo IN ('alta', 'edicion', 'baja', 'reactivacion', 'jornada', 'pin', 'consentimiento_cara', 'cara'));

-- ── 4. El interruptor por negocio ───────────────────────────────────────────
ALTER TABLE xecador_config ADD COLUMN IF NOT EXISTS cara_al_checar text NOT NULL DEFAULT 'apagado';
ALTER TABLE xecador_config
  DROP CONSTRAINT IF EXISTS xecador_config_cara_al_checar_check,
  ADD CONSTRAINT xecador_config_cara_al_checar_check CHECK (cara_al_checar IN ('apagado', 'confirmar'));

-- ── 5. Cómo salió la cara en cada checada ───────────────────────────────────
--   no_requerida   el negocio no lo pide (todas las checadas anteriores).
--   sin_registro   lo pide, pero el empleado no tiene su cara registrada.
--   coincide       la cara coincide y la cabeza se movió.
--   no_coincide    la cara no coincide: para revisar, con aviso.
--   no_verificada  no se pudo comparar (cara_detalle dice por qué): para revisar.
ALTER TABLE xecador_checadas
  ADD COLUMN IF NOT EXISTS cara            text NOT NULL DEFAULT 'no_requerida',
  ADD COLUMN IF NOT EXISTS cara_detalle    text NULL,
  ADD COLUMN IF NOT EXISTS cara_similitud  real NULL;

ALTER TABLE xecador_checadas
  DROP CONSTRAINT IF EXISTS xecador_checadas_cara_check,
  ADD CONSTRAINT xecador_checadas_cara_check
    CHECK (cara IN ('no_requerida', 'sin_registro', 'coincide', 'no_coincide', 'no_verificada')),
  DROP CONSTRAINT IF EXISTS xecador_checadas_cara_detalle_check,
  ADD CONSTRAINT xecador_checadas_cara_detalle_check CHECK (
    (cara = 'no_verificada') = (cara_detalle IS NOT NULL)
    AND (cara_detalle IS NULL OR cara_detalle IN ('sin_camara', 'sin_cara', 'varias_caras', 'de_lado', 'sin_giro', 'motor'))),
  DROP CONSTRAINT IF EXISTS xecador_checadas_cara_similitud_check,
  ADD CONSTRAINT xecador_checadas_cara_similitud_check CHECK (cara_similitud IS NULL OR cara_similitud BETWEEN -1 AND 1),
  -- La lista de la 131 más los dos motivos de la cara.
  DROP CONSTRAINT IF EXISTS xecador_checadas_revision_check,
  ADD CONSTRAINT xecador_checadas_revision_check CHECK (revision <@ ARRAY[
    'reloj_desfasado', 'sin_referencia', 'pin_no_valido', 'otra_sucursal', 'empleado_de_baja', 'ip_distinta',
    'cara_no_coincide', 'cara_no_verificada']::text[]);

-- La lista de la 129 más el aviso de la cara.
ALTER TABLE xecador_avisos
  DROP CONSTRAINT IF EXISTS xecador_avisos_tipo_check,
  ADD CONSTRAINT xecador_avisos_tipo_check CHECK (tipo IN ('pin_bloqueado', 'dispositivo_pausado', 'turno_sin_cerrar',
    'pin_no_valido', 'checada_sin_empleado', 'cara_no_coincide'));
