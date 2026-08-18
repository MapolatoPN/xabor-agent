-- ─── 061: el folio se RECLAMA, no se consulta ───────────────────────────────
-- Idempotente y re-ejecutable.
--
-- LOS DOS AGUJEROS QUE CIERRA
--
-- (A) LA EXCEPCIÓN DE PROGRAMADOS ERA POR FOLIO A SECAS.
--
-- La 060 dejaba pasar cualquier INSERT cuyo folio estuviera reservado por un
-- programado sin activar. Eso demuestra "alguien reservó este número", no "este
-- INSERT es la activación de ESA reserva". Un pedido cualquiera del binario
-- viejo, con otro cliente y hasta de otro negocio, entraba por esa puerta.
--
-- Y no había con qué cerrarla: `pedidos_programados` tenía `folio` como PK,
-- `negocio_id` nullable y ninguna otra identidad estable. Se crea una:
-- `programado_id`, que viaja también dentro de `datos` del pedido, de modo que
-- la activación pueda demostrar "soy exactamente esta reserva".
--
-- (B) LA BARRERA MIRABA SOLO `pedidos`.
--
-- La 059 ya reconocía que un folio puede sobrevivir en 12 tablas distintas
-- --pagos, impresion_trabajos, tienda_pedidos, promociones, rewards...-- porque
-- este sistema tuvo persistencias best-effort y las fuentes divergen. Un folio
-- huérfano en `pagos` o en `impresion_trabajos`, sin fila en `pedidos`, pasaba
-- la barrera de la 060 y volvía a emitirse.
--
-- LA SOLUCIÓN: UN LEDGER DE CLAIMS
--
-- La pregunta deja de ser "¿aparece este folio en alguna tabla?" --12 consultas
-- por INSERT, y siempre incompletas-- y pasa a ser "¿esta identidad de folio ya
-- fue reclamada, y por quién?".
--
-- `folios_pedido_usados` con el folio como PRIMARY KEY. El claim es un
-- INSERT ... ON CONFLICT DO NOTHING: atómico por definición, sin ventana entre
-- comprobar y actuar. Dos procesos que intenten el mismo folio a la vez se
-- serializan en la PK y solo uno gana.

