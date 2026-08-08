-- Verificación de solo lectura de 041.
SELECT 'email_es_nullable: ' || (CASE WHEN is_nullable = 'YES' THEN 'OK' ELSE 'FALLA' END)
FROM information_schema.columns WHERE table_name = 'usuarios' AND column_name = 'email';

SELECT 'pin_hash_existe: ' || COUNT(*)::text
FROM information_schema.columns WHERE table_name = 'usuarios' AND column_name = 'pin_hash';

SELECT 'check_identidad: ' || COUNT(*)::text
FROM pg_constraint WHERE conname = 'usuarios_identidad_check';

-- Ninguna cuenta existente debe haber perdido su correo con la migración.
SELECT 'usuarios_sin_email_ni_pin: ' || COUNT(*)::text
FROM usuarios WHERE email IS NULL AND pin_hash IS NULL;

-- La unicidad global de correo sigue vigente para quienes sí tienen correo.
SELECT 'correos_duplicados: ' || COUNT(*)::text FROM (
  SELECT email FROM usuarios WHERE email IS NOT NULL GROUP BY email HAVING COUNT(*) > 1
) d;
