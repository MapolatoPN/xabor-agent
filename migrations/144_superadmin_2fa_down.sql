-- Reversa de la 144. Quitar la tabla deja a todos los superadmins sin
-- segundo factor dado de alta: el binario de la 144 les pedirá darlo de alta
-- otra vez. Despliega primero el binario anterior a la 144.
ALTER TABLE auditoria_plataforma DROP COLUMN IF EXISTS ip;
DROP TABLE IF EXISTS superadmin_totp;
