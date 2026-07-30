-- Verificaciones post-migración 012 (LOCAL)

-- 1. Tabla existe
SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name='invitaciones_usuario';

-- 2. Columnas y tipos
SELECT column_name, data_type, is_nullable FROM information_schema.columns
WHERE table_name='invitaciones_usuario' ORDER BY ordinal_position;

-- 3. Constraints (FKs + UNIQUE + CHECK)
SELECT conname, contype, pg_get_constraintdef(oid) FROM pg_constraint
WHERE conrelid = 'invitaciones_usuario'::regclass ORDER BY conname;

-- 4. Índices
SELECT indexname, indexdef FROM pg_indexes WHERE tablename='invitaciones_usuario' ORDER BY indexname;

-- 5. Sin filas todavía (la migración no genera ninguna invitación)
SELECT count(*) AS invitaciones_creadas_por_la_migracion FROM invitaciones_usuario;

-- 6. Nonna Maye / negocios existentes sin cambios (esta migración no los toca)
SELECT count(*) FROM negocios;
SELECT count(*) FROM usuarios;
SELECT count(*) FROM usuario_negocios;
