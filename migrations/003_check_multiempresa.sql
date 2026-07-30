-- ============================================================
-- XABOR Multiempresa — Validación Migración 003
-- Script de solo lectura (no modifica datos).
-- Ejecutar después de aplicar 003_multiempresa.sql y el seed.
-- ============================================================

-- 1. Confirmar existencia de las 5 tablas nuevas
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('negocios','sucursales','terminales','usuarios','usuario_sucursales')
ORDER BY table_name;

-- 2. Confirmar llaves primarias tipo UUID
SELECT c.relname AS tabla, a.attname AS columna, t.typname AS tipo
FROM pg_index i
JOIN pg_class c ON c.oid = i.indrelid
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
JOIN pg_type t ON t.oid = a.atttypid
WHERE i.indisprimary
  AND c.relname IN ('negocios','sucursales','terminales','usuarios','usuario_sucursales');

-- 3. Confirmar unicidad de negocios.slug
SELECT conname, contype
FROM pg_constraint
WHERE conrelid = 'negocios'::regclass AND contype = 'u';

-- 4. Confirmar llaves foráneas (sucursal→negocio, terminal→sucursal,
--    usuario→negocio, usuario_sucursales→usuario/sucursal)
SELECT
  tc.table_name AS tabla,
  kcu.column_name AS columna,
  ccu.table_name AS tabla_referenciada
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND tc.table_name IN ('sucursales','terminales','usuarios','usuario_sucursales')
ORDER BY tabla;

-- 5. Confirmar reglas ON DELETE (deben coincidir con lo aprobado:
--    RESTRICT en sucursales.negocio_id y usuarios.negocio_id;
--    CASCADE en terminales.sucursal_id, usuario_sucursales.usuario_id
--    y usuario_sucursales.sucursal_id)
SELECT
  con.conrelid::regclass::text AS tabla,
  con.conname,
  con.confrelid::regclass::text AS tabla_referenciada,
  CASE con.confdeltype
    WHEN 'c' THEN 'CASCADE'
    WHEN 'r' THEN 'RESTRICT'
    WHEN 'n' THEN 'SET NULL'
    WHEN 'a' THEN 'NO ACTION'
    WHEN 'd' THEN 'SET DEFAULT'
  END AS on_delete
FROM pg_constraint con
WHERE con.contype = 'f'
  AND con.conrelid::regclass::text IN ('sucursales','terminales','usuarios','usuario_sucursales')
ORDER BY tabla;

-- 6. Confirmar unicidad de terminales.codigo por sucursal
--    6a. La restricción existe
SELECT conname, contype
FROM pg_constraint
WHERE conrelid = 'terminales'::regclass AND contype = 'u';

--    6b. No hay códigos duplicados dentro de la misma sucursal
--        (no debe devolver ninguna fila)
SELECT sucursal_id, codigo, count(*) AS repeticiones
FROM terminales
GROUP BY sucursal_id, codigo
HAVING count(*) > 1;

-- 7. Confirmar que los triggers de updated_at existen en las 5 tablas
SELECT event_object_table AS tabla, trigger_name
FROM information_schema.triggers
WHERE trigger_name = 'set_updated_at'
  AND event_object_table IN ('negocios','sucursales','terminales','usuarios','usuario_sucursales')
ORDER BY tabla;

-- 8. Confirmar seed idempotente (cada consulta debe devolver 1)
SELECT count(*) AS negocios_nonna_maye
FROM negocios WHERE slug = 'nonna-maye';

SELECT count(*) AS sucursales_piedras_negras
FROM sucursales s
JOIN negocios n ON n.id = s.negocio_id
WHERE n.slug = 'nonna-maye' AND s.nombre = 'Piedras Negras';

SELECT count(*) AS terminales_caja_principal
FROM terminales t
JOIN sucursales s ON s.id = t.sucursal_id
JOIN negocios n ON n.id = s.negocio_id
WHERE n.slug = 'nonna-maye' AND s.nombre = 'Piedras Negras'
  AND t.nombre = 'Caja principal' AND t.codigo = 'caja-principal';

-- 9. Confirmar que NO se agregó negocio_id a tablas existentes
--    (pedidos, clientes, menú, caja, etc. — solo debe aparecer en
--    las tablas nuevas de este mismo módulo)
SELECT table_name, column_name
FROM information_schema.columns
WHERE column_name = 'negocio_id'
  AND table_name NOT IN ('sucursales','usuarios');
