-- 099 · Traza durable de cada turno del agente y respuestas en el outbox.
--
-- Hasta aquí un turno del agente dejaba rastro en tres sitios que no se
-- hablaban: el libro de operaciones (una fila por herramienta con efecto), el
-- estado de la conversación (solo el último) y los logs de Railway (que rotan).
-- Reconstruir «qué pidió el cliente, qué propuso el modelo, qué autorizó Xabor
-- y en qué quedó el pedido» exigía cruzar logs a mano.
--
-- `agente_turnos` guarda UNA fila por turno aplicado, escrita en la MISMA
-- transacción que el nuevo estado de la conversación y que la respuesta en el
-- outbox: o están los tres o no está ninguno. La clave (negocio, conversación,
-- turno_clave) sale de los wamid del lote, así que un turno no puede quedar
-- aplicado dos veces.
--
-- Sin PII en claro más allá de lo que ya guarda `agente_operaciones`
-- (conversacion_id): los argumentos se guardan redactados y el texto del
-- cliente NO se copia; se cruza por `wamids` con `mensajes`.
--
-- `agente_outbox` recibe columnas para las respuestas al cliente, que desde
-- esta versión se escriben en el outbox dentro del commit del turno: la
-- conversación y el turno al que responden (para descartar una respuesta que
-- un turno posterior ya dejó vieja), y el arrendamiento y la aceptación de
-- Meta que impiden enviarla dos veces (ver «Entrega sin doble envío»).
--
-- Aditiva e idempotente.

CREATE TABLE IF NOT EXISTS agente_turnos (
  id                 bigserial   PRIMARY KEY,
  negocio_id         uuid        NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  conversacion_id    text        NOT NULL,
  turno_clave        text        NOT NULL,
  modo               text        NOT NULL DEFAULT 'productivo',
  wamids             text[]      NOT NULL DEFAULT '{}',
  fase_antes         text        NULL,
  fase_despues       text        NULL,
  version_antes      bigint      NULL,
  version_despues    bigint      NULL,
  pendiente_antes    jsonb       NULL,
  pendiente_despues  jsonb       NULL,
  acciones           jsonb       NOT NULL DEFAULT '[]'::jsonb,
  rechazos           jsonb       NOT NULL DEFAULT '[]'::jsonb,
  folio              text        NULL,
  outbox_claves      text[]      NOT NULL DEFAULT '{}',
  motivo_handoff     text        NULL,
  cierre             text        NULL,
  recuperacion       text        NULL,
  latencias          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  errores_proveedor  jsonb       NOT NULL DEFAULT '[]'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agente_turnos_modo_check CHECK (modo IN ('productivo', 'sombra', 'replay')),
  CONSTRAINT uq_agente_turnos_clave UNIQUE (negocio_id, conversacion_id, turno_clave)
);

CREATE INDEX IF NOT EXISTS idx_agente_turnos_conversacion
  ON agente_turnos (negocio_id, conversacion_id, created_at);

ALTER TABLE agente_outbox ADD COLUMN IF NOT EXISTS conversacion_id text NULL;
ALTER TABLE agente_outbox ADD COLUMN IF NOT EXISTS turno_clave text NULL;

CREATE INDEX IF NOT EXISTS idx_agente_outbox_respuestas_pendientes
  ON agente_outbox (negocio_id, conversacion_id, created_at)
  WHERE estado = 'pendiente' AND tipo = 'respuesta_cliente';

-- ── ENTREGA SIN DOBLE ENVÍO ──────────────────────────────────────────────
--
-- Una respuesta sale por dos caminos (en línea y el despachador). Para que
-- nunca salga dos veces:
--   · quien la envía primero la RECLAMA: `pendiente → enviando`, con dueño y
--     hora (`reclamado_por`, `reclamado_at`) — un arrendamiento;
--   · la aceptación de Meta queda en `wamid_salida` + `entregado`, escrita sola
--     y antes que cualquier otra cosa;
--   · un resultado que no se puede saber (timeout, conexión cortada a media
--     petición, un emisor que murió con la fila en `enviando`) queda en
--     `incierto`: revisión humana, NUNCA reenvío automático.
-- El código anterior no escribe ninguno de estos estados ni columnas.
ALTER TABLE agente_outbox ADD COLUMN IF NOT EXISTS wamid_salida  text        NULL;
ALTER TABLE agente_outbox ADD COLUMN IF NOT EXISTS reclamado_at  timestamptz NULL;
ALTER TABLE agente_outbox ADD COLUMN IF NOT EXISTS reclamado_por text        NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'agente_outbox_estado_check'
                AND pg_get_constraintdef(oid) NOT LIKE '%incierto%') THEN
    ALTER TABLE agente_outbox DROP CONSTRAINT agente_outbox_estado_check;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agente_outbox_estado_check') THEN
    ALTER TABLE agente_outbox ADD CONSTRAINT agente_outbox_estado_check
      CHECK (estado IN ('pendiente','enviando','entregado','incierto','fallido','descartado'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_agente_outbox_enviando
  ON agente_outbox (reclamado_at)
  WHERE estado = 'enviando';

-- La conciliación del acuse: «¿Meta aceptó la respuesta de ESTE diálogo?».
CREATE INDEX IF NOT EXISTS idx_agente_outbox_dialogo
  ON agente_outbox ((carga->>'dialogo_id'))
  WHERE tipo = 'respuesta_cliente';

-- ── UNA RESPUESTA QUE NO LLEGÓ PASA A UNA PERSONA, UNA SOLA VEZ ──────────
--
-- Rechazo agotado, respuesta vencida, resultado incierto o emisor muerto: el
-- cliente se quedó sin respuesta y la conversación pasa a una persona. Esa
-- decisión queda en la fila, en la MISMA sentencia que la saca de circulación
-- (`humano_motivo`, `humano_solicitado_at`); la confirmación de la revisión
-- humana se reclama con arrendamiento (`humano_reclamado_at`) para que dos
-- procesos no la pidan a la vez, y queda en `humano_confirmado_at`. Lo marcado
-- y sin confirmar lo retoma el despachador.
ALTER TABLE agente_outbox ADD COLUMN IF NOT EXISTS humano_motivo        text        NULL;
ALTER TABLE agente_outbox ADD COLUMN IF NOT EXISTS humano_solicitado_at timestamptz NULL;
ALTER TABLE agente_outbox ADD COLUMN IF NOT EXISTS humano_reclamado_at  timestamptz NULL;
ALTER TABLE agente_outbox ADD COLUMN IF NOT EXISTS humano_confirmado_at timestamptz NULL;

CREATE INDEX IF NOT EXISTS idx_agente_outbox_humano_por_confirmar
  ON agente_outbox (humano_solicitado_at)
  WHERE humano_motivo IS NOT NULL AND humano_confirmado_at IS NULL;
