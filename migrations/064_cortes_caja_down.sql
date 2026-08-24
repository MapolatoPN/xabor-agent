-- Reversa de la 064. Se deja por simetría con el resto de migraciones.
--
-- ADVERTENCIA: borrar cortes_caja BORRA HISTORIA FINANCIERA CERRADA. No
-- ejecutar en producción salvo que el release completo se esté revirtiendo y
-- ya se tenga respaldo -- un corte cerrado es la constancia de un arqueo.
DROP INDEX IF EXISTS idx_movimientos_caja_corte;
DROP INDEX IF EXISTS idx_movimientos_caja_negocio_fecha;
DROP TABLE IF EXISTS movimientos_caja;

DROP INDEX IF EXISTS idx_cortes_caja_negocio_fecha;
DROP INDEX IF EXISTS uq_cortes_caja_negocio_folio;
DROP INDEX IF EXISTS uq_cortes_caja_negocio_fecha;
DROP TABLE IF EXISTS cortes_caja;
