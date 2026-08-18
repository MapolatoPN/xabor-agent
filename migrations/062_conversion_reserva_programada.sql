-- ─── 062: convertir un pedido activo en RESERVA programada ──────────────────
-- Idempotente y re-ejecutable.
--
-- EL DEFECTO (P0-15C), reproducido con el flujo productivo
--
-- Un pedido programado NO nace como reserva: nace como pedido activo normal.
--
--   1. `registrarPedido` INSERTa en `pedidos_activos` -> el trigger de la 061
--      reclama el folio con estado 'usado', origen 'pedido_activo';
--   2. el canal ve `pedido.programado_para` y llama a `guardarPedidoProgramado`,
--      que intenta reclamarlo como 'reserva_programado' con
--      ON CONFLICT DO NOTHING -- y NO HACE NADA, porque ya está 'usado';
--   3. el canal llama a `eliminarPedido` y lo saca del tablero.
--
-- Estado final medido: `pedidos_programados` pendiente, `pedidos_activos` vacío
-- y el ledger en 'usado'. Al llegar su hora, el trigger ve 'usado', devuelve
-- NULL, y el pedido programado NO SE ACTIVA NUNCA. Confirmado en la base local:
-- `insertado=false`, sin ocupante de esa identidad.
--
-- Y `guardarPedidoProgramado` devolvía `ok:true, nueva:true` mientras el claim
-- seguía en 'usado': afirmaba una reserva que no existía.
--
-- LA TRANSICIÓN, ATÓMICA
--
-- `xabor_convertir_a_reserva_programada` hace la conversión completa en una sola
-- sentencia: comprueba que hay una reserva INEQUÍVOCA para ese folio --misma
-- tabla, mismo negocio, sin activar, con `programado_id`-- y mueve el claim de
-- 'usado' a 'reserva_programado' con esa identidad. Devuelve qué pasó, para que
-- el llamador no pueda "suponer" que salió bien.
--
-- No hay estado durable a mitad de camino: o el claim es una reserva completa y
-- activable, o sigue siendo un pedido activo normal.
--
-- COMPATIBILIDAD CON EL BINARIO VIEJO
--
-- La 061 se aplica mientras OLD puede seguir vivo, y OLD no conoce este helper:
-- su flujo es registrarPedido -> guardarPedidoProgramado -> eliminar activo. Si
-- la conversión viviera solo en el código nuevo, todo programado creado por OLD
-- durante la ventana quedaría inactivable para siempre.
--
-- Por eso la garantía va también en la base: un trigger AFTER DELETE sobre
-- `pedidos_activos` intenta la misma conversión. Se dispara SOLO cuando existe
-- una reserva inequívoca, así que un borrado normal --cancelar, archivar,
-- entregar-- no convierte nada: sin fila en `pedidos_programados` pendiente para
-- ese folio y negocio, el trigger no toca el ledger.

CREATE OR REPLACE FUNCTION xabor_convertir_a_reserva_programada(
  p_folio text, p_negocio_id uuid)
RETURNS text AS $$
DECLARE
  prog RECORD;
  actualizadas int;
BEGIN
  IF p_folio IS NULL OR p_folio !~ '^XAB-[0-9]+$' THEN
    RETURN 'folio_no_aplica';
  END IF;

  -- La reserva tiene que ser INEQUÍVOCA: misma tabla, mismo negocio, sin
  -- activar y con identidad. Cualquier otra cosa no autoriza a tocar el claim.
  SELECT * INTO prog FROM pedidos_programados
   WHERE folio = p_folio
     AND activado = FALSE
     AND programado_id IS NOT NULL
     AND (negocio_id IS NULL OR p_negocio_id IS NULL OR negocio_id = p_negocio_id);

  IF NOT FOUND THEN
    RETURN 'sin_reserva';
  END IF;

  -- Solo se convierte un claim que sea de ESTE pedido activo. Si ya es una
  -- reserva --retry-- se comprueba que sea la MISMA, y se deja como está.
  UPDATE folios_pedido_usados
     SET estado = 'reserva_programado',
         programado_id = prog.programado_id,
         negocio_id = COALESCE(negocio_id, prog.negocio_id, p_negocio_id),
         origen = 'conversion_programado'
   WHERE folio = p_folio
     -- 'usado' se convierte SOLO si el claim no lleva ya la identidad de esta
     -- reserva. Si la lleva, es que esta reserva YA se activo y su pedido se
     -- purgo despues del tablero: reconvertirla dejaria el folio disponible
     -- para una SEGUNDA activacion del mismo programado.
     AND ((estado = 'usado'
           AND (programado_id IS NULL OR programado_id <> prog.programado_id))
          OR (estado = 'reserva_programado' AND programado_id = prog.programado_id));
  GET DIAGNOSTICS actualizadas = ROW_COUNT;

  IF actualizadas = 0 THEN
    -- O el claim es de otra reserva, o es de ESTA pero ya consumida. En ambos
    -- casos no se toca.
    RETURN 'claim_no_convertible';
  END IF;

  -- La identidad también tiene que quedar en `datos`, que es lo único que viaja
  -- hasta el INSERT de la activación.
  UPDATE pedidos_programados
     SET datos = datos || jsonb_build_object('programado_id', prog.programado_id::text)
   WHERE folio = p_folio
     AND (datos->>'programado_id') IS DISTINCT FROM prog.programado_id::text;

  RETURN 'reservado';
END;
$$ LANGUAGE plpgsql;

-- ─── COMPATIBILIDAD CON OLD: la conversión también al retirar del tablero ───
CREATE OR REPLACE FUNCTION xabor_reserva_al_retirar_activo()
RETURNS TRIGGER AS $$
BEGIN
  -- Solo actúa si hay una reserva programada inequívoca esperando ese folio.
  -- Un borrado normal (cancelación, archivado, entrega) no encuentra nada y no
  -- toca el ledger.
  PERFORM xabor_convertir_a_reserva_programada(OLD.folio, OLD.negocio_id);
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reserva_al_retirar_activo ON pedidos_activos;
CREATE TRIGGER trg_reserva_al_retirar_activo
  AFTER DELETE ON pedidos_activos
  FOR EACH ROW EXECUTE FUNCTION xabor_reserva_al_retirar_activo();

-- ─── REPARACIÓN de los programados que ya quedaron huérfanos ────────────────
-- Cualquier programado pendiente cuyo claim siga en 'usado' es exactamente el
-- defecto de arriba: se convierte para que pueda activarse.
UPDATE folios_pedido_usados f
   SET estado = 'reserva_programado',
       programado_id = p.programado_id,
       negocio_id = COALESCE(f.negocio_id, p.negocio_id),
       origen = 'reparacion_062'
  FROM pedidos_programados p
 WHERE f.folio = p.folio
   AND p.activado = FALSE
   AND p.programado_id IS NOT NULL
   AND f.estado = 'usado'
   -- Mismo criterio: si el claim ya lleva la identidad de esta reserva, es que
   -- se activo y no debe volver a abrirse.
   AND (f.programado_id IS NULL OR f.programado_id <> p.programado_id);

UPDATE pedidos_programados
   SET datos = datos || jsonb_build_object('programado_id', programado_id::text)
 WHERE activado = FALSE
   AND programado_id IS NOT NULL
   AND (datos->>'programado_id') IS DISTINCT FROM programado_id::text;
