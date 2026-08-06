-- Verificación de solo lectura de la migración 037.
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'negocios' AND column_name IN ('onboarding_estado', 'implementacion');
SELECT count(*) AS sesiones_soporte_existe FROM information_schema.tables WHERE table_name = 'sesiones_soporte';
SELECT onboarding_estado, count(*) FROM negocios GROUP BY onboarding_estado ORDER BY 2 DESC;
