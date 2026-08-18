-- ─── 060: ningún folio ya usado vuelve a entrar al tablero ──────────────────
-- Idempotente y re-ejecutable.
--
-- POR QUÉ NO BASTABA LA 059
--
-- La 059 hace que el binario NUEVO no recicle folios. Pero durante el deploy el
-- binario VIEJO sigue vivo, y su allocator no consulta la base en cada pedido:
-- al arrancar hace `obtenerMaxFolioNum()` --MAX sobre `pedidos_activos` y nada
-- más-- y guarda `contadorPedidos = max + 1` EN MEMORIA.
--
-- Escenario reproducido en `test/fase-cutover-059.mjs`:
--
--   · `pedidos` conserva XAB-0091..0100, ya purgados del tablero;
--   · el tablero llega solo a XAB-0090;
--   · OLD arrancó antes de la 059 -> su contador quedó en 91;
--   · se aplica la 059 -> NEW arranca en 101;
--   · OLD, sin reiniciar, propone XAB-0091.
--
-- `UNIQUE (pedidos_activos.folio)` NO lo bloquea, porque XAB-0091 no está
-- ACTIVO: solo existe en el histórico. El INSERT entraba, y ese número pasaba a
-- pertenecer a dos pedidos distintos -- rompiendo el dedupe del panel, la
-- idempotencia de Edge, los pagos, las promociones y las compras reales.
--
-- LA BARRERA
--
-- Un trigger BEFORE INSERT que devuelve NULL cuando el folio YA fue usado por
-- otro pedido. Devolver NULL cancela la fila SIN lanzar excepción, así que
-- encaja exactamente en el contrato que ya existe: `guardarPedidoActivo`
-- (database.js:1859) mira `rowCount` y trata 0 como CONFLICTO, y
-- `registrarPedido` --el binario viejo y el nuevo, porque ese código no
-- cambió-- reintenta con el siguiente candidato o falla cerrado con
-- FOLIO_NO_DISPONIBLE. Nunca adopta el pedido ajeno ni confirma sin fila propia.
--
-- Así OLD converge solo: reintenta 91, 92... hasta salir del rango histórico.
--
-- QUÉ NO PUEDE ROMPER
--
-- PEDIDOS PROGRAMADOS. Un programado reserva su folio al crearse y lo activa
-- horas o días después, insertándolo en `pedidos_activos` con ese mismo número
-- (server.js:7480). Si el trigger mirara solo "¿este folio ya existió?", un
-- programado legítimo de antes de la 059 quedaría bloqueado para siempre. Por
-- eso la excepción explícita: si el folio está en `pedidos_programados` sin
-- activar, PASA.
--
-- REEMISIÓN DEL MISMO PEDIDO. El `ON CONFLICT (folio) DO NOTHING` del INSERT
-- sigue delante para lo que ya está activo; el trigger solo añade el histórico.
--
-- VIGENCIA
--
-- La barrera es permanente y barata (dos índices ya existentes). Con la 059 en
-- marcha ningún folio nuevo puede chocar, así que en régimen normal el trigger
-- no rechaza nada: solo existe para que la VENTANA DE CUTOVER sea segura y para
-- que un rollback al binario viejo no reabra P0-13.

CREATE OR REPLACE FUNCTION xabor_barrera_folio_historico()
RETURNS TRIGGER AS $$
BEGIN
  -- Solo aplica al formato de folio de pedidos. Ventas de restaurante (RM-...)
  -- y cualquier otro esquema pasan sin tocarse.
  IF NEW.folio IS NULL OR NEW.folio !~ '^XAB-[0-9]+$' THEN
    RETURN NEW;
  END IF;

  -- Excepción: un pedido PROGRAMADO reservó este folio y todavía no se activa.
  -- Es su única oportunidad de entrar al tablero y es legítima.
  IF EXISTS (SELECT 1 FROM pedidos_programados p
              WHERE p.folio = NEW.folio AND p.activado = FALSE) THEN
    RETURN NEW;
  END IF;

  -- El folio ya perteneció a un pedido: cancelar la fila sin excepción.
  -- rowCount = 0 -> el llamador lo lee como conflicto y reintenta.
  IF EXISTS (SELECT 1 FROM pedidos h WHERE h.folio = NEW.folio) THEN
    RAISE NOTICE '[060] folio % rechazado: ya pertenece a un pedido historico', NEW.folio;
    RETURN NULL;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_barrera_folio_historico ON pedidos_activos;
CREATE TRIGGER trg_barrera_folio_historico
  BEFORE INSERT ON pedidos_activos
  FOR EACH ROW EXECUTE FUNCTION xabor_barrera_folio_historico();

-- El trigger consulta `pedidos.folio` y `pedidos_programados.folio` en cada
-- INSERT de pedido: sin índice eso sería un seq scan por pedido.
CREATE INDEX IF NOT EXISTS idx_pedidos_folio_barrera ON pedidos (folio);
CREATE INDEX IF NOT EXISTS idx_prog_folio_barrera
  ON pedidos_programados (folio) WHERE activado = FALSE;
