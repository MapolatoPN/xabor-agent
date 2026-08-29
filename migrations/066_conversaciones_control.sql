-- 066 — Estado de atención (bot pausado) POR NEGOCIO Y CONVERSACIÓN.
--
-- PROBLEMA QUE RESUELVE (P0 "Tomar conversación"):
-- `clientes.telefono` es PRIMARY KEY GLOBAL — una sola fila por número en
-- TODA la plataforma. Pero el mismo número puede conversar con varios
-- negocios (Nonna, Alora, Mapolato…). El estado "bot_pausado" vivía en esa
-- fila global de `clientes`, así que:
--   * el dueño de la fila es el negocio que registró primero al cliente;
--   * otro negocio ve la conversación (por sus filas en `mensajes`) pero al
--     pausar, el UPDATE con WHERE negocio_id = <suyo> no matchea la fila
--     ajena → rowCount = 0 → el botón responde 403 "No se pudo modificar".
--   * y una pausa de un negocio afectaría el bot del otro (estado compartido).
--
-- SOLUCIÓN: el estado de atención pertenece a (negocio_id, telefono), NO al
-- cliente global. Cada negocio controla SU bot para ese teléfono de forma
-- independiente. NO se toca `clientes` ni su PK — este sprint aísla SOLO el
-- estado de atención humana/bot, no migra clientes.
--
-- Add-only, idempotente: CREATE ... IF NOT EXISTS. FK a negocios (NUNCA a
-- clientes.telefono, que reintroduciría el problema global).

CREATE TABLE IF NOT EXISTS conversaciones_control (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id  UUID NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  telefono    VARCHAR(20) NOT NULL,
  bot_pausado BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by  UUID NULL REFERENCES usuarios(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Una sola fila de estado por (negocio, teléfono): el UPSERT del panel
  -- pivota sobre esta unicidad y jamás pisa el estado de otro negocio.
  CONSTRAINT uq_conv_control_negocio_tel UNIQUE (negocio_id, telefono)
);
CREATE INDEX IF NOT EXISTS idx_conv_control_negocio_tel
  ON conversaciones_control (negocio_id, telefono);

-- Backfill del estado legado: solo pausas ACTIVAS con dueño inequívoco.
-- clientes.negocio_id es el dueño real de la fila legada; se migra su
-- bot_pausado=true a la nueva fuente. Los clientes con negocio_id NULL NO
-- se atribuyen (no se inventa a qué negocio pertenece la pausa). No pierde
-- ninguna pausa activa atribuible; idempotente por el ON CONFLICT.
INSERT INTO conversaciones_control (negocio_id, telefono, bot_pausado)
SELECT c.negocio_id, c.telefono, TRUE
  FROM clientes c
 WHERE c.negocio_id IS NOT NULL AND c.bot_pausado = TRUE
ON CONFLICT (negocio_id, telefono) DO NOTHING;
