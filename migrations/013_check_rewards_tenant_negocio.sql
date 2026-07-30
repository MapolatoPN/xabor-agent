-- ============================================================
-- XABOR Multiempresa — Validación Migración 013
-- Script de solo lectura (no modifica datos).
-- Ejecutar después de aplicar 013_rewards_tenant_negocio.sql.
-- ============================================================

-- 1. Ninguna fila queda con el tenant_id legado 'xabor-principal'
--    en las 3 tablas (salvo la fila de config que initDB() re-crea
--    en cada arranque como efecto secundario documentado, cosmético,
--    inofensivo — ver reporte)
SELECT 'rewards_accounts' AS tabla, count(*) FROM rewards_accounts WHERE tenant_id = 'xabor-principal'
UNION ALL
SELECT 'rewards_movements', count(*) FROM rewards_movements WHERE tenant_id = 'xabor-principal';
-- esperado: 0 en ambas

-- 2. Todas las cuentas/movimientos quedaron bajo el negocio_id real
--    de nonna-maye
SELECT count(*) AS accounts_bajo_nonna_maye
FROM rewards_accounts ra
JOIN negocios n ON n.id::text = ra.tenant_id
WHERE n.slug = 'nonna-maye';
-- esperado: igual al total de cuentas que existían antes de la migración

SELECT count(*) AS accounts_total FROM rewards_accounts;
SELECT count(*) AS movements_total FROM rewards_movements;
SELECT count(*) AS movements_bajo_nonna_maye
FROM rewards_movements rm
JOIN negocios n ON n.id::text = rm.tenant_id
WHERE n.slug = 'nonna-maye';
-- esperado: movements_bajo_nonna_maye = movements_total

-- 3. rewards_config tiene una fila para nonna-maye
SELECT rc.tenant_id, n.slug
FROM rewards_config rc
JOIN negocios n ON n.id::text = rc.tenant_id
WHERE n.slug = 'nonna-maye';
-- esperado: 1 fila

-- 4. Ningún tenant_id "huérfano" (que no sea ni 'xabor-principal' ni
--    un negocio_id real existente) — detecta datos corruptos, no
--    debería devolver filas nunca
SELECT DISTINCT tenant_id FROM rewards_accounts
WHERE tenant_id <> 'xabor-principal'
  AND tenant_id NOT IN (SELECT id::text FROM negocios);
-- esperado: 0 filas
