-- ============================================================
-- XABOR Multiempresa — Migración 020
-- Preparación del chat manual para piloto: distingue quién envió cada
-- mensaje saliente (bot de IA vs. humano) y evita duplicar mensajes
-- entrantes si Meta reentrega el mismo webhook.
--
-- mensajes.origen: 'cliente' (entrante), 'bot' (respuesta automática
-- de brain.js) o 'humano' (envío manual desde el panel). NULL para
-- filas anteriores a esta migración -- nunca se adivina retroactivamente
-- si un 'saliente' viejo fue del bot o de un humano; se backfillea solo
-- el caso inequívoco (todo 'entrante' es 'cliente').
--
-- mensajes.message_id_externo: el message.id que manda Meta en cada
-- webhook entrante (wamid). Índice único PARCIAL (solo cuando no es
-- NULL) -- reintentar el mismo webhook ya no inserta un mensaje
-- duplicado. Los envíos salientes no lo usan (quedan NULL): la
-- respuesta de Meta al enviar no es la misma clase de identificador
-- entrante y no hay evidencia en el repo de cómo deduplicar salientes
-- todavía -- no se inventa ese mecanismo aquí.
--
-- Reejecutable (columnas con IF NOT EXISTS, backfill idempotente).
-- Ejecutar con: psql "$CONN" -v ON_ERROR_STOP=1 -f 020_mensajes_origen_dedup.sql
-- ============================================================

BEGIN;

ALTER TABLE mensajes ADD COLUMN IF NOT EXISTS origen TEXT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mensajes_origen_check') THEN
    ALTER TABLE mensajes ADD CONSTRAINT mensajes_origen_check CHECK (origen IS NULL OR origen IN ('cliente','bot','humano'));
  END IF;
END $$;

ALTER TABLE mensajes ADD COLUMN IF NOT EXISTS message_id_externo TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mensajes_message_id_externo
  ON mensajes (message_id_externo)
  WHERE message_id_externo IS NOT NULL;

UPDATE mensajes SET origen = 'cliente' WHERE direccion = 'entrante' AND origen IS NULL;

COMMIT;
