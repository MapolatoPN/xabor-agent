-- ============================================================
-- XABOR Multiempresa Fase 2 — Migración 005
-- Relación formal usuario ↔ negocio (muchos a muchos), con rol.
-- Requiere que 003_multiempresa.sql ya esté aplicada (tabla usuarios).
-- No modifica usuarios, negocios ni ninguna otra tabla existente —
-- usuarios.negocio_id se conserva intacto como referencia legada.
-- Reejecutable.
-- ============================================================

-- ── usuario_negocios ────────────────────────────────────────────
-- usuario_id: CASCADE — sin el usuario, la membresía no tiene sentido.
-- negocio_id: RESTRICT — mismo criterio que el resto del esquema
-- multiempresa: un negocio con usuarios asignados no se borra
-- físicamente, se desactiva.
CREATE TABLE IF NOT EXISTS usuario_negocios (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id  UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  negocio_id  UUID NOT NULL REFERENCES negocios(id) ON DELETE RESTRICT,
  rol         TEXT NOT NULL DEFAULT 'staff',
  activo      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (usuario_id, negocio_id)
);

CREATE INDEX IF NOT EXISTS idx_usuario_negocios_usuario ON usuario_negocios (usuario_id);
CREATE INDEX IF NOT EXISTS idx_usuario_negocios_negocio ON usuario_negocios (negocio_id);
CREATE INDEX IF NOT EXISTS idx_usuario_negocios_activo  ON usuario_negocios (activo);

-- Trigger updated_at — reutiliza set_updated_at() ya creada en 003.
DROP TRIGGER IF EXISTS set_updated_at ON usuario_negocios;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON usuario_negocios
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Backfill ──────────────────────────────────────────────────
-- Todo usuario existente ya pertenece a exactamente un negocio via
-- usuarios.negocio_id. Se replica esa membresía aquí como rol 'admin'
-- (son los únicos usuarios creados hasta ahora, asumidos como dueños
-- de su negocio). Idempotente: solo inserta lo que falte.
INSERT INTO usuario_negocios (usuario_id, negocio_id, rol)
SELECT u.id, u.negocio_id, 'admin'
FROM usuarios u
ON CONFLICT (usuario_id, negocio_id) DO NOTHING;
