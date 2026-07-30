-- ============================================================
-- XABOR Multiempresa — Migración 012 (LOCAL, no aplicada en producción)
-- Invitaciones de usuario: primer paso del flujo de creación segura de
-- contraseña para el primer administrador de un negocio nuevo.
-- Aditiva únicamente. Reejecutable.
-- ============================================================

-- usuario_id/negocio_id: CASCADE -- una invitación no tiene sentido sin su
-- usuario o su negocio (a diferencia de auditoria_plataforma, que SÍ debe
-- sobrevivir; una invitación es un artefacto transitorio, no un registro
-- histórico que deba conservarse si el usuario o negocio desaparecen).
-- created_by: RESTRICT -- no se borra físicamente a un superadmin que haya
-- emitido invitaciones (mismo criterio que auditoria_plataforma.superadmin_id).
-- token_hash: NUNCA el token en texto plano -- solo su SHA-256, mismo
-- mecanismo ya usado para terminales de impresión (migración 010).
CREATE TABLE IF NOT EXISTS invitaciones_usuario (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id   UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  negocio_id   UUID NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  tipo         TEXT NOT NULL DEFAULT 'crear_password_inicial' CHECK (tipo IN ('crear_password_inicial')),
  token_hash   TEXT NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  used_at      TIMESTAMPTZ NULL,
  revoked_at   TIMESTAMPTZ NULL,
  created_by   UUID NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- UNIQUE sobre el hash -- una colisión sería indistinguible de un intento de
-- reutilizar el hash de otro token; a 256 bits de entropía es astronómicamente
-- improbable, pero la constraint convierte "improbable" en "imposible sin error".
CREATE UNIQUE INDEX IF NOT EXISTS idx_invitaciones_token_hash ON invitaciones_usuario (token_hash);
CREATE INDEX IF NOT EXISTS idx_invitaciones_usuario ON invitaciones_usuario (usuario_id);
-- Índice parcial: solo las invitaciones todavía vigentes importan para las
-- búsquedas frecuentes (reenviar, validar) -- las usadas/revocadas quedan
-- como historial pero no se consultan por este camino.
CREATE INDEX IF NOT EXISTS idx_invitaciones_vigentes ON invitaciones_usuario (usuario_id) WHERE used_at IS NULL AND revoked_at IS NULL;

-- Sin backfill: no se genera ninguna invitación automáticamente para
-- usuarios ya existentes (incluida Alora) -- eso es una acción explícita
-- separada (POST /api/superadmin/negocios/:id/reenviar-invitacion),
-- nunca un efecto secundario silencioso de esta migración.
