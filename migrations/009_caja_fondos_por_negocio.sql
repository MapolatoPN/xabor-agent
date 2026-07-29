-- ============================================================
-- XABOR Multiempresa — Migración 009
-- Aísla caja_fondos por negocio: endurece negocio_id a NOT NULL y
-- reemplaza la unicidad global UNIQUE(fecha) por UNIQUE(negocio_id,
-- fecha). Antes de esta migración caja_fondos tenía una sola fila por
-- fecha para TODOS los negocios (bloqueo documentado en el commit
-- 3738d91 "fix(multitenancy): aislar ventas e historial por negocio"):
-- dos negocios activos el mismo día compartían y se pisaban el mismo
-- fondo inicial, porque guardarFondoCaja nunca escribía negocio_id
-- aunque la columna ya existiera (nullable, sin backfill activo) desde
-- la migración 007.
--
-- Requiere que 003_multiempresa.sql (tabla negocios) y
-- 007_negocio_id_datos_operativos.sql (columna negocio_id nullable + FK
-- + índice en caja_fondos) ya estén aplicadas. Reejecutable.
-- ============================================================

-- ── Paso 1: abortar ANTES de tocar nada si no hay exactamente
--    un negocio con slug='nonna-maye' ─────────────────────────
DO $$
DECLARE
  v_count INTEGER;
BEGIN
  SELECT count(*) INTO v_count FROM negocios WHERE slug = 'nonna-maye';
  IF v_count <> 1 THEN
    RAISE EXCEPTION
      'Migración 009 abortada: se esperaba exactamente 1 negocio con slug=''nonna-maye'', se encontraron %. No se modificó ningún dato.',
      v_count;
  END IF;
END $$;

-- ── Paso 2: columna negocio_id — ya debería existir (nullable, FK a
--    negocios ON DELETE RESTRICT, índice) desde la migración 007. Se
--    repite de forma idempotente por si esta migración corre en una
--    base donde 007 no llegó a aplicarse sobre esta tabla en particular.
--    "ADD COLUMN IF NOT EXISTS ... REFERENCES ..." no falla ni duplica
--    la FK si la columna ya existe: Postgres omite toda la cláusula ──
ALTER TABLE caja_fondos ADD COLUMN IF NOT EXISTS negocio_id UUID REFERENCES negocios(id) ON DELETE RESTRICT;

-- ── Paso 3: backfill — asignar todo lo existente a nonna-maye,
--    únicamente donde negocio_id IS NULL (reejecutable). No es un valor
--    inventado: es el único negocio con datos reales de caja hasta hoy ─
DO $$
DECLARE
  v_negocio_id UUID;
BEGIN
  SELECT id INTO v_negocio_id FROM negocios WHERE slug = 'nonna-maye';
  UPDATE caja_fondos SET negocio_id = v_negocio_id WHERE negocio_id IS NULL;
END $$;

-- ── Paso 4: verificar que no queden NULL antes de endurecer
--    el esquema ──────────────────────────────────────────────
DO $$
DECLARE
  v_nulls INTEGER;
BEGIN
  SELECT count(*) INTO v_nulls FROM caja_fondos WHERE negocio_id IS NULL;
  IF v_nulls > 0 THEN
    RAISE EXCEPTION
      'Migración 009 abortada: quedan % registros con negocio_id NULL en caja_fondos tras el backfill.',
      v_nulls;
  END IF;
END $$;

-- ── Paso 5: NOT NULL (ALTER COLUMN ya es idempotente: no falla si
--    ya es NOT NULL) ─────────────────────────────────────────────
ALTER TABLE caja_fondos ALTER COLUMN negocio_id SET NOT NULL;

-- ── Paso 6: índice por negocio_id (ya debería existir desde 007;
--    reejecutable) ────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_caja_fondos_negocio_id ON caja_fondos (negocio_id);

-- ── Paso 7: reemplazar UNIQUE(fecha) global por UNIQUE(negocio_id,
--    fecha). Se identifica la restricción actual por composición de
--    columnas vía pg_constraint/pg_attribute, no por nombre asumido
--    (mismo patrón que 004 usó para menu_productos.codigo). La
--    restricción única compuesta ya funciona como índice para
--    (negocio_id, fecha) — no se necesita un índice adicional ────────
DO $$
DECLARE
  v_fecha_attnum   SMALLINT;
  v_negocio_attnum SMALLINT;
  v_old_conname    TEXT;
  v_dup_count      INTEGER;
BEGIN
  SELECT attnum INTO v_fecha_attnum
  FROM pg_attribute WHERE attrelid = 'caja_fondos'::regclass AND attname = 'fecha';
  SELECT attnum INTO v_negocio_attnum
  FROM pg_attribute WHERE attrelid = 'caja_fondos'::regclass AND attname = 'negocio_id';

  -- Guarda: verificar que no existan duplicados por (negocio_id, fecha)
  -- antes de crear la restricción única compuesta. No debería ser
  -- posible hoy (fecha es única globalmente, así que a lo sumo hay una
  -- fila por fecha para cualquier negocio_id), pero se verifica en vez
  -- de asumir.
  SELECT count(*) INTO v_dup_count FROM (
    SELECT negocio_id, fecha FROM caja_fondos GROUP BY negocio_id, fecha HAVING count(*) > 1
  ) t;
  IF v_dup_count > 0 THEN
    RAISE EXCEPTION
      'Migración 009 abortada: % pares (negocio_id, fecha) duplicados en caja_fondos impedirían crear UNIQUE (negocio_id, fecha). No se modificó nada.',
      v_dup_count;
  END IF;

  SELECT conname INTO v_old_conname
  FROM pg_constraint
  WHERE conrelid = 'caja_fondos'::regclass
    AND contype = 'u'
    AND conkey = ARRAY[v_fecha_attnum];

  IF v_old_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE caja_fondos DROP CONSTRAINT %I', v_old_conname);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'caja_fondos'::regclass
      AND contype = 'u'
      AND conkey = ARRAY[v_negocio_attnum, v_fecha_attnum]
  ) THEN
    ALTER TABLE caja_fondos ADD CONSTRAINT caja_fondos_negocio_id_fecha_key UNIQUE (negocio_id, fecha);
  END IF;
END $$;
