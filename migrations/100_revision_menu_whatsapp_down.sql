-- Reversión de la 100. Solo a mano, con psql, y a propósito.
--
-- Después de esto el código de la 100 no arranca bien su menú automático
-- (estado_revision_menu_whatsapp no existe: el envío cae a la carta en texto
-- por error de lectura). Revertir primero el código y después esto.
-- Se pierden las revisiones registradas: al volver a aplicar la 100, cada
-- menú en imagen necesita otra revisión de su administrador.
DROP FUNCTION IF EXISTS estado_revision_menu_whatsapp(uuid, text[]);
DROP FUNCTION IF EXISTS huella_imagenes_menu(text[]);
DROP FUNCTION IF EXISTS imagenes_menu_whatsapp(uuid);
DROP FUNCTION IF EXISTS huella_carta_whatsapp(uuid);
DROP FUNCTION IF EXISTS carta_whatsapp_canonica(uuid);

ALTER TABLE whatsapp_menu_automatico
  DROP COLUMN IF EXISTS revisado_por,
  DROP COLUMN IF EXISTS revisado_at,
  DROP COLUMN IF EXISTS revision_carta,
  DROP COLUMN IF EXISTS revision_imagenes_huella,
  DROP COLUMN IF EXISTS revision_carta_huella;
