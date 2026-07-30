-- ============================================================
-- XABOR Multiempresa — Validación Migración 014
-- Script de solo lectura (no modifica datos).
-- ============================================================

-- 1. Columna negocio_id (UUID, NOT NULL) en ambas tablas
SELECT table_name, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name IN ('push_subscriptions', 'push_subscriptions_repartidor')
  AND column_name = 'negocio_id';
-- esperado: 2 filas, data_type = 'uuid', is_nullable = 'NO' en ambas

-- 2. Cero NULL (debería ser estructuralmente imposible tras el NOT NULL)
SELECT
  (SELECT count(*) FROM push_subscriptions WHERE negocio_id IS NULL) AS push_subscriptions_null,
  (SELECT count(*) FROM push_subscriptions_repartidor WHERE negocio_id IS NULL) AS push_subscriptions_repartidor_null;
-- esperado: 0, 0

-- 3. FK hacia negocios en ambas tablas
SELECT con.conrelid::regclass::text AS tabla, con.conname,
       CASE con.confdeltype WHEN 'r' THEN 'RESTRICT' ELSE con.confdeltype::text END AS on_delete
FROM pg_constraint con
WHERE con.contype = 'f'
  AND con.conrelid IN ('push_subscriptions'::regclass, 'push_subscriptions_repartidor'::regclass)
  AND con.confrelid = 'negocios'::regclass;
-- esperado: 2 filas, on_delete = RESTRICT

-- 4. Índices por negocio_id
SELECT tablename, indexname FROM pg_indexes
WHERE tablename IN ('push_subscriptions', 'push_subscriptions_repartidor')
  AND indexname LIKE '%negocio%';
-- esperado: 2 filas

-- 5. Conteo actual por tabla (informativo)
SELECT 'push_subscriptions' AS tabla, count(*) FROM push_subscriptions
UNION ALL
SELECT 'push_subscriptions_repartidor', count(*) FROM push_subscriptions_repartidor;

-- 6. push_subscriptions_repartidor: todas coinciden con el negocio_id
--    real de su repartidor (nunca deben desincronizarse)
SELECT count(*) AS desincronizadas
FROM push_subscriptions_repartidor psr
JOIN repartidores r ON r.id = psr.repartidor_id
WHERE psr.negocio_id IS DISTINCT FROM r.negocio_id;
-- esperado: 0

-- 7. Distribución de push_subscriptions_repartidor por negocio (informativo,
--    sin exponer endpoints)
SELECT n.slug, count(*) FROM push_subscriptions_repartidor psr
JOIN negocios n ON n.id = psr.negocio_id
GROUP BY n.slug ORDER BY n.slug;
