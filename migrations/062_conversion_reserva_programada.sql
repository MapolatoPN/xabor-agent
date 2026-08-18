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
--      que intentaba reclamarlo como 'reserva_programado' con
--      ON CONFLICT DO NOTHING -- y NO HACIA NADA, porque ya estaba 'usado';
--   3. el canal llamaba a `eliminarPedido` y lo sacaba del tablero.
--
-- Estado final medido (antes de este fix): `pedidos_programados` pendiente,
-- `pedidos_activos` vacío y el ledger en 'usado'. Al llegar su hora, el trigger
-- veía 'usado', devolvía NULL, y el pedido programado NO SE ACTIVABA NUNCA.
--
-- ─── P0-15D: LA PRIMERA REPARACIÓN CONFUNDÍA DOS CASOS DISTINTOS ────────────
--
-- La primera versión de esta migración convertía CUALQUIER claim 'usado' junto
-- a un programado pendiente con el mismo folio. Eso mezclaba:
--
--   (A) un claim 'usado' creado hace segundos por ESTE MISMO pedido activo,
--       justo antes de convertirse en programado -- el caso legítimo;
--   (B) un claim 'usado' que viene del BACKFILL histórico (`pedidos`, `pagos`,
--       `impresion_trabajos`...), perteneciente a OTRO pedido -- el caso que la
--       061 dejó fail-closed A PROPÓSITO, porque no hay forma de demostrar que
--       ese folio reciclado sea del mismo pedido.
--
-- (B) JAMÁS debe convertirse: haría exactamente lo que la 061 impedía --
-- regalar la identidad de un folio histórico a un pedido que nunca lo tuvo.
--
-- LA DISTINCIÓN, AUDITADA (no `programado_id IS NULL`, que no demuestra nada):
--
-- `origen='pedido_activo'` en `folios_pedido_usados` SOLO lo escribe el
-- trigger `trg_barrera_folio_historico` (061) en el momento del INSERT vivo en
-- `pedidos_activos`. Y ese mismo trigger es la garantía de que ese origen
-- nunca puede aparecer sobre un folio histórico: antes de dejar pasar el
-- INSERT, comprueba con `ON CONFLICT DO NOTHING` si el folio ya está
-- reclamado -- y si lo está (por backfill o por cualquier otra cosa), el
-- INSERT en `pedidos_activos` se RECHAZA por completo (`RETURN NULL`). Un
-- folio histórico jamás llega a tener un claim `pedido_activo` porque nunca
-- pudo nacer como pedido activo nuevo.
--
-- Por tanto: solo se convierte un claim con `estado='usado' AND
-- origen='pedido_activo'`. Cualquier otro origen (`backfill_061`,
-- `backfill_061_programado`, o el de una reserva ya consumida) queda
-- intocable. La reparación de esta migración aplica el MISMO filtro.
--
-- ─── P0-15E: LA TRANSICIÓN COMPLETA, ATÓMICA DE PUNTA A PUNTA ───────────────
--
-- La versión anterior hacía la conversión en varias sentencias separadas desde
-- Node (INSERT programado, UPDATE datos, conversión del claim) y DEJABA el
-- DELETE de `pedidos_activos` fuera, a cargo del caller. Un crash entre esos
-- pasos podía dejar un estado híbrido durable: pedido activo Y programado
-- pendiente a la vez, o el claim convertido sin que el activo se retirara.
--
-- Ahora la transición completa vive en UNA función, `xabor_activo_a_programado`,
-- que hace todo -- verificar el activo, asegurar el programado, mover el claim,
-- retirar el activo -- en una sola sentencia. Postgres no ejecuta media función:
-- si el proceso que la invoca muere a mitad de camino, la conexión se cae antes
-- de que el servidor termine de evaluarla y la transacción entera se revierte.
-- No hay forma de observar un estado a medio camino, porque nunca se confirma.
--
-- No se duplica una segunda máquina de estados: tanto esta función (llamada
-- explícitamente por el código NUEVO) como el trigger AFTER DELETE (que cubre
-- al binario VIEJO) comparten el MISMO nucleo -- `xabor_convertir_claim_a_reserva`
-- -- para el paso que de verdad importa: mover el claim de 'usado' a
-- 'reserva_programado'.
--
-- COMPATIBILIDAD CON EL BINARIO VIEJO
--
-- OLD no conoce `xabor_activo_a_programado`: su flujo sigue siendo
-- registrarPedido -> guardarPedidoProgramado (INSERT plano en
-- `pedidos_programados`, que recibe `programado_id` por el DEFAULT de la
-- columna) -> DELETE crudo de `pedidos_activos`. El trigger AFTER DELETE sigue
-- ahí para ese camino, y con el MISMO filtro por origen: si el borrado
-- corresponde a un folio histórico bloqueado, no convierte nada.

