-- Reversa de la 136. Solo a mano, con psql, y a propósito: borra la bitácora
-- de los descuentos enviados (sin ella, un cliente que ya lo recibió podría
-- recibirlo otra vez si el job sigue encendido). Apaga antes el job quitando
-- `cerrado_descuento_codigo` de la configuración del negocio.
DROP TABLE IF EXISTS descuento_tras_cierre_envios;
