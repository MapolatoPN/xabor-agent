-- Quita la bitácora y la marca de cancelación. Los recibos que la 122 pasó a
-- 'cancelado' se quedan así: son CFDI cancelados ante el SAT.
DROP TABLE IF EXISTS facturacion_bitacora;
ALTER TABLE facturas_pedido DROP COLUMN IF EXISTS cancelada_at;