CREATE TABLE IF NOT EXISTS folios_pedido_usados (
  folio          text PRIMARY KEY,
  negocio_id     uuid,
  -- 'usado'                el folio ya pertenece a un pedido: nadie más lo toma;
  -- 'reserva_programado'   reservado por un programado que aún no se activa.
  estado         text NOT NULL DEFAULT 'usado',
  -- Identidad de la reserva. Solo el INSERT que la presente puede consumirla.
  programado_id  uuid,
  origen         text,
  created_at     timestamptz NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE folios_pedido_usados ADD CONSTRAINT chk_folio_usado_estado
    CHECK (estado IN ('usado', 'reserva_programado'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Identidad estable de la reserva programada. Los programados que ya existían
-- reciben una al vuelo: sin ella no podrían demostrar nada al activarse.
ALTER TABLE pedidos_programados ADD COLUMN IF NOT EXISTS programado_id uuid;
UPDATE pedidos_programados SET programado_id = gen_random_uuid() WHERE programado_id IS NULL;
ALTER TABLE pedidos_programados ALTER COLUMN programado_id SET DEFAULT gen_random_uuid();

-- ─── BACKFILL: todas las fuentes que la 059 ya reconocía ────────────────────
-- Un folio que aparezca en cualquiera de ellas ya perteneció a un pedido.
INSERT INTO folios_pedido_usados (folio, negocio_id, estado, origen)
SELECT f.folio,
       (array_agg(f.negocio_id) FILTER (WHERE f.negocio_id IS NOT NULL))[1],
       'usado', 'backfill_061'
  FROM (
    SELECT folio, negocio_id FROM pedidos_activos WHERE folio ~ '^XAB-[0-9]+$'
    UNION ALL SELECT folio, negocio_id FROM pedidos WHERE folio ~ '^XAB-[0-9]+$'
    UNION ALL SELECT pedido_folio, negocio_id FROM pagos WHERE pedido_folio ~ '^XAB-[0-9]+$'
    UNION ALL SELECT folio, negocio_id FROM compras_reales WHERE folio ~ '^XAB-[0-9]+$'
    UNION ALL SELECT pedido_folio, negocio_id FROM tienda_pedidos WHERE pedido_folio ~ '^XAB-[0-9]+$'
    UNION ALL SELECT pedido_folio, negocio_id FROM tienda_promocion_usos WHERE pedido_folio ~ '^XAB-[0-9]+$'
    UNION ALL SELECT pedido_folio, NULL::uuid FROM notificaciones_repartidor WHERE pedido_folio ~ '^XAB-[0-9]+$'
    UNION ALL SELECT folio_venta, negocio_id FROM rewards_movements WHERE folio_venta ~ '^XAB-[0-9]+$'
    UNION ALL SELECT folio_pedido, negocio_id FROM oportunidades WHERE folio_pedido ~ '^XAB-[0-9]+$'
    UNION ALL SELECT venta_folio, negocio_id FROM restaurante_cuentas WHERE venta_folio ~ '^XAB-[0-9]+$'
    UNION ALL SELECT origen_id, negocio_id FROM impresion_trabajos WHERE origen_id ~ '^XAB-[0-9]+$'
  ) f
 WHERE f.folio IS NOT NULL
 GROUP BY f.folio
ON CONFLICT (folio) DO NOTHING;

-- Los programados SIN activar entran como RESERVA, con su identidad, para poder
-- activarse después. Solo si su folio no fue ya usado por otro pedido: en ese
-- caso la fila 'usado' del backfill anterior gana y el programado quedará
-- bloqueado a propósito -- fail closed. Reutilizar ese número volvería a romper
-- panel, impresión, pagos y compras, y no hay forma de demostrar que la fila
-- histórica sea suya.
INSERT INTO folios_pedido_usados (folio, negocio_id, estado, programado_id, origen)
SELECT p.folio, p.negocio_id, 'reserva_programado', p.programado_id, 'backfill_061_programado'
  FROM pedidos_programados p
 WHERE p.activado = FALSE AND p.folio ~ '^XAB-[0-9]+$'
ON CONFLICT (folio) DO NOTHING;

-- ─── LA BARRERA, ahora por CLAIM ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION xabor_barrera_folio_historico()
RETURNS TRIGGER AS $$
DECLARE
  reclamado RECORD;
  id_presentado uuid;
BEGIN
  IF NEW.folio IS NULL OR NEW.folio !~ '^XAB-[0-9]+$' THEN
    RETURN NEW;
  END IF;

  -- CLAIM ATÓMICO. Sin ventana entre comprobar y actuar: si esta fila entra, el
  -- folio es de este pedido y de nadie más.
  INSERT INTO folios_pedido_usados (folio, negocio_id, estado, origen)
  VALUES (NEW.folio, NEW.negocio_id, 'usado', 'pedido_activo')
  ON CONFLICT (folio) DO NOTHING;

  IF FOUND THEN
    RETURN NEW;
  END IF;

  -- El folio ya estaba reclamado. La única forma de pasar es demostrar que este
  -- INSERT es la activación de esa reserva concreta.
  SELECT * INTO reclamado FROM folios_pedido_usados WHERE folio = NEW.folio;

  IF reclamado.estado = 'reserva_programado' THEN
    BEGIN
      id_presentado := (NEW.datos->>'programado_id')::uuid;
    EXCEPTION WHEN others THEN
      id_presentado := NULL;
    END;

    IF id_presentado IS NOT NULL
       AND reclamado.programado_id IS NOT NULL
       AND id_presentado = reclamado.programado_id
       -- El tenant también tiene que coincidir: una reserva del negocio A no
       -- autoriza a insertar un pedido del negocio B.
       AND (reclamado.negocio_id IS NULL OR reclamado.negocio_id = NEW.negocio_id)
    THEN
      -- La reserva se consume: de aquí en adelante el folio es 'usado' y nadie
      -- --ni una segunda activación-- vuelve a entrar por esta puerta.
      UPDATE folios_pedido_usados
         SET estado = 'usado', negocio_id = COALESCE(negocio_id, NEW.negocio_id)
       WHERE folio = NEW.folio;
      RETURN NEW;
    END IF;

    RAISE NOTICE '[061] folio % rechazado: hay reserva programada pero este INSERT no la demuestra', NEW.folio;
    RETURN NULL;
  END IF;

  RAISE NOTICE '[061] folio % rechazado: ya reclamado por otro pedido', NEW.folio;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_barrera_folio_historico ON pedidos_activos;
CREATE TRIGGER trg_barrera_folio_historico
  BEFORE INSERT ON pedidos_activos
  FOR EACH ROW EXECUTE FUNCTION xabor_barrera_folio_historico();

CREATE INDEX IF NOT EXISTS idx_folios_usados_estado
  ON folios_pedido_usados (estado) WHERE estado = 'reserva_programado';
