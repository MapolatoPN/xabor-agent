-- ============================================================
-- XABOR Multiempresa Fase 3 — Migración 006
-- Login real por correo y contraseña.
-- Requiere que 003_multiempresa.sql y 005_usuario_negocios.sql ya
-- estén aplicadas. No borra ni modifica ningún dato existente.
-- Reejecutable.
-- ============================================================

-- ── password_hash ────────────────────────────────────────────
-- Nullable a propósito: un usuario sin password_hash simplemente no
-- puede iniciar sesión por contraseña todavía (no se inventa ninguna
-- por defecto). Formato de almacenamiento: "<salt_hex>:<hash_hex>"
-- (scrypt, ver src/services/password.js) — nunca texto plano.
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS password_hash TEXT;

-- ── usuarios.email pasa a ser único globalmente ─────────────────
-- Decisión de diseño (Fase 3): un usuario ahora representa UNA
-- PERSONA (con un solo password), que puede pertenecer a varios
-- negocios vía usuario_negocios (migración 005). Antes, email solo
-- era único por negocio (UNIQUE(negocio_id, email)), lo que permitía
-- que el mismo correo tuviera una fila — y una contraseña — distinta
-- por cada negocio. Eso es incompatible con "iniciar sesión con
-- correo+contraseña y luego elegir negocio" (requisito de esta fase).
-- No hay datos reales en producción todavía (la tabla usuarios ni
-- siquiera existe ahí), así que este cambio no puede violar ningún
-- dato real existente.
DO $$
DECLARE
  v_email_attnum    SMALLINT;
  v_negocio_attnum  SMALLINT;
  v_old_conname     TEXT;
BEGIN
  SELECT attnum INTO v_email_attnum
  FROM pg_attribute WHERE attrelid = 'usuarios'::regclass AND attname = 'email';
  SELECT attnum INTO v_negocio_attnum
  FROM pg_attribute WHERE attrelid = 'usuarios'::regclass AND attname = 'negocio_id';

  -- ¿Existe todavía la UNIQUE vieja (negocio_id, email)?
  SELECT conname INTO v_old_conname
  FROM pg_constraint
  WHERE conrelid = 'usuarios'::regclass
    AND contype = 'u'
    AND conkey = ARRAY[v_negocio_attnum, v_email_attnum];

  IF v_old_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE usuarios DROP CONSTRAINT %I', v_old_conname);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'usuarios'::regclass
      AND contype = 'u'
      AND conkey = ARRAY[v_email_attnum]
  ) THEN
    ALTER TABLE usuarios ADD CONSTRAINT usuarios_email_key UNIQUE (email);
  END IF;
END $$;
