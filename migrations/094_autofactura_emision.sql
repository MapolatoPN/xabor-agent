-- 090 · Autofactura nativa — motor de emisión: intento fiscal idempotente y
-- snapshot cifrado del request que se manda a Facturapi.
--
-- Cada intento de timbrado queda fijado ANTES de tocar la red: el JSON exacto
-- del POST /invoices (cliente, concepto, uso, forma de pago, external_id e
-- idempotency_key) se guarda cifrado con AES-256-GCM bajo
-- INTEGRATIONS_ENCRYPTION_KEY (cifradoIntegraciones.js, mismo formato que las
-- credenciales de integración) junto con su SHA-256. Un reintento técnico
-- (timeout, 429, 5xx) reenvía ESE snapshot con LA MISMA idempotency_key; nunca
-- se reconstruye desde una venta que pudo cambiar. RFC, nombre, CP y correo
-- jamás quedan en claro en esta tabla.
--
-- NÚMERO: en esta rama la última es la 089; no hay 090 en ninguna rama local
-- ni remota al escribir esto. Producción (prod/mesero-shadow-v3) va en 088;
-- al integrar hay que confirmar que 090 siga libre.
--
-- Aditiva e idempotente: ADD COLUMN / CREATE INDEX IF NOT EXISTS.

ALTER TABLE autofacturas
  ADD COLUMN IF NOT EXISTS intento_numero           smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS intento_iniciado_at      timestamptz,
  ADD COLUMN IF NOT EXISTS intento_cerrado_at       timestamptz,
  ADD COLUMN IF NOT EXISTS snapshot_cifrado         text,
  ADD COLUMN IF NOT EXISTS snapshot_iv              text,
  ADD COLUMN IF NOT EXISTS snapshot_auth_tag        text,
  ADD COLUMN IF NOT EXISTS snapshot_formato_version smallint,
  ADD COLUMN IF NOT EXISTS snapshot_sha256          text,
  -- Último status que reportó el proveedor para el intento (pending, valid,
  -- rejected, ...). Texto libre a propósito: es vocabulario de Facturapi.
  ADD COLUMN IF NOT EXISTS proveedor_status         text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'autofacturas_snapshot_sha256_formato') THEN
    ALTER TABLE autofacturas ADD CONSTRAINT autofacturas_snapshot_sha256_formato
      CHECK (snapshot_sha256 IS NULL OR snapshot_sha256 ~ '^[a-f0-9]{64}$');
  END IF;
END $$;

-- Una idempotency_key pertenece a UN solo intento de UNA sola autofactura.
CREATE UNIQUE INDEX IF NOT EXISTS uq_autofacturas_intento_key
  ON autofacturas (intento_key) WHERE intento_key IS NOT NULL;
-- Intentos en curso que hay que reanudar o reconciliar.
CREATE INDEX IF NOT EXISTS idx_autofacturas_emitiendo
  ON autofacturas (intento_iniciado_at) WHERE estado = 'emitiendo';
