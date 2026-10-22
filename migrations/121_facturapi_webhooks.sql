-- Avisos de Facturapi (webhooks) sobre los recibos de cada negocio.
--
-- facturapi_webhooks: una fila por negocio. El token de la URL dice de qué
-- negocio es un aviso; el secreto (cifrado, como las credenciales de
-- integraciones_canal_credenciales) verifica la firma. Vive aparte de la llave
-- de Facturapi para que guardarla otra vez desde el panel no borre el secreto.
-- Sin fila 'activo' el barrido de recibos funciona como antes.
--
-- facturapi_webhook_eventos: un evento se aplica una sola vez. Solo ids,
-- estados y el resultado; ningún dato fiscal del cliente.
CREATE TABLE IF NOT EXISTS facturapi_webhooks (
  negocio_id              uuid PRIMARY KEY REFERENCES negocios(id) ON DELETE CASCADE,
  routing_token           text NOT NULL UNIQUE CHECK (routing_token ~ '^[a-f0-9]{48}$'),
  estado                  text NOT NULL DEFAULT 'registrando'
                          CHECK (estado IN ('registrando','activo','pausado','retirado')),
  webhook_id              text,
  organizacion_id         text,
  livemode                boolean,
  secreto_cifrado         text,
  secreto_iv              text,
  secreto_auth_tag        text,
  secreto_formato_version smallint,
  ultimo_evento_at        timestamptz,
  respaldo_desde          timestamptz,
  respaldo_pagina         integer,
  respaldo_completado_at  timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CHECK (estado NOT IN ('activo','pausado')
         OR (webhook_id IS NOT NULL AND organizacion_id IS NOT NULL AND livemode IS NOT NULL
             AND secreto_cifrado IS NOT NULL AND secreto_iv IS NOT NULL AND secreto_auth_tag IS NOT NULL
             AND secreto_formato_version IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS facturapi_webhook_eventos (
  negocio_id        uuid NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  evento_id         text NOT NULL,
  tipo              text NOT NULL,
  recibo_id         text,
  estado_remoto     text,
  folio             text,
  resultado         text NOT NULL,
  evento_creado_at  timestamptz,
  recibido_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (negocio_id, evento_id)
);
CREATE INDEX IF NOT EXISTS idx_facturapi_webhook_eventos_recibidos
  ON facturapi_webhook_eventos (negocio_id, recibido_at DESC);
