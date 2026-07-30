-- ============================================================
-- XABOR Multiempresa — Migración 014 (Auditoría P0 complementaria)
-- Aísla push_subscriptions y push_subscriptions_repartidor por negocio.
-- Ninguna de las dos tablas tuvo nunca negocio_id -- el sistema de push
-- quedó deliberadamente global en una fase anterior (ver comentario
-- "Fase 7" en server.js) y no se tocó al corregir WebSocket/HTTP en el
-- incidente P0. Esta migración cierra ese hueco.
--
-- push_subscriptions (panel): el origen de las filas existentes es
-- DESCONOCIDO -- no hay forma confiable de saber a qué negocio
-- pertenece cada endpoint, y Alora tuvo una sesión de admin activa
-- antes de suspenderse. Por instrucción explícita, NO se les asigna
-- Nonna Maye ni ningún otro negocio como relleno: se eliminan. El
-- navegador vuelve a suscribirse limpio, ya bajo el negocio correcto,
-- la próxima vez que la app registre el push.
--
-- push_subscriptions_repartidor: SÍ tiene un vínculo inequívoco vía
-- repartidor_id -> repartidores.negocio_id (columna ya poblada por el
-- incidente P0 principal). Se hace backfill real a partir de esa
-- relación; solo se eliminan las filas cuyo repartidor no exista o no
-- tenga negocio_id resuelto -- nunca se usa un relleno.
--
-- Requiere que negocios/repartidores ya existan (migraciones 003/007).
-- Reejecutable: solo toca filas con negocio_id todavía NULL en cada
-- paso, así que una segunda corrida no re-elimina ni re-asigna nada que
-- ya haya quedado resuelto por uso real de la app después del deploy.
-- ============================================================

-- ── push_subscriptions (panel) ──────────────────────────────────────
DO $$
DECLARE
  v_antes INTEGER;
BEGIN
  SELECT count(*) INTO v_antes FROM push_subscriptions;
  RAISE NOTICE 'push_subscriptions: % fila(s) antes de la migración', v_antes;
END $$;

ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS negocio_id UUID REFERENCES negocios(id) ON DELETE RESTRICT;

-- Origen desconocido -- se eliminan por instrucción explícita, nunca se
-- reasignan a Nonna Maye ni a ningún otro negocio. Solo afecta a filas
-- que TODAVÍA no tienen negocio_id (reejecutable: una fila ya migrada
-- por uso real de la app nunca cae aquí).
DELETE FROM push_subscriptions WHERE negocio_id IS NULL;

ALTER TABLE push_subscriptions ALTER COLUMN negocio_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_negocio ON push_subscriptions (negocio_id);

DO $$
DECLARE
  v_despues INTEGER;
BEGIN
  SELECT count(*) INTO v_despues FROM push_subscriptions;
  RAISE NOTICE 'push_subscriptions: % fila(s) después de la migración (deberían ser 0 en la primera corrida)', v_despues;
END $$;

-- ── push_subscriptions_repartidor ───────────────────────────────────
DO $$
DECLARE
  v_antes INTEGER;
BEGIN
  SELECT count(*) INTO v_antes FROM push_subscriptions_repartidor;
  RAISE NOTICE 'push_subscriptions_repartidor: % fila(s) antes de la migración', v_antes;
END $$;

ALTER TABLE push_subscriptions_repartidor ADD COLUMN IF NOT EXISTS negocio_id UUID REFERENCES negocios(id) ON DELETE RESTRICT;

-- Backfill real -- solo desde el repartidor relacionado, nunca un
-- relleno inventado. Solo toca filas con negocio_id todavía NULL.
UPDATE push_subscriptions_repartidor psr
SET negocio_id = r.negocio_id
FROM repartidores r
WHERE psr.repartidor_id = r.id
  AND r.negocio_id IS NOT NULL
  AND psr.negocio_id IS NULL;

-- Irresolubles (repartidor eliminado o sin negocio_id propio) -- se
-- eliminan, nunca se les asigna un negocio por defecto.
DELETE FROM push_subscriptions_repartidor WHERE negocio_id IS NULL;

ALTER TABLE push_subscriptions_repartidor ALTER COLUMN negocio_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_repartidor_negocio ON push_subscriptions_repartidor (negocio_id);

DO $$
DECLARE
  v_despues INTEGER;
BEGIN
  SELECT count(*) INTO v_despues FROM push_subscriptions_repartidor;
  RAISE NOTICE 'push_subscriptions_repartidor: % fila(s) después de la migración', v_despues;
END $$;
