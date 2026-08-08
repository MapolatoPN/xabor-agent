-- Reversa de 042. Segura en cualquier momento: la tabla solo contiene
-- enlaces de recuperación (artefactos transitorios, no historial contable) y
-- la columna solo guarda una marca de invalidación de sesiones.
--
-- Efecto de revertir: las sesiones que se habían invalidado al restablecer
-- una contraseña vuelven a aceptarse hasta su expiración natural (máximo
-- 12 h). Las contraseñas ya cambiadas NO se revierten — eso vive en
-- usuarios.password_hash y no lo toca esta migración.
BEGIN;

DROP INDEX IF EXISTS idx_password_reset_vigentes;
DROP INDEX IF EXISTS idx_password_reset_usuario;
DROP INDEX IF EXISTS idx_password_reset_token_hash;
DROP TABLE IF EXISTS password_reset_tokens;

ALTER TABLE usuarios DROP COLUMN IF EXISTS sesiones_invalidas_antes;

COMMIT;
