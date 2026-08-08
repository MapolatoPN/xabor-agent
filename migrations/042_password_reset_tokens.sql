-- ============================================================
-- XABOR — Migración 042: recuperación de contraseña
--
-- Un administrador o staff que olvida su contraseña hoy no tiene salida:
-- las invitaciones (012) solo sirven para la contraseña INICIAL y las emite
-- un superadmin. Esta migración agrega el soporte para "¿Olvidaste tu
-- contraseña?" reutilizando exactamente el mismo mecanismo ya probado en
-- invitaciones_usuario: token aleatorio de 256 bits, del que la base guarda
-- ÚNICAMENTE su SHA-256.
--
-- Aditiva y reejecutable. No toca ninguna fila existente.
-- ============================================================

-- usuario_id: CASCADE — un token de recuperación no tiene sentido sin su
-- usuario y no es un registro histórico que deba sobrevivir (a diferencia de
-- auditoria_plataforma).
--
-- Sin negocio_id a propósito: la recuperación es sobre la IDENTIDAD, no
-- sobre un negocio. El mismo correo puede pertenecer a varios negocios y su
-- contraseña es una sola; amarrar el token a un tenant obligaría a elegir
-- uno arbitrariamente y dejaría al usuario sin poder entrar a los demás.
-- Los permisos por negocio siguen viviendo en usuario_negocios y se
-- verifican al iniciar sesión, como siempre.
--
-- token_hash: NUNCA el token en claro. Quien lea la base no puede
-- reconstruir ningún enlace enviado por correo.
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id   UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  used_at      TIMESTAMPTZ NULL,
  revoked_at   TIMESTAMPTZ NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- UNIQUE sobre el hash — mismo criterio que invitaciones_usuario: a 256 bits
-- una colisión es astronómicamente improbable, y la constraint la vuelve
-- imposible sin error.
CREATE UNIQUE INDEX IF NOT EXISTS idx_password_reset_token_hash ON password_reset_tokens (token_hash);
CREATE INDEX IF NOT EXISTS idx_password_reset_usuario ON password_reset_tokens (usuario_id);
-- Solo los vigentes se consultan de forma frecuente (al pedir uno nuevo hay
-- que revocar los anteriores); los usados quedan como historial.
CREATE INDEX IF NOT EXISTS idx_password_reset_vigentes
  ON password_reset_tokens (usuario_id) WHERE used_at IS NULL AND revoked_at IS NULL;

-- Revocación de sesiones abiertas al cambiar la contraseña.
--
-- Las sesiones de Xabor son tokens firmados sin registro server-side (ver
-- src/services/session.js), así que no existe una lista de sesiones vivas
-- que se pueda borrar. En vez de inventar un sistema de sesiones nuevo se
-- guarda una marca de tiempo por usuario: cualquier token emitido ANTES de
-- ella deja de aceptarse. La comprobación va dentro de la consulta de
-- membresía que ya se hace en cada request, así que no agrega consultas.
--
-- NULL (el valor para todos los usuarios existentes) significa "nada que
-- invalidar": el comportamiento actual no cambia para nadie.
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS sesiones_invalidas_antes TIMESTAMPTZ NULL;

COMMENT ON TABLE password_reset_tokens IS
  'Enlaces de "olvidé mi contraseña": un solo uso, expiración corta, solo el hash del token.';
COMMENT ON COLUMN usuarios.sesiones_invalidas_antes IS
  'Las sesiones emitidas antes de esta marca se rechazan (se fija al restablecer la contraseña).';
