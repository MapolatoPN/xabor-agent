-- Reversa de la 088. Solo quita las tres columnas nuevas; el resto del
-- corte (ventas, caja, arqueo) queda intacto.
ALTER TABLE cortes_caja DROP COLUMN IF EXISTS rewards_canjeados;
ALTER TABLE cortes_caja DROP COLUMN IF EXISTS descuento_promocional;
ALTER TABLE cortes_caja DROP COLUMN IF EXISTS descuento_manual;
