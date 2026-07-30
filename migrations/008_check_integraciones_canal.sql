-- ============================================================
-- XABOR Multiempresa Fase 5 — Validación Migración 008
-- Script de solo lectura.
-- ============================================================

-- 1. La tabla existe con la PK esperada
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'integraciones_canal'
ORDER BY ordinal_position;

-- 2. Restricciones: PK, FKs (negocio_id RESTRICT NOT NULL, sucursal_id
--    RESTRICT nullable), UNIQUE(canal, identificador), CHECKs
SELECT
  tc.constraint_type,
  tc.constraint_name,
  kcu.column_name,
  rc.update_rule,
  rc.delete_rule
FROM information_schema.table_constraints tc
LEFT JOIN information_schema.key_column_usage kcu
  ON kcu.constraint_name = tc.constraint_name AND kcu.table_name = tc.table_name
LEFT JOIN information_schema.referential_constraints rc
  ON rc.constraint_name = tc.constraint_name
WHERE tc.table_name = 'integraciones_canal'
ORDER BY tc.constraint_type, kcu.column_name;
-- esperado:
--   PRIMARY KEY sobre id
--   FOREIGN KEY negocio_id -> negocios, delete_rule = RESTRICT
--   FOREIGN KEY sucursal_id -> sucursales, delete_rule = RESTRICT
--   UNIQUE sobre (canal, identificador)
--   CHECK sobre canal y sobre identificador

-- 3. negocio_id es NOT NULL (a diferencia de sucursal_id, que sí acepta NULL)
SELECT column_name, is_nullable
FROM information_schema.columns
WHERE table_name = 'integraciones_canal' AND column_name IN ('negocio_id', 'sucursal_id');
-- esperado: negocio_id=NO, sucursal_id=YES

-- 4. Índices esperados
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'integraciones_canal'
ORDER BY indexname;
-- esperado: índice único de la PK, índice único (canal, identificador)
-- (autogenerado por el UNIQUE), idx_integraciones_canal_negocio,
-- idx_integraciones_canal_sucursal (parcial, WHERE sucursal_id IS NOT NULL),
-- idx_integraciones_canal_negocio_canal

-- 5. Trigger updated_at presente y usa la función compartida set_updated_at()
SELECT tgname, tgrelid::regclass AS tabla, proname AS funcion
FROM pg_trigger t
JOIN pg_proc p ON p.oid = t.tgfoid
WHERE tgrelid = 'integraciones_canal'::regclass AND NOT tgisinternal;
-- esperado: 1 fila — set_updated_at / integraciones_canal / set_updated_at

-- 6. Seed de Rappi presente y correctamente asociado a Nonna Maye
SELECT ic.canal, ic.identificador, ic.nombre, n.slug AS negocio_slug, ic.sucursal_id, ic.activo
FROM integraciones_canal ic
JOIN negocios n ON n.id = ic.negocio_id
WHERE ic.canal = 'rappi'
ORDER BY ic.created_at;
-- esperado: 1 fila — rappi / 1930419809 / Rappi — Nonna Maye / nonna-maye / NULL / true

-- 7. Ningún secreto obvio quedó guardado en configuracion (heurística de
--    solo lectura — no reemplaza una revisión manual del diff)
SELECT id, canal, identificador
FROM integraciones_canal
WHERE configuracion::text ILIKE '%token%'
   OR configuracion::text ILIKE '%secret%'
   OR configuracion::text ILIKE '%password%'
   OR configuracion::text ILIKE '%key%';
-- esperado: 0 filas

-- 8. No hay dos negocios con el mismo (canal, identificador) — lo
--    garantiza el UNIQUE, esto es una doble verificación de lectura
SELECT canal, identificador, COUNT(DISTINCT negocio_id) AS negocios_distintos
FROM integraciones_canal
GROUP BY canal, identificador
HAVING COUNT(DISTINCT negocio_id) > 1;
-- esperado: 0 filas
