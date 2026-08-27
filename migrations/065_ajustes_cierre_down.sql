-- 065 down — elimina el módulo de ajustes de cierre y el registro local de
-- facturación. Destructivo por definición (es un down): borra el historial
-- de ajustes y el enlace pedido→factura. Solo para entornos de desarrollo.
DROP TABLE IF EXISTS ajustes_cierre;
DROP TABLE IF EXISTS facturas_pedido;
