-- Verificación de solo lectura tras la migración 015. Nunca muestra
-- nombres/teléfonos completos de clientes reales -- solo conteos y el
-- propio constraint.

SELECT pg_get_constraintdef(oid) AS check_modulo
FROM pg_constraint WHERE conname = 'negocio_modulos_modulo_check';

SELECT pg_get_constraintdef(oid) AS check_estado
FROM pg_constraint WHERE conname = 'negocio_modulos_estado_check';

SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'rewards_accounts' AND column_name = 'nombre';

-- Confirma que ningún módulo distinto a 'rewards' quedó con un estado del
-- vocabulario nuevo (pendiente_configuracion/no_contratado) -- deben seguir
-- usando exclusivamente su vocabulario heredado; solo 'rewards' usa el nuevo.
SELECT modulo, estado, count(*) FROM negocio_modulos
WHERE estado IN ('pendiente_configuracion','no_contratado')
GROUP BY modulo, estado ORDER BY modulo, estado;

SELECT n.slug, nm.estado
FROM negocio_modulos nm JOIN negocios n ON n.id = nm.negocio_id
WHERE nm.modulo = 'rewards'
ORDER BY n.slug;

-- Cuentas de Rewards con nombre poblado vs total, por negocio (conteos
-- únicamente, sin exponer datos).
SELECT n.slug,
  count(*) AS cuentas_total,
  count(a.nombre) AS cuentas_con_nombre
FROM rewards_accounts a
JOIN negocios n ON n.id::text = a.tenant_id
GROUP BY n.slug
ORDER BY n.slug;
