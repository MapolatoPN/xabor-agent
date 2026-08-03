-- ============================================================
-- XABOR Multiempresa — Migración 030
-- PWA + push notifications: push_subscriptions.usuario_id (Bloque 4).
--
-- Antes, una suscripcion push solo se ligaba a negocio_id -- CUALQUIER
-- dispositivo suscrito de un negocio recibia TODAS las notificaciones de
-- ese negocio, sin poder distinguir preferencias por usuario ni saber
-- que operador especifico esta detras de cada dispositivo. usuario_id
-- (nullable -- las suscripciones existentes ya guardadas siguen validas
-- sin romper nada) permite "varios dispositivos por usuario" y
-- "preferencias por usuario" sin perder el aislamiento por negocio ya
-- existente (que se mantiene intacto, negocio_id sigue siendo NOT NULL).
--
-- Reejecutable: IF NOT EXISTS en todo.
-- ============================================================

BEGIN;

ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS usuario_id UUID REFERENCES usuarios(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_usuario ON push_subscriptions (usuario_id);

COMMIT;
