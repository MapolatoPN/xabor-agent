-- ============================================================
-- XABOR Multiempresa — Migración 032
-- Notificaciones a repartidores: registro de intentos y estado real de
-- entrega (sent/delivered/read/failed vía Meta), en vez de asumir éxito
-- solo porque la llamada HTTP a Meta respondió 2xx.
--
-- Contexto (diagnóstico de producción, Nonna Maye): Xabor enviaba texto
-- libre a los repartidores y registraba "Notificación enviada" con solo
-- que Meta aceptara la petición -- sin verificar entrega real ni procesar
-- los webhooks de estado que Meta manda después. Esta tabla es el
-- registro que permite saber, por cada intento, si Meta lo aceptó, si se
-- entregó, si se leyó, o si falló (y con qué código/detalle).
--
-- Reejecutable: IF NOT EXISTS en todo.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS notificaciones_repartidor (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id     UUID NOT NULL REFERENCES negocios(id) ON DELETE RESTRICT,
  -- Sin FK a pedidos_activos(folio) a propósito: registrarPedido() persiste
  -- el pedido en segundo plano (guardarPedidoActivo, sin await) y
  -- emitirPedido() dispara esta notificación también en segundo plano, sin
  -- ningún orden garantizado entre ambas -- es una condición de carrera ya
  -- existente en el código de pedidos, ajena a esta migración. Una FK aquí
  -- podría hacer fallar el INSERT de esta fila si la notificación gana la
  -- carrera, perdiendo justo el registro que se quiere garantizar.
  pedido_folio   VARCHAR NOT NULL,
  repartidor_id  INTEGER NOT NULL REFERENCES repartidores(id) ON DELETE RESTRICT,
  -- 'plantilla' es el canal correcto para mensajes de negocio iniciados
  -- fuera de la ventana de 24h de servicio al cliente (ver diagnóstico) --
  -- 'texto_libre' se conserva como valor válido solo para no romper filas
  -- que pudieran insertarse manualmente en un escenario de depuración,
  -- nunca es lo que el código nuevo usa por defecto.
  canal          TEXT NOT NULL DEFAULT 'plantilla' CHECK (canal IN ('plantilla', 'texto_libre')),
  -- wamid: id de mensaje que devuelve Meta al aceptar el envío. Es la
  -- llave para poder correlacionar el webhook de status (sent/delivered/
  -- read/failed) que llega después, de forma asíncrona, con esta fila.
  wamid          TEXT,
  estado         TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN (
                   'pendiente', 'aceptado_meta', 'entregado', 'leido', 'fallido', 'error_envio'
                 )),
  error_codigo   TEXT,
  error_detalle  TEXT,
  intento_numero INTEGER NOT NULL DEFAULT 1,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notificaciones_repartidor_pedido
  ON notificaciones_repartidor (pedido_folio);

CREATE INDEX IF NOT EXISTS idx_notificaciones_repartidor_repartidor
  ON notificaciones_repartidor (repartidor_id);

CREATE INDEX IF NOT EXISTS idx_notificaciones_repartidor_negocio
  ON notificaciones_repartidor (negocio_id);

-- Único parcial: solo cuando wamid ya se resolvió (no todos los intentos
-- fallidos antes de la llamada a Meta tienen uno) -- es la llave real que
-- usa el webhook de status para encontrar esta fila.
CREATE UNIQUE INDEX IF NOT EXISTS idx_notificaciones_repartidor_wamid
  ON notificaciones_repartidor (wamid)
  WHERE wamid IS NOT NULL;

DROP TRIGGER IF EXISTS set_updated_at ON notificaciones_repartidor;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON notificaciones_repartidor
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
