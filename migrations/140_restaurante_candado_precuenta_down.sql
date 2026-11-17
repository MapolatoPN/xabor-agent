-- Reversa de la 140. Solo a mano, con psql, y a propósito: borra el registro
-- de precuentas impresas y la bitácora de las cuentas. Antes, apaga las dos
-- banderas del negocio ('restaurante_candado_precuenta' y
-- 'restaurante_cobro_identificado') y vuelve a un binario anterior a la 140:
-- el código de la 140 escribe en estas tablas al imprimir una precuenta.
DROP TABLE IF EXISTS restaurante_cuenta_bitacora;
DROP TABLE IF EXISTS restaurante_precuentas;
