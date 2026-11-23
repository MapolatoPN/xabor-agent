BEGIN;
CREATE TABLE IF NOT EXISTS limites_registro_basico (
  clave CHAR(64) PRIMARY KEY,
  ventana TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  intentos INTEGER NOT NULL DEFAULT 1 CHECK(intentos>0)
);
CREATE INDEX IF NOT EXISTS limites_basico_ventana ON limites_registro_basico(ventana);
ALTER TABLE solicitudes_registro_basico ADD COLUMN IF NOT EXISTS privacidad_aceptada_at TIMESTAMPTZ;
ALTER TABLE solicitudes_registro_basico ADD COLUMN IF NOT EXISTS privacidad_sha256 CHAR(64);
COMMIT;
