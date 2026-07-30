-- ============================================================
-- XABOR Multiempresa — Migración 011 (LOCAL, no aplicada en producción)
-- Superadmin de plataforma: negocios.estado/plan/checklist, módulos por
-- negocio, y tabla de auditoría de acciones de plataforma.
-- Aditiva únicamente -- no borra ni reinterpreta ninguna columna existente.
-- Reejecutable.
-- ============================================================

-- ── Superadmin: tabla separada, NO columna en usuarios ──────────────────
-- Decisión de arquitectura (ver reporte de esta tarea): una tabla separada
-- da una garantía estructural más fuerte que una columna en `usuarios`.
-- Ningún endpoint del panel de negocio (todo lo que cuelga de
-- resolverNegocioSeguro/requireAdminSeguro) toca jamás esta tabla -- no hay
-- ni una sola línea de código en las rutas /api/admin/* ni /api/auth/* que
-- la lea o escriba. Compárese con una columna es_superadmin en `usuarios`:
-- viviría en la MISMA tabla que ya tocan crearUsuarioConPassword,
-- obtenerUsuariosDeNegocio, etc. -- nada te protege de que un cambio futuro
-- ahí exponga o modifique el campo por accidente. Con tabla separada, ese
-- riesgo es cero por construcción, no por disciplina.
-- usuario_id UNIQUE: cada persona es superadmin como máximo una vez.
-- ON DELETE RESTRICT: coherente con el resto del esquema -- no se borra
-- físicamente a un usuario que sea superadmin.
CREATE TABLE IF NOT EXISTS administradores_plataforma (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id  UUID NOT NULL UNIQUE REFERENCES usuarios(id) ON DELETE RESTRICT,
  activo      BOOLEAN NOT NULL DEFAULT true,
  notas       TEXT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_administradores_plataforma_activo ON administradores_plataforma (activo);

DROP TRIGGER IF EXISTS set_updated_at ON administradores_plataforma;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON administradores_plataforma
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── negocios: estado/plan/checklist ──────────────────────────────────────
-- estado es DESCRIPTIVO -- negocios.activo (ya existente, migración 003)
-- sigue siendo la ÚNICA columna que el control de acceso real usa
-- (obtenerMembresiaUsuarioNegocio, login, WS, etc. -- CERO cambios ahí).
-- El backend de superadmin mantiene la invariante: estado='activo' implica
-- activo=true; 'pendiente'/'suspendido' implica activo=false. Nunca al
-- revés -- así ningún código existente necesita enterarse de que `estado`
-- existe para seguir funcionando exactamente igual que hoy.
ALTER TABLE negocios ADD COLUMN IF NOT EXISTS estado TEXT NOT NULL DEFAULT 'activo';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'negocios_estado_check') THEN
    ALTER TABLE negocios ADD CONSTRAINT negocios_estado_check CHECK (estado IN ('pendiente','activo','suspendido'));
  END IF;
END $$;

ALTER TABLE negocios ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'prueba';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'negocios_plan_check') THEN
    ALTER TABLE negocios ADD CONSTRAINT negocios_plan_check CHECK (plan IN ('prueba','basico','pro','personalizado'));
  END IF;
END $$;

-- Checklist de instalación -- estructura fija y pequeña, JSONB en la propia
-- fila evita una tabla puente para 12 booleanos que siempre se leen/escriben
-- juntos por negocio (mismo criterio que configuracion usa key/value para
-- datos que SÍ varían en forma; aquí la forma es fija).
ALTER TABLE negocios ADD COLUMN IF NOT EXISTS checklist JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Backfill: todo negocio existente (Nonna Maye) ya está operando, así que
-- su estado real es 'activo' -- coincide con su activo=true actual, no lo
-- cambia. Nunca se infiere 'pendiente' ni 'suspendido' para datos ya reales.
UPDATE negocios SET estado = 'activo' WHERE activo = true AND estado = 'activo';
UPDATE negocios SET estado = 'suspendido' WHERE activo = false AND estado = 'activo';

-- ── Módulos habilitados por negocio ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS negocio_modulos (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id  UUID NOT NULL REFERENCES negocios(id) ON DELETE RESTRICT,
  modulo      TEXT NOT NULL CHECK (modulo IN ('pos','usuarios','caja','menu','impresion','whatsapp','voz','rappi','facturacion')),
  estado      TEXT NOT NULL DEFAULT 'no_configurado' CHECK (estado IN ('no_configurado','pendiente','configurado','activo','suspendido')),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (negocio_id, modulo)
);
CREATE INDEX IF NOT EXISTS idx_negocio_modulos_negocio ON negocio_modulos (negocio_id);

DROP TRIGGER IF EXISTS set_updated_at ON negocio_modulos;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON negocio_modulos
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Backfill: Nonna Maye ya opera con estos módulos en producción real.
INSERT INTO negocio_modulos (negocio_id, modulo, estado)
SELECT n.id, m.modulo, 'activo'
FROM negocios n
CROSS JOIN (VALUES ('pos'),('usuarios'),('caja'),('menu'),('impresion'),('whatsapp'),('voz'),('rappi')) AS m(modulo)
WHERE n.slug = 'nonna-maye'
ON CONFLICT (negocio_id, modulo) DO NOTHING;
INSERT INTO negocio_modulos (negocio_id, modulo, estado)
SELECT n.id, 'facturacion', 'configurado'
FROM negocios n WHERE n.slug = 'nonna-maye'
ON CONFLICT (negocio_id, modulo) DO NOTHING;

-- ── Auditoría de acciones de plataforma ──────────────────────────────────
-- superadmin_id: RESTRICT -- no se borra físicamente a un superadmin con
-- historial de auditoría. negocio_id/usuario_id: SET NULL -- la fila de
-- auditoría debe sobrevivir aunque el negocio o usuario referido cambien;
-- el contexto JSONB conserva nombre/slug/email en el momento del evento.
CREATE TABLE IF NOT EXISTS auditoria_plataforma (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  superadmin_id     UUID NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
  accion            TEXT NOT NULL,
  negocio_id        UUID NULL REFERENCES negocios(id) ON DELETE SET NULL,
  usuario_id        UUID NULL REFERENCES usuarios(id) ON DELETE SET NULL,
  estado_anterior   JSONB NULL,
  estado_nuevo      JSONB NULL,
  contexto          JSONB NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_auditoria_plataforma_negocio ON auditoria_plataforma (negocio_id);
CREATE INDEX IF NOT EXISTS idx_auditoria_plataforma_created ON auditoria_plataforma (created_at DESC);
