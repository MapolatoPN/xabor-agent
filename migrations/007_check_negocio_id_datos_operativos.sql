-- ============================================================
-- XABOR Multiempresa Fase 4 — Validación Migración 007
-- Script de solo lectura.
-- ============================================================

-- 1. Todas las tablas objetivo tienen la columna negocio_id
SELECT table_name, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE column_name = 'negocio_id'
  AND table_name IN (
    'clientes', 'pedidos', 'pedidos_activos', 'mensajes',
    'pedidos_programados', 'transcripciones_voz', 'caja_fondos',
    'repartidores', 'campanas', 'rewards_config', 'rewards_accounts',
    'rewards_movements', 'eventos', 'perfiles_clientes', 'oportunidades'
  )
ORDER BY table_name;
-- esperado: una fila por cada tabla que exista en esta base, is_nullable = 'YES'

-- 2. Filas sin backfill (deberían ser 0 si 'nonna-maye' ya existía al migrar)
SELECT 'clientes' AS tabla, COUNT(*) FROM clientes WHERE negocio_id IS NULL
UNION ALL SELECT 'pedidos', COUNT(*) FROM pedidos WHERE negocio_id IS NULL
UNION ALL SELECT 'pedidos_activos', COUNT(*) FROM pedidos_activos WHERE negocio_id IS NULL
UNION ALL SELECT 'campanas', COUNT(*) FROM campanas WHERE negocio_id IS NULL
UNION ALL SELECT 'repartidores', COUNT(*) FROM repartidores WHERE negocio_id IS NULL;

-- 3. negocio_id referencia siempre un negocio real (la FK ya lo garantiza,
--    esto es una doble verificación de lectura)
SELECT 'pedidos' AS tabla, COUNT(*) AS huerfanos
FROM pedidos p LEFT JOIN negocios n ON n.id = p.negocio_id
WHERE p.negocio_id IS NOT NULL AND n.id IS NULL;
-- esperado: 0
