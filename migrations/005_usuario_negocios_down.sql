-- ============================================================
-- XABOR Multiempresa Fase 2 — Rollback Migración 005
-- Elimina únicamente la tabla usuario_negocios y su trigger.
-- No afecta usuarios, negocios ni ninguna otra tabla.
-- Reejecutable.
-- ============================================================

DROP TRIGGER IF EXISTS set_updated_at ON usuario_negocios;
DROP TABLE IF EXISTS usuario_negocios;
