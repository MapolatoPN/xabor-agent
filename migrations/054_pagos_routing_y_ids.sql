-- ─── 054: identificadores de pago separados + routing seguro de webhooks ────
-- Idempotente y re-ejecutable.
--
-- POR QUÉ EXISTE
--
-- 1) `preference_id` NO es `payment_id`. Mercado Pago devuelve al crear el
--    checkout el id de la PREFERENCIA; el webhook trae el id del PAGO, y son
--    espacios de identificadores distintos. Usar uno donde va el otro consulta
--    un recurso que no existe. Antes ambos cabían en `referencia_externa`, un
--    campo con dos significados. Aquí se separan: cada uno con su nombre.
--
-- 2) El webhook llega de internet y no puede decir de qué negocio es. Confiar
--    en el cuerpo sería dejar que quien lo manda elija a quién cobrarle. La
--    salida es un token de ruteo OPACO, generado por Xabor, aleatorio y no
--    enumerable, atado de forma durable a la integración (y por ella al
--    negocio). Viaja en la notification_url que Xabor mismo configuró; el
--    webhook llega a esa URL y el token dice qué credenciales usar. Nunca es
--    un secreto compartido global ni sirve para autenticar por sí solo: la
--    firma se verifica igual.

ALTER TABLE pagos ADD COLUMN IF NOT EXISTS preference_id text;
ALTER TABLE pagos ADD COLUMN IF NOT EXISTS payment_id text;

-- Un payment_id es único dentro del proveedor: si dos filas del mismo negocio
-- lo reclamaran, una de las dos estaría cobrando lo que no le toca.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pagos_payment_id
  ON pagos (negocio_id, proveedor, payment_id) WHERE payment_id IS NOT NULL;

-- Búsqueda por preferencia al llegar un webhook que sólo trae ese id.
CREATE INDEX IF NOT EXISTS idx_pagos_preference_id
  ON pagos (negocio_id, preference_id) WHERE preference_id IS NOT NULL;

ALTER TABLE integraciones_canal ADD COLUMN IF NOT EXISTS webhook_routing_token text;

-- Único a nivel plataforma: es lo que hace que un token resuelva UNA sola
-- integración. Parcial porque las integraciones que no reciben webhooks no lo
-- tienen y no deben chocar entre sí por NULL.
CREATE UNIQUE INDEX IF NOT EXISTS idx_integraciones_routing_token
  ON integraciones_canal (webhook_routing_token) WHERE webhook_routing_token IS NOT NULL;
