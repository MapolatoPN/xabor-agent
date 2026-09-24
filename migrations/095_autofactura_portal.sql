-- 091 · Autofactura nativa — emisión desde el portal público.
--
-- Tres cosas, todas aditivas:
--   1. autofacturas.email_enviado_at: el correo con la factura se manda UNA
--      sola vez (se reclama la marca antes de enviar; un reintento idempotente
--      no vuelve a mandarlo).
--   2. autofacturas.reconciliado_at: candado temporal para que el polling del
--      portal no consulte al proveedor en cada refresh (una reconciliación
--      cada N segundos por autofactura, reclamada con UPDATE ... RETURNING).
--   3. autofactura_intentos: historial de intentos fiscales. Cuando un intento
--      termina rechazado de forma determinista (400) y el cliente corrige sus
--      datos, el intento anterior (snapshot cifrado, idempotency_key, huella,
--      status y códigos) se archiva aquí ANTES de reabrir la liga; nunca se
--      sobrescribe la evidencia. El siguiente intento usa intento_numero + 1
--      y una idempotency_key nueva.
--
-- NÚMERO: última en esta rama es la 090 (autofactura_emision); no existe 091
-- en ninguna rama local ni remota al escribir esto. Producción va en 088/089/090
-- (cortes, configuración fechada, promociones usos canal): al integrar hay que
-- confirmar que 091 siga libre y que el orden del runner sea 088 → 089 → 090 →
-- (087, 089-autofactura, 090-emision renumeradas si chocan) → 091.
--
-- Aditiva e idempotente.

ALTER TABLE autofacturas
  ADD COLUMN IF NOT EXISTS email_enviado_at timestamptz,
  ADD COLUMN IF NOT EXISTS reconciliado_at  timestamptz;

CREATE TABLE IF NOT EXISTS autofactura_intentos (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  autofactura_id           uuid NOT NULL REFERENCES autofacturas(id) ON DELETE CASCADE,
  negocio_id               uuid NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  folio                    text NOT NULL,
  intento_numero           smallint NOT NULL,
  intento_key              text NOT NULL,
  snapshot_cifrado         text,
  snapshot_iv              text,
  snapshot_auth_tag        text,
  snapshot_formato_version smallint,
  snapshot_sha256          text,
  proveedor_status         text,
  error_codigo             text,
  error_detalle            text,
  factura_id               text,
  intento_iniciado_at      timestamptz,
  intento_cerrado_at       timestamptz,
  motivo                   text NOT NULL,
  archivado_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (autofactura_id, intento_numero),
  UNIQUE (intento_key)
);
CREATE INDEX IF NOT EXISTS idx_autofactura_intentos_negocio_folio
  ON autofactura_intentos (negocio_id, folio);
