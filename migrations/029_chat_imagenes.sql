-- ============================================================
-- XABOR Multiempresa — Migración 029
-- Chat multimedia básico: enviar y recibir fotos como WhatsApp normal.
-- Sin IA visual, sin catálogo visual, sin video/audio -- únicamente
-- envío/recepción/historial de imágenes, reutilizando la tabla
-- `documentos` ya usada para PDFs (mismo modelo de pertenencia,
-- dedup por wamid, estados pendiente/descargando/listo/error).
--
-- Agrega:
--   1. documentos.categoria -- distingue 'documento' (PDF, comportamiento
--      previo, default) de 'imagen' (nuevo). Ninguna fila existente
--      cambia de categoria (DEFAULT 'documento' aplica retroactivamente).
--   2. documentos.media_id -- identificador de media de Meta (distinto
--      del wamid, que es el ID del MENSAJE) -- informativo/trazabilidad,
--      el mecanismo real de deduplicación sigue siendo el índice único
--      parcial ya existente sobre wamid (idx_documentos_wamid, migración
--      026) -- un reenvío del mismo webhook siempre trae el mismo wamid.
--   3. documentos.checksum -- SHA-256 del contenido ya descargado/validado,
--      para diagnóstico y una futura deduplicación por contenido (no se
--      agrega un índice único sobre esta columna en esta fase -- dos
--      imágenes idénticas enviadas a propósito en mensajes distintos son
--      válidas, no un duplicado de webhook).
--   4. mensajes.tipo -- se amplía el CHECK para aceptar 'imagen' además de
--      los valores existentes ('texto','documento').
--
-- No se toca negocio_modulos: 'chat_imagenes' ya existe como módulo válido
-- y ya está sembrado 'activo' para todos los negocios reales desde la
-- migración 026 (fue diseñado desde entonces para operar sin gate de
-- contratación, a diferencia de chat_documentos_pdf) -- esta migración no
-- cambia ese estado para ningún negocio.
--
-- Reejecutable: IF NOT EXISTS / DO $$ guards en todo.
-- Ejecutar con: psql "$CONN" -v ON_ERROR_STOP=1 -f 029_chat_imagenes.sql
-- ============================================================

BEGIN;

ALTER TABLE documentos ADD COLUMN IF NOT EXISTS categoria TEXT NOT NULL DEFAULT 'documento';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'documentos_categoria_check') THEN
    ALTER TABLE documentos ADD CONSTRAINT documentos_categoria_check CHECK (categoria IN ('documento','imagen'));
  END IF;
END $$;

ALTER TABLE documentos ADD COLUMN IF NOT EXISTS media_id TEXT;
ALTER TABLE documentos ADD COLUMN IF NOT EXISTS checksum TEXT;

CREATE INDEX IF NOT EXISTS idx_documentos_categoria ON documentos (negocio_id, categoria);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mensajes_tipo_check') THEN
    ALTER TABLE mensajes DROP CONSTRAINT mensajes_tipo_check;
  END IF;
  ALTER TABLE mensajes ADD CONSTRAINT mensajes_tipo_check CHECK (tipo IN ('texto','documento','imagen'));
END $$;

COMMIT;
