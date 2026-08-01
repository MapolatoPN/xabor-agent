-- Rollback de la migración 022. Elimina la tabla completa -- a
-- diferencia de las migraciones puramente aditivas de columnas, esto SÍ
-- pierde el seguimiento comercial capturado desde que se aplicó (no hay
-- forma de revertir una tabla nueva sin perder sus filas). Respaldar
-- antes de ejecutar si hay datos comerciales reales cargados.
-- Ejecutar con: psql "$CONN" -v ON_ERROR_STOP=1 -f 022_plan_comercial_negocio_down.sql

BEGIN;

DROP TABLE IF EXISTS negocio_plan_comercial;

COMMIT;