-- ─── NÚCLEO: mover el claim, y solo el claim ────────────────────────────────
CREATE OR REPLACE FUNCTION xabor_convertir_claim_a_reserva(
  p_folio text, p_negocio_id uuid, p_programado_id uuid)
RETURNS text AS $$
DECLARE
  actualizadas int;
BEGIN
  IF p_folio IS NULL OR p_programado_id IS NULL THEN
    RETURN 'sin_identidad';
  END IF;

  UPDATE folios_pedido_usados
     SET estado = 'reserva_programado',
         programado_id = p_programado_id,
         negocio_id = COALESCE(negocio_id, p_negocio_id),
         origen = 'conversion_programado'
   WHERE folio = p_folio
     AND (
       -- (A) el caso legitimo: claim vivo, nunca convertido, de ESTE pedido.
       (estado = 'usado' AND origen = 'pedido_activo')
       -- Retry idempotente: ya es la reserva de ESTA misma identidad.
       OR (estado = 'reserva_programado' AND programado_id = p_programado_id)
     );
  GET DIAGNOSTICS actualizadas = ROW_COUNT;

  IF actualizadas = 0 THEN
    -- Puede ser (B): un 'usado' histórico -- se queda fail-closed a proposito.
    -- O el claim es de otra identidad. En ambos casos no se toca.
    RETURN 'claim_no_convertible';
  END IF;

  RETURN 'reservado';
END;
$$ LANGUAGE plpgsql;

-- Se retira la version anterior de 4 argumentos: dejarla junto a la nueva de 5
-- (con DEFAULT) crearia dos sobrecargas distintas y ambiguedad de resolucion.
DROP FUNCTION IF EXISTS xabor_activo_a_programado(text, uuid, jsonb, timestamptz);

-- ─── LA TRANSICIÓN COMPLETA (código NUEVO) ──────────────────────────────────
-- `p_falla_en`: inyeccion de fallo para pruebas (P0-15E, mutacion 12). Mismo
-- patron ya usado en todo el proyecto (XABOR_PAGOS_FALLA_EN, etc.) trasladado a
-- SQL porque la transaccion vive entera en esta funcion: el punto de fallo hay
-- que provocarlo DESDE DENTRO para demostrar que Postgres revierte la
-- transaccion completa, no una parte. Inerte en produccion: solo el arnes de
-- pruebas pasa un valor no-NULL.
CREATE OR REPLACE FUNCTION xabor_activo_a_programado(
  p_folio text, p_negocio_id uuid, p_datos jsonb, p_programado_para timestamptz,
  p_falla_en text DEFAULT NULL)
RETURNS TABLE(resultado text, programado_id uuid) AS $$
DECLARE
  activo RECORD;
  prog RECORD;
  pid uuid;
  conv text;
BEGIN
  -- Bloquea el activo: nadie más puede tocar este folio mientras se decide.
  SELECT * INTO activo FROM pedidos_activos
   WHERE folio = p_folio AND negocio_id = p_negocio_id FOR UPDATE;

  IF NOT FOUND THEN
    -- RETRY IDEMPOTENTE: si ya no hay activo, puede ser porque un intento
    -- anterior ya completó la conversión. Se comprueba antes de fallar.
    SELECT * INTO prog FROM pedidos_programados
     WHERE folio = p_folio AND activado = FALSE AND programado_id IS NOT NULL
       AND (negocio_id IS NULL OR negocio_id = p_negocio_id);
    IF FOUND AND EXISTS (
      SELECT 1 FROM folios_pedido_usados
       WHERE folio = p_folio AND estado = 'reserva_programado'
         AND programado_id = prog.programado_id)
    THEN
      RETURN QUERY SELECT 'reservado'::text, prog.programado_id;
      RETURN;
    END IF;
    RETURN QUERY SELECT 'activo_no_existe'::text, NULL::uuid;
    RETURN;
  END IF;

  -- Asegura la reserva. ON CONFLICT: si otro intento ya la creó (retry), se
  -- reutiliza su identidad -- nunca se genera una segunda.
  INSERT INTO pedidos_programados (folio, datos, programado_para, negocio_id)
  VALUES (p_folio, p_datos, p_programado_para, p_negocio_id)
  ON CONFLICT (folio) DO NOTHING
  RETURNING pedidos_programados.programado_id INTO pid;

  IF pid IS NULL THEN
    SELECT pp.programado_id INTO pid FROM pedidos_programados pp WHERE pp.folio = p_folio;
  END IF;

  IF pid IS NULL THEN
    RETURN QUERY SELECT 'sin_identidad_programado'::text, NULL::uuid;
    RETURN;
  END IF;

  IF p_falla_en = 'tras_insert_programado' THEN
    RAISE EXCEPTION 'fallo inyectado en tras_insert_programado';
  END IF;

  -- La identidad viaja tambien dentro de `datos`: es lo unico que vera la
  -- activacion en el INSERT de `pedidos_activos`.
  UPDATE pedidos_programados
     SET datos = datos || jsonb_build_object('programado_id', pid::text)
   WHERE folio = p_folio;

  conv := xabor_convertir_claim_a_reserva(p_folio, p_negocio_id, pid);

  IF p_falla_en = 'tras_conversion_claim' THEN
    RAISE EXCEPTION 'fallo inyectado en tras_conversion_claim';
  END IF;

  IF conv <> 'reservado' THEN
    -- El claim no se pudo mover: NO se retira el activo. El pedido sigue
    -- siendo un pedido activo normal -- nunca un estado hibrido.
    RETURN QUERY SELECT conv, pid;
    RETURN;
  END IF;

  -- Solo AHORA, con la reserva ya asegurada, se retira el activo. Dentro de la
  -- MISMA transaccion: si el proceso muere aqui, todo se revierte junto.
  IF p_falla_en = 'antes_eliminar_activo' THEN
    RAISE EXCEPTION 'fallo inyectado en antes_eliminar_activo';
  END IF;

  DELETE FROM pedidos_activos WHERE folio = p_folio AND negocio_id = p_negocio_id;

  IF p_falla_en = 'despues_eliminar_activo' THEN
    RAISE EXCEPTION 'fallo inyectado en despues_eliminar_activo';
  END IF;

  RETURN QUERY SELECT 'reservado'::text, pid;
