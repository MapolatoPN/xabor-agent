-- ─── 080: Cliente canónico de la tienda en línea ──────────────────────────
-- Idempotente y re-ejecutable. Aditiva: no altera ni borra ninguna fila
-- existente, no mueve un solo punto de Rewards y no enciende nada para
-- ningún negocio.
--
-- QUÉ RESUELVE: hasta hoy la tienda no tenía sesión. La "identidad" del
-- cliente era el teléfono que él mismo tecleaba en cada compra, guardado en
-- el localStorage de su navegador. Rewards, a su vez, identificaba a la
-- persona por (telefono, tenant_id) -- y ese teléfono llega con formatos
-- distintos según el canal (10 dígitos por POS/tienda, con 52/521 por
-- WhatsApp), así que una misma persona podía tener dos cuentas.
--
-- `clientes` NO sirve como entidad canónica: su PK es el teléfono a nivel
-- GLOBAL (es la tabla de conversaciones de WhatsApp, anterior a la
-- multiempresa). Por eso nace `clientes_negocio`: UN cliente por
-- (negocio, teléfono normalizado a 10 dígitos). Rewards y los pedidos se
-- RELACIONAN con él; ninguno de los dos motores se reescribe.
--
-- Ejecutar con: psql "$CONN" -v ON_ERROR_STOP=1 -f 080_clientes_tienda.sql

