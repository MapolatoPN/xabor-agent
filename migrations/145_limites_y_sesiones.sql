-- 145 — Límites de intentos y sesiones cerradas que sobreviven a un despliegue
-- (Fase 1, bloque 2, 21-nov-2026).
--
-- Hasta aquí los límites de intentos (login, PIN de meseros, clave de quien
-- autoriza, segundo factor, pedidos de Temporada y tienda) y la lista de
-- sesiones cerradas vivían en la memoria del proceso: cada despliegue o
-- reinicio los borraba, y una sesión cerrada volvía a valer hasta vencer.
--
-- limites_acceso: un renglón por intento que cuenta. `clave` es la HUELLA
-- (sha256, hex) de la llave lógica —correo, IP, mesero, negocio—: el correo o
-- la IP nunca se guardan en claro. Ventana deslizante: cuentan los renglones
-- con creado_at dentro de la ventana; `vence_at` solo sirve para purgar.
--
-- sesiones_revocadas: la huella (sha256, base64url) de cada token de sesión
-- cerrado, hasta que el token habría vencido solo. Nunca el token.
--
-- Aditiva e idempotente: dos tablas nuevas y vacías. No toca ninguna fila.
CREATE TABLE IF NOT EXISTS limites_acceso (
  id         BIGSERIAL PRIMARY KEY,
  clave      TEXT        NOT NULL,
  creado_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  vence_at   TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS limites_acceso_clave_idx ON limites_acceso (clave, creado_at);
CREATE INDEX IF NOT EXISTS limites_acceso_vence_idx ON limites_acceso (vence_at);

CREATE TABLE IF NOT EXISTS sesiones_revocadas (
  huella     TEXT        PRIMARY KEY,
  vence_at   TIMESTAMPTZ NOT NULL,
  creado_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sesiones_revocadas_vence_idx ON sesiones_revocadas (vence_at);
