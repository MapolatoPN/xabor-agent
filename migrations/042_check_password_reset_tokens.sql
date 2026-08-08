-- Verificación de solo lectura de 042.
SELECT 'tabla_password_reset_tokens: ' || COUNT(*)::text
FROM information_schema.tables WHERE table_name = 'password_reset_tokens';

SELECT 'columnas_esperadas: ' || COUNT(*)::text
FROM information_schema.columns
WHERE table_name = 'password_reset_tokens'
  AND column_name IN ('id','usuario_id','token_hash','expires_at','used_at','revoked_at','created_at');

SELECT 'indice_unico_token: ' || COUNT(*)::text
FROM pg_indexes WHERE indexname = 'idx_password_reset_token_hash';

SELECT 'columna_sesiones_invalidas_antes: ' || COUNT(*)::text
FROM information_schema.columns
WHERE table_name = 'usuarios' AND column_name = 'sesiones_invalidas_antes';

-- Sin backfill: la migración no invalida la sesión de nadie.
SELECT 'usuarios_con_sesiones_invalidadas: ' || COUNT(*)::text
FROM usuarios WHERE sesiones_invalidas_antes IS NOT NULL;

-- Nace vacía: ningún enlace de recuperación se genera por migrar.
SELECT 'tokens_existentes: ' || COUNT(*)::text FROM password_reset_tokens;

-- El correo de los usuarios sigue intacto (041 no se revierte con esto).
SELECT 'usuarios_totales: ' || COUNT(*)::text FROM usuarios;
