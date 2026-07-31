-- Verificación de solo lectura tras la migración 016. Nunca muestra el
-- contenido real de los overrides (podría incluir texto operativo
-- sensible) -- solo conteos y metadatos estructurales.

SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'prompt_overrides' AND column_name = 'negocio_id';

-- Confirmar que ya no existen overrides huérfanos (sin negocio_id)
SELECT count(*) AS overrides_sin_negocio
FROM prompt_overrides WHERE negocio_id IS NULL;

-- Distribución de overrides por negocio (solo conteos, sin contenido)
SELECT n.slug, count(*) AS total_overrides, count(*) FILTER (WHERE po.activo) AS activos
FROM prompt_overrides po
JOIN negocios n ON n.id = po.negocio_id
GROUP BY n.slug
ORDER BY n.slug;

-- Confirmar el índice nuevo
SELECT indexname FROM pg_indexes WHERE tablename = 'prompt_overrides' AND indexname = 'idx_prompt_overrides_negocio';
