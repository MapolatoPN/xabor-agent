-- Reverso de la 113. Nadie lo ejecuta en automático: solo a mano, con psql y
-- a propósito.
--
-- ANTES de correrlo, DESPLEGAR un binario que ya no lea esta tabla. El de la
-- 113 la lee en cada /api/conversacion/:telefono/estado-bot sin plan B
-- (src/services/estadoAtencionConversacion.js): con la tabla fuera esa ruta
-- responde 503 en TODAS las conversaciones, y el panel deja el botón en
-- «Estado no disponible», sin «Tomar conversación» ni «Devolver al bot».
--
-- Y apagar el job en cada negocio (borrar la clave
-- `whatsapp_pausa_vence_horas` de `configuracion`): con la tabla fuera, el job
-- registra un error en cada corrida y no libera nada.
--
-- Se pierde la bitácora de qué pausas venció el sistema. Para conservarla:
--   \copy conversaciones_pausa_vencimientos TO 'pausa_vencimientos.csv' CSV HEADER
DROP INDEX IF EXISTS idx_pausa_vencimientos_conversacion;
DROP TABLE IF EXISTS conversaciones_pausa_vencimientos;