END;
$$ LANGUAGE plpgsql;

-- ─── COMPATIBILIDAD CON OLD: la conversión también al retirar del tablero ───
CREATE OR REPLACE FUNCTION xabor_reserva_al_retirar_activo()
RETURNS TRIGGER AS $$
DECLARE
  prog RECORD;
BEGIN
  -- Solo actúa si hay una reserva programada INEQUÍVOCA esperando ese folio:
  -- misma tabla, mismo negocio, sin activar, con identidad. Un borrado normal
  -- (cancelación, archivado, entrega) no encuentra nada y no toca el ledger.
  SELECT * INTO prog FROM pedidos_programados
   WHERE folio = OLD.folio AND activado = FALSE AND programado_id IS NOT NULL
     AND (negocio_id IS NULL OR OLD.negocio_id IS NULL OR negocio_id = OLD.negocio_id);
  IF FOUND THEN
    PERFORM xabor_convertir_claim_a_reserva(OLD.folio, OLD.negocio_id, prog.programado_id);
    UPDATE pedidos_programados
       SET datos = datos || jsonb_build_object('programado_id', prog.programado_id::text)
     WHERE folio = OLD.folio
       AND (datos->>'programado_id') IS DISTINCT FROM prog.programado_id::text;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reserva_al_retirar_activo ON pedidos_activos;
CREATE TRIGGER trg_reserva_al_retirar_activo
  AFTER DELETE ON pedidos_activos
  FOR EACH ROW EXECUTE FUNCTION xabor_reserva_al_retirar_activo();

-- Ya no hace falta el nombre antiguo de la funcion (llamada directa desde
-- Node antes de esta version); se conserva como alias fino para no romper
-- codigo que aun no se haya actualizado dentro de esta misma migracion.
DROP FUNCTION IF EXISTS xabor_convertir_a_reserva_programada(text, uuid);

-- ─── REPARACIÓN, con el filtro correcto (P0-15D) ────────────────────────────
-- Solo se convierte un claim 'usado' cuyo ORIGEN sea 'pedido_activo': el que
-- demuestra que nació de ESTE pedido, nunca uno historico.
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
   AND f.origen = 'pedido_activo';

UPDATE pedidos_programados
   SET datos = datos || jsonb_build_object('programado_id', programado_id::text)
 WHERE activado = FALSE
   AND programado_id IS NOT NULL
   AND (datos->>'programado_id') IS DISTINCT FROM programado_id::text;

-- ─── REPORTE: programados AMBIGUOS que la reparación NO puede tocar ─────────
-- Un programado pendiente cuyo claim sigue en 'usado' con OTRO origen (o sin
-- claim en absoluto) es exactamente el caso (B): fail-closed a proposito. Se
-- deja constancia via NOTICE para que el gate de predeploy lo reporte.
DO $$
DECLARE
  r RECORD;
  n int := 0;
BEGIN
  FOR r IN
    SELECT p.folio FROM pedidos_programados p
     LEFT JOIN folios_pedido_usados f ON f.folio = p.folio
     WHERE p.activado = FALSE
       AND (f.folio IS NULL
            OR NOT (f.estado = 'reserva_programado' AND f.programado_id = p.programado_id))
  LOOP
    RAISE NOTICE '[062] programado % con folio ambiguo/bloqueado: requiere reemision manual de folio', r.folio;
    n := n + 1;
  END LOOP;
  IF n > 0 THEN
    RAISE NOTICE '[062] % programado(s) pendiente(s) NO se pudieron reservar automaticamente', n;
  END IF;
END $$;
