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
