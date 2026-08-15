-- Rollback de la 051. Solo borra objetos creados por esa migración; ninguna
-- tabla preexistente se toca. Orden inverso por las FKs.
DROP TABLE IF EXISTS tienda_pedidos;
DROP TABLE IF EXISTS tienda_promocion_usos;
DROP TABLE IF EXISTS tienda_promociones;
DROP TABLE IF EXISTS tienda_campanas;
DROP TABLE IF EXISTS tienda_productos;
DROP TABLE IF EXISTS tienda_config;
