-- 127 · Xecador, primer entregable: directorio de empleados con número.
--
-- Xecador es el módulo de asistencia dentro de Xabor. Esta migración solo
-- prepara el directorio: quién trabaja en el negocio y con qué número se
-- identifica. No hay horarios, reloj, PIN, huella, fotos ni multisucursal.
--
-- Cuatro cosas, todas aditivas:
--
--   1. 'personal' entra al CHECK de negocio_modulos. NO se inserta ninguna
--      fila: el módulo queda apagado para todos los negocios y solo el
--      Superadmin lo enciende, con el mecanismo de siempre
--      (PATCH /api/superadmin/negocios/:id/modulos).
--
--   2. xecador_numeros_empleado — el registro de cada número que el negocio
--      ha asignado alguna vez. Es lo que impide reutilizar un número: la llave
--      (negocio_id, numero) no se repite, y dos triggers rechazan UPDATE,
--      DELETE y TRUNCATE.
--      Dar de baja a alguien, o corregirle el número, NO libera el anterior.
--
--   3. xecador_empleados — el expediente. Su número tiene que estar
--      registrado A SU NOMBRE en xecador_numeros_empleado (llave foránea
--      compuesta con su propio id). Así, aunque alguien escribiera directo en
--      la base, un empleado no puede tomar el número que tuvo otro.
--
--   4. xecador_empleado_eventos — la bitácora del expediente: alta, cada
--      edición (valor anterior y nuevo), cada baja (fecha, motivo, autor) y
--      cada reactivación, con quién y cuándo. Solo inserción, como el registro
--      de números. Como referencia al expediente, un expediente con historia
--      tampoco se puede borrar.
--
-- La baja es lógica (estatus = 'baja'): la fila se conserva porque las
-- checadas y las prenóminas futuras apuntarán a ella. La fila dice el estado
-- ACTUAL; la historia completa (todas las bajas y reactivaciones, todos los
-- cambios de nombre) vive en la bitácora y no se borra.
--
-- ¿Por qué xecador_* y no personal_*? La rama local `personal/mvp` (nunca
-- desplegada desde una rama) traía sus migraciones 073/074 con tablas
-- personal_empleados, personal_checadas, etc., de OTRA forma (sueldo,
-- sucursal, PIN; sin número). Esas tablas existen en bases locales donde se
-- corrieron sus suites. Con un nombre propio esta migración es aditiva pase lo
-- que pase: no choca con ellas, no las lee y no las toca.

-- ── 1. El módulo existe para el sistema de módulos ──────────────────────────
-- Misma lista que dejó la 051 (última que tocó este CHECK) más 'personal'.
ALTER TABLE negocio_modulos DROP CONSTRAINT IF EXISTS negocio_modulos_modulo_check;
ALTER TABLE negocio_modulos ADD CONSTRAINT negocio_modulos_modulo_check CHECK (modulo = ANY (ARRAY[
  'pos', 'usuarios', 'caja', 'menu', 'impresion', 'whatsapp', 'voz', 'rappi',
  'facturacion', 'rewards', 'chat_imagenes', 'chat_documentos_pdf', 'cotizaciones',
  'generador_cotizaciones', 'pagos', 'repartidores', 'asistente_comercial_cotizaciones',
  'restaurante', 'tienda_online', 'personal'
]));

-- ── 2. Números asignados: solo inserción ────────────────────────────────────
-- empleado_id no lleva llave foránea a propósito: la referencia va en sentido
-- contrario (xecador_empleados → aquí), y una referencia circular obligaría a
-- restricciones diferidas sin ganar nada.
CREATE TABLE IF NOT EXISTS xecador_numeros_empleado (
  negocio_id   uuid        NOT NULL REFERENCES negocios(id) ON DELETE RESTRICT,
  numero       integer     NOT NULL CHECK (numero BETWEEN 1 AND 999999999),
  empleado_id  uuid        NOT NULL,
  creado_por   uuid        NULL,
  created_at   timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (negocio_id, numero),
  UNIQUE (negocio_id, numero, empleado_id)
);

