-- Reversa de la 058. Deja el sistema como estaba: `clienteYaComproDeVerdad`
-- volvería a correlacionar `pedidos` con `pedidos_activos`, con la limitación
-- conocida (un intento nunca pagado y purgado del tablero vuelve a parecer
-- compra). Por eso esta reversa solo debería usarse para rehacer la migración,
-- nunca como estado final.
DROP INDEX IF EXISTS idx_compra_real_cliente;
DROP INDEX IF EXISTS idx_compra_real_pedido;
ALTER TABLE IF EXISTS compras_reales DROP CONSTRAINT IF EXISTS chk_compra_origen;
DROP TABLE IF EXISTS compras_reales;
