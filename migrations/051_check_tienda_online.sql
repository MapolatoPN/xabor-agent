-- Verificación de solo lectura de la 051.
SELECT
  (SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'tienda_config')          AS t_config,
  (SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'tienda_productos')       AS t_productos,
  (SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'tienda_campanas')        AS t_campanas,
  (SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'tienda_promociones')     AS t_promos,
  (SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'tienda_promocion_usos')  AS t_usos,
  (SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'tienda_pedidos')         AS t_pedidos,
  -- unicidad de cupón POR NEGOCIO (no global) y tracking opaco único
  (SELECT COUNT(*) FROM pg_indexes WHERE indexname = 'idx_promo_negocio_codigo')               AS idx_codigo_por_negocio,
  (SELECT COUNT(*) FROM pg_indexes WHERE indexname = 'idx_tienda_pedidos_tracking')            AS idx_tracking,
  (SELECT COUNT(*) FROM pg_indexes WHERE indexname = 'idx_tienda_pedidos_checkout')            AS idx_idempotencia,
  (SELECT COUNT(*) FROM pg_indexes WHERE indexname = 'idx_promo_uso_unico')                    AS idx_uso_idempotente;
-- El módulo nuevo debe ser aceptado por el CHECK de negocio_modulos.
SELECT 'tienda_online en CHECK' AS prueba,
       pg_get_constraintdef(oid) LIKE '%tienda_online%' AS ok
  FROM pg_constraint WHERE conname = 'negocio_modulos_modulo_check';
-- Las relaciones entre tablas del módulo deben ser COMPUESTAS con negocio_id:
-- así el esquema impide una asociación cruzada aunque el código se equivoque.
SELECT 'FKs compuestas por negocio' AS prueba, COUNT(*) = 4 AS ok
  FROM pg_constraint WHERE conname IN (
    'tienda_productos_negocio_producto_fkey',
    'tienda_promociones_negocio_campania_fkey',
    'tienda_promocion_usos_negocio_promocion_fkey',
    'tienda_promocion_usos_negocio_campania_fkey');
