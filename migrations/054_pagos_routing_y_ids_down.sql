-- ─── Rollback de la 054 ───────────────────────────────────────────────────
-- ⚠ Al quitar webhook_routing_token, los webhooks en vuelo dejan de poder
-- resolver su integración: se rechazan (fail closed), no se procesan mal.
-- Al quitar payment_id/preference_id se pierde la trazabilidad de qué pago
-- externo confirmó cada cobro; el dinero ya cobrado no se toca.

BEGIN;
DROP INDEX IF EXISTS idx_integraciones_routing_token;
ALTER TABLE integraciones_canal DROP COLUMN IF EXISTS webhook_routing_token;
DROP INDEX IF EXISTS idx_pagos_preference_id;
DROP INDEX IF EXISTS idx_pagos_payment_id;
ALTER TABLE pagos DROP COLUMN IF EXISTS payment_id;
ALTER TABLE pagos DROP COLUMN IF EXISTS preference_id;
COMMIT;
