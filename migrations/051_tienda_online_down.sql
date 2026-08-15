-- Rollback de la 051.
--
-- La 051 hace DOS cosas, y revertir solo una deja la base inconsistente:
--   (a) crea seis tablas nuevas
--   (b) REEMPLAZA el CHECK de negocio_modulos para admitir 'tienda_online'
--
-- El orden de abajo importa. Restaurar el CHECK antes de borrar las filas de
-- negocio_modulos haría fallar el ALTER: Postgres valida la restricción contra
-- las filas existentes, y cualquier negocio con el módulo contratado la
-- violaría. Por eso primero se desactiva el módulo y después se restaura.

BEGIN;

-- 1) Ningún negocio puede quedar con un módulo que dejará de existir.
--    Se borran las filas, no se "suspenden": el módulo desaparece del sistema.
DELETE FROM negocio_modulos WHERE modulo = 'tienda_online';

-- 2) CHECK de negocio_modulos exactamente como estaba antes de la 051: los
--    dieciocho módulos previos, sin 'tienda_online'. Esta lista es el estado
--    que dejó la 039 (última migración que tocó este CHECK).
ALTER TABLE negocio_modulos DROP CONSTRAINT IF EXISTS negocio_modulos_modulo_check;
ALTER TABLE negocio_modulos ADD CONSTRAINT negocio_modulos_modulo_check CHECK (modulo = ANY (ARRAY[
  'pos', 'usuarios', 'caja', 'menu', 'impresion', 'whatsapp', 'voz', 'rappi',
  'facturacion', 'rewards', 'chat_imagenes', 'chat_documentos_pdf', 'cotizaciones',
  'generador_cotizaciones', 'pagos', 'repartidores', 'asistente_comercial_cotizaciones',
  'restaurante'
]));

-- 3) La FK compuesta que la 051 puso sobre una tabla PREEXISTENTE
--    (tienda_productos → menu_productos) y el índice de apoyo que creó en
--    menu_productos. Es lo único que la 051 dejó fuera de sus propias tablas,
--    así que es lo único que hay que deshacer aparte de borrarlas.
ALTER TABLE tienda_productos DROP CONSTRAINT IF EXISTS tienda_productos_negocio_producto_fkey;
DROP INDEX IF EXISTS idx_menu_producto_negocio_id;
-- Y el índice único de checkout sobre pedidos_activos. Los pedidos NO se
-- tocan: solo deja de haber restricción sobre un campo que ya nadie escribe.
DROP INDEX IF EXISTS idx_pedido_activo_checkout_token;

-- 4) Las seis tablas, en orden inverso por las FKs. Ninguna tabla preexistente
--    se toca: los pedidos que la tienda haya creado viven en pedidos_activos y
--    pedidos, y siguen ahí — pierden el vínculo con su checkout_token, que es
--    dato de la tienda, no del pedido.
DROP TABLE IF EXISTS tienda_pedidos;
DROP TABLE IF EXISTS tienda_promocion_usos;
DROP TABLE IF EXISTS tienda_promociones;
DROP TABLE IF EXISTS tienda_campanas;
DROP TABLE IF EXISTS tienda_productos;
DROP TABLE IF EXISTS tienda_config;

COMMIT;

-- ADVERTENCIA OPERATIVA
-- Este rollback DESTRUYE la configuración de tienda, las promociones y su
-- historial de uso. Los pedidos ya cobrados no se pierden, pero la atribución
-- de qué promoción los generó, sí. Antes de correrlo en una base con tiendas
-- publicadas, respaldar las seis tablas.
