-- Verificaciones post-migración 011 (LOCAL)

-- 1. Tablas nuevas existen
SELECT table_name FROM information_schema.tables
WHERE table_schema='public' AND table_name IN ('administradores_plataforma','negocio_modulos','auditoria_plataforma')
ORDER BY table_name;

-- 2. Columnas nuevas en negocios
SELECT column_name, data_type, column_default FROM information_schema.columns
WHERE table_name='negocios' AND column_name IN ('estado','plan','checklist')
ORDER BY column_name;

-- 3. Invariante estado/activo: cero filas donde no coincidan
SELECT count(*) AS inconsistentes_estado_activo
FROM negocios
WHERE (estado = 'activo' AND activo = false)
   OR (estado IN ('pendiente','suspendido') AND activo = true);

-- 4. Nonna Maye quedó con estado='activo' (no se reinterpretó como pendiente/suspendido)
SELECT slug, estado, plan, activo FROM negocios WHERE slug='nonna-maye';

-- 5. Módulos backfilleados para Nonna Maye (8 activos + 1 configurado = 9)
SELECT nm.modulo, nm.estado FROM negocio_modulos nm
JOIN negocios n ON n.id = nm.negocio_id
WHERE n.slug = 'nonna-maye' ORDER BY nm.modulo;

-- 6. Cero superadmins todavía (la migración no crea ninguno)
SELECT count(*) AS superadmins_creados_por_la_migracion FROM administradores_plataforma;

-- 7. Cero filas de auditoría todavía
SELECT count(*) AS auditoria_inicial FROM auditoria_plataforma;

-- 8. CHECK constraints activos (deben rechazar valores fuera de rango)
SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
WHERE conname IN ('negocios_estado_check','negocios_plan_check')
ORDER BY conname;
