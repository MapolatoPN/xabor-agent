-- Rollback de 080. Deshace en orden inverso y dentro de una transacción.
--
-- DESTRUYE datos propios de la función: direcciones guardadas, sesiones,
-- códigos y consentimientos de los clientes. NO destruye puntos: solo suelta
-- el puntero rewards_accounts.cliente_id (el saldo, los movimientos y la
-- identidad (telefono, tenant_id) de Rewards quedan intactos). Tampoco
-- toca ningún pedido: se quita la columna cliente_id, y el snapshot del
-- cliente sigue en datos->'cliente' como siempre.
BEGIN;
ALTER TABLE tienda_config    DROP COLUMN IF EXISTS cuentas_clientes;
DROP INDEX IF EXISTS idx_pedidos_activos_cliente;
ALTER TABLE pedidos_activos  DROP CONSTRAINT IF EXISTS pedidos_activos_cliente_id_fkey;
ALTER TABLE pedidos_activos  DROP COLUMN IF EXISTS cliente_id;
DROP INDEX IF EXISTS idx_rewards_accounts_cliente;
ALTER TABLE rewards_accounts DROP CONSTRAINT IF EXISTS rewards_accounts_cliente_id_fkey;
ALTER TABLE rewards_accounts DROP COLUMN IF EXISTS cliente_id;
DROP TABLE IF EXISTS cliente_consentimientos;
DROP TABLE IF EXISTS cliente_sesiones;
DROP TABLE IF EXISTS cliente_otp;
DROP TABLE IF EXISTS cliente_direcciones;
DROP TABLE IF EXISTS clientes_negocio;
COMMIT;
