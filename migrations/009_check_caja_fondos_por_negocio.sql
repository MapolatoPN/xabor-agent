-- ============================================================
-- XABOR Multiempresa — Validación Migración 009
-- Script de solo lectura (no modifica datos).
-- Ejecutar después de aplicar 009_caja_fondos_por_negocio.sql.
-- ============================================================

-- 1. Columna negocio_id (UUID) existe en caja_fondos
SELECT table_name, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'caja_fondos' AND column_name = 'negocio_id';
-- esperado: 1 fila, data_type = 'uuid', is_nullable = 'NO'

-- 2. Cero valores NULL en negocio_id
SELECT count(*) AS caja_fondos_null FROM caja_fondos WHERE negocio_id IS NULL;
-- esperado: 0

-- 3. FK hacia negocios con ON DELETE RESTRICT
SELECT
  con.conrelid::regclass::text  AS tabla,
  con.conname,
  con.confrelid::regclass::text AS tabla_referenciada,
  CASE con.confdeltype
    WHEN 'r' THEN 'RESTRICT'
    WHEN 'c' THEN 'CASCADE'
    WHEN 'n' THEN 'SET NULL'
    WHEN 'a' THEN 'NO ACTION'
    WHEN 'd' THEN 'SET DEFAULT'
  END AS on_delete
FROM pg_constraint con
WHERE con.contype = 'f'
  AND con.conrelid = 'caja_fondos'::regclass
  AND con.confrelid = 'negocios'::regclass;
-- esperado: 1 fila, on_delete = RESTRICT

-- 4. Índice por negocio_id
SELECT tablename, indexname
FROM pg_indexes
WHERE tablename = 'caja_fondos' AND indexname = 'idx_caja_fondos_negocio_id';
-- esperado: 1 fila

-- 5. UNIQUE compuesto (negocio_id, fecha), en ese orden
SELECT a.attname, k.ordinality
FROM pg_constraint c
JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ordinality) ON true
JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
WHERE c.conrelid = 'caja_fondos'::regclass AND c.contype = 'u'
  AND cardinality(c.conkey) = 2
ORDER BY k.ordinality;
-- esperado: 2 filas — negocio_id, fecha (en ese orden)

-- 6. La UNIQUE global de una sola columna (fecha) ya NO existe
SELECT conname
FROM pg_constraint
WHERE conrelid = 'caja_fondos'::regclass AND contype = 'u'
  AND cardinality(conkey) = 1;
-- esperado: 0 filas

-- 7. Todas las filas actuales asignadas a nonna-maye
--    (esperado: 0 justo tras aplicar la migración, antes de crear
--    cualquier segundo negocio de prueba)
SELECT count(*) AS caja_fondos_otros
FROM caja_fondos cf
WHERE cf.negocio_id NOT IN (SELECT id FROM negocios WHERE slug = 'nonna-maye');

-- 8. Ningún duplicado por (negocio_id, fecha) — la UNIQUE del paso 5
--    debería garantizarlo estructuralmente, esto es una verificación
--    directa sobre los datos
SELECT negocio_id, fecha, count(*)
FROM caja_fondos
GROUP BY negocio_id, fecha
HAVING count(*) > 1;
-- esperado: 0 filas

-- 9. Aptitud para rollback: fechas con fondos de más de un negocio.
--    Informativo, no es un error de la migración — simplemente indica
--    que 009_caja_fondos_por_negocio_down.sql se abortará si se intenta
--    ahora (ver preflight del propio down). Cualquier fila devuelta
--    aquí requiere una estrategia manual de datos antes de poder
--    revertir esta migración.
SELECT fecha, count(*) AS negocios_con_fondo
FROM caja_fondos
GROUP BY fecha
HAVING count(*) > 1;
-- esperado tras un backfill normal: 0 filas. Si hay filas, el rollback
-- está bloqueado deliberadamente hasta resolver esas fechas.
