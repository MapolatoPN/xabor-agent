-- ─── 053: la impresión legacy deja de perder trabajos y de filtrar negocios ──
-- Idempotente y re-ejecutable.
--
-- POR QUÉ EXISTE
-- La 052 registraba "este trabajo ya se emitió" para no reimprimirlo. Pero
-- emitir no es imprimir: si en ese momento no había ningún agente conectado
-- (destinatarios = 0), la fila igual quedaba escrita y el trabajo se perdía
-- para siempre -- el negocio se quedaba sin comanda y nadie se enteraba.
--
-- Ahora la fila lleva ESTADO: 'pendiente' mientras nadie la haya recibido,
-- 'entregado' en cuanto un agente conectado la recibe. Al reconectarse, un
-- agente recibe SOLO sus pendientes, y solo una vez.
--
-- QUÉ TOCA DE LO YA EXISTENTE: únicamente impresion_legacy_emitida, que creó
-- la 052. Ninguna tabla anterior al módulo.

ALTER TABLE impresion_legacy_emitida
  ADD COLUMN IF NOT EXISTS estado text NOT NULL DEFAULT 'entregado';

DO $$ BEGIN
  ALTER TABLE impresion_legacy_emitida ADD CONSTRAINT chk_impresion_legacy_estado
    CHECK (estado IN ('pendiente', 'entregado'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE impresion_legacy_emitida
  ADD COLUMN IF NOT EXISTS entregado_at timestamptz;

-- Coherencia sobre lo ya registrado por la 052: lo que llegó a algún agente
-- cuenta como entregado; lo que no llegó a nadie vuelve a estar pendiente,
-- que es lo que siempre debió ser.
UPDATE impresion_legacy_emitida
   SET estado = 'entregado', entregado_at = COALESCE(entregado_at, created_at)
 WHERE destinatarios > 0 AND entregado_at IS NULL;

UPDATE impresion_legacy_emitida
   SET estado = 'pendiente'
 WHERE destinatarios = 0 AND entregado_at IS NULL;

-- La cola de reconexión se lee por negocio y solo mira pendientes.
CREATE INDEX IF NOT EXISTS idx_impresion_legacy_pendiente
  ON impresion_legacy_emitida (negocio_id, created_at)
  WHERE estado = 'pendiente';
