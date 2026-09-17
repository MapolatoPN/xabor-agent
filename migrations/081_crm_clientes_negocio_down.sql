-- Rollback de 081. Solo quita el índice de expresión.
--
-- Las filas que el backfill agregó a clientes_negocio se CONSERVAN a
-- propósito: son clientes reales del negocio (personas que pidieron), pueden
-- haber acumulado direcciones, sesiones o consentimientos después, y la 080
-- las borraría en cascada. Con el código anterior son inertes (el tab viejo
-- lee `clientes`). Si de verdad hiciera falta retirarlas, es una decisión
-- con datos en la mano, no un rollback ciego.
DROP INDEX IF EXISTS idx_pedidos_activos_negocio_tel10;
