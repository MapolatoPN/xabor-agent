-- ============================================================
-- XABOR — Migración 085: outbox transaccional del agente.
--
-- El problema que resuelve: un pedido confirmado dispara efectos —avisar por
-- WhatsApp, imprimir la comanda, sumar rewards, analítica— y hoy esos efectos
-- se lanzan en el mismo hilo. Si el proceso se cae entre el pedido y el aviso,
-- el pedido existe y el aviso no, y nadie lo sabe.
--
-- El outbox lo convierte en un hecho persistido: el evento se escribe en la
-- MISMA transacción que el pedido. O están los dos, o no está ninguno. Los
-- consumidores lo leen después, a su ritmo, y son idempotentes por
-- `evento_clave`.
--
-- Lo que NO se hace aquí, a propósito: meter la llamada a Meta —o a la
-- impresora, o a Rappi— dentro de la transacción de negocio. Un HTTP lento
-- dentro de una transacción de Postgres es cómo se bloquea la tabla de pedidos
-- un martes a las dos de la tarde.
--
-- Aditiva. Reejecutable. Tabla nueva y vacía.
-- ============================================================

CREATE TABLE IF NOT EXISTS agente_outbox (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id      UUID NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  -- sha256 del contenido: dos escrituras del mismo evento son una sola fila.
  evento_clave    TEXT NOT NULL UNIQUE,
  tipo            TEXT NOT NULL,
  carga           JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- pendiente -> entregado | fallido | descartado
  estado          TEXT NOT NULL DEFAULT 'pendiente',
  intentos        INTEGER NOT NULL DEFAULT 0,
  ultimo_error    TEXT NULL,
  disponible_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  entregado_at    TIMESTAMPTZ NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agente_outbox_estado_check') THEN
    ALTER TABLE agente_outbox ADD CONSTRAINT agente_outbox_estado_check
      CHECK (estado IN ('pendiente','entregado','fallido','descartado'));
  END IF;
END $$;

-- El consumidor pide «lo pendiente que ya toca», y nada más.
CREATE INDEX IF NOT EXISTS idx_agente_outbox_pendiente
  ON agente_outbox (disponible_at) WHERE estado = 'pendiente';

CREATE INDEX IF NOT EXISTS idx_agente_outbox_negocio
  ON agente_outbox (negocio_id, created_at DESC);
