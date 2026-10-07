-- 116 — Segundo factor (TOTP) obligatorio para la consola de Superadmin, e
-- IP en la bitácora de plataforma.
--
-- 7-oct-2026: el privilegio de superadmin dependía solo de la contraseña.
-- Una cuenta de prueba con superadmin y su contraseña escrita en el
-- repositorio (público) bastaba para entrar a /superadmin en producción. Desde
-- aquí, /api/superadmin/* y /ws/superadmin exigen además un código TOTP
-- (RFC 6238, apps como Google Authenticator) verificado para ESA sesión.
--
-- superadmin_totp: una fila por superadmin. El secreto va cifrado con
-- INTEGRATIONS_ENCRYPTION_KEY (AES-256-GCM, cifradoIntegraciones.js), nunca
-- en claro. `estado` = 'pendiente' mientras se da de alta (se mostró el QR
-- pero aún no se tecleó un código válido) y 'confirmado' después; una vez
-- confirmado, la web no permite volver a darlo de alta: reponer un teléfono
-- perdido se hace con scripts/superadmin-2fa-reiniciar.mjs.
-- `version` sube en cada alta: va dentro de la cookie del segundo factor, así
-- que reiniciar el TOTP invalida en el acto toda sesión ya verificada.
-- `ultimo_paso` es el último paso de 30 s aceptado: un código ya usado no
-- vale dos veces (anti-repetición).
--
-- auditoria_plataforma.ip: la IP del cliente de cada acción de Superadmin
-- (req.ip con trust proxy 1, el primer salto del proxy de Railway). El
-- usuario que actúa ya está en superadmin_id. Nullable: las filas
-- históricas y las que escribe un script no traen IP.
--
-- Aditiva e idempotente: una tabla nueva y vacía y una columna nullable. No
-- toca ninguna fila existente.
CREATE TABLE IF NOT EXISTS superadmin_totp (
  usuario_id       UUID PRIMARY KEY REFERENCES usuarios(id) ON DELETE RESTRICT,
  estado           TEXT NOT NULL CHECK (estado IN ('pendiente', 'confirmado')),
  secreto_cifrado  TEXT NOT NULL,
  secreto_iv       TEXT NOT NULL,
  secreto_tag      TEXT NOT NULL,
  secreto_formato  INTEGER NOT NULL,
  version          INTEGER NOT NULL DEFAULT 1,
  ultimo_paso      BIGINT NULL,
  confirmado_at    TIMESTAMPTZ NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS set_updated_at ON superadmin_totp;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON superadmin_totp
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE auditoria_plataforma ADD COLUMN IF NOT EXISTS ip TEXT NULL;
