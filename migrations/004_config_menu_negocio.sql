-- ============================================================
-- XABOR Multiempresa Fase 1 — Migración 004
-- Agrega negocio_id a configuracion, menu_categorias, menu_productos,
-- menu_modificadores_grupos y menu_modificadores_opciones.
-- Reejecutable. No modifica ninguna otra tabla, ni ids, ni las
-- relaciones existentes (categoria_id, producto_id, grupo_id).
-- Requiere que 003_multiempresa.sql ya esté aplicada (tabla negocios).
-- ============================================================

-- ── Paso 1-2: abortar ANTES de tocar nada si no hay exactamente
--    un negocio con slug='nonna-maye' ─────────────────────────
DO $$
DECLARE
  v_count INTEGER;
BEGIN
  SELECT count(*) INTO v_count FROM negocios WHERE slug = 'nonna-maye';
  IF v_count <> 1 THEN
    RAISE EXCEPTION
      'Migración 004 abortada: se esperaba exactamente 1 negocio con slug=''nonna-maye'', se encontraron %. No se modificó ningún dato.',
      v_count;
  END IF;
END $$;

-- ── Paso 3: columnas nuevas, nullable ──────────────────────────
ALTER TABLE configuracion               ADD COLUMN IF NOT EXISTS negocio_id UUID;
ALTER TABLE menu_categorias             ADD COLUMN IF NOT EXISTS negocio_id UUID;
ALTER TABLE menu_productos              ADD COLUMN IF NOT EXISTS negocio_id UUID;
ALTER TABLE menu_modificadores_grupos   ADD COLUMN IF NOT EXISTS negocio_id UUID;
ALTER TABLE menu_modificadores_opciones ADD COLUMN IF NOT EXISTS negocio_id UUID;

-- ── Paso 4: backfill — asignar todo lo existente a nonna-maye,
--    únicamente donde negocio_id IS NULL (reejecutable) ────────
DO $$
DECLARE
  v_negocio_id UUID;
BEGIN
  SELECT id INTO v_negocio_id FROM negocios WHERE slug = 'nonna-maye';

  UPDATE configuracion               SET negocio_id = v_negocio_id WHERE negocio_id IS NULL;
  UPDATE menu_categorias             SET negocio_id = v_negocio_id WHERE negocio_id IS NULL;
  UPDATE menu_productos              SET negocio_id = v_negocio_id WHERE negocio_id IS NULL;
  UPDATE menu_modificadores_grupos   SET negocio_id = v_negocio_id WHERE negocio_id IS NULL;
  UPDATE menu_modificadores_opciones SET negocio_id = v_negocio_id WHERE negocio_id IS NULL;
END $$;

-- ── Paso 5: verificar que no queden NULL antes de endurecer
--    el esquema ──────────────────────────────────────────────
DO $$
DECLARE
  v_nulls INTEGER;
BEGIN
  SELECT
    (SELECT count(*) FROM configuracion               WHERE negocio_id IS NULL) +
    (SELECT count(*) FROM menu_categorias             WHERE negocio_id IS NULL) +
    (SELECT count(*) FROM menu_productos              WHERE negocio_id IS NULL) +
    (SELECT count(*) FROM menu_modificadores_grupos   WHERE negocio_id IS NULL) +
    (SELECT count(*) FROM menu_modificadores_opciones WHERE negocio_id IS NULL)
  INTO v_nulls;

  IF v_nulls > 0 THEN
    RAISE EXCEPTION
      'Migración 004 abortada: quedan % registros con negocio_id NULL tras el backfill.',
      v_nulls;
  END IF;
END $$;

-- ── Paso 6: NOT NULL (ALTER COLUMN ya es idempotente: no falla
--    si ya es NOT NULL) ─────────────────────────────────────────
ALTER TABLE configuracion               ALTER COLUMN negocio_id SET NOT NULL;
ALTER TABLE menu_categorias             ALTER COLUMN negocio_id SET NOT NULL;
ALTER TABLE menu_productos              ALTER COLUMN negocio_id SET NOT NULL;
ALTER TABLE menu_modificadores_grupos   ALTER COLUMN negocio_id SET NOT NULL;
ALTER TABLE menu_modificadores_opciones ALTER COLUMN negocio_id SET NOT NULL;

