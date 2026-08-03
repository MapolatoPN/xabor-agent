-- ============================================================
-- XABOR Multiempresa — Migración 031
-- Hotfix: sesiones_comerciales nunca debe quedar atorada ante un error
-- construyendo el borrador (fecha inválida, fallo de DB/catálogo, etc.).
--
-- Agrega:
--   1. Nuevo estado 'error_recuperable' al CHECK de sesiones_comerciales.estado
--      -- cuenta como sesión ACTIVA (no está en finalizada/abandonada), así
--      que el mismo teléfono retoma la MISMA sesión en su siguiente mensaje
--      en vez de quedar bloqueado por el índice único parcial.
--   2. ultimo_error_codigo / ultimo_error_at / intentos_fallidos -- para
--      poder diagnosticar y, si hace falta, limitar reintentos.
--
-- Reejecutable: IF NOT EXISTS / DO $$ guards en todo. El bloque de abajo
-- localiza el nombre real del CHECK constraint de "estado" en vez de
-- asumir un nombre fijo (mismo criterio que el paso 1 de la migración 028
-- con cotizaciones_origen_check, pero aquí buscando por definición en vez
-- de por nombre, porque el constraint de "estado" en 028 es inline dentro
-- del CREATE TABLE y Postgres le asigna un nombre autogenerado).
-- ============================================================

BEGIN;

ALTER TABLE sesiones_comerciales
  ADD COLUMN IF NOT EXISTS ultimo_error_codigo TEXT,
  ADD COLUMN IF NOT EXISTS ultimo_error_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS intentos_fallidos INTEGER NOT NULL DEFAULT 0;

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
    'esperando_aprobacion', 'error_recuperable', 'finalizada', 'abandonada'
  ));

COMMIT;
