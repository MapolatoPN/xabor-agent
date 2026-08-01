-- Rollback de la migración 023. Elimina la tabla completa -- a
-- diferencia de otras migraciones aditivas de este proyecto, esta sí
-- es destructiva porque toda la información vive únicamente en esta
-- tabla nueva (no hay columnas agregadas a una tabla existente que
-- puedan revertirse por separado). Ejecutar solo si se decide
-- descartar la captura de prospectos por completo.
-- Ejecutar con: psql "$CONN" -v ON_ERROR_STOP=1 -f 023_prospectos_comerciales_down.sql

BEGIN;

DROP TABLE IF EXISTS prospectos_comerciales;

COMMIT;
