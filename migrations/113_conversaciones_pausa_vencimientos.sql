-- 113 — Bitácora del vencimiento de las pausas del bot por conversación.
--
-- P3 (3-oct-2026): una pausa del bot (`conversaciones_control.bot_pausado` o
-- una revisión de `whatsapp_conversaciones`) no vencía nunca. El job de
-- src/services/vencimientoPausasWhatsapp.js la devuelve al bot tras N horas
-- sin mensajes del personal, solo en los negocios con la bandera
-- `whatsapp_pausa_vence_horas` (apagada por omisión).
--
-- Cada liberación —y cada una que liberaría en modo simulado— deja aquí qué
-- pausa era, quién la había puesto y por qué. Es el aviso que el dueño revisa
-- al entrar al sistema (el resumen por WhatsApp es opcional y nace apagado).
-- No puede ser `auditoria_plataforma`: esa tabla exige exactamente un actor
-- humano (046), y aquí el actor es el sistema.
--
-- `identidad_pausa` identifica la pausa concreta (inicio de la pausa, número
-- y fecha de la revisión). El UNIQUE hace dos cosas: el modo simulado deja
-- como mucho UNA fila por pausa aunque corra cada 5 minutos, y dos instancias
-- del job no pueden registrar dos veces la misma liberación.
--
-- Aditiva e idempotente: una tabla nueva y vacía. No toca ninguna pausa,
-- revisión, entrada ni estado de conversación.
CREATE TABLE IF NOT EXISTS conversaciones_pausa_vencimientos (
  id                      BIGSERIAL PRIMARY KEY,
  negocio_id              UUID NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  telefono                TEXT NOT NULL,
  modo                    TEXT NOT NULL CHECK (modo IN ('simulado', 'aplicado')),
  -- automatica: revisión del sistema; manual: la puso una persona;
  -- huerfana: pausa de una solicitud del menú sin revisión; desconocida: sin
  -- rastro de quién (p. ej. el relleno de la 066).
  origen_pausa            TEXT NOT NULL CHECK (origen_pausa IN ('automatica', 'manual', 'huerfana', 'desconocida')),
  pausado_por             UUID NULL REFERENCES usuarios(id) ON DELETE SET NULL,
  pausado_desde           TIMESTAMPTZ NULL,
  requeria_revision       BOOLEAN NOT NULL,
  motivo_revision         TEXT NULL,
  -- El motivo que anotó el agente en su traspaso (estado.handoff.motivo).
  motivo_agente           TEXT NULL,
  atendida_por_humano     BOOLEAN NOT NULL,
  ultimo_mensaje_personal TIMESTAMPTZ NULL,
  ultimo_mensaje_cliente  TIMESTAMPTZ NULL,
  -- El mínimo de 6 h también vive aquí: por debajo, el agente retomaría un
  -- carrito viejo (HORAS_PARA_REABRIR).
  horas_configuradas      NUMERIC NOT NULL CHECK (horas_configuradas >= 6),
  horas_sin_personal      NUMERIC NULL,
  revision_nueva          BIGINT NULL,
  identidad_pausa         TEXT NOT NULL,
  -- Resultado del resumen opcional por WhatsApp al encargado
  -- (whatsapp_pausa_vence_aviso_whatsapp). 'aceptado' = Meta aceptó el envío,
  -- NO que se entregó: fuera de la ventana de 24 h el rechazo llega después
  -- por el webhook de estados. 'no_aplica' = simulación o resumen apagado.
  aviso                   TEXT NOT NULL DEFAULT 'pendiente'
                          CHECK (aviso IN ('pendiente', 'aceptado', 'fallido', 'sin_numero', 'no_aplica')),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_pausa_vencimiento_identidad UNIQUE (negocio_id, telefono, modo, identidad_pausa)
);
CREATE INDEX IF NOT EXISTS idx_pausa_vencimientos_conversacion
  ON conversaciones_pausa_vencimientos (negocio_id, telefono, created_at DESC);
COMMENT ON TABLE conversaciones_pausa_vencimientos IS
  'Pausas del bot por conversación que vencieron (o vencerían, en modo simulado) por falta de mensajes del personal: origen, motivo y resultado del resumen opcional al encargado.';
