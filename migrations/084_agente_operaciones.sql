-- ============================================================
-- XABOR — Migración 084: el libro de operaciones del agente.
--
-- Registra CADA llamada a herramienta del Mesero: qué pidió el modelo, con
-- qué argumentos, qué contestó Xabor y si tuvo efecto.
--
-- Su razón de ser NO es el log: es la IDEMPOTENCIA. `operacion_clave` es
-- única, y una mutación que ya está en 'ok' no se vuelve a ejecutar — se
-- devuelve el resultado guardado.
--
-- Esto NO es lo mismo que la deduplicación por wamid de whatsapp_entradas.
-- Aquella impide procesar dos veces el mismo MENSAJE de Meta; ésta impide
-- aplicar dos veces la misma ACCIÓN del agente, que puede repetirse dentro de
-- un mismo mensaje (un reintento del modelo, una excepción a mitad de turno,
-- un redespliegue con el turno a medias). Son dos problemas distintos y hasta
-- hoy el segundo no tenía respuesta.
--
-- Aditiva. Reejecutable. Tabla nueva y vacía: no toca nada existente.
-- ============================================================

CREATE TABLE IF NOT EXISTS agente_operaciones (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id        UUID NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  conversacion_id   TEXT NOT NULL,
  turno_id          TEXT NOT NULL,
  tool_call_id      TEXT NULL,
  -- sha256(negocio|conversacion|turno|herramienta|hash_argumentos).
  -- UNIQUE: aquí vive la idempotencia.
  operacion_clave   TEXT NOT NULL UNIQUE,
  herramienta       TEXT NOT NULL,
  argumentos        JSONB NOT NULL DEFAULT '{}'::jsonb,
  argumentos_hash   TEXT NOT NULL,
  -- pendiente -> ok | error | rechazada | ilegal
  --   ok          se ejecutó y el pedido quedó como dice `resultado`
  --   error       reventó (excepción); NO se puede dar por aplicada
  --   rechazada   el reconciliador no la autorizó (lo normal, no es un fallo)
  --   ilegal      la máquina de estados no la permitía aquí
  estado            TEXT NOT NULL DEFAULT 'pendiente',
  aplicada          BOOLEAN NOT NULL DEFAULT FALSE,
  resultado         JSONB NULL,
  error             TEXT NULL,
  duracion_ms       INTEGER NULL,
  modo              TEXT NOT NULL DEFAULT 'productivo',  -- productivo | sombra | replay
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agente_operaciones_estado_check') THEN
    ALTER TABLE agente_operaciones ADD CONSTRAINT agente_operaciones_estado_check
      CHECK (estado IN ('pendiente','ok','error','rechazada','ilegal'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agente_operaciones_modo_check') THEN
    ALTER TABLE agente_operaciones ADD CONSTRAINT agente_operaciones_modo_check
      CHECK (modo IN ('productivo','sombra','replay'));
  END IF;
END $$;

-- Leer el turno entero, que es como se depura una conversación.
CREATE INDEX IF NOT EXISTS idx_agente_operaciones_turno
  ON agente_operaciones (negocio_id, conversacion_id, turno_id, created_at);

-- Solo un intento de confirmación con resultado posible por conversación.
-- Un rechazo conocido libera el ciclo; un intento pendiente o de resultado
-- incierto bloquea otro INSERT incluso si dos turnos corren concurrentes.
CREATE UNIQUE INDEX IF NOT EXISTS uq_agente_confirmacion_conversacion
  ON agente_operaciones (negocio_id, conversacion_id)
  WHERE herramienta = 'confirmar_pedido' AND estado IN ('pendiente','ok','error');

-- Contar por herramienta y por día para el scorecard.
CREATE INDEX IF NOT EXISTS idx_agente_operaciones_herramienta
  ON agente_operaciones (negocio_id, herramienta, created_at DESC);
