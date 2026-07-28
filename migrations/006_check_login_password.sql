-- ============================================================
-- XABOR Multiempresa Fase 3 — Validación Migración 006
-- Script de solo lectura.
-- ============================================================

-- 1. password_hash existe
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'usuarios' AND column_name = 'password_hash';

-- 2. UNIQUE(email) global (no compuesta con negocio_id)
SELECT a.attname, k.ordinality
FROM pg_constraint c
JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ordinality) ON true
JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
WHERE c.conrelid = 'usuarios'::regclass AND c.contype = 'u'
ORDER BY k.ordinality;
-- esperado: exactamente 1 fila — "email"

-- 3. Ningún usuario con password_hash en texto plano evidente
--    (heurística: un hash scrypt real siempre contiene ':')
SELECT id, email FROM usuarios
WHERE password_hash IS NOT NULL AND password_hash NOT LIKE '%:%';
-- esperado: 0 filas
