-- ─── Rollback de la 053 ───────────────────────────────────────────────────
--
-- Devuelve impresion_legacy_emitida al estado que le dio la 052: sin noción de
-- pendiente. ⚠ Los trabajos que estuvieran esperando a que su agente se
-- conectara dejan de ser recuperables -- se pierden en silencio, que es
-- exactamente el defecto que la 053 corrige.
--
-- No toca ninguna tabla anterior al módulo.

BEGIN;

DROP INDEX IF EXISTS idx_impresion_legacy_pendiente;

ALTER TABLE impresion_legacy_emitida DROP CONSTRAINT IF EXISTS chk_impresion_legacy_estado;
ALTER TABLE impresion_legacy_emitida DROP COLUMN IF EXISTS entregado_at;
ALTER TABLE impresion_legacy_emitida DROP COLUMN IF EXISTS estado;

COMMIT;
