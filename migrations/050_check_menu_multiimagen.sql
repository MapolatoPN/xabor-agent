-- Verificación de solo lectura de la 050.
SELECT
  (SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'whatsapp_menu_imagenes') AS tabla_existe,
  (SELECT COUNT(*) FROM whatsapp_menu_imagenes) AS paginas_totales,
  (SELECT COUNT(*) FROM whatsapp_menu_automatico WHERE storage_key IS NOT NULL) AS negocios_con_imagen_v1,
  (SELECT COUNT(*) FROM pg_constraint WHERE conname = 'whatsapp_menu_activo_exige_imagen') AS check_v1_restante;
