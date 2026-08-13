-- ============================================================
-- XABOR Multiempresa — Migración 050
-- Menú automático MULTIIMAGEN: un menú puede tener varias páginas.
--
-- Por qué: el V1 (048) guarda UNA imagen por negocio en columnas de
-- whatsapp_menu_automatico. Nonna Maye (y cualquier negocio con menú de
-- varias hojas) necesita 1..N páginas ordenadas. Tal como la propia 048
-- anticipó: "Si algún día hay varias páginas, se agrega una tabla hija,
-- no se multiplica esta".
--
-- Compatibilidad, sin destruir nada:
--   1. Se crea la tabla hija whatsapp_menu_imagenes (páginas ordenadas).
--   2. BACKFILL: la imagen única existente de cada negocio se convierte
--      automáticamente en su "Página 1" (mismo storage_key -- el objeto
--      en R2 NO se mueve ni se copia). Idempotente: solo inserta si el
--      negocio aún no tiene páginas.
--   3. Las columnas viejas (storage_key/mime_type/...) NO se eliminan:
--      quedan como respaldo de rollback. El código deja de escribirlas.
--   4. El CHECK "activo exige storage_key" se elimina: la condición real
--      ahora es "activo exige ≥1 página" y vive en la aplicación
--      (guardarConfigMenu / eliminarImagenMenuPagina), que además la
--      explica en lenguaje del negocio en vez de un error de Postgres.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS whatsapp_menu_imagenes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id UUID NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  storage_key TEXT NOT NULL,
  mime_type TEXT NULL,
  nombre_archivo TEXT NULL,
  tamano_bytes INTEGER NULL,
  orden INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_menu_imagenes_negocio
  ON whatsapp_menu_imagenes (negocio_id, orden);

-- Backfill: la imagen única del V1 se vuelve la Página 1 del negocio, sin
-- intervención de nadie. Solo si ese negocio todavía no tiene páginas.
INSERT INTO whatsapp_menu_imagenes (negocio_id, storage_key, mime_type, nombre_archivo, tamano_bytes, orden)
SELECT m.negocio_id, m.storage_key, m.mime_type, m.nombre_archivo, m.tamano_bytes, 1
  FROM whatsapp_menu_automatico m
 WHERE m.storage_key IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM whatsapp_menu_imagenes i WHERE i.negocio_id = m.negocio_id);

-- El CHECK del V1 ata "activo" a la columna vieja; con páginas en la tabla
-- hija esa condición ya no es la verdad y bloquearía activaciones válidas.
ALTER TABLE whatsapp_menu_automatico
  DROP CONSTRAINT IF EXISTS whatsapp_menu_activo_exige_imagen;

DROP TRIGGER IF EXISTS trg_whatsapp_menu_imagenes_updated_at ON whatsapp_menu_imagenes;
CREATE TRIGGER trg_whatsapp_menu_imagenes_updated_at
  BEFORE UPDATE ON whatsapp_menu_imagenes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
