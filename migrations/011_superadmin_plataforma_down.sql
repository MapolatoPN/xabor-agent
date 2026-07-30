-- ============================================================
-- XABOR Multiempresa — Rollback de la migración 011 (LOCAL)
-- Reversa exacta en orden inverso. No toca negocios.activo, usuarios,
-- usuario_negocios ni ninguna otra tabla fuera de lo que 011 agregó.
-- ============================================================

DROP TABLE IF EXISTS auditoria_plataforma;

DROP TABLE IF EXISTS negocio_modulos;

ALTER TABLE negocios DROP CONSTRAINT IF EXISTS negocios_plan_check;
ALTER TABLE negocios DROP COLUMN IF EXISTS plan;

ALTER TABLE negocios DROP CONSTRAINT IF EXISTS negocios_estado_check;
ALTER TABLE negocios DROP COLUMN IF EXISTS estado;

ALTER TABLE negocios DROP COLUMN IF EXISTS checklist;

DROP TABLE IF EXISTS administradores_plataforma;
