-- 133 — Bitácora del descuento a quien escribió con el negocio cerrado.
--
-- Decisión de Mario (10-nov-2026), empezando por Acuña: quien escribió en el
-- horario habitual de servicio un día en que estuvimos cerrados recibe, al
-- abrir, un código de descuento para la tienda en línea. Lo manda el job de
-- src/services/descuentoTrasCierre.js, solo en los negocios con
-- `cerrado_descuento_codigo` en su configuración (apagado por omisión).
--
-- Cada fila es UN envío. La fila se aparta ANTES de mandar el mensaje: el
-- UNIQUE (negocio, teléfono) garantiza que cada cliente lo recibe una sola
-- vez, aunque dos instancias corran a la vez durante un despliegue. Un envío
-- fallido se queda como 'fallido' y no se reintenta; uno que quedó en
-- 'enviando' (el proceso murió a media llamada) tampoco: pudo haber salido.
--
-- 'aceptado' = Meta aceptó el envío, NO que se entregó: el estado de entrega
-- llega después por el webhook, con el `wamid` de aquí.
--
-- Aditiva e idempotente: una tabla nueva y vacía. No toca ningún mensaje,
-- conversación, promoción ni pedido.
CREATE TABLE IF NOT EXISTS descuento_tras_cierre_envios (
  id                 BIGSERIAL PRIMARY KEY,
  negocio_id         UUID NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  telefono           TEXT NOT NULL,
  codigo             TEXT NOT NULL,
  -- El primer mensaje del cliente que llegó en horario habitual con el
  -- negocio cerrado.
  mensaje_cliente_at TIMESTAMPTZ NOT NULL,
  estado             TEXT NOT NULL DEFAULT 'enviando'
                     CHECK (estado IN ('enviando', 'aceptado', 'fallido')),
  wamid              TEXT NULL,
  error              TEXT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_descuento_tras_cierre_telefono UNIQUE (negocio_id, telefono)
);
CREATE INDEX IF NOT EXISTS idx_descuento_tras_cierre_fecha
  ON descuento_tras_cierre_envios (negocio_id, created_at DESC);
COMMENT ON TABLE descuento_tras_cierre_envios IS
  'Descuentos enviados al abrir a quien escribió en horario habitual con el negocio cerrado: uno por cliente y negocio, apartado antes de enviar.';
