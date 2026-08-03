BEGIN;

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    WHERE rel.relname = 'sesiones_comerciales'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%estado%'
  LOOP
    EXECUTE format('ALTER TABLE sesiones_comerciales DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE sesiones_comerciales ADD CONSTRAINT sesiones_comerciales_estado_check
  CHECK (estado IN (
    'descubriendo_necesidad', 'construyendo_borrador',
    'esperando_aprobacion', 'finalizada', 'abandonada'
  ));

ALTER TABLE sesiones_comerciales
  DROP COLUMN IF EXISTS ultimo_error_codigo,
  DROP COLUMN IF EXISTS ultimo_error_at,
  DROP COLUMN IF EXISTS intentos_fallidos;

COMMIT;
