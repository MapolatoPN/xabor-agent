-- 066 down — elimina el estado de atención por negocio/conversación.
-- Destructivo por definición (down): pierde las pausas por conversación.
-- Solo para entornos de desarrollo. NO toca `clientes`.
DROP TABLE IF EXISTS conversaciones_control;