-- ── Paso 7: FK hacia negocios(id) ON DELETE RESTRICT.
--    Postgres no soporta ADD CONSTRAINT IF NOT EXISTS, así que se
--    verifica contra pg_constraint antes de agregar cada una ────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'configuracion_negocio_id_fkey') THEN
    ALTER TABLE configuracion ADD CONSTRAINT configuracion_negocio_id_fkey
      FOREIGN KEY (negocio_id) REFERENCES negocios(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'menu_categorias_negocio_id_fkey') THEN
    ALTER TABLE menu_categorias ADD CONSTRAINT menu_categorias_negocio_id_fkey
      FOREIGN KEY (negocio_id) REFERENCES negocios(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'menu_productos_negocio_id_fkey') THEN
    ALTER TABLE menu_productos ADD CONSTRAINT menu_productos_negocio_id_fkey
      FOREIGN KEY (negocio_id) REFERENCES negocios(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'menu_modificadores_grupos_negocio_id_fkey') THEN
    ALTER TABLE menu_modificadores_grupos ADD CONSTRAINT menu_modificadores_grupos_negocio_id_fkey
      FOREIGN KEY (negocio_id) REFERENCES negocios(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'menu_modificadores_opciones_negocio_id_fkey') THEN
    ALTER TABLE menu_modificadores_opciones ADD CONSTRAINT menu_modificadores_opciones_negocio_id_fkey
      FOREIGN KEY (negocio_id) REFERENCES negocios(id) ON DELETE RESTRICT;
  END IF;
END $$;

-- ── Paso 8: índices por negocio_id (CREATE INDEX sí soporta
--    IF NOT EXISTS de forma nativa) ─────────────────────────────
CREATE INDEX IF NOT EXISTS idx_configuracion_negocio              ON configuracion (negocio_id);
CREATE INDEX IF NOT EXISTS idx_menu_categorias_negocio             ON menu_categorias (negocio_id);
CREATE INDEX IF NOT EXISTS idx_menu_productos_negocio              ON menu_productos (negocio_id);
CREATE INDEX IF NOT EXISTS idx_menu_modificadores_grupos_negocio   ON menu_modificadores_grupos (negocio_id);
CREATE INDEX IF NOT EXISTS idx_menu_modificadores_opciones_negocio ON menu_modificadores_opciones (negocio_id);

-- ── Restricciones únicas: configuracion ─────────────────────────
-- PK actual (clave) → PK nueva (negocio_id, clave).
-- Se identifica la PK por catálogo (contype='p'), no por nombre
-- asumido, y solo se reemplaza si todavía es de una sola columna.
DO $$
DECLARE
  v_clave_attnum   SMALLINT;
  v_pk_conname     TEXT;
  v_pk_conkey      SMALLINT[];
BEGIN
  SELECT attnum INTO v_clave_attnum
  FROM pg_attribute WHERE attrelid = 'configuracion'::regclass AND attname = 'clave';

  SELECT conname, conkey INTO v_pk_conname, v_pk_conkey
  FROM pg_constraint
  WHERE conrelid = 'configuracion'::regclass AND contype = 'p';

  IF v_pk_conkey = ARRAY[v_clave_attnum] THEN
    EXECUTE format('ALTER TABLE configuracion DROP CONSTRAINT %I', v_pk_conname);
    ALTER TABLE configuracion ADD CONSTRAINT configuracion_pkey PRIMARY KEY (negocio_id, clave);
  END IF;
  -- si v_pk_conkey ya tiene 2 columnas, la migración ya se aplicó: no hacer nada
END $$;

-- ── Restricciones únicas: menu_productos ────────────────────────
-- UNIQUE actual (codigo) → UNIQUE nueva (negocio_id, codigo).
-- Igual que arriba: se identifica por composición de columnas via
-- pg_constraint, no por nombre asumido.
DO $$
DECLARE
  v_codigo_attnum  SMALLINT;
  v_negocio_attnum SMALLINT;
  v_old_conname    TEXT;
BEGIN
  SELECT attnum INTO v_codigo_attnum
  FROM pg_attribute WHERE attrelid = 'menu_productos'::regclass AND attname = 'codigo';
  SELECT attnum INTO v_negocio_attnum
  FROM pg_attribute WHERE attrelid = 'menu_productos'::regclass AND attname = 'negocio_id';

  SELECT conname INTO v_old_conname
  FROM pg_constraint
  WHERE conrelid = 'menu_productos'::regclass
    AND contype = 'u'
    AND conkey = ARRAY[v_codigo_attnum];

  IF v_old_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE menu_productos DROP CONSTRAINT %I', v_old_conname);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'menu_productos'::regclass
      AND contype = 'u'
      AND conkey = ARRAY[v_negocio_attnum, v_codigo_attnum]
  ) THEN
    ALTER TABLE menu_productos ADD CONSTRAINT menu_productos_negocio_id_codigo_key UNIQUE (negocio_id, codigo);
  END IF;
END $$;
