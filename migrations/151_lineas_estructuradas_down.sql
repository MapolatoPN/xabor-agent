-- Reversa de la 151 (Fase 2: datos estructurados). Solo a mano, con psql, y a
-- propósito: ningún proceso la corre solo.
--
-- Borra SOLO lo que la 151 creó: el registro derivado de líneas, los
-- emparejamientos de Rappi corregidos a mano, las dos columnas nuevas de
-- los artículos de mesa y el tipo de producto. Las ventas
-- (pedidos_activos), los cortes y las facturas no se tocan.
--
-- OJO: también se pierden los tipos marcados (envío, extra, bebida) y los
-- emparejamientos hechos a mano. Antes de correrla, apagar las banderas
-- lineas_estructuradas y envio_solo_como_cargo y volver al binario anterior.

BEGIN;
DROP TABLE IF EXISTS pedido_linea_modificadores;
DROP TABLE IF EXISTS pedido_lineas;
DROP TABLE IF EXISTS pedido_lineas_pedidos;
DROP TABLE IF EXISTS rappi_emparejamientos;
ALTER TABLE restaurante_cuenta_items
  DROP COLUMN IF EXISTS modificadores_det,
  DROP COLUMN IF EXISTS producto_id;
ALTER TABLE menu_productos DROP CONSTRAINT IF EXISTS menu_productos_tipo;
ALTER TABLE menu_productos DROP COLUMN IF EXISTS tipo;
COMMIT;
