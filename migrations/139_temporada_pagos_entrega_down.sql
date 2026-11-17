-- Reversa de la 139 (pedidos de temporada: pagos, entrega, captura y bitácora).
--
-- ANTES DE CORRERLA: revertir primero el código que la usa (/temporada y
-- /api/admin/temporada/*). El código anterior no lee nada de la 139: revertir
-- el código basta, y esta reversa es opcional.
--
-- Se corre con psql:  psql "$CONN" -f migrations/139_temporada_pagos_entrega_down.sql
-- Todo o nada: ON_ERROR_STOP propio y BEGIN/COMMIT.
--
-- Falla (a propósito) si ya hay pagos registrados, entradas en la bitácora,
-- pedidos capturados en el panel o pedidos que avanzaron en la entrega: se
-- perdería quién cobró qué, quién cambió qué y en qué va cada pedido.
-- Respaldarlos antes si de todos modos hay que revertir:
--   psql "$CONN" -c "\copy (SELECT * FROM temporada_pagos) TO 'temporada_pagos.csv' CSV HEADER"
--   psql "$CONN" -c "\copy (SELECT * FROM temporada_bitacora) TO 'temporada_bitacora.csv' CSV HEADER"
\set ON_ERROR_STOP on

BEGIN;

LOCK TABLE temporada_campanas, temporada_pedidos IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF to_regclass('public.temporada_pagos') IS NOT NULL AND EXISTS (SELECT 1 FROM temporada_pagos) THEN
    RAISE EXCEPTION 'La reversa de la 139 no corre: hay pagos registrados que se perderían';
  END IF;
  IF to_regclass('public.temporada_bitacora') IS NOT NULL AND EXISTS (SELECT 1 FROM temporada_bitacora) THEN
    RAISE EXCEPTION 'La reversa de la 139 no corre: la bitácora tiene cambios que se perderían';
  END IF;
  IF EXISTS (SELECT 1 FROM temporada_pedidos WHERE origen <> 'formulario' OR estado_entrega <> 'agendado') THEN
    RAISE EXCEPTION 'La reversa de la 139 no corre: hay pedidos capturados en el panel o con entrega avanzada';
  END IF;
END $$;

DROP TABLE IF EXISTS temporada_bitacora;
DROP TABLE IF EXISTS temporada_pagos;
DROP FUNCTION IF EXISTS temporada_bitacora_inmutable();
DROP FUNCTION IF EXISTS temporada_pagos_solo_anular();

ALTER TABLE temporada_pedidos
  DROP CONSTRAINT IF EXISTS temporada_pedidos_precio,
  DROP CONSTRAINT IF EXISTS temporada_pedidos_entrega,
  DROP CONSTRAINT IF EXISTS temporada_pedidos_origen,
  DROP CONSTRAINT IF EXISTS temporada_pedidos_creado_por_fkey,
  DROP CONSTRAINT IF EXISTS temporada_pedidos_motivo,
  DROP COLUMN IF EXISTS precio_unitario,
  DROP COLUMN IF EXISTS estado_entrega,
  DROP COLUMN IF EXISTS entrega_cambiada_en,
  DROP COLUMN IF EXISTS origen,
  DROP COLUMN IF EXISTS creado_por,
  DROP COLUMN IF EXISTS actualizado_en,
  DROP COLUMN IF EXISTS motivo_cancelacion;

ALTER TABLE temporada_campanas
  DROP CONSTRAINT IF EXISTS temporada_campanas_anticipo,
  DROP CONSTRAINT IF EXISTS temporada_campanas_mensajes,
  DROP COLUMN IF EXISTS anticipo_tipo,
  DROP COLUMN IF EXISTS anticipo_valor,
  DROP COLUMN IF EXISTS mensaje_confirmacion,
  DROP COLUMN IF EXISTS mensaje_recordatorio;

COMMIT;
