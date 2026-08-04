-- ============================================================
-- XABOR Multiempresa — Migración 034
-- Modo explícito de conversación (cliente/repartidor) por repartidor.
--
-- Incidencia real (piloto de notificaciones a repartidores, Nonna Maye):
-- un teléfono registrado como repartidor quedaba permanentemente
-- interceptado por el flujo de repartidor en whatsapp-meta.js -- cualquier
-- mensaje que no fuera "entregué" recibía siempre el link de repartidor.html,
-- sin importar la intención real (p. ej. "quiero hacer un pedido"). La
-- causa: la clasificación era una simple existencia en `repartidores`, sin
-- ningún concepto de sesión/modo.
--
-- Esta migración agrega el modo explícito y reversible que permite que un
-- mismo teléfono sea cliente Y repartidor sin que uno bloquee al otro:
--   'sin_modo'   -- default. Se resuelve por intención del mensaje.
--   'cliente'    -- fijado explícitamente (o por intención clara de compra).
--   'repartidor' -- fijado explícitamente ("modo repartidor"/"disponible").
--
-- Se agrega a la propia fila de `repartidores` (no una tabla nueva) porque
-- el modo es 1:1 con la identidad teléfono+negocio que esa fila ya
-- representa -- no existe conversación de "repartidor" sin una fila de
-- repartidor, y viceversa.
--
-- Reejecutable: IF NOT EXISTS en todo.
-- ============================================================

BEGIN;

ALTER TABLE repartidores
  ADD COLUMN IF NOT EXISTS modo_actual TEXT NOT NULL DEFAULT 'sin_modo'
    CHECK (modo_actual IN ('cliente', 'repartidor', 'sin_modo')),
  ADD COLUMN IF NOT EXISTS modo_actualizado_at TIMESTAMPTZ;

COMMIT;
