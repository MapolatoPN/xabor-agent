-- Reversa de la 057. Deja `tienda_promocion_usos` como estaba: sin estado
-- explícito ni versión de pedido.
--
-- Antes de soltar la columna se resuelven las reservas vivas con folio real:
-- sin `estado` no hay forma de distinguirlas de un uso consumido, y dejarlas
-- ahí las convertiría en usos definitivos de promociones que nadie pagó. Se
-- borran y se devuelve el cupo, que es lo que significaban.

DO $$
DECLARE
  r RECORD;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'tienda_promocion_usos' AND column_name = 'estado') THEN
    FOR r IN
      SELECT negocio_id, promocion_id, COUNT(*)::int AS n
        FROM tienda_promocion_usos
       WHERE estado = 'reservada' AND pedido_folio NOT LIKE 'reserva:%'
       GROUP BY negocio_id, promocion_id
    LOOP
      UPDATE tienda_promociones
         SET usos = GREATEST(usos - r.n, 0), updated_at = NOW()
       WHERE id = r.promocion_id AND negocio_id = r.negocio_id;
    END LOOP;

    DELETE FROM tienda_promocion_usos
     WHERE estado = 'reservada' AND pedido_folio NOT LIKE 'reserva:%';
  END IF;
END $$;

DROP INDEX IF EXISTS idx_promo_uso_reservada;

ALTER TABLE tienda_promocion_usos DROP CONSTRAINT IF EXISTS chk_promo_uso_estado;
ALTER TABLE tienda_promocion_usos DROP COLUMN IF EXISTS estado;
ALTER TABLE tienda_promocion_usos DROP COLUMN IF EXISTS pedido_version;
ALTER TABLE tienda_promocion_usos DROP COLUMN IF EXISTS consumida_at;
