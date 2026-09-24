-- 089 · Autofactura nativa de Xabor — liga pública por venta.
--
-- Sustituye (en fases) a los E-Receipts de Facturapi: Xabor emite la liga y
-- el QR; Facturapi queda solo como motor de timbrado (fase de emisión).
-- `facturacion_recibos` se deja intacta a propósito: coexiste hasta que el
-- reemplazo esté completo. `facturas_pedido` sigue siendo el ledger fiscal.
--
-- Una fila por venta: UNIQUE (negocio_id, folio) es el candado "una venta,
-- una factura". El token público NUNCA se guarda en claro: se guarda su
-- SHA-256 (lookup público desde /f/<token>) y el token cifrado con
-- AES-256-GCM bajo INTEGRATIONS_ENCRYPTION_KEY (mismo formato y helper que
-- integraciones_canal_credenciales) para poder reimprimir la MISMA liga/QR
-- después de reinicios sin volver a emitirla.
--
-- Aditiva e idempotente: CREATE ... IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS autofacturas (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id            uuid NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  folio                 text NOT NULL CHECK (char_length(trim(folio)) > 0),
  -- SHA-256 hex del token público: lo único que se consulta desde /f/<token>.
  token_hash            text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  -- Token cifrado (AES-256-GCM, cifradoIntegraciones.js) para reconstruir la liga.
  token_cifrado         text NOT NULL,
  token_iv              text NOT NULL,
  token_auth_tag        text NOT NULL,
  token_formato_version smallint NOT NULL DEFAULT 1,
  -- Total de la venta congelado al crear la liga; si la venta cambia, TOTAL_CAMBIO.
  total                 numeric(12,2) NOT NULL CHECK (total > 0),
  estado                text NOT NULL DEFAULT 'vigente'
                        CHECK (estado IN ('vigente','emitiendo','facturada','expirada','revocada','error')),
  expires_at            timestamptz NOT NULL,
  -- Clave de idempotencia enviada al proveedor al emitir (fase de emisión).
  intento_key           text,
  factura_id            text,
  uuid                  text,
  emitida_at            timestamptz,
  fuente_emision        text CHECK (fuente_emision IS NULL OR fuente_emision IN ('portal','panel','restaurante','whatsapp')),
  error_codigo          text,
  error_detalle         text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (negocio_id, folio)
);

-- Un CFDI del proveedor pertenece a UNA sola autofactura del negocio.
CREATE UNIQUE INDEX IF NOT EXISTS uq_autofacturas_negocio_factura
  ON autofacturas (negocio_id, factura_id) WHERE factura_id IS NOT NULL;
-- Barrido de vigencias (expirar ligas vencidas) y de emisiones colgadas.
CREATE INDEX IF NOT EXISTS idx_autofacturas_estado_expira
  ON autofacturas (estado, expires_at);

-- updated_at automático: misma función set_updated_at() de la 003.
DROP TRIGGER IF EXISTS set_updated_at ON autofacturas;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON autofacturas
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
