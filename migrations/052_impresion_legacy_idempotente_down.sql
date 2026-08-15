-- ─── Rollback de la 052 ───────────────────────────────────────────────────
--
-- ⚠ PÉRDIDA DE DATOS: borra la memoria de qué trabajos legacy ya se emitieron.
-- Tras ejecutarlo, un reintento de un pedido anterior volvería a mandar la
-- comanda al print-agent viejo -- es decir, papel repetido. Solo tiene sentido
-- si también se revierte el código que consulta esta tabla.
--
-- La 052 no modificó nada preexistente, así que no hay nada que restaurar.

BEGIN;

DROP INDEX IF EXISTS idx_impresion_legacy_emitida_fecha;
DROP TABLE IF EXISTS impresion_legacy_emitida;

COMMIT;
