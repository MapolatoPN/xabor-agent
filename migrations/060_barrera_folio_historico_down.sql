-- Reversa de la 060. Quita la barrera que impide que un folio ya usado vuelva
-- a entrar al tablero.
--
-- AVISO: sin esta barrera, un binario con allocator en memoria (cualquiera
-- anterior a la 059) puede volver a reciclar folios historicos en cuanto el
-- tablero se purgue -- que es exactamente P0-13. No revertirla mientras exista
-- la posibilidad de correr codigo viejo con escrituras abiertas.
DROP TRIGGER IF EXISTS trg_barrera_folio_historico ON pedidos_activos;
DROP FUNCTION IF EXISTS xabor_barrera_folio_historico();
