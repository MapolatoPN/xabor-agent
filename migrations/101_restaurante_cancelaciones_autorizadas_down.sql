-- Reversa de la 101. Borra la bitácora y las columnas nuevas: lo cancelado
-- con autorización conserva estado, quién lo pidió y el motivo en texto
-- (columnas de la 039), pierde quién autorizó y el código del motivo.
DROP TABLE IF EXISTS restaurante_item_eventos;
ALTER TABLE restaurante_cuenta_items DROP CONSTRAINT IF EXISTS restaurante_cuenta_items_motivo_codigo_check;
ALTER TABLE restaurante_cuenta_items DROP COLUMN IF EXISTS reemplaza_item_id;
ALTER TABLE restaurante_cuenta_items DROP COLUMN IF EXISTS motivo_codigo;
ALTER TABLE restaurante_cuenta_items DROP COLUMN IF EXISTS autorizado_por;
ALTER TABLE usuarios DROP COLUMN IF EXISTS pin_autorizacion_hash;
