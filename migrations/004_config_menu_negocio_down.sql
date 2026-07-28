-- ============================================================
-- XABOR Multiempresa Fase 1 — Rollback Migración 004
-- Aborta ANTES de tocar nada si revertir perdería o corrompería
-- datos (más de un negocio con datos, claves o códigos repetidos
-- que impedirían restaurar las restricciones únicas originales).
-- Reejecutable.
-- ============================================================

-- ── Guarda 1: más de un negocio_id distinto con datos ──────────
-- Si negocio_id ya no existe en estas tablas, el rollback ya se
-- aplicó antes: no hay nada que verificar aquí.
DO $$
DECLARE
  v_col_exists BOOLEAN;
  v_distintos  INTEGER;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'configuracion' AND column_name = 'negocio_id'
  ) INTO v_col_exists;

  IF NOT v_col_exists THEN
    RETURN;
  END IF;

  SELECT count(DISTINCT negocio_id) INTO v_distintos
  FROM (
    SELECT negocio_id FROM configuracion
    UNION ALL SELECT negocio_id FROM menu_categorias
    UNION ALL SELECT negocio_id FROM menu_productos
    UNION ALL SELECT negocio_id FROM menu_modificadores_grupos
    UNION ALL SELECT negocio_id FROM menu_modificadores_opciones
  ) t;

  IF v_distintos > 1 THEN
    RAISE EXCEPTION
      'Rollback 004 abortado: hay % negocios distintos con datos en configuracion/menú. Revertir perdería la separación multiempresa. No se modificó nada.',
      v_distintos;
  END IF;
END $$;

-- ── Guarda 2: claves repetidas en configuracion ─────────────────
DO $$
DECLARE
  v_dup INTEGER;
BEGIN
  SELECT count(*) INTO v_dup FROM (
    SELECT clave FROM configuracion GROUP BY clave HAVING count(*) > 1
  ) t;
  IF v_dup > 0 THEN
    RAISE EXCEPTION
      'Rollback 004 abortado: % claves repetidas en configuracion impedirían restaurar PRIMARY KEY (clave). No se modificó nada.',
      v_dup;
  END IF;
END $$;

-- ── Guarda 3: códigos repetidos en menu_productos ───────────────
DO $$
DECLARE
  v_dup INTEGER;
BEGIN
  SELECT count(*) INTO v_dup FROM (
    SELECT codigo FROM menu_productos WHERE codigo IS NOT NULL GROUP BY codigo HAVING count(*) > 1
  ) t;
  IF v_dup > 0 THEN
    RAISE EXCEPTION
      'Rollback 004 abortado: % códigos repetidos en menu_productos impedirían restaurar UNIQUE (codigo). No se modificó nada.',
      v_dup;
  END IF;
END $$;

-- ── Paso 1: eliminar las FKs nuevas ─────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'configuracion_negocio_id_fkey') THEN
    ALTER TABLE configuracion DROP CONSTRAINT configuracion_negocio_id_fkey;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'menu_categorias_negocio_id_fkey') THEN
    ALTER TABLE menu_categorias DROP CONSTRAINT menu_categorias_negocio_id_fkey;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'menu_productos_negocio_id_fkey') THEN
    ALTER TABLE menu_productos DROP CONSTRAINT menu_productos_negocio_id_fkey;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'menu_modificadores_grupos_negocio_id_fkey') THEN
    ALTER TABLE menu_modificadores_grupos DROP CONSTRAINT menu_modificadores_grupos_negocio_id_fkey;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'menu_modificadores_opciones_negocio_id_fkey') THEN
    ALTER TABLE menu_modificadores_opciones DROP CONSTRAINT menu_modificadores_opciones_negocio_id_fkey;
  END IF;
END $$;

-- ── Paso 2: eliminar los índices nuevos ──────────────────────────
DROP INDEX IF EXISTS idx_configuracion_negocio;
DROP INDEX IF EXISTS idx_menu_categorias_negocio;
DROP INDEX IF EXISTS idx_menu_productos_negocio;
DROP INDEX IF EXISTS idx_menu_modificadores_grupos_negocio;
DROP INDEX IF EXISTS idx_menu_modificadores_opciones_negocio;

-- ── Paso 3: restaurar PRIMARY KEY (clave) en configuracion ──────
DO $$
DECLARE
  v_pk_conname TEXT;
BEGIN
  SELECT conname INTO v_pk_conname
  FROM pg_constraint WHERE conrelid = 'configuracion'::regclass AND contype = 'p';

  IF v_pk_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE configuracion DROP CONSTRAINT %I', v_pk_conname);
  END IF;

  ALTER TABLE configuracion ADD CONSTRAINT configuracion_pkey PRIMARY KEY (clave);
END $$;

-- ── Paso 4: restaurar UNIQUE (codigo) en menu_productos ─────────
DO $$
DECLARE
  v_codigo_attnum SMALLINT;
  v_uq_conname    TEXT;
BEGIN
  SELECT attnum INTO v_codigo_attnum
  FROM pg_attribute WHERE attrelid = 'menu_productos'::regclass AND attname = 'codigo';

  SELECT conname INTO v_uq_conname
  FROM pg_constraint
  WHERE conrelid = 'menu_productos'::regclass AND contype = 'u'
    AND conkey @> ARRAY[v_codigo_attnum] AND cardinality(conkey) > 1;

  IF v_uq_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE menu_productos DROP CONSTRAINT %I', v_uq_conname);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'menu_productos'::regclass AND contype = 'u' AND conkey = ARRAY[v_codigo_attnum]
  ) THEN
    ALTER TABLE menu_productos ADD CONSTRAINT menu_productos_codigo_key UNIQUE (codigo);
  END IF;
END $$;

-- ── Paso 5: eliminar negocio_id de las cinco tablas ─────────────
ALTER TABLE configuracion               DROP COLUMN IF EXISTS negocio_id;
ALTER TABLE menu_categorias             DROP COLUMN IF EXISTS negocio_id;
ALTER TABLE menu_productos              DROP COLUMN IF EXISTS negocio_id;
ALTER TABLE menu_modificadores_grupos   DROP COLUMN IF EXISTS negocio_id;
ALTER TABLE menu_modificadores_opciones DROP COLUMN IF EXISTS negocio_id;
