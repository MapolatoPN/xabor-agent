-- Reversa de la 061. Vuelve la barrera a mirar solo `pedidos` (estado 060) y
-- retira el ledger de claims.
--
-- AVISO: sin el ledger, un folio que solo exista en `pagos`,
-- `impresion_trabajos` o cualquiera de las otras fuentes vuelve a ser
-- reutilizable, y la excepcion de programados vuelve a ser por folio a secas.
-- No revertir mientras pueda correr codigo con allocator en memoria.
DROP TRIGGER IF EXISTS trg_barrera_folio_historico ON pedidos_activos;
DROP FUNCTION IF EXISTS xabor_barrera_folio_historico();
DROP TABLE IF EXISTS folios_pedido_usados;
-- `pedidos_programados.programado_id` se CONSERVA: es aditiva, inocua para el
-- codigo viejo, y borrarla destruiria la identidad de reservas vivas.
