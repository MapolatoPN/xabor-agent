-- ─── 057: la promoción tiene ciclo de vida propio, coordinado con el dinero ──
-- Idempotente y re-ejecutable.
--
-- QUÉ ESTABA MAL
--
-- `tienda_promocion_usos` ya tenía una noción de reserva, pero codificada en el
-- texto de `pedido_folio` con el prefijo `reserva:<checkoutToken>`. Esa reserva
-- solo cubría la ventana entre "el cliente pulsó comprar" y "el pedido existe".
-- En cuanto el pedido nacía, `registrarUsosPromociones` le ponía el folio real
-- y el uso quedaba CONSUMIDO -- aunque el pedido naciera `pendiente_pago` y no
-- hubiera entrado un solo peso.
--
-- Con eso, llegar al checkout gastaba la promoción: si el cliente no pagaba
-- nunca, el cupo quedaba quemado para siempre. El reciclador de reservas solo
-- mira filas con prefijo `reserva:`, así que jamás la volvía a tocar, y el
-- vencimiento del pago cancelaba el pedido sin devolver nada.
--
-- QUÉ SE AGREGA
--
--   estado          'reservada' | 'consumida'. El estado deja de vivir en el
--                   texto del folio y pasa a ser una columna con CHECK.
--   pedido_version  el hash de versión del pedido que justificó el descuento.
--                   Sin esto, consumir no puede revalidar que la reserva
--                   corresponde al precio que realmente se cobró.
--   consumida_at    cuándo se convirtió en uso real. `created_at` sigue siendo
--                   cuándo se apartó; son dos momentos distintos y confundirlos
--                   falsearía cualquier reporte de conversión.
--
-- La identidad de la reserva es `negocio + pedido + promoción`, que ya está
-- garantizada por idx_promo_uso_unico. La VERSIÓN no entra en la clave: cuando
-- el pedido cambia de versión, la reserva vieja se supersede y se vuelve a
-- reservar -- una sola reserva viva por pedido, que es justo lo que hace que
-- cambiar de proveedor (Clip → Mercado Pago) no compita por el último cupo.
--
-- El contador `tienda_promociones.usos` sube al RESERVAR y baja al LIBERAR;
-- consumir no lo mueve. Así `consumidas + reservas activas <= limite_usos` se
-- sostiene por construcción, con el UPDATE condicional que ya existía.
--
-- BACKFILL: todo lo ya registrado es un uso real -> 'consumida' (el DEFAULT).
-- Lo único que se marca 'reservada' son las filas con el prefijo provisional,
-- que por definición todavía no eran usos.

ALTER TABLE tienda_promocion_usos
  ADD COLUMN IF NOT EXISTS estado text NOT NULL DEFAULT 'consumida';

ALTER TABLE tienda_promocion_usos
  ADD COLUMN IF NOT EXISTS pedido_version text;

ALTER TABLE tienda_promocion_usos
  ADD COLUMN IF NOT EXISTS consumida_at timestamptz;

DO $$ BEGIN
  ALTER TABLE tienda_promocion_usos ADD CONSTRAINT chk_promo_uso_estado
    CHECK (estado IN ('reservada', 'consumida'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

UPDATE tienda_promocion_usos
   SET estado = 'reservada'
 WHERE pedido_folio LIKE 'reserva:%' AND estado <> 'reservada';

-- El expirador y el settlement buscan por (negocio, pedido) las reservas vivas.
-- Índice parcial: el conjunto de reservas abiertas es pequeño frente al
-- histórico de usos consumidos.
CREATE INDEX IF NOT EXISTS idx_promo_uso_reservada
  ON tienda_promocion_usos (negocio_id, pedido_folio)
  WHERE estado = 'reservada';
