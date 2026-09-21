-- ============================================================
-- XABOR — Migración 086: estado autoritativo de pedidos activos.
--
-- Incidente XAB-0458: el pago cambió pedidos_activos.estado a `nuevo` y la
-- comanda sí salió, pero datos.estado conservó `pendiente_pago`. Después de
-- recuperar el proceso, el tablero podía reconstruir la fotografía vieja y
-- ocultar el pedido aunque cocina ya lo estuviera preparando.
--
-- La columna SQL sigue siendo la autoridad. Esta migración repara las
-- fotografías existentes y mantiene ambos valores alineados ante cualquier
-- INSERT o cambio posterior. No cambia el estado SQL de ningún pedido.
-- Reejecutable.
-- ============================================================

CREATE OR REPLACE FUNCTION sincronizar_estado_json_pedido_activo()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.estado IS NULL THEN
    RAISE EXCEPTION 'pedidos_activos.estado no puede ser NULL para el folio %', NEW.folio;
  END IF;

  NEW.datos := jsonb_set(
    COALESCE(NEW.datos, '{}'::jsonb),
    '{estado}',
    to_jsonb(NEW.estado::text),
    true
  );
  RETURN NEW;
END;
$$;

-- El UPDATE sólo toca la copia JSON; el estado SQL permanece intacto.
UPDATE pedidos_activos
   SET datos = jsonb_set(datos, '{estado}', to_jsonb(estado::text), true)
 WHERE datos->>'estado' IS DISTINCT FROM estado;

DROP TRIGGER IF EXISTS trg_pedidos_activos_estado_json ON pedidos_activos;
CREATE TRIGGER trg_pedidos_activos_estado_json
BEFORE INSERT OR UPDATE OF estado, datos ON pedidos_activos
FOR EACH ROW
EXECUTE FUNCTION sincronizar_estado_json_pedido_activo();
