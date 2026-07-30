-- ============================================================
-- XABOR Multiempresa Fase 5 — Rollback Migración 008
-- Elimina ÚNICAMENTE lo creado por 008: la tabla integraciones_canal
-- (su trigger e índices se eliminan automáticamente junto con ella — no
-- son objetos independientes que deban borrarse aparte). No toca
-- set_updated_at() (pertenece a la migración 003 y la siguen usando
-- otras tablas: negocios, sucursales, terminales, usuarios,
-- usuario_sucursales, usuario_negocios) ni ninguna otra tabla.
-- Reejecutable.
-- ============================================================

DROP TABLE IF EXISTS integraciones_canal;
