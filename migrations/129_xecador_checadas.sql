-- 129 · Xecador, Parte B1: tablets autorizadas, checadas de solo inserción,
-- bloqueo temporal del PIN, avisos al administrador y foto opcional.
--
-- Aprobado por el dueño el 6-nov-2026. Necesita la 128 (PIN y sucursal del
-- expediente). Todo es aditivo: ninguna fila existente cambia de valor.
--
--   1. xecador_config — por negocio: «pedir foto al checar» (apagada al nacer).
--
--   2. xecador_dispositivos — cada tablet queda autorizada para UNA sucursal de
--      su negocio. El administrador genera un código de un solo uso (se guarda
--      solo su hash y vence); la tablet lo canjea por un token propio (también
--      solo su hash). Revocar la deja fuera. No se borra: las checadas la
--      referencian.
--
--   3. xecador_empleados gana el estado del bloqueo del PIN: fallos seguidos,
--      último fallo y «bloqueado hasta». El bloqueo es TEMPORAL (decisión del
--      dueño): nunca deja a alguien sin poder checar todo el turno.
--
--   4. xecador_checadas — entrada, salida, inicio y fin de descanso. SOLO
--      INSERCIÓN: un trigger rechaza UPDATE, DELETE y TRUNCATE (las correcciones
--      de la Parte B2 serán eventos nuevos que apuntan a la original). La hora
--      oficial la pone el servidor; la del dispositivo va aparte, solo como
--      referencia. Una clave por checada hace que un reintento no la duplique.
--
--   5. xecador_checada_fotos — la foto de una checada, si el negocio la pide.
--      También de solo inserción.
--
--   6. xecador_avisos — lo que el administrador tiene que ver: un PIN bloqueado,
--      una tablet en pausa por muchos intentos, un turno anterior sin salida.
--      Lo único que cambia en un aviso es que se marque como atendido.
--
-- Todas las llaves son compuestas con el negocio: una checada de un negocio no
-- puede apuntar a un empleado, sucursal o tablet de otro.

-- ── 1. Configuración del checador por negocio ──────────────────────────────
CREATE TABLE IF NOT EXISTS xecador_config (
  negocio_id      uuid        PRIMARY KEY REFERENCES negocios(id) ON DELETE RESTRICT,
  foto_al_checar  boolean     NOT NULL DEFAULT false,
  updated_at      timestamptz NOT NULL DEFAULT NOW(),
  updated_por     uuid        NULL REFERENCES usuarios(id) ON DELETE SET NULL
);