-- ── Cliente por negocio ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clientes_negocio (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id        uuid NOT NULL REFERENCES negocios(id) ON DELETE RESTRICT,
  -- SIEMPRE los últimos 10 dígitos (normalizarTelefonoMX). Es la identidad.
  telefono          text NOT NULL,
  -- Cómo lo escribió la persona (o cómo venía en Rewards). Solo informativo.
  telefono_original text,
  nombre            text,
  -- Guardado ya normalizado (recortado y en minúsculas) por el servicio.
  email             text,
  -- 'tienda' (se registró él), 'rewards' (backfill de esta migración),
  -- 'checkout' (creado al comprar con sesión).
  origen            text NOT NULL DEFAULT 'tienda',
  ultima_compra_at  timestamptz,
  created_at        timestamptz NOT NULL DEFAULT NOW(),
  updated_at        timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (negocio_id, telefono),
  -- Para que las tablas hijas puedan llevar FK COMPUESTA (negocio_id, id):
  -- una dirección o sesión del negocio A jamás puede colgar de un cliente
  -- del negocio B, aunque un servicio futuro se equivoque.
  UNIQUE (negocio_id, id)
);
DO $$ BEGIN
  ALTER TABLE clientes_negocio ADD CONSTRAINT chk_cliente_telefono_10
    CHECK (telefono ~ '^[0-9]{10}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_clientes_negocio_email
  ON clientes_negocio (negocio_id, email) WHERE email IS NOT NULL;

-- ── Direcciones guardadas ─────────────────────────────────────────────────
-- Lo que se guarda aquí es la LIBRETA del cliente. Lo que viaja en un pedido
-- es una COPIA (datos->'cliente' en pedidos_activos): editar o borrar una
-- dirección hoy nunca cambia cómo se ve un pedido de hace seis meses.
CREATE TABLE IF NOT EXISTS cliente_direcciones (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id            uuid NOT NULL,
  cliente_id            uuid NOT NULL,
  alias                 text NOT NULL DEFAULT 'Casa',
  calle                 text NOT NULL,
  numero_exterior       text,
  numero_interior       text,
  colonia               text,
  codigo_postal         text,
  entre_calles          text,
  referencia            text,
  instrucciones_entrega text,
  -- Zona de reparto del negocio (reglas_atencion.zonas): es lo que decide el
  -- costo de envío, así que una dirección guardada tiene que recordarla.
  zona                  text,
  latitud               numeric(9,6),
  longitud              numeric(9,6),
  predeterminada        boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT NOW(),
  updated_at            timestamptz NOT NULL DEFAULT NOW(),
  FOREIGN KEY (negocio_id, cliente_id) REFERENCES clientes_negocio (negocio_id, id) ON DELETE CASCADE
);
DO $$ BEGIN
  ALTER TABLE cliente_direcciones ADD CONSTRAINT chk_direccion_alias
    CHECK (alias IN ('Casa', 'Trabajo', 'Otro'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE cliente_direcciones ADD CONSTRAINT chk_direccion_coordenadas
    CHECK ((latitud IS NULL AND longitud IS NULL)
        OR (latitud BETWEEN -90 AND 90 AND longitud BETWEEN -180 AND 180));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_cliente_direcciones_cliente
  ON cliente_direcciones (cliente_id, created_at);
-- Una sola predeterminada por cliente, garantizado por la base.
CREATE UNIQUE INDEX IF NOT EXISTS idx_cliente_direccion_predeterminada
  ON cliente_direcciones (cliente_id) WHERE predeterminada;

-- ── Códigos de acceso (OTP) ───────────────────────────────────────────────
-- Solo el HASH del código. Un código caduca, se usa una vez, admite pocos
-- intentos y el siguiente que se pide revoca al anterior.
CREATE TABLE IF NOT EXISTS cliente_otp (
  id           bigserial PRIMARY KEY,
  negocio_id   uuid NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  telefono     text NOT NULL,
  codigo_hash  text NOT NULL,
  canal        text NOT NULL DEFAULT 'dev',
  intentos     integer NOT NULL DEFAULT 0,
  expires_at   timestamptz NOT NULL,
  usado_at     timestamptz,
  revocado_at  timestamptz,
  ip           text,
  created_at   timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cliente_otp_vigente
  ON cliente_otp (negocio_id, telefono, created_at DESC);

-- ── Sesiones del cliente ──────────────────────────────────────────────────
-- Del lado del SERVIDOR (a diferencia de las sesiones del panel, que son
-- tokens firmados sin registro): cerrar sesión revoca de verdad, y una
-- sesión de 90 días se puede cortar sin esperar a que caduque. Solo se
-- guarda el hash del token; el token en claro vive en la cookie httpOnly.
CREATE TABLE IF NOT EXISTS cliente_sesiones (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id     uuid NOT NULL,
  cliente_id     uuid NOT NULL,
  token_hash     text NOT NULL UNIQUE,
  user_agent     text,
  ip             text,
  created_at     timestamptz NOT NULL DEFAULT NOW(),
  ultimo_uso_at  timestamptz NOT NULL DEFAULT NOW(),
  expires_at     timestamptz NOT NULL,
  revocada_at    timestamptz,
  FOREIGN KEY (negocio_id, cliente_id) REFERENCES clientes_negocio (negocio_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_cliente_sesiones_cliente ON cliente_sesiones (cliente_id);

-- ── Consentimientos ───────────────────────────────────────────────────────
-- Bitácora, no un flag: cada cambio deja fila con fecha y fuente. El estado
-- vigente es la fila más reciente por canal. Nace vacía: el checkout no
-- marca nada solo.
CREATE TABLE IF NOT EXISTS cliente_consentimientos (
  id          bigserial PRIMARY KEY,
  negocio_id  uuid NOT NULL,
  cliente_id  uuid NOT NULL,
  canal       text NOT NULL,
  otorgado    boolean NOT NULL,
  fuente      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT NOW(),
  FOREIGN KEY (negocio_id, cliente_id) REFERENCES clientes_negocio (negocio_id, id) ON DELETE CASCADE
);
DO $$ BEGIN
  ALTER TABLE cliente_consentimientos ADD CONSTRAINT chk_consentimiento_canal
    CHECK (canal IN ('whatsapp', 'email'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_cliente_consentimientos_cliente
  ON cliente_consentimientos (cliente_id, canal, created_at DESC);

-- ── Rewards se RELACIONA con el cliente (no se reescribe) ─────────────────
-- rewards_accounts conserva su identidad (telefono, tenant_id) y todo su
-- motor. Solo gana un puntero. ON DELETE SET NULL: borrar un cliente nunca
-- borra puntos.
ALTER TABLE rewards_accounts ADD COLUMN IF NOT EXISTS cliente_id uuid;
DO $$ BEGIN
  ALTER TABLE rewards_accounts ADD CONSTRAINT rewards_accounts_cliente_id_fkey
    FOREIGN KEY (cliente_id) REFERENCES clientes_negocio(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_rewards_accounts_cliente
  ON rewards_accounts (cliente_id) WHERE cliente_id IS NOT NULL;

-- ── El pedido recuerda a qué cliente pertenece ────────────────────────────
-- Columna nullable sin default: metadato instantáneo en Postgres, cero
-- reescritura de la tabla más caliente del sistema. Los pedidos de
-- invitado y todos los históricos quedan en NULL. El snapshot operativo
-- (nombre, teléfono, dirección) sigue viviendo en `datos` exactamente igual.
ALTER TABLE pedidos_activos ADD COLUMN IF NOT EXISTS cliente_id uuid;
DO $$ BEGIN
  ALTER TABLE pedidos_activos ADD CONSTRAINT pedidos_activos_cliente_id_fkey
    FOREIGN KEY (cliente_id) REFERENCES clientes_negocio(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_pedidos_activos_cliente
  ON pedidos_activos (negocio_id, cliente_id, created_at DESC) WHERE cliente_id IS NOT NULL;

-- ── Interruptor por tienda ────────────────────────────────────────────────
-- Nace APAGADO: ninguna tienda muestra "Iniciar sesión" por el hecho de
-- desplegar. Encenderlo es un acto explícito del negocio (mismo criterio
-- que rewards_config.canal_tienda en la 079).
ALTER TABLE tienda_config ADD COLUMN IF NOT EXISTS cuentas_clientes boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN tienda_config.cuentas_clientes IS
  'La tienda ofrece cuenta de cliente (OTP, direcciones guardadas, Rewards en Mi cuenta). Default FALSE: se enciende por negocio.';

-- ── Backfill idempotente: Rewards existente → Cliente ─────────────────────
-- 1) Un Cliente por (negocio, teléfono normalizado) a partir de cada cuenta
--    de Rewards cuyo tenant es un negocio real. Dos cuentas de la misma
--    persona con formato distinto (10 dígitos / 52… / 521…) producen UN solo
--    cliente. ON CONFLICT DO NOTHING: re-ejecutar no crea ni cambia nada.
--    Se excluyen los teléfonos sintéticos ('rappi-…', '—', cortos).
INSERT INTO clientes_negocio (negocio_id, telefono, telefono_original, nombre, origen, created_at)
SELECT DISTINCT ON (n.id, right(regexp_replace(ra.telefono, '\D', '', 'g'), 10))
       n.id,
       right(regexp_replace(ra.telefono, '\D', '', 'g'), 10),
       ra.telefono,
       COALESCE(NULLIF(trim(ra.nombre), ''), NULLIF(trim(c.nombre), '')),
       'rewards',
       COALESCE(ra.created_at, NOW())
  FROM rewards_accounts ra
  JOIN negocios n ON n.id::text = ra.tenant_id
  LEFT JOIN clientes c ON c.telefono = ra.telefono
 WHERE ra.telefono IS NOT NULL
   AND ra.telefono NOT LIKE 'rappi-%'
   AND length(regexp_replace(ra.telefono, '\D', '', 'g')) BETWEEN 10 AND 13
 -- Entre varias cuentas de la misma persona gana la que TIENE nombre, luego
 -- la que ya venía en 10 dígitos (el formato canónico), luego la más reciente.
 ORDER BY n.id, right(regexp_replace(ra.telefono, '\D', '', 'g'), 10),
          (NULLIF(trim(ra.nombre), '') IS NULL),
          (length(regexp_replace(ra.telefono, '\D', '', 'g')) <> 10),
          ra.updated_at DESC NULLS LAST
ON CONFLICT (negocio_id, telefono) DO NOTHING;

-- 2) Cada cuenta de Rewards apunta a su Cliente. NUNCA toca puntos_balance
--    ni movimientos: es un puntero. Solo las que aún no lo tienen.
UPDATE rewards_accounts ra
   SET cliente_id = c.id
  FROM clientes_negocio c
 WHERE ra.cliente_id IS NULL
   AND ra.telefono IS NOT NULL
   AND ra.telefono NOT LIKE 'rappi-%'
   AND length(regexp_replace(ra.telefono, '\D', '', 'g')) BETWEEN 10 AND 13
   AND c.negocio_id::text = ra.tenant_id
   AND c.telefono = right(regexp_replace(ra.telefono, '\D', '', 'g'), 10);
