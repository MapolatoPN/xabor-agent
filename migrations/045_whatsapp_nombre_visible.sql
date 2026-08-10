-- 045 -- Nombre visible de WhatsApp y su estado de revision en Meta.
--
-- Estrictamente ADITIVA: dos columnas nuevas, ambas nullable, sin default y
-- sin backfill. 0 UPDATE, 0 DELETE, 0 DROP. Las filas existentes quedan con
-- NULL, que es la verdad: hoy no sabemos su nombre visible porque nunca se
-- guardo.
--
-- Hace falta porque el panel del negocio tiene que mostrar el nombre que ve
-- el cliente en WhatsApp y si Meta ya lo aprobo. Sin esto habria que
-- consultarlo a Graph API en cada pintado de la pantalla, o peor, inventarlo.
--
-- `estado_nombre` guarda el valor CRUDO de Meta (APPROVED, PENDING_REVIEW,
-- REJECTED...). La traduccion a lenguaje humano vive en el codigo, no aqui:
-- si Meta agrega un estado nuevo, la base no tiene por que rechazarlo.

ALTER TABLE integraciones_canal ADD COLUMN IF NOT EXISTS verified_name TEXT;
ALTER TABLE integraciones_canal ADD COLUMN IF NOT EXISTS estado_nombre TEXT;
