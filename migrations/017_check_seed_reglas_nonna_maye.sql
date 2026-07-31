-- Verificación de solo lectura tras la migración 017. Nunca muestra el
-- contenido completo de las reglas -- solo confirma existencia y
-- algunos metadatos no sensibles (son reglas operativas públicas del
-- restaurante, pero igual se evita volcar JSON completo en logs de
-- verificación por costumbre de higiene).

SELECT n.slug,
  (cfg.valor IS NOT NULL) AS reglas_sembradas,
  length(cfg.valor) AS tamano_json,
  (cfg.valor::jsonb ? 'horarios') AS tiene_horarios,
  (cfg.valor::jsonb ? 'pedidos') AS tiene_pedidos,
  (cfg.valor::jsonb ? 'politicas') AS tiene_politicas
FROM negocios n
LEFT JOIN configuracion cfg ON cfg.negocio_id = n.id AND cfg.clave = 'reglas_atencion'
WHERE n.slug = 'nonna-maye';
