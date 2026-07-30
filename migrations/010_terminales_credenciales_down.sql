-- ============================================================
-- XABOR Multiempresa — Rollback Migración 010
-- Elimina ÚNICAMENTE lo que 010 agregó: las columnas token_hash, tipo,
-- ultima_conexion, y el índice único parcial idx_terminales_token_hash_unique.
--
-- NO toca: la columna created_at/updated_at (existen desde 003), el
-- trigger set_updated_at (pertenece a 003 y lo siguen usando negocios,
-- sucursales, usuarios, usuario_sucursales, usuario_negocios,
-- integraciones_canal), la función set_updated_at() en sí, la tabla
-- terminales, su PK, su FK a sucursales, ni sus UNIQUE(sucursal_id,
-- nombre) / UNIQUE(sucursal_id, codigo).
--
-- Aborta ANTES de tocar nada si ya existe algún token_hash real
-- (no NULL) -- perderlo silenciosamente invalidaría credenciales de
-- terminal ya emitidas y en uso. Reejecutable si no hay tokens.
-- ============================================================

-- ── Guarda: no revertir si ya hay credenciales reales emitidas ──────
DO $$
DECLARE
  v_col_exists BOOLEAN;
  v_con_token  INTEGER;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'terminales' AND column_name = 'token_hash'
  ) INTO v_col_exists;

  IF NOT v_col_exists THEN
    RETURN; -- ya revertido antes, nada que hacer
  END IF;

  SELECT count(*) INTO v_con_token FROM terminales WHERE token_hash IS NOT NULL;
  IF v_con_token > 0 THEN
    RAISE EXCEPTION
      'Rollback 010 abortado: % terminal(es) ya tienen token_hash real (no NULL). Revertir perdería esas credenciales y las dejaría inutilizables. Revoca/regenera esos tokens primero (o acepta el riesgo manualmente) antes de reintentar. No se modificó nada.',
      v_con_token;
  END IF;
END $$;

-- ── Paso 1: eliminar el índice único parcial (propio de 010) ─────────
DROP INDEX IF EXISTS idx_terminales_token_hash_unique;

-- ── Paso 2: eliminar las tres columnas agregadas por 010 ──────────────
-- created_at / updated_at NO se tocan -- pertenecen a 003. El trigger
-- set_updated_at tampoco se toca -- también pertenece a 003 y sigue
-- siendo necesario para esa columna en esta y otras tablas.
ALTER TABLE terminales DROP COLUMN IF EXISTS token_hash;
ALTER TABLE terminales DROP COLUMN IF EXISTS tipo;
ALTER TABLE terminales DROP COLUMN IF EXISTS ultima_conexion;
