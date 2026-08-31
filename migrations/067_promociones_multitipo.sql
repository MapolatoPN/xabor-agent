-- 067: extiende `tienda_promociones` al MOTOR DE PROMOCIONES multi-canal.
--
-- El motor (src/services/tiendaPromociones.js) ya era, por diseño, neutro de
-- canal ("cuando otro canal quiera promociones, se le pasa canal:'whatsapp'").
-- Esta migración lo convierte en la FUENTE ÚNICA DE VERDAD para POS, pedidos
-- manuales, WhatsApp/IA, carrito, checkout, totales, tickets e historial,
-- agregando los tipos que faltaban:
--   · '2x1'                (BUY_X_GET_Y: compra X, el/los de MENOR precio gratis)
--   · 'segundo_descuento'  (compra X, el/los de MENOR precio con `valor`% off)
--
-- NO destructivo: solo amplía CHECKs y agrega columnas nullable. No toca datos
-- existentes ni promociones/órdenes históricas.

-- 1) Tipos permitidos: se conservan los tres actuales y se agregan los per-unit.
ALTER TABLE tienda_promociones DROP CONSTRAINT IF EXISTS chk_promo_tipo;
ALTER TABLE tienda_promociones ADD CONSTRAINT chk_promo_tipo
  CHECK (tipo IN ('envio_gratis', 'porcentaje', 'monto_fijo', '2x1', 'segundo_descuento'));

-- 2) 'segundo_descuento' usa `valor` como PORCENTAJE (0..100), igual que
--    'porcentaje'. '2x1' no usa `valor` (el beneficio es 100%).
ALTER TABLE tienda_promociones DROP CONSTRAINT IF EXISTS chk_promo_valor;
ALTER TABLE tienda_promociones ADD CONSTRAINT chk_promo_valor
  CHECK (valor >= 0 AND (tipo NOT IN ('porcentaje', 'segundo_descuento') OR valor <= 100));

-- 3) Cardinalidad de los tipos per-unit. Nullable: solo la usan '2x1' y
--    'segundo_descuento'; los demás tipos la dejan en NULL.
--    · cantidad_requerida   = compra X unidades participantes (default 2)
--    · cantidad_beneficiada = de cada grupo, Y reciben el beneficio (default 1)
--    · max_aplicaciones     = tope opcional de grupos beneficiados por pedido
ALTER TABLE tienda_promociones ADD COLUMN IF NOT EXISTS cantidad_requerida   integer;
ALTER TABLE tienda_promociones ADD COLUMN IF NOT EXISTS cantidad_beneficiada integer;
ALTER TABLE tienda_promociones ADD COLUMN IF NOT EXISTS max_aplicaciones     integer;

DO $$ BEGIN
  ALTER TABLE tienda_promociones ADD CONSTRAINT chk_promo_cardinalidad CHECK (
    (cantidad_requerida   IS NULL OR cantidad_requerida   >= 1) AND
    (cantidad_beneficiada IS NULL OR cantidad_beneficiada >= 1) AND
    (max_aplicaciones     IS NULL OR max_aplicaciones     >= 1) AND
    (cantidad_beneficiada IS NULL OR cantidad_requerida IS NULL
       OR cantidad_beneficiada <= cantidad_requerida)
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
