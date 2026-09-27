-- Menu en imagen: por negocio, sale IMAGEN o sale TEXTO. Solo despues de la 100.
-- Solo lectura. estado_revision = 'vigente' es el UNICO que deja salir imagenes;
-- cualquier otro manda el menu en texto desde la carta publicada para WhatsApp.
-- Condicion del canario: el negocio del canario no tiene menu en imagen activo,
-- o su estado_revision es 'vigente' DESPUES de que el dueno reviso las paginas.
BEGIN READ ONLY;

SELECT n.nombre                                   AS negocio,
       n.id                                       AS negocio_id,
       n.bot_whatsapp_activo,
       m.activo                                   AS menu_imagen_activo,
       cardinality(imagenes_menu_whatsapp(n.id))  AS paginas,
       estado_revision_menu_whatsapp(n.id)        AS estado_revision,
       m.revisado_at,
       u.nombre                                   AS revisado_por
  FROM whatsapp_menu_automatico m
  JOIN negocios n ON n.id = m.negocio_id
  LEFT JOIN usuarios u ON u.id = m.revisado_por
 WHERE n.activo IS NOT FALSE
 ORDER BY n.nombre, n.id;

ROLLBACK;
