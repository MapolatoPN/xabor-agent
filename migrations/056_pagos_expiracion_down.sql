-- Rollback de la 056.
--
-- Quitar `xabor_espera_hasta` NO pierde dinero: los cobros, sus identidades y
-- su historia viven en otras columnas. Lo que se pierde es el deadline interno,
-- así que los pedidos que estaban esperando pago dejarían de vencer solos hasta
-- que alguien los atienda a mano.

DROP INDEX IF EXISTS idx_pagos_espera_vencida;
ALTER TABLE pagos DROP COLUMN IF EXISTS xabor_espera_hasta;
