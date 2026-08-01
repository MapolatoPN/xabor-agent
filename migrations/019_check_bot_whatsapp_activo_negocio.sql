-- Verificación de solo lectura tras la migración 019.
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'negocios' AND column_name = 'bot_whatsapp_activo';

SELECT slug, bot_whatsapp_activo FROM negocios ORDER BY slug;
