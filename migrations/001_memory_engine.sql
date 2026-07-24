-- ============================================================
-- XABOR Memory Engine — Migración 001
-- Ejecutar una vez en Railway PostgreSQL
-- ============================================================

-- ── Capa 1: Event Log (inmutable, append-only) ──────────────
CREATE TABLE IF NOT EXISTS eventos (
  evento_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id   TEXT NOT NULL DEFAULT 'xabor-principal',
  tipo_evento     TEXT NOT NULL,
  entidad_tipo    TEXT NOT NULL,         -- 'cliente', 'producto', 'conversacion', 'pedido'
  entidad_id      TEXT NOT NULL,         -- telefono, sku, folio, etc.
  payload         JSONB NOT NULL DEFAULT '{}',
  canal           TEXT,                  -- 'whatsapp', 'rappi', 'presencial', 'voz'
  sesion_id       TEXT,
  ocurrido_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_eventos_entidad   ON eventos (entidad_tipo, entidad_id);
CREATE INDEX IF NOT EXISTS idx_eventos_tipo      ON eventos (tipo_evento);
CREATE INDEX IF NOT EXISTS idx_eventos_ocurrido  ON eventos (ocurrido_at DESC);
CREATE INDEX IF NOT EXISTS idx_eventos_sesion    ON eventos (sesion_id) WHERE sesion_id IS NOT NULL;

-- ── Capa 2: Perfiles computados de clientes ─────────────────
CREATE TABLE IF NOT EXISTS perfiles_clientes (
  telefono                TEXT PRIMARY KEY REFERENCES clientes(telefono),
  restaurant_id           TEXT NOT NULL DEFAULT 'xabor-principal',

  -- Comportamiento de compra
  pedidos_total           INTEGER NOT NULL DEFAULT 0,
  ticket_promedio         NUMERIC(10,2),
  total_gastado           NUMERIC(10,2),
  dias_entre_compras_prom NUMERIC(6,1),
  ultimo_pedido_hace_dias INTEGER,

  -- Preferencias detectadas
  dia_favorito            TEXT,          -- 'lunes', 'viernes', etc.
  hora_favorita           INTEGER,       -- 0-23
  modalidad_favorita      TEXT,          -- 'domicilio', 'recoger', 'presencial'
  pago_favorito           TEXT,
  productos_favoritos     TEXT[],        -- top 3 productos

  -- Estado comercial
  segmento                TEXT NOT NULL DEFAULT 'nuevo',
  -- 'nuevo', 'frecuente', 'vip', 'en_riesgo', 'dormido', 'recuperado'

  score_abandono          NUMERIC(4,1),  -- 0-100: probabilidad de no volver
  acepta_promociones      BOOLEAN,       -- NULL = desconocido

  -- Metadatos
  ultima_actualizacion    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_perfiles_segmento ON perfiles_clientes (segmento);
CREATE INDEX IF NOT EXISTS idx_perfiles_score    ON perfiles_clientes (score_abandono DESC);

-- ── Capa 2: Oportunidades (conversaciones con intención sin cierre) ──
CREATE TABLE IF NOT EXISTS oportunidades (
  id                    SERIAL PRIMARY KEY,
  restaurant_id         TEXT NOT NULL DEFAULT 'xabor-principal',
  telefono              TEXT NOT NULL,
  sesion_id             TEXT,

  -- Estado comercial de la conversación
  estado                TEXT NOT NULL DEFAULT 'activa',
  -- 'activa', 'pendiente', 'recuperada', 'perdida', 'cerrada_con_venta'

  -- Señales detectadas
  intents_detectados    TEXT[] DEFAULT '{}',
  -- 'menu_solicitado', 'precio_consultado', 'pedido_iniciado', etc.
  valor_estimado        NUMERIC(10,2),

  -- Seguimiento
  seguimiento_enviado_at TIMESTAMPTZ,
  seguimiento_count      INTEGER NOT NULL DEFAULT 0,
  folio_pedido           TEXT,          -- si cerró con venta

  -- Timestamps
  primera_actividad_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ultima_actividad_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cerrada_at            TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_oportunidades_telefono ON oportunidades (telefono);
CREATE INDEX IF NOT EXISTS idx_oportunidades_estado   ON oportunidades (estado);
CREATE INDEX IF NOT EXISTS idx_oportunidades_sesion   ON oportunidades (sesion_id);
CREATE INDEX IF NOT EXISTS idx_oportunidades_pendientes ON oportunidades (ultima_actividad_at)
  WHERE estado = 'pendiente';
