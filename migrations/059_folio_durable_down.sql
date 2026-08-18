-- Reversa de la 059. Elimina la secuencia durable; el sistema volveria al
-- contador en memoria sembrado desde `pedidos_activos`, es decir, a reciclar
-- folios. Solo para rehacer la migracion, nunca como estado final.
DROP SEQUENCE IF EXISTS folio_pedido_seq;
