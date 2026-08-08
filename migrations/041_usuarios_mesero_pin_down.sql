-- Reversa de 041. Solo es aplicable si NO existen meseros sin correo: una
-- vez creados, volver a email NOT NULL exigiría inventarles una identidad,
-- que es justo lo que esta migración evita.
BEGIN;

DO $$
DECLARE v_sin_email INT;
BEGIN
  SELECT COUNT(*) INTO v_sin_email FROM usuarios WHERE email IS NULL;
  IF v_sin_email > 0 THEN
    RAISE EXCEPTION 'Hay % usuario(s) sin correo (meseros). Elimínalos o asígnales correo antes de revertir 041.', v_sin_email;
  END IF;
END $$;

DROP INDEX IF EXISTS idx_usuarios_negocio_pin;
ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_identidad_check;
ALTER TABLE usuarios DROP COLUMN IF EXISTS pin_hash;
ALTER TABLE usuarios ALTER COLUMN email SET NOT NULL;

COMMIT;
