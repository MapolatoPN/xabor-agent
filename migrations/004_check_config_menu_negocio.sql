-- ============================================================
-- XABOR Multiempresa Fase 1 — Validación Migración 004
-- Script de solo lectura (no modifica datos).
-- Ejecutar después de aplicar 004_config_menu_negocio.sql.
-- ============================================================

-- 1. Existencia de las cinco columnas negocio_id (UUID)
SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE column_name = 'negocio_id'
  AND table_name IN ('configuracion','menu_categorias','menu_productos',
                      'menu_modificadores_grupos','menu_modificadores_opciones')
ORDER BY table_name;
-- esperado: 5 filas, data_type = 'uuid'

-- 2. Cero valores NULL en negocio_id
SELECT
  (SELECT count(*) FROM configuracion               WHERE negocio_id IS NULL) AS configuracion_null,
  (SELECT count(*) FROM menu_categorias             WHERE negocio_id IS NULL) AS categorias_null,
  (SELECT count(*) FROM menu_productos              WHERE negocio_id IS NULL) AS productos_null,
  (SELECT count(*) FROM menu_modificadores_grupos   WHERE negocio_id IS NULL) AS grupos_null,
  (SELECT count(*) FROM menu_modificadores_opciones WHERE negocio_id IS NULL) AS opciones_null;
-- esperado: todos en 0

-- 3. Cinco FKs correctas hacia negocios, con ON DELETE RESTRICT
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
  AND con.confrelid = 'negocios'::regclass
  AND con.conrelid::regclass::text IN ('configuracion','menu_categorias','menu_productos',
                                        'menu_modificadores_grupos','menu_modificadores_opciones')
ORDER BY tabla;
-- esperado: 5 filas, todas con on_delete = RESTRICT

-- 4. Cinco índices por negocio_id
SELECT tablename, indexname
FROM pg_indexes
WHERE tablename IN ('configuracion','menu_categorias','menu_productos',
                     'menu_modificadores_grupos','menu_modificadores_opciones')
  AND indexname LIKE 'idx_%_negocio'
ORDER BY tablename;
-- esperado: 5 filas (una por tabla)

-- 5. PK compuesta (negocio_id, clave) en configuracion
SELECT a.attname, k.ordinality
FROM pg_constraint c
JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ordinality) ON true
JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
WHERE c.conrelid = 'configuracion'::regclass AND c.contype = 'p'
ORDER BY k.ordinality;
-- esperado: 2 filas — negocio_id, clave (en ese orden)

-- 6. UNIQUE compuesto (negocio_id, codigo) en menu_productos
SELECT a.attname, k.ordinality
FROM pg_constraint c
JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ordinality) ON true
JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
WHERE c.conrelid = 'menu_productos'::regclass AND c.contype = 'u'
  AND cardinality(c.conkey) = 2
ORDER BY k.ordinality;
-- esperado: 2 filas — negocio_id, codigo (en ese orden)

-- 7. Todos los registros actuales asignados a nonna-maye
--    (esperado: todos en 0 justo tras aplicar la migración,
--    antes de crear cualquier segundo negocio de prueba)
SELECT
  (SELECT count(*) FROM configuracion c
     WHERE c.negocio_id NOT IN (SELECT id FROM negocios WHERE slug='nonna-maye'))              AS configuracion_otros,
  (SELECT count(*) FROM menu_categorias m
     WHERE m.negocio_id NOT IN (SELECT id FROM negocios WHERE slug='nonna-maye'))              AS categorias_otros,
  (SELECT count(*) FROM menu_productos m
     WHERE m.negocio_id NOT IN (SELECT id FROM negocios WHERE slug='nonna-maye'))              AS productos_otros,
  (SELECT count(*) FROM menu_modificadores_grupos m
     WHERE m.negocio_id NOT IN (SELECT id FROM negocios WHERE slug='nonna-maye'))              AS grupos_otros,
  (SELECT count(*) FROM menu_modificadores_opciones m
     WHERE m.negocio_id NOT IN (SELECT id FROM negocios WHERE slug='nonna-maye'))              AS opciones_otros;

-- 8. Ausencia de relaciones cruzadas en el árbol de menú
--    (ninguna de las siguientes tres consultas debe devolver filas)

-- 8a. producto.negocio_id debe coincidir con el de su categoría
SELECT p.id AS producto_id, p.negocio_id AS producto_negocio, c.negocio_id AS categoria_negocio
FROM menu_productos p
JOIN menu_categorias c ON c.id = p.categoria_id
WHERE p.negocio_id IS DISTINCT FROM c.negocio_id;

-- 8b. grupo.negocio_id debe coincidir con el de su producto
SELECT g.id AS grupo_id, g.negocio_id AS grupo_negocio, p.negocio_id AS producto_negocio
FROM menu_modificadores_grupos g
JOIN menu_productos p ON p.id = g.producto_id
WHERE g.negocio_id IS DISTINCT FROM p.negocio_id;

-- 8c. opcion.negocio_id debe coincidir con el de su grupo
SELECT o.id AS opcion_id, o.negocio_id AS opcion_negocio, g.negocio_id AS grupo_negocio
FROM menu_modificadores_opciones o
JOIN menu_modificadores_grupos g ON g.id = o.grupo_id
WHERE o.negocio_id IS DISTINCT FROM g.negocio_id;
