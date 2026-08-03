-- Rollback de la migración 029. Guarda: aborta si ya existe alguna imagen
-- real (categoria='imagen') -- este down perdería la clasificación (y con
-- ella, la capacidad de distinguir imágenes de PDFs) de esas filas.
-- Ejecutar con: psql "$CONN" -v ON_ERROR_STOP=1 -f 029_chat_imagenes_down.sql

BEGIN;

DO $$
DECLARE
  v_imagenes INTEGER;
BEGIN
  SELECT count(*) INTO v_imagenes FROM documentos WHERE categoria = 'imagen';
  IF v_imagenes > 0 THEN
    RAISE EXCEPTION
      'Rollback 029 abortado: existen % imagen(es) real(es) en documentos. Este down perdería su categoria/checksum/media_id.',
      v_imagenes;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mensajes_tipo_check') THEN
    ALTER TABLE mensajes DROP CONSTRAINT mensajes_tipo_check;
  END IF;
  ALTER TABLE mensajes ADD CONSTRAINT mensajes_tipo_check CHECK (tipo IN ('texto','documento'));
END $$;

DROP INDEX IF EXISTS idx_documentos_categoria;
ALTER TABLE documentos DROP COLUMN IF EXISTS checksum;
ALTER TABLE documentos DROP COLUMN IF EXISTS media_id;
ALTER TABLE documentos DROP CONSTRAINT IF EXISTS documentos_categoria_check;
ALTER TABLE documentos DROP COLUMN IF EXISTS categoria;

COMMIT;
