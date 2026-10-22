-- Con estas tablas fuera, la ruta de avisos responde 500 y el barrido de
-- recibos falla: retirar antes los webhooks (scripts/ops/facturapi-webhook-2026-10)
-- y volver al código anterior.
DROP TABLE IF EXISTS facturapi_webhook_eventos;
DROP TABLE IF EXISTS facturapi_webhooks;
