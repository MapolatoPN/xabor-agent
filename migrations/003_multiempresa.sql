-- ============================================================
-- XABOR Multiempresa — Migración 003 (estructura base)
-- Ejecutar una vez en Railway PostgreSQL
-- No modifica tablas existentes. No agrega negocio_id a pedidos,
-- clientes, menú, caja ni ninguna otra tabla existente.
-- ============================================================

-- ── Negocios ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS negocios (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre      TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  activo      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_negocios_activo ON negocios (activo);

-- ── Sucursales ───────────────────────────────────────────────
-- negocio_id: RESTRICT — un negocio con sucursales no puede
-- eliminarse físicamente; se desactiva con activo = false.
CREATE TABLE IF NOT EXISTS sucursales (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id  UUID NOT NULL REFERENCES negocios(id) ON DELETE RESTRICT,
  nombre      TEXT NOT NULL,
  activo      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (negocio_id, nombre)
);

CREATE INDEX IF NOT EXISTS idx_sucursales_negocio ON sucursales (negocio_id);
CREATE INDEX IF NOT EXISTS idx_sucursales_activo  ON sucursales (activo);

-- ── Terminales ───────────────────────────────────────────────
-- sucursal_id: CASCADE — una terminal no tiene significado propio
-- sin su sucursal.
-- codigo: identificador estable (p. ej. para emparejar hardware/POS),
-- independiente de nombre, que es solo la etiqueta visible.
CREATE TABLE IF NOT EXISTS terminales (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sucursal_id  UUID NOT NULL REFERENCES sucursales(id) ON DELETE CASCADE,
  nombre       TEXT NOT NULL,
  codigo       TEXT NOT NULL,
  activo       BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (sucursal_id, nombre),
  UNIQUE (sucursal_id, codigo)
);

CREATE INDEX IF NOT EXISTS idx_terminales_sucursal ON terminales (sucursal_id);
CREATE INDEX IF NOT EXISTS idx_terminales_activo   ON terminales (activo);

-- ── Usuarios ─────────────────────────────────────────────────
-- Estructura base únicamente. No incluye password_hash, rol ni JWT:
-- eso corresponde a una migración separada de autenticación.
-- negocio_id: RESTRICT — un negocio con usuarios no puede
-- eliminarse físicamente; se desactiva con activo = false.
CREATE TABLE IF NOT EXISTS usuarios (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id  UUID NOT NULL REFERENCES negocios(id) ON DELETE RESTRICT,
  nombre      TEXT NOT NULL,
  email       TEXT NOT NULL,
  activo      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (negocio_id, email)
);

CREATE INDEX IF NOT EXISTS idx_usuarios_negocio ON usuarios (negocio_id);
CREATE INDEX IF NOT EXISTS idx_usuarios_activo  ON usuarios (activo);

-- ── Usuario × Sucursales (acceso a una o varias sucursales) ──
-- usuario_id / sucursal_id: CASCADE — es una tabla puente; sin el
-- usuario o la sucursal, el registro de acceso no tiene sentido.
CREATE TABLE IF NOT EXISTS usuario_sucursales (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id   UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  sucursal_id  UUID NOT NULL REFERENCES sucursales(id) ON DELETE CASCADE,
  activo       BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (usuario_id, sucursal_id)
);

CREATE INDEX IF NOT EXISTS idx_usuario_sucursales_usuario  ON usuario_sucursales (usuario_id);
CREATE INDEX IF NOT EXISTS idx_usuario_sucursales_sucursal ON usuario_sucursales (sucursal_id);

-- ── Trigger genérico: mantiene updated_at al editar cualquier fila ──
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_updated_at ON negocios;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON negocios
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at ON sucursales;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON sucursales
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at ON terminales;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON terminales
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at ON usuarios;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON usuarios
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at ON usuario_sucursales;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON usuario_sucursales
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
