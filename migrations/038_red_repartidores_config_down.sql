-- Rollback de la migración 038 — elimina la tabla aditiva. Los negocios
-- vuelven al comportamiento previo (modo de notificación por claves de
-- configuracion), que nunca dejó de existir como respaldo.
BEGIN;
DROP TABLE IF EXISTS red_repartidores_config;
COMMIT;
