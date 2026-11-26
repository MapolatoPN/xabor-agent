-- 163 · Asistente del restaurante, Fase 1: los avisos de la campanita.
--
-- Pedido del dueño del 26-nov-2026 (plan aprobado). Cada mañana (entre las
-- 6:00 y las 12:00 de su hora) el servidor revisa las ventas de UNA sucursal
-- hasta el día anterior con reglas fijas (src/asistenteRestaurante/reglas.js),
-- elige hasta 3 hallazgos (primero los de control y calidad, luego por pesos
-- en juego) y los deja en la campanita.
-- Todavía sin inteligencia artificial.
--
-- Cuatro tablas, todas de UN negocio:
--   · corridas    — una por sucursal y día (UNIQUE): dos procesos a la vez no
--                   pueden correr el mismo día dos veces.
--   · hallazgos   — TODOS los candidatos de la corrida, elegidos o no, con su
--                   motivo: así se audita por qué salió uno y no otro.
--   · opiniones   — Útil / No útil / No avisar de esto, una por usuario.
--   · silenciados — lo que se pidió no volver a avisar.
-- Las llaves compuestas (negocio_id, id) impiden que un hallazgo cuelgue de
-- la corrida de otro negocio, o una opinión del hallazgo de otro.
--
-- Nunca guardan teléfonos, direcciones ni datos de pago: los clientes van por
-- nombre. Aditiva: tablas nuevas y vacías que el código anterior no lee; el
-- nuevo solo las usa en la sucursal con la bandera asistente_restaurante_v1
-- (tabla configuracion). La reversa es 163_asistente_restaurante_down.sql.

CREATE TABLE IF NOT EXISTS asistente_restaurante_corridas (
  id            bigserial PRIMARY KEY,
  negocio_id    uuid NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  -- El día local de la corrida (los datos llegan hasta el día anterior).
  fecha         date NOT NULL,
  -- 'ensayo': se calcula y se guarda, pero no se muestra a nadie.
  modo          text NOT NULL,
  estado        text NOT NULL DEFAULT 'corriendo',
  candidatos    integer NOT NULL DEFAULT 0,
  elegidos      integer NOT NULL DEFAULT 0,
  error         text,
  iniciada_en   timestamptz NOT NULL DEFAULT now(),
  terminada_en  timestamptz,
  UNIQUE (negocio_id, fecha),
  UNIQUE (negocio_id, id)
);
DO $$ BEGIN
  ALTER TABLE asistente_restaurante_corridas ADD CONSTRAINT asistente_restaurante_corridas_modo
    CHECK (modo IN ('ensayo', 'visible'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE asistente_restaurante_corridas ADD CONSTRAINT asistente_restaurante_corridas_estado
    CHECK (estado IN ('corriendo', 'lista', 'fallo'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS asistente_restaurante_hallazgos (
  id            bigserial PRIMARY KEY,
  negocio_id    uuid NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  corrida_id    bigint NOT NULL,
  tipo          text NOT NULL,
  -- «El mismo aviso» para no repetirlo (p. ej. producto_baja:<producto>).
  firma         text NOT NULL,
  -- Pesos en juego, para ordenar. 0 = informativo.
  impacto       numeric(14, 2) NOT NULL DEFAULT 0,
  titulo        text NOT NULL,
  -- { detalle, sugerencia, revisar, frecuencia }: lo que pinta el panel.
  contenido     jsonb NOT NULL DEFAULT '{}'::jsonb,
  elegido       boolean NOT NULL DEFAULT false,
  motivo        text,
  -- Elegido Y la corrida era visible: lo ve la campanita.
  mostrado      boolean NOT NULL DEFAULT false,
  creado_en     timestamptz NOT NULL DEFAULT now(),
  visto_en      timestamptz,
  visto_por     uuid REFERENCES usuarios(id) ON DELETE SET NULL,
  UNIQUE (negocio_id, id),
  FOREIGN KEY (negocio_id, corrida_id) REFERENCES asistente_restaurante_corridas (negocio_id, id) ON DELETE CASCADE
);
DO $$ BEGIN
  ALTER TABLE asistente_restaurante_hallazgos ADD CONSTRAINT asistente_restaurante_hallazgos_tipo
    CHECK (tipo ~ '^[a-z_]{3,40}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE asistente_restaurante_hallazgos ADD CONSTRAINT asistente_restaurante_hallazgos_contenido
    CHECK (jsonb_typeof(contenido) = 'object');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE asistente_restaurante_hallazgos ADD CONSTRAINT asistente_restaurante_hallazgos_mostrado
    CHECK (NOT mostrado OR elegido);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE asistente_restaurante_hallazgos ADD CONSTRAINT asistente_restaurante_hallazgos_visto
    CHECK (visto_por IS NULL OR visto_en IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- La campanita: lo mostrado de UN negocio, lo más nuevo primero.
CREATE INDEX IF NOT EXISTS asistente_restaurante_hallazgos_mostrados
  ON asistente_restaurante_hallazgos (negocio_id, creado_en DESC, id DESC) WHERE mostrado;
-- «¿Ya se mostró este aviso hace poco?»
CREATE INDEX IF NOT EXISTS asistente_restaurante_hallazgos_firma
  ON asistente_restaurante_hallazgos (negocio_id, firma, creado_en DESC) WHERE elegido;
CREATE INDEX IF NOT EXISTS asistente_restaurante_hallazgos_corrida
  ON asistente_restaurante_hallazgos (corrida_id);

CREATE TABLE IF NOT EXISTS asistente_restaurante_opiniones (
  id            bigserial PRIMARY KEY,
  negocio_id    uuid NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  hallazgo_id   bigint NOT NULL,
  usuario_id    uuid NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  opinion       text NOT NULL,
  -- Copiados del hallazgo: el ajuste por «No útil» se cuenta por tipo.
  tipo          text NOT NULL,
  firma         text NOT NULL,
  creado_en     timestamptz NOT NULL DEFAULT now(),
  actualizado_en timestamptz NOT NULL DEFAULT now(),
  UNIQUE (hallazgo_id, usuario_id),
  FOREIGN KEY (negocio_id, hallazgo_id) REFERENCES asistente_restaurante_hallazgos (negocio_id, id) ON DELETE CASCADE
);
DO $$ BEGIN
  ALTER TABLE asistente_restaurante_opiniones ADD CONSTRAINT asistente_restaurante_opiniones_opinion
    CHECK (opinion IN ('util', 'no_util', 'no_avisar'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS asistente_restaurante_opiniones_tipo
  ON asistente_restaurante_opiniones (negocio_id, tipo, opinion);

CREATE TABLE IF NOT EXISTS asistente_restaurante_silenciados (
  negocio_id    uuid NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  firma         text NOT NULL,
  usuario_id    uuid REFERENCES usuarios(id) ON DELETE SET NULL,
  creado_en     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (negocio_id, firma)
);
