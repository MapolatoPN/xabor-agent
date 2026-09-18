-- ─── 080: identidad durable de los pedidos que nacen en otra plataforma ───
-- Idempotente y re-ejecutable.
--
-- EL DEFECTO
--
-- Un pedido de Rappi solo conocía su identidad externa dentro del JSON de
-- `pedidos_activos` (`datos->>'rappi_order_id'`), sin índice ni restricción.
-- La deduplicación vivía en memoria: `obtenerPedidos(negocioId).some(...)`.
-- Eso deja dos agujeros que producción ya evidenció (SAMPLE-ORDER-0001 existe
-- tres veces para el mismo negocio):
--
--   1. dos webhooks simultáneos pasan la comprobación antes de que el primero
--      inserte, y nacen dos pedidos con dos folios;
--   2. una reentrega tardía --cuando el pedido ya se entregó y salió de la
--      memoria-- vuelve a crear el pedido desde cero.
--
-- LO QUE GUARDA
--
-- Una fila por (negocio, canal, id_externo): la constancia de que ESA orden
-- de ESA plataforma entró a ESTE negocio, con el sobre crudo, el folio que le
-- tocó en Xabor y en qué quedó frente al proveedor (aceptada o no). Se
-- escribe ANTES de acusar recibo, igual que `webhook_entrante` (077) para
-- WhatsApp: si el proceso muere después del 200, el arranque recupera lo que
-- quedó en 'reclamado'.
--
-- La restricción UNIQUE es la garantía: dos procesos que reciban la misma
-- orden a la vez solo pueden insertar una fila. El que no insertó lee el
-- estado de la que ya existe y decide (ver pedidosExternos.js).
--
-- POR QUÉ NO ES `webhook_entrante`
--
-- Esa tabla responde "¿este sobre entró?" y su referencia es el sobre. Aquí
-- la identidad es la ORDEN, y lo que importa es a qué pedido de Xabor quedó
-- ligada y si el proveedor la tiene por aceptada. Son preguntas distintas y
-- se responden en tablas distintas para no mezclar dos ciclos de vida.

CREATE TABLE IF NOT EXISTS pedidos_externos (
  id                    bigserial   PRIMARY KEY,
  negocio_id            uuid        NOT NULL REFERENCES negocios(id) ON DELETE RESTRICT,
  canal                 text        NOT NULL CHECK (canal ~ '^[a-z][a-z0-9_]*$'),
  id_externo            text        NOT NULL CHECK (length(trim(id_externo)) > 0),
  -- reclamado: entró y se está procesando (o el proceso murió a medias).
  -- creado:    ya existe el pedido de Xabor (folio) -- una reentrega se ignora.
  -- fallido:   no se pudo crear el pedido; un reintento puede volver a tomarla.
  -- cancelado: el proveedor canceló la orden (con o sin pedido creado antes).
  estado                text        NOT NULL DEFAULT 'reclamado'
                                    CHECK (estado IN ('reclamado','creado','fallido','cancelado')),
  folio                 text        NULL,
  payload               jsonb       NOT NULL,
  -- Aceptación frente al proveedor (Rappi: PUT /orders/{id}/take).
  -- NULL = no se ha intentado; TRUE/FALSE = resultado del último intento.
  aceptado_en_proveedor boolean     NULL,
  aceptacion_error      text        NULL,
  -- Notificación "listo" al proveedor (Rappi: ready-for-pickup, que limita a
  -- tres llamadas por orden): se registra para no repetirla.
  listo_notificado_at   timestamptz NULL,
  cancelacion           jsonb       NULL,
  ultimo_error          text        NULL,
  intentos              int         NOT NULL DEFAULT 1,
  reentregas            int         NOT NULL DEFAULT 0,
  recibido_at           timestamptz NOT NULL DEFAULT NOW(),
  actualizado_at        timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (negocio_id, canal, id_externo)
);

-- Lo que el reconciliador barre: lo que quedó reclamado sin terminar y lo
-- que falló, lo más viejo primero.
CREATE INDEX IF NOT EXISTS idx_pedidos_externos_pendientes
  ON pedidos_externos (canal, recibido_at)
  WHERE estado IN ('reclamado','fallido');

-- Del folio al id externo (cancelaciones y "listo" desde el panel).
CREATE INDEX IF NOT EXISTS idx_pedidos_externos_folio
  ON pedidos_externos (negocio_id, folio)
  WHERE folio IS NOT NULL;

COMMENT ON TABLE pedidos_externos IS
  'Identidad durable de cada orden que nace en una plataforma externa (Rappi): una fila por (negocio, canal, id_externo), escrita antes de acusar recibo. Es la única deduplicación de pedidos externos; la memoria del tablero no cuenta.';
