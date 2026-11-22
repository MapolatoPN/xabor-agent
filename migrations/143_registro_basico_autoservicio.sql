-- Registro público verificado de Xabor Básico. 143: solo tabla nueva.
-- Requiere migraciones de multiempresa 003/005/011/022/025 ya existentes.
-- Nunca se escriben negocios ni contraseñas sin verificar el correo.
BEGIN;
CREATE TABLE IF NOT EXISTS solicitudes_registro_basico (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  token_hash CHAR(64) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  nombre_propietario TEXT NOT NULL,
  nombre_negocio TEXT NOT NULL,
  telefono TEXT NOT NULL DEFAULT '',
  ciudad TEXT NOT NULL DEFAULT '',
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  negocio_id UUID REFERENCES negocios(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT solicitud_basico_correo_normalizado CHECK (email = lower(trim(email)))
);
CREATE INDEX IF NOT EXISTS solicitudes_basico_expira_idx
  ON solicitudes_registro_basico (expires_at)
  WHERE used_at IS NULL;
COMMIT;
