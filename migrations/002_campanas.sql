-- ============================================================
-- XABOR Campañas WA — Migración 002
-- Ejecutar una vez en Railway PostgreSQL
-- ============================================================

-- ── Campañas (cabecera) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS campanas (
  id                  SERIAL PRIMARY KEY,
  restaurant_id       TEXT NOT NULL DEFAULT 'xabor-principal',
  nombre              TEXT NOT NULL,               -- ej: "Reactivación julio"
  segmento            TEXT NOT NULL,               -- 'todos','vip','frecuente','en_riesgo','dormido'
  mensaje             TEXT NOT NULL,               -- texto libre enviado por WA
  total_destinatarios INTEGER NOT NULL DEFAULT 0,
  enviados            INTEGER NOT NULL DEFAULT 0,
  fallidos            INTEGER NOT NULL DEFAULT 0,
  respondidos         INTEGER NOT NULL DEFAULT 0,  -- cuántos contestaron en 48h
  estado              TEXT NOT NULL DEFAULT 'pendiente',
  -- 'pendiente','enviando','completada','error'
  creada_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completada_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_campanas_estado    ON campanas (estado);
CREATE INDEX IF NOT EXISTS idx_campanas_creada    ON campanas (creada_at DESC);

-- ── Envíos individuales ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS campana_envios (
  id          SERIAL PRIMARY KEY,
  campana_id  INTEGER NOT NULL REFERENCES campanas(id) ON DELETE CASCADE,
  telefono    TEXT NOT NULL,
  nombre      TEXT,
  estado      TEXT NOT NULL DEFAULT 'pendiente',  -- 'enviado','fallido'
  enviado_at  TIMESTAMPTZ,
  respondio_at TIMESTAMPTZ                        -- primera respuesta post-envío (48h)
);

CREATE INDEX IF NOT EXISTS idx_campana_envios_campana   ON campana_envios (campana_id);
CREATE INDEX IF NOT EXISTS idx_campana_envios_telefono  ON campana_envios (telefono);
CREATE INDEX IF NOT EXISTS idx_campana_envios_estado    ON campana_envios (estado);
