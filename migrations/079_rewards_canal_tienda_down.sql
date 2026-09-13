-- Rollback de 079. Quitar la columna devuelve el comportamiento anterior
-- (la tienda deja de acumular y de canjear, porque el mapa de canales
-- vuelve a no encontrar 'tienda_online'), pero PIERDE qué negocios lo
-- tenían encendido. No borra ningún movimiento ya acreditado: los puntos
-- que la tienda haya dado siguen siendo del cliente.
ALTER TABLE rewards_config DROP COLUMN IF EXISTS canal_tienda;
