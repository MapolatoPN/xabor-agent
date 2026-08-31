-- Rollback de la 067. Revierte los tipos per-unit y sus columnas.
-- Solo es seguro si NO existen promociones activas de tipo '2x1' o
-- 'segundo_descuento' (el CHECK viejo las rechazaría). El rollback las
-- desactiva antes de restaurar el CHECK, nunca las borra.
UPDATE tienda_promociones SET activa = FALSE, updated_at = NOW()
  WHERE tipo IN ('2x1', 'segundo_descuento');

ALTER TABLE tienda_promociones DROP CONSTRAINT IF EXISTS chk_promo_cardinalidad;
ALTER TABLE tienda_promociones DROP COLUMN IF EXISTS max_aplicaciones;
ALTER TABLE tienda_promociones DROP COLUMN IF EXISTS cantidad_beneficiada;
ALTER TABLE tienda_promociones DROP COLUMN IF EXISTS cantidad_requerida;

ALTER TABLE tienda_promociones DROP CONSTRAINT IF EXISTS chk_promo_valor;
ALTER TABLE tienda_promociones ADD CONSTRAINT chk_promo_valor
  CHECK (valor >= 0 AND (tipo <> 'porcentaje' OR valor <= 100));

-- Filas '2x1'/'segundo_descuento' quedaron inactivas arriba; para restaurar el
-- CHECK viejo hay que reconvertirlas a un tipo válido (se dejan como 'monto_fijo'
-- inactivas, preservando la fila para auditoría).
UPDATE tienda_promociones SET tipo = 'monto_fijo'
  WHERE tipo IN ('2x1', 'segundo_descuento');
ALTER TABLE tienda_promociones DROP CONSTRAINT IF EXISTS chk_promo_tipo;
ALTER TABLE tienda_promociones ADD CONSTRAINT chk_promo_tipo
  CHECK (tipo IN ('envio_gratis', 'porcentaje', 'monto_fijo'));
