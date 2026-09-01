-- Reversa de la 068. Elimina la columna de condiciones por modificadores.
-- Destructivo solo de esa columna (las promociones y sus demás campos quedan).
ALTER TABLE tienda_promociones
  DROP COLUMN IF EXISTS condiciones_modificadores;
