-- ─── 077: el webhook deja de acusar recibo antes de guardar ────────────────
-- Idempotente y re-ejecutable.
--
-- EL DEFECTO
--
-- `router.post('/')` respondía `200` a Meta ANTES de escribir nada. Si el
-- proceso moría en esa ventana --un despliegue, un OOM, Railway moviendo el
-- contenedor-- el mensaje no existía para nadie. Y lo peor no es la ventana:
-- es que Meta YA recibió su 200, así que NO lo reintenta. El cliente escribió
-- y nadie se enteró nunca.
--
-- La reentrega que sí ocurre --cuando Meta no recibe el 200 a tiempo-- ya está
-- cubierta aparte: `guardarMensaje` marca `yaExistia` y el flujo corta. Esto es
-- el otro lado del mismo problema.
--
-- LO QUE GUARDA
--
-- El SOBRE crudo, tal como llegó, con su identificador externo. No el mensaje
-- interpretado: eso es trabajo posterior y puede fallar por mil motivos. Aquí
-- solo importa poder decir "esto entró" con el proceso ya muerto.
--
-- POR QUÉ NO ES UNA COLA DE TRABAJO
--
-- No lo es a propósito. `colaMensajes` ya serializa los turnos de una
-- conversación y `pedido_emisiones` ya garantiza que una comanda llegue a
-- cocina. Meter aquí una tercera máquina de estados crearía una segunda ruta
-- hacia el mismo efecto, que es justo lo que la 063 existe para impedir.
--
-- Esta tabla responde UNA pregunta: ¿se recibió, y se terminó de procesar? El
-- arranque puede así retomar lo que quedó a medias.

CREATE TABLE IF NOT EXISTS webhook_entrante (
  id            bigserial   PRIMARY KEY,
  canal         text        NOT NULL DEFAULT 'whatsapp',
  -- Identificador externo del sobre. Se deriva de los wamids que trae dentro,
  -- así que una reentrega del MISMO sobre choca aquí y no se procesa dos veces.
  referencia    text        NOT NULL,
  payload       jsonb       NOT NULL,
  estado        text        NOT NULL DEFAULT 'pendiente'
                            CHECK (estado IN ('pendiente','procesado','fallido')),
  intentos      int         NOT NULL DEFAULT 0,
  ultimo_error  text,
  recibido_at   timestamptz NOT NULL DEFAULT NOW(),
  procesado_at  timestamptz
);

-- Una reentrega del mismo sobre no crea una segunda fila. Es la misma
-- estrategia que `mensajes.message_id_externo`, un nivel más arriba.
CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_entrante_referencia
  ON webhook_entrante (canal, referencia);

-- Lo que el arranque necesita barrer: lo que quedó pendiente, lo más viejo
-- primero.
CREATE INDEX IF NOT EXISTS idx_webhook_entrante_pendiente
  ON webhook_entrante (estado, recibido_at) WHERE estado = 'pendiente';

COMMENT ON TABLE webhook_entrante IS
  'Constancia durable de que un sobre del webhook ENTRÓ, escrita antes de acusar recibo. No es una cola de trabajo: colaMensajes y pedido_emisiones siguen siendo los mecanismos de proceso y de entrega.';
