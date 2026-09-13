-- ─── 079: Rewards en la tienda en línea ───────────────────────────────────
-- Idempotente y re-ejecutable.
--
-- QUÉ ARREGLA: `rewardsService.acumularPuntos` decide si una venta acumula
-- mirando un mapa de canales contra las columnas `canal_*` de rewards_config.
-- La tienda en línea (canal 'tienda_online', migración 051) nunca tuvo
-- columna, así que el mapa devolvía `undefined` y TODA venta de la tienda
-- salía por la rama "canal no habilitado": cero puntos, en silencio, para
-- todos los negocios. El canje ni siquiera existía en la tienda.
--
-- POR QUÉ EL DEFAULT ES FALSE (y no TRUE como mostrador/WhatsApp):
-- `ADD COLUMN ... DEFAULT` rellena TODAS las filas existentes. Con TRUE,
-- esta migración encendería Rewards en la tienda de cada negocio que ya
-- tenga el programa activo -- un cambio de configuración comercial que
-- nadie pidió, aplicado por una migración. Con FALSE el comportamiento de
-- hoy se conserva exacto y encenderlo es un acto explícito del negocio
-- (panel → Rewards → Config → "Tienda en línea", o
-- PATCH /api/rewards/config).
--
-- Un solo interruptor gobierna las DOS mitades (acumular y canjear) en la
-- tienda: media función encendida es más difícil de explicarle a un cliente
-- ("gané puntos pero no puedo usarlos") que la función completa o apagada.
--
-- Ejecutar con: psql "$CONN" -v ON_ERROR_STOP=1 -f 079_rewards_canal_tienda.sql

ALTER TABLE rewards_config
  ADD COLUMN IF NOT EXISTS canal_tienda BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN rewards_config.canal_tienda IS
  'Rewards activo en la tienda en línea (canal tienda_online): acumulación y canje. Default FALSE: se enciende explícitamente por negocio.';