-- Quién registró el número. Este registro es una bitácora de solo inserción,
-- así que su autor sigue el patrón de las bitácoras de Xabor
-- (auditoria_plataforma.superadmin_id en la 011, registrado_por en la 083):
-- ON DELETE RESTRICT. Un SET NULL sería un UPDATE sobre la fila y el trigger
-- de abajo lo rechazaría: borrar al usuario fallaría con un error que no dice
-- por qué. Con RESTRICT falla con la llave foránea, que sí lo dice, y lo que
-- corresponde en Xabor es desactivar al usuario (usuarios.activo = false),
-- no borrarlo. Se declara aparte (DROP + ADD) para que una base que traiga la
-- versión anterior con SET NULL converja al reaplicar.
ALTER TABLE xecador_numeros_empleado
  DROP CONSTRAINT IF EXISTS xecador_numeros_empleado_creado_por_fkey,
  ADD CONSTRAINT xecador_numeros_empleado_creado_por_fkey
    FOREIGN KEY (creado_por) REFERENCES usuarios(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_xecador_numeros_empleado
  ON xecador_numeros_empleado (negocio_id, empleado_id);

CREATE OR REPLACE FUNCTION xecador_numeros_empleado_inmutable() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'xecador_numeros_empleado es de solo inserción: un número de empleado no se libera ni se reasigna (operación %)', TG_OP
    USING ERRCODE = 'P0001';
END
$$;

DROP TRIGGER IF EXISTS xecador_numeros_empleado_sin_cambios ON xecador_numeros_empleado;
CREATE TRIGGER xecador_numeros_empleado_sin_cambios
  BEFORE UPDATE OR DELETE ON xecador_numeros_empleado
  FOR EACH ROW EXECUTE FUNCTION xecador_numeros_empleado_inmutable();

-- TRUNCATE no dispara triggers de fila: sin este, vaciar la tabla liberaría
-- todos los números de golpe. Dispara también con TRUNCATE ... CASCADE y
-- cuando la tabla va en una lista con otras. Misma función que el de arriba,
-- así la reversa (que borra la tabla y luego la función) no cambia.
-- Creado con DROP + CREATE para que una 127 aplicada antes de existir este
-- trigger lo reciba al reaplicarse (el predeploy-127 lo detecta y reaplica).
DROP TRIGGER IF EXISTS xecador_numeros_empleado_sin_truncate ON xecador_numeros_empleado;
CREATE TRIGGER xecador_numeros_empleado_sin_truncate
  BEFORE TRUNCATE ON xecador_numeros_empleado
  FOR EACH STATEMENT EXECUTE FUNCTION xecador_numeros_empleado_inmutable();

-- ── 3. Expediente del empleado ──────────────────────────────────────────────
-- Un empleado NO es un usuario: dar de alta a alguien de cocina no le crea una
-- cuenta de acceso. Solo lo indispensable para el directorio; sueldos,
-- horarios y sucursal llegan con sus propias etapas.
CREATE TABLE IF NOT EXISTS xecador_empleados (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id       uuid        NOT NULL REFERENCES negocios(id) ON DELETE RESTRICT,
  numero_empleado  integer     NOT NULL,
  nombre           text        NOT NULL CHECK (btrim(nombre) <> '' AND char_length(nombre) <= 120),
  puesto           text        NULL CHECK (puesto IS NULL OR char_length(puesto) <= 80),
  telefono         text        NULL CHECK (telefono IS NULL OR char_length(telefono) <= 30),
  estatus          text        NOT NULL DEFAULT 'activo' CHECK (estatus IN ('activo', 'baja')),
  baja_at          timestamptz NULL,
  baja_motivo      text        NULL CHECK (baja_motivo IS NULL OR char_length(baja_motivo) <= 200),
  baja_por         uuid        NULL REFERENCES usuarios(id) ON DELETE SET NULL,
  creado_por       uuid        NULL REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT NOW(),
  updated_at       timestamptz NOT NULL DEFAULT NOW(),
  -- Un número vivo por negocio, y además registrado a nombre de ESTE empleado.
  CONSTRAINT xecador_empleados_numero_unico UNIQUE (negocio_id, numero_empleado),
  CONSTRAINT xecador_empleados_numero_registrado
    FOREIGN KEY (negocio_id, numero_empleado, id)
    REFERENCES xecador_numeros_empleado (negocio_id, numero, empleado_id) ON DELETE RESTRICT,
  -- Para las llaves compuestas de las etapas siguientes (checadas, horarios):
  -- una checada del negocio A nunca podrá apuntar a un empleado de B.
  CONSTRAINT xecador_empleados_negocio_id_key UNIQUE (negocio_id, id),
  -- Baja y fecha de baja van juntas.
  CONSTRAINT xecador_empleados_baja_coherente CHECK ((estatus = 'baja') = (baja_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_xecador_empleados_negocio
  ON xecador_empleados (negocio_id, estatus, nombre);

DROP TRIGGER IF EXISTS set_updated_at ON xecador_empleados;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON xecador_empleados
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── 4. Bitácora del expediente: solo inserción ──────────────────────────────
-- Regla del dueño (4-nov-2026): corregir el nombre se permite, pero cada
-- cambio guarda quién, cuándo, el valor anterior y el nuevo; la baja conserva
-- su fecha, motivo y autor aunque la persona se reactive, y la reactivación es
-- otro evento. Una persona nueva recibe otro expediente y otro número: así, si
-- alguien le cambia el nombre a un expediente, queda escrito, no en silencio.
--
-- Referencia al expediente con la llave (negocio_id, id): un evento del
-- negocio A no puede apuntar a un empleado de B, y un expediente con historia
-- no se puede borrar (RESTRICT). actor_id sigue el patrón de las bitácoras de
-- Xabor (011, 083): RESTRICT, el autor se desactiva, no se borra.
CREATE TABLE IF NOT EXISTS xecador_empleado_eventos (
  id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  negocio_id   uuid        NOT NULL,
  empleado_id  uuid        NOT NULL,
  tipo         text        NOT NULL CHECK (tipo IN ('alta', 'edicion', 'baja', 'reactivacion')),
  -- { campo: { antes, despues } } en una edición; los valores iniciales en un alta.
  cambios      jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(cambios) = 'object'),
  motivo       text        NULL CHECK (motivo IS NULL OR char_length(motivo) <= 200),
  actor_id     uuid        NULL CONSTRAINT xecador_empleado_eventos_actor_fkey REFERENCES usuarios(id) ON DELETE RESTRICT,
  created_at   timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT xecador_empleado_eventos_empleado_fkey
    FOREIGN KEY (negocio_id, empleado_id) REFERENCES xecador_empleados (negocio_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_xecador_empleado_eventos
  ON xecador_empleado_eventos (negocio_id, empleado_id, id);

CREATE OR REPLACE FUNCTION xecador_empleado_eventos_inmutable() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'xecador_empleado_eventos es de solo inserción: la historia de un expediente no se borra ni se reescribe (operación %)', TG_OP
    USING ERRCODE = 'P0001';
END
$$;

DROP TRIGGER IF EXISTS xecador_empleado_eventos_sin_cambios ON xecador_empleado_eventos;
CREATE TRIGGER xecador_empleado_eventos_sin_cambios
  BEFORE UPDATE OR DELETE ON xecador_empleado_eventos
  FOR EACH ROW EXECUTE FUNCTION xecador_empleado_eventos_inmutable();

DROP TRIGGER IF EXISTS xecador_empleado_eventos_sin_truncate ON xecador_empleado_eventos;
CREATE TRIGGER xecador_empleado_eventos_sin_truncate
  BEFORE TRUNCATE ON xecador_empleado_eventos
  FOR EACH STATEMENT EXECUTE FUNCTION xecador_empleado_eventos_inmutable();
