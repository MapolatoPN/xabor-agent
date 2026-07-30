-- ============================================================
-- XABOR Multiempresa Fase 3 — Rollback Migración 006
-- Restaura UNIQUE(negocio_id, email) y elimina password_hash.
-- Aborta si hay contraseñas ya establecidas (perderlas sin avisar
-- sería destructivo) o si hay datos que impedirían restaurar la
-- restricción original.
-- Reejecutable.
-- ============================================================

DO $$
DECLARE
  v_con_password INTEGER;
BEGIN
  SELECT count(*) INTO v_con_password FROM usuarios WHERE password_hash IS NOT NULL;
  IF v_con_password > 0 THEN
    RAISE EXCEPTION
      'Rollback 006 abortado: % usuario(s) ya tienen password_hash establecido. Revertir los borraría sin aviso. No se modificó nada.',
      v_con_password;
  END IF;
END $$;

-- Restaurar UNIQUE (negocio_id, email)
DO $$
DECLARE
  v_email_attnum   SMALLINT;
  v_negocio_attnum SMALLINT;
  v_conname        TEXT;
BEGIN
  SELECT attnum INTO v_email_attnum
  FROM pg_attribute WHERE attrelid = 'usuarios'::regclass AND attname = 'email';
  SELECT attnum INTO v_negocio_attnum
  FROM pg_attribute WHERE attrelid = 'usuarios'::regclass AND attname = 'negocio_id';

  SELECT conname INTO v_conname
  FROM pg_constraint
  WHERE conrelid = 'usuarios'::regclass AND contype = 'u' AND conkey = ARRAY[v_email_attnum];

  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE usuarios DROP CONSTRAINT %I', v_conname);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'usuarios'::regclass AND contype = 'u' AND conkey = ARRAY[v_negocio_attnum, v_email_attnum]
  ) THEN
    ALTER TABLE usuarios ADD CONSTRAINT usuarios_negocio_id_email_key UNIQUE (negocio_id, email);
  END IF;
END $$;

ALTER TABLE usuarios DROP COLUMN IF EXISTS password_hash;
