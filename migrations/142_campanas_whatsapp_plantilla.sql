-- 142 · Campañas de WhatsApp con plantilla aprobada por Meta.
--
-- Pedido de Mario del 20-nov-2026 («sí, prepáralas»). La campaña de hoy manda
-- texto libre, que WhatsApp solo entrega a quien escribió en las últimas 24 h;
-- a los demás Meta la rechaza después (131047) y el panel la contaba como
-- enviada. Desde esta versión la campaña elige una plantilla aprobada por Meta
-- y deja una COLA en campana_envios que un trabajo en segundo plano va
-- mandando (así un redeploy a la mitad ya no la corta), y lo entregado y leído
-- sale de los acuses reales de Meta (whatsapp_estados_mensaje), por wamid.
--
-- Aditiva: columnas NULL o con valor constante (no reescriben la tabla),
-- índices parciales que no cubren ninguna fila existente y una regla NOT VALID
-- (no revisa el historial, solo lo que se escriba de aquí en adelante). Las
-- campañas viejas quedan como tipo 'texto' y el código anterior no lee nada
-- de esto.
--
-- Es la 142: la 141 ya está en producción (temporada, «se prepara en»).

ALTER TABLE campanas
  ADD COLUMN IF NOT EXISTS tipo text NOT NULL DEFAULT 'texto',
  -- { analisis, variables, respaldoNombre, excluirRecientes }: lo necesario
  -- para mandar sin volver a preguntarle a Meta por la plantilla.
  ADD COLUMN IF NOT EXISTS plantilla jsonb,
  ADD COLUMN IF NOT EXISTS creada_por text,
  ADD COLUMN IF NOT EXISTS detenida_at timestamptz,
  ADD COLUMN IF NOT EXISTS detenida_motivo text,
  -- Meta pidió bajar la velocidad: la cola no toca esta campaña antes de esto.
  ADD COLUMN IF NOT EXISTS reanudar_at timestamptz;

ALTER TABLE campanas
  DROP CONSTRAINT IF EXISTS campanas_tipo_check,
  ADD CONSTRAINT campanas_tipo_check CHECK (tipo IN ('texto', 'plantilla'));

ALTER TABLE campana_envios
  -- Cuándo entró a la cola. NULL = envío de una campaña de texto (anterior).
  ADD COLUMN IF NOT EXISTS cola_at timestamptz,
  -- El número como se le manda a Meta (52 + 10 dígitos para México).
  ADD COLUMN IF NOT EXISTS telefono_envio text,
  ADD COLUMN IF NOT EXISTS intento_at timestamptz,
  ADD COLUMN IF NOT EXISTS wamid text,
  ADD COLUMN IF NOT EXISTS error_codigo integer,
  ADD COLUMN IF NOT EXISTS entregado_at timestamptz,
  ADD COLUMN IF NOT EXISTS leido_at timestamptz,
  ADD COLUMN IF NOT EXISTS no_entregado_at timestamptz;

-- pendiente → enviando → enviado | fallido | incierto | cancelado.
-- 'incierto' = se cayó la red a medio envío: no se sabe si salió y NUNCA se
-- reintenta solo (un mensaje de marketing repetido se cobra dos veces).
ALTER TABLE campana_envios
  DROP CONSTRAINT IF EXISTS campana_envios_estado_check,
  ADD CONSTRAINT campana_envios_estado_check
    CHECK (estado IN ('pendiente', 'enviando', 'enviado', 'fallido', 'incierto', 'cancelado')) NOT VALID;

-- Un cliente entra UNA vez a la cola de cada campaña.
CREATE UNIQUE INDEX IF NOT EXISTS campana_envios_cola_unica
  ON campana_envios (campana_id, telefono_envio) WHERE cola_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS campana_envios_cola_por_mandar
  ON campana_envios (campana_id, id) WHERE estado IN ('pendiente', 'enviando');
CREATE INDEX IF NOT EXISTS campana_envios_wamid
  ON campana_envios (wamid) WHERE wamid IS NOT NULL;
CREATE INDEX IF NOT EXISTS campanas_plantilla_enviando
  ON campanas (creada_at) WHERE tipo = 'plantilla' AND estado = 'enviando';
