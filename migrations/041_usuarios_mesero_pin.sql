-- 041 — Usuarios tipo MESERO con acceso local por PIN.
--
-- Por qué hace falta migración: usuarios.email es NOT NULL desde 003 y
-- UNIQUE global desde 006. Un mesero de piso no tiene correo corporativo ni
-- se le invita por email; la alternativa (inventar correos tipo
-- mesero1@negocio.local) ensucia la identidad global y ata a una persona a
-- una dirección falsa que nadie controla. Se prefiere permitir email NULL.
--
-- En PostgreSQL una restricción UNIQUE trata cada NULL como distinto, así
-- que usuarios_email_key sigue garantizando correos únicos entre las cuentas
-- que sí tienen correo, y admite tantos meseros sin correo como haga falta.
--
-- El rol vive donde ya viven los roles: usuario_negocios.rol = 'mesero'.
-- No se crea tabla de meseros: usuarios ya representa a las personas del
-- negocio, con su UUID estable y su aislamiento por negocio_id.

BEGIN;

ALTER TABLE usuarios ALTER COLUMN email DROP NOT NULL;

-- PIN de acceso local (4-6 dígitos), guardado con el MISMO esquema scrypt
-- salt:hash de las contraseñas (services/password.js). Nunca en claro.
-- Columna aparte de password_hash a propósito: un PIN de mostrador no es una
-- contraseña de inicio de sesión y no debe poder usarse como tal.
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS pin_hash TEXT;

-- Toda fila debe conservar al menos una forma de identidad: correo (cuentas
-- administrativas, que inician sesión) o PIN (meseros, que solo operan en el
-- piso). Las filas existentes tienen email, así que la restricción es válida
-- desde el primer día.
ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_identidad_check;
ALTER TABLE usuarios ADD CONSTRAINT usuarios_identidad_check
  CHECK (email IS NOT NULL OR pin_hash IS NOT NULL);

-- Búsqueda de meseros activos de un negocio (selector al abrir mesa).
CREATE INDEX IF NOT EXISTS idx_usuarios_negocio_pin
  ON usuarios (negocio_id) WHERE pin_hash IS NOT NULL;

COMMIT;
