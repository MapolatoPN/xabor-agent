-- ============================================================
-- Rollback de la migración 014.
--
-- ADVERTENCIA: push_subscriptions perdió sus filas originales durante el
-- UP (se eliminaron por instrucción explícita, origen desconocido). Este
-- rollback NO las recupera -- solo revierte el cambio de esquema
-- (quita negocio_id). Cualquier suscripción registrada DESPUÉS del
-- deploy de la 014 se conserva (con negocio_id, que simplemente deja de
-- usarse tras el rollback), no se borra.
--
-- push_subscriptions_repartidor: las filas irresolubles si las hubo
-- también se eliminaron durante el UP y tampoco se recuperan aquí --
-- solo se revierte el esquema sobre lo que haya quedado.
--
-- Reejecutable.
-- ============================================================

ALTER TABLE push_subscriptions DROP CONSTRAINT IF EXISTS push_subscriptions_negocio_id_fkey;
DROP INDEX IF EXISTS idx_push_subscriptions_negocio;
ALTER TABLE push_subscriptions ALTER COLUMN negocio_id DROP NOT NULL;
ALTER TABLE push_subscriptions DROP COLUMN IF EXISTS negocio_id;

ALTER TABLE push_subscriptions_repartidor DROP CONSTRAINT IF EXISTS push_subscriptions_repartidor_negocio_id_fkey;
DROP INDEX IF EXISTS idx_push_subscriptions_repartidor_negocio;
ALTER TABLE push_subscriptions_repartidor ALTER COLUMN negocio_id DROP NOT NULL;
ALTER TABLE push_subscriptions_repartidor DROP COLUMN IF EXISTS negocio_id;
