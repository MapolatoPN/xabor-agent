-- Reverso de 050. Las columnas viejas de whatsapp_menu_automatico nunca se
-- tocaron, así que el V1 vuelve a funcionar tal cual; solo se restaura su
-- CHECK y se desactiva a quien quedaría activo sin imagen en columna vieja.
BEGIN;
DROP TABLE IF EXISTS whatsapp_menu_imagenes;
UPDATE whatsapp_menu_automatico SET activo = FALSE WHERE activo = TRUE AND storage_key IS NULL;
ALTER TABLE whatsapp_menu_automatico
  ADD CONSTRAINT whatsapp_menu_activo_exige_imagen
  CHECK (activo = FALSE OR storage_key IS NOT NULL);
COMMIT;
