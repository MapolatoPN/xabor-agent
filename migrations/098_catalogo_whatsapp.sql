-- 098 · Catálogo publicado para WhatsApp, independiente del menú operativo.
--
-- El menú operativo (menu_productos) incluye artículos internos que el POS y
-- el inventario necesitan —extras sueltos, piezas, productos de cortesía— y
-- que un cliente nunca debe ver ni poder pedir por WhatsApp. Esta tabla decide,
-- por negocio, qué productos puede conocer y vender el agente.
--
--   · Sin fila = NO publicado. Todo producto creado después de esta migración
--     nace cerrado para WhatsApp hasta que el negocio lo ofrezca en el panel.
--   · Retirar un producto guarda la fila en FALSE (no se borra), para que
--     ninguna ejecución posterior de esta migración lo vuelva a publicar.
--   · La FK compuesta (negocio_id, producto_id) impide asociar un producto de
--     otro negocio: la publicación está aislada por tenant en el esquema, no
--     solo en el código.
--   · No toca menu_productos, tienda_productos ni nada que lea el POS: ocultar
--     algo de WhatsApp no lo oculta de ningún otro canal.
--
-- Siembra: SOLO la primera vez que la tabla se crea, se publican los productos
-- que el negocio ya publicó en su Tienda en línea (la única selección pública
-- revisada que existe hoy). Es un punto de partida, no una decisión del bot:
-- el negocio la revisa en Menú › Productos para WhatsApp antes de activar el
-- agente. Las filas sembradas quedan marcadas con origen='siembra_tienda'.
--
-- Aditiva e idempotente: se puede ejecutar N veces sin cambiar el resultado.

-- La FK compuesta necesita unicidad sobre (negocio_id, id). `id` ya es PK, así
-- que el índice es trivialmente único; en las bases actuales ya existe con este
-- nombre y la sentencia no hace nada.
CREATE UNIQUE INDEX IF NOT EXISTS idx_menu_producto_negocio_id
  ON menu_productos (negocio_id, id);

DO $$
DECLARE
  tabla_nueva boolean := to_regclass('public.whatsapp_productos') IS NULL;
BEGIN
  CREATE TABLE IF NOT EXISTS whatsapp_productos (
    negocio_id       uuid        NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
    producto_id      integer     NOT NULL,
    publicado        boolean     NOT NULL DEFAULT false,
    origen           text        NOT NULL DEFAULT 'panel',
    actualizado_por  uuid        NULL,
    created_at       timestamptz NOT NULL DEFAULT NOW(),
    updated_at       timestamptz NOT NULL DEFAULT NOW(),
    PRIMARY KEY (negocio_id, producto_id),
    CONSTRAINT whatsapp_productos_origen_check
      CHECK (origen IN ('panel', 'siembra_tienda')),
    CONSTRAINT fk_whatsapp_producto_negocio
      FOREIGN KEY (negocio_id, producto_id)
      REFERENCES menu_productos (negocio_id, id) ON DELETE CASCADE
  );

  IF tabla_nueva AND to_regclass('public.tienda_productos') IS NOT NULL THEN
    INSERT INTO whatsapp_productos (negocio_id, producto_id, publicado, origen)
    SELECT tp.negocio_id, tp.producto_id, TRUE, 'siembra_tienda'
      FROM tienda_productos tp
      JOIN menu_productos p
        ON p.id = tp.producto_id AND p.negocio_id = tp.negocio_id
     WHERE tp.publicado = TRUE
    ON CONFLICT (negocio_id, producto_id) DO NOTHING;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_whatsapp_productos_publicados
  ON whatsapp_productos (negocio_id, producto_id) WHERE publicado;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'set_updated_at_whatsapp_productos'
       AND tgrelid = 'whatsapp_productos'::regclass
  ) THEN
    CREATE TRIGGER set_updated_at_whatsapp_productos
      BEFORE UPDATE ON whatsapp_productos
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;
