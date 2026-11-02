-- Reversa de la 125. Los pedidos cobrados en dólares conservan su
-- datos.pago_dolares; sin la tabla, el negocio deja de aceptar dólares.
DROP TABLE IF EXISTS dolares_tipo_cambio;

ALTER TABLE formas_cobro
  DROP CONSTRAINT IF EXISTS formas_cobro_clave_check,
  ADD CONSTRAINT formas_cobro_clave_check CHECK (
    clave ~ '^[a-z0-9_]{2,40}$'
    AND position('efectivo' IN clave) = 0
    AND clave NOT IN ('mixto', 'terminal', 'tarjeta', 'enlace_pago', 'por_cobrar', 'pendiente', 'sin_pago'));
