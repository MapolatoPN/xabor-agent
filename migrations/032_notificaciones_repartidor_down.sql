BEGIN;

DROP TRIGGER IF EXISTS set_updated_at ON notificaciones_repartidor;
DROP TABLE IF EXISTS notificaciones_repartidor;

COMMIT;
