-- Reversa de la 136: deja de numerar. Solo a mano, con psql y a propósito.
--
-- Para APAGAR la numeración de una sucursal no hace falta esto: basta con
-- poner `numero_sucursal_activo` en 'false' en su configuracion. Un binario
-- anterior tampoco la necesita: no lee estas tablas ni la columna.
--
-- Esta reversa quita el trigger y su función y CONSERVA los datos (la columna,
-- el contador y el ledger). Borrarlos haría que, al volver a aplicar la 136,
-- la numeración empezara otra vez en 1 y repitiera números ya impresos y
-- vistos en Caja. Si de verdad se quieren borrar, el bloque de abajo está
-- comentado.
\set ON_ERROR_STOP on
BEGIN;
DROP TRIGGER IF EXISTS trg_zz_numero_sucursal ON pedidos_activos;
DROP FUNCTION IF EXISTS xabor_numero_sucursal();
COMMIT;

-- Borrado completo (pierde la historia de números; no se puede deshacer):
-- BEGIN;
-- ALTER TABLE pedidos_activos DROP COLUMN IF EXISTS numero_sucursal;
-- DROP TABLE IF EXISTS pedido_numeros_sucursal;
-- DROP TABLE IF EXISTS pedido_numero_sucursal_contador;
-- DELETE FROM configuracion WHERE clave IN ('numero_sucursal_activo', 'numero_sucursal_prefijo');
-- COMMIT;
