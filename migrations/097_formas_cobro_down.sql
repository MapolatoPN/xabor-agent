-- Revierte la 097. Solo a mano y a propósito: con la tabla fuera, la Caja y
-- la ruta de cobro usan la lista inicial en memoria (FORMAS_COBRO_INICIALES)
-- y las formas que un negocio haya dado de alta dejan de reconocerse.
DROP TABLE IF EXISTS formas_cobro;
