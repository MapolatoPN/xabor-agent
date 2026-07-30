-- ============================================================
-- XABOR Multiempresa Fase 2 — Validación Migración 005
-- Script de solo lectura (no modifica datos).
-- ============================================================

-- 1. La tabla existe con las columnas esperadas
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'usuario_negocios'
ORDER BY column_name;

-- 2. FKs correctas (usuario CASCADE, negocio RESTRICT)
SELECT
  con.conname,
  con.confrelid::regclass::text AS tabla_referenciada,
  CASE con.confdeltype WHEN 'c' THEN 'CASCADE' WHEN 'r' THEN 'RESTRICT' ELSE con.confdeltype::text END AS on_delete
FROM pg_constraint con
WHERE con.contype = 'f' AND con.conrelid = 'usuario_negocios'::regclass
ORDER BY con.conname;

-- 3. UNIQUE (usuario_id, negocio_id)
SELECT a.attname, k.ordinality
FROM pg_constraint c
JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ordinality) ON true
JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
WHERE c.conrelid = 'usuario_negocios'::regclass AND c.contype = 'u'
ORDER BY k.ordinality;

-- 4. Trigger set_updated_at presente
SELECT trigger_name FROM information_schema.triggers
WHERE event_object_table = 'usuario_negocios' AND trigger_name = 'set_updated_at';

-- 5. Todo usuario existente tiene al menos una membresía (backfill correcto)
SELECT u.id, u.negocio_id
FROM usuarios u
LEFT JOIN usuario_negocios un ON un.usuario_id = u.id AND un.negocio_id = u.negocio_id
WHERE un.id IS NULL;
-- esperado: 0 filas (todo usuario ya tiene su membresía original replicada)

-- 6. Sin membresías duplicadas (la UNIQUE ya lo impide, esto es una doble verificación de datos)
SELECT usuario_id, negocio_id, count(*) FROM usuario_negocios
GROUP BY usuario_id, negocio_id HAVING count(*) > 1;
-- esperado: 0 filas
