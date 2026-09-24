DROP INDEX IF EXISTS idx_autofacturas_emitiendo;
DROP INDEX IF EXISTS uq_autofacturas_intento_key;
ALTER TABLE autofacturas DROP CONSTRAINT IF EXISTS autofacturas_snapshot_sha256_formato;
ALTER TABLE autofacturas
  DROP COLUMN IF EXISTS proveedor_status,
  DROP COLUMN IF EXISTS snapshot_sha256,
  DROP COLUMN IF EXISTS snapshot_formato_version,
  DROP COLUMN IF EXISTS snapshot_auth_tag,
  DROP COLUMN IF EXISTS snapshot_iv,
  DROP COLUMN IF EXISTS snapshot_cifrado,
  DROP COLUMN IF EXISTS intento_cerrado_at,
  DROP COLUMN IF EXISTS intento_iniciado_at,
  DROP COLUMN IF EXISTS intento_numero;