-- ── 2. Tablets autorizadas ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS xecador_dispositivos (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id        uuid        NOT NULL,
  sucursal_id       uuid        NOT NULL,
  nombre            text        NOT NULL CHECK (btrim(nombre) <> '' AND char_length(nombre) <= 60),
  codigo_hash       text        NULL,
  codigo_expira_at  timestamptz NULL,
  token_hash        text        NULL,
  creado_por        uuid        NULL REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT NOW(),
  vinculado_at      timestamptz NULL,
  ultimo_uso_at     timestamptz NULL,
  revocado_at       timestamptz NULL,
  revocado_por      uuid        NULL REFERENCES usuarios(id) ON DELETE SET NULL,
  CONSTRAINT xecador_dispositivos_negocio_id_key UNIQUE (negocio_id, id),
  CONSTRAINT xecador_dispositivos_token_unico UNIQUE (token_hash),
  CONSTRAINT xecador_dispositivos_sucursal_fkey
    FOREIGN KEY (sucursal_id, negocio_id) REFERENCES sucursales (id, negocio_id) ON DELETE RESTRICT,
  -- Un código sin vencimiento sería para siempre.
  CONSTRAINT xecador_dispositivos_codigo_vence CHECK (codigo_hash IS NULL OR codigo_expira_at IS NOT NULL),
  -- Un token existe solo en una tablet que canjeó su código.
  CONSTRAINT xecador_dispositivos_token_vinculado CHECK (token_hash IS NULL OR vinculado_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_xecador_dispositivos_codigo
  ON xecador_dispositivos (codigo_hash) WHERE codigo_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_xecador_dispositivos_negocio
  ON xecador_dispositivos (negocio_id, created_at DESC);

-- ── 3. Bloqueo temporal del PIN ────────────────────────────────────────────
ALTER TABLE xecador_empleados
  ADD COLUMN IF NOT EXISTS pin_fallos           integer     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pin_ultimo_fallo_at  timestamptz NULL,
  ADD COLUMN IF NOT EXISTS pin_bloqueado_hasta  timestamptz NULL;

ALTER TABLE xecador_empleados
  DROP CONSTRAINT IF EXISTS xecador_empleados_pin_fallos_check,
  ADD CONSTRAINT xecador_empleados_pin_fallos_check CHECK (pin_fallos >= 0);

-- ── 4. Checadas (solo inserción) ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS xecador_checadas (
  id                bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  negocio_id        uuid        NOT NULL,
  empleado_id       uuid        NOT NULL,
  sucursal_id       uuid        NOT NULL,
  dispositivo_id    uuid        NOT NULL,
  tipo              text        NOT NULL CHECK (tipo IN ('entrada', 'salida', 'inicio_descanso', 'fin_descanso')),
  hora_oficial      timestamptz NOT NULL DEFAULT NOW(),
  hora_dispositivo  timestamptz NULL,
  clave             uuid        NOT NULL,
  foto              text        NOT NULL DEFAULT 'no_requerida'
                                CHECK (foto IN ('no_requerida', 'tomada', 'no_disponible')),
  created_at        timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT xecador_checadas_negocio_id_key UNIQUE (negocio_id, id),
  CONSTRAINT xecador_checadas_clave_unica UNIQUE (negocio_id, clave),
  CONSTRAINT xecador_checadas_empleado_fkey
    FOREIGN KEY (negocio_id, empleado_id) REFERENCES xecador_empleados (negocio_id, id) ON DELETE RESTRICT,
  CONSTRAINT xecador_checadas_sucursal_fkey
    FOREIGN KEY (sucursal_id, negocio_id) REFERENCES sucursales (id, negocio_id) ON DELETE RESTRICT,
  CONSTRAINT xecador_checadas_dispositivo_fkey
    FOREIGN KEY (negocio_id, dispositivo_id) REFERENCES xecador_dispositivos (negocio_id, id) ON DELETE RESTRICT
);

-- La última checada de cada empleado (qué le toca ahora) y las de un día.
CREATE INDEX IF NOT EXISTS idx_xecador_checadas_empleado
  ON xecador_checadas (negocio_id, empleado_id, hora_oficial DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_xecador_checadas_dia
  ON xecador_checadas (negocio_id, hora_oficial);

-- ── 5. Fotos de checadas (solo inserción) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS xecador_checada_fotos (
  checada_id  bigint      PRIMARY KEY,
  negocio_id  uuid        NOT NULL,
  mime        text        NOT NULL CHECK (mime IN ('image/jpeg', 'image/webp')),
  datos       bytea       NOT NULL CHECK (octet_length(datos) BETWEEN 1 AND 204800),
  created_at  timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT xecador_checada_fotos_checada_fkey
    FOREIGN KEY (negocio_id, checada_id) REFERENCES xecador_checadas (negocio_id, id) ON DELETE RESTRICT
);

-- ── 6. Avisos al administrador ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS xecador_avisos (
  id              bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  negocio_id      uuid        NOT NULL REFERENCES negocios(id) ON DELETE RESTRICT,
  tipo            text        NOT NULL CHECK (tipo IN ('pin_bloqueado', 'dispositivo_pausado', 'turno_sin_cerrar')),
  empleado_id     uuid        NULL,
  dispositivo_id  uuid        NULL,
  detalle         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT NOW(),
  atendido_at     timestamptz NULL,
  atendido_por    uuid        NULL REFERENCES usuarios(id) ON DELETE SET NULL,
  CONSTRAINT xecador_avisos_empleado_fkey
    FOREIGN KEY (negocio_id, empleado_id) REFERENCES xecador_empleados (negocio_id, id) ON DELETE RESTRICT,
  CONSTRAINT xecador_avisos_dispositivo_fkey
    FOREIGN KEY (negocio_id, dispositivo_id) REFERENCES xecador_dispositivos (negocio_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_xecador_avisos_pendientes
  ON xecador_avisos (negocio_id, created_at DESC) WHERE atendido_at IS NULL;

-- ── Solo inserción: checadas y fotos ───────────────────────────────────────
CREATE OR REPLACE FUNCTION xecador_checadas_inmutable() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% es de solo inserción: una checada no se cambia ni se borra; se corrige con un evento nuevo (operación %)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'P0001';
END
$$;

DROP TRIGGER IF EXISTS xecador_checadas_sin_cambios ON xecador_checadas;
CREATE TRIGGER xecador_checadas_sin_cambios
  BEFORE UPDATE OR DELETE ON xecador_checadas
  FOR EACH ROW EXECUTE FUNCTION xecador_checadas_inmutable();
DROP TRIGGER IF EXISTS xecador_checadas_sin_truncate ON xecador_checadas;
CREATE TRIGGER xecador_checadas_sin_truncate
  BEFORE TRUNCATE ON xecador_checadas
  FOR EACH STATEMENT EXECUTE FUNCTION xecador_checadas_inmutable();

DROP TRIGGER IF EXISTS xecador_checada_fotos_sin_cambios ON xecador_checada_fotos;
CREATE TRIGGER xecador_checada_fotos_sin_cambios
  BEFORE UPDATE OR DELETE ON xecador_checada_fotos
  FOR EACH ROW EXECUTE FUNCTION xecador_checadas_inmutable();
DROP TRIGGER IF EXISTS xecador_checada_fotos_sin_truncate ON xecador_checada_fotos;
CREATE TRIGGER xecador_checada_fotos_sin_truncate
  BEFORE TRUNCATE ON xecador_checada_fotos
  FOR EACH STATEMENT EXECUTE FUNCTION xecador_checadas_inmutable();
