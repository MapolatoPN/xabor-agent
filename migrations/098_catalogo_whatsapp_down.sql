-- Reversión manual de la 098. Solo junto con el rollback del código que la lee:
-- el agente nuevo falla CERRADO sin esta tabla (carta vacía → persona), y el
-- bot legacy no la consulta. Se pierde la selección que el negocio haya hecho
-- en el panel; la siembra desde Tienda se repetiría al volver a aplicar la 098.
DROP TABLE IF EXISTS whatsapp_productos;
