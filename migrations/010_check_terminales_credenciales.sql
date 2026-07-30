-- ============================================================
-- XABOR Multiempresa — Validación Migración 010
-- Script de solo lectura (no modifica datos).
-- Ejecutar después de aplicar 010_terminales_credenciales.sql.
-- ============================================================

-- 1. Las tres columnas nuevas existen con tipo/nulabilidad/default correctos
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'terminales'
  AND column_name IN ('token_hash', 'tipo', 'ultima_conexion')
ORDER BY column_name;
-- esperado: 3 filas
--   token_hash      | text                        | YES | (null)
--   tipo             | text                        | NO  | 'impresora'::text
--   ultima_conexion  | timestamp without time zone | YES | (null)

-- 2. created_at / updated_at siguen existiendo tal cual (sin duplicar,
--    sin cambiar tipo/nulabilidad/default)
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'terminales'
  AND column_name IN ('created_at', 'updated_at')
ORDER BY column_name;
-- esperado: 2 filas, ambas timestamp with time zone, NOT NULL, default now()

-- 3. token_hash: nullable, sin default (verificación explícita separada)
SELECT
  (SELECT is_nullable FROM information_schema.columns WHERE table_name='terminales' AND column_name='token_hash') AS token_hash_nullable,
  (SELECT column_default FROM information_schema.columns WHERE table_name='terminales' AND column_name='token_hash') AS token_hash_default;
-- esperado: nullable='YES', default=NULL

-- 4. tipo: NOT NULL con default 'impresora'
SELECT
  (SELECT is_nullable FROM information_schema.columns WHERE table_name='terminales' AND column_name='tipo') AS tipo_nullable,
  (SELECT column_default FROM information_schema.columns WHERE table_name='terminales' AND column_name='tipo') AS tipo_default;
-- esperado: nullable='NO', default = 'impresora'::text

-- 5. Trigger set_updated_at sigue presente en terminales (ya existía
--    desde 003 -- esta migración solo lo reafirma de forma idempotente)
SELECT tgname, tgrelid::regclass::text AS tabla
FROM pg_trigger
WHERE tgrelid = 'terminales'::regclass AND tgname = 'set_updated_at' AND NOT tgisinternal;
-- esperado: 1 fila

-- 6. Índice único parcial sobre token_hash existe y es realmente parcial
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'terminales' AND indexname = 'idx_terminales_token_hash_unique';
-- esperado: 1 fila, indexdef debe incluir "WHERE (token_hash IS NOT NULL)"

-- 7. PK, FKs y UNIQUE originales de terminales siguen intactos
SELECT conname, contype
FROM pg_constraint
WHERE conrelid = 'terminales'::regclass
ORDER BY contype, conname;
-- esperado: incluye la PK (contype='p'), la FK a sucursales (contype='f'),
-- y las dos UNIQUE (sucursal_id, nombre) / (sucursal_id, codigo) (contype='u')
-- -- ninguna debe faltar ni haber cambiado

-- 8. Cero tokens reales creados por esta migración (informativo — se
--    espera 0 justo tras aplicar 010, antes de que cualquier fase
--    posterior emita credenciales reales)
SELECT count(*) AS terminales_con_token FROM terminales WHERE token_hash IS NOT NULL;
-- esperado: 0 justo después de aplicar esta migración

-- 9. Filas previas de terminales permanecen intactas (conteo total sin cambios)
SELECT count(*) AS total_terminales FROM terminales;
