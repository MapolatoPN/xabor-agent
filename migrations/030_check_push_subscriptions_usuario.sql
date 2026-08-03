-- Verificación de solo lectura tras la migración 030.
SELECT column_name, data_type, is_nullable FROM information_schema.columns
WHERE table_name = 'push_subscriptions' AND column_name = 'usuario_id';
