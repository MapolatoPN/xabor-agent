-- Rollback de la 055.
--
-- ATENCIÓN: quitar `derivacion_pendiente` borra deudas de derivación abiertas.
-- Si hay filas con derivacion_pendiente = true en el momento del rollback, esos
-- pedidos quedan cobrados y sin liberar, y ya no habrá cómo encontrarlos. Antes
-- de correr esto, verificar que la cuenta sea cero:
--
--   SELECT COUNT(*) FROM pagos WHERE derivacion_pendiente;
--
-- El resto de las columnas de pagos y todo el dinero asentado quedan intactos.

DROP INDEX IF EXISTS idx_pagos_reconciliables;
DROP INDEX IF EXISTS idx_pagos_derivacion_pendiente;
ALTER TABLE pagos DROP COLUMN IF EXISTS derivacion_saldada_at;
ALTER TABLE pagos DROP COLUMN IF EXISTS derivacion_pendiente;
