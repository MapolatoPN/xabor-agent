-- 143 · Saneamiento de Clientes, fase 1: lo que bloquea la primera campaña.
--
-- Pedido de Mario del 21-nov-2026 (prompt maestro de Clientes, Campañas y
-- Rewards, «sí, con tus recomendaciones»):
--
--   · Teléfonos del negocio: los WhatsApp de cada sucursal y los que el
--     administrador agregue. Nunca reciben una campaña, no cuentan en los
--     segmentos y un pedido capturado con uno de ellos no crea un cliente.
--   · Marca «interno / empresa» por cliente y por negocio: lo saca de
--     segmentos, de VIP y de campañas.
--   · Bitácora de esos dos cambios: quién, cuándo, antes y después.
--   · Campañas por tandas: tope de envíos en 24 h y pausa automática si los
--     rechazos pasan un umbral. Reanudar es explícito.
--   · La baja de promociones (botón de la plantilla o 131050 de Meta) se
--     guarda en el cliente: campana_envios sabe a qué cliente se mandó y si
--     su baja ya se anotó, y un cursor recorre los mensajes entrantes.
--
-- Aditiva: tablas nuevas y vacías; columnas NULL o con un valor constante
-- (no reescriben la tabla); reglas sobre columnas nuevas, que en las filas
-- existentes valen NULL. Nada de lo que ya existe cambia de valor. El código
-- anterior no lee nada de esto.

-- ── Teléfonos del negocio ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS negocio_telefonos_propios (
  id          bigserial PRIMARY KEY,
  negocio_id  uuid NOT NULL REFERENCES negocios(id) ON DELETE RESTRICT,
  -- Siempre los últimos 10 dígitos, como clientes_negocio.telefono.
  telefono    text NOT NULL,
  etiqueta    text,
  -- 'whatsapp': el número conectado del negocio (lo da Meta). 'manual': lo
  -- agregó el administrador.
  origen      text NOT NULL,
  -- Nunca se borra: se desactiva (y queda en la bitácora).
  activo      boolean NOT NULL DEFAULT true,
  creado_por  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT negocio_telefonos_propios_unico UNIQUE (negocio_id, telefono),
  CONSTRAINT negocio_telefonos_propios_telefono_10 CHECK (telefono ~ '^[0-9]{10}$'),
  CONSTRAINT negocio_telefonos_propios_origen CHECK (origen IN ('whatsapp', 'manual'))
);

-- ── Interno / empresa ─────────────────────────────────────────────────────
ALTER TABLE clientes_negocio
  ADD COLUMN IF NOT EXISTS es_interno boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS interno_motivo text,
  ADD COLUMN IF NOT EXISTS interno_at timestamptz,
  ADD COLUMN IF NOT EXISTS interno_por text;

-- ── Bitácora ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clientes_bitacora (
  id          bigserial PRIMARY KEY,
  negocio_id  uuid NOT NULL REFERENCES negocios(id) ON DELETE RESTRICT,
  entidad     text NOT NULL,
  entidad_id  text NOT NULL,
  accion      text NOT NULL,
  antes       jsonb,
  despues     jsonb,
  ejecutor    text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT clientes_bitacora_entidad CHECK (entidad IN ('cliente', 'telefono_negocio'))
);
CREATE INDEX IF NOT EXISTS clientes_bitacora_por_entidad
  ON clientes_bitacora (negocio_id, entidad, entidad_id, created_at DESC);

-- ── Campañas por tandas ───────────────────────────────────────────────────
ALTER TABLE campanas
  -- Máximo de envíos en 24 h (ventana móvil, como el límite de Meta).
  ADD COLUMN IF NOT EXISTS tope_24h integer,
  -- Si los rechazos pasan este porcentaje, la campaña se pausa sola.
  ADD COLUMN IF NOT EXISTS umbral_rechazo_pct integer,
  ADD COLUMN IF NOT EXISTS pausada_at timestamptz,
  ADD COLUMN IF NOT EXISTS pausada_motivo text,
  -- Al reanudar, el umbral se mide solo sobre lo que sale desde aquí.
  ADD COLUMN IF NOT EXISTS reanudada_at timestamptz;

ALTER TABLE campanas
  DROP CONSTRAINT IF EXISTS campanas_tope_24h_check,
  ADD CONSTRAINT campanas_tope_24h_check CHECK (tope_24h IS NULL OR tope_24h BETWEEN 1 AND 100000),
  DROP CONSTRAINT IF EXISTS campanas_umbral_rechazo_check,
  ADD CONSTRAINT campanas_umbral_rechazo_check CHECK (umbral_rechazo_pct IS NULL OR umbral_rechazo_pct BETWEEN 1 AND 100);

ALTER TABLE campana_envios
  -- El cliente de la Lista (clientes_negocio.id) al que se le mandó.
  ADD COLUMN IF NOT EXISTS cliente_id uuid,
  -- Cuándo se anotó su baja en cliente_consentimientos (una sola vez).
  ADD COLUMN IF NOT EXISTS baja_at timestamptz;

CREATE INDEX IF NOT EXISTS campana_envios_baja_pendiente
  ON campana_envios (campana_id) WHERE error_codigo = 131050 AND baja_at IS NULL;

-- Hasta qué mensaje entrante (whatsapp_entradas.id) ya se buscaron toques del
-- botón de baja. Recorrer por id usa la llave primaria: nunca la tabla entera.
CREATE TABLE IF NOT EXISTS campanas_wa_cursor (
  nombre      text PRIMARY KEY,
  ultimo_id   bigint NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
