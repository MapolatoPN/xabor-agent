-- ============================================================
-- XABOR Multiempresa — Rollback Migración 003
-- Elimina únicamente los objetos creados en 003_multiempresa.sql
-- No afecta ninguna otra tabla existente.
-- Orden: primero triggers, luego la función que usan,
-- y por último las tablas (respetando dependencias de FK).
-- ============================================================

-- 1. Triggers
DROP TRIGGER IF EXISTS set_updated_at ON usuario_sucursales;
DROP TRIGGER IF EXISTS set_updated_at ON usuarios;
DROP TRIGGER IF EXISTS set_updated_at ON terminales;
DROP TRIGGER IF EXISTS set_updated_at ON sucursales;
DROP TRIGGER IF EXISTS set_updated_at ON negocios;

-- 2. Función usada por los triggers
DROP FUNCTION IF EXISTS set_updated_at();

-- 3. Tablas (orden FK-safe: primero las que referencian, al final negocios)
DROP TABLE IF EXISTS usuario_sucursales;
DROP TABLE IF EXISTS usuarios;
DROP TABLE IF EXISTS terminales;
DROP TABLE IF EXISTS sucursales;
DROP TABLE IF EXISTS negocios;
