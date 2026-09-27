-- 100 · El menú en imagen solo sale si el administrador lo revisó contra la
-- carta de WhatsApp VIGENTE.
--
-- Una imagen del menú es opaca: Xabor no puede leer qué productos muestra. Si
-- el negocio retira un producto de su carta de WhatsApp (098), una imagen
-- vieja lo seguiría mostrando. Regla: si Xabor no puede comprobar que las
-- imágenes corresponden a la carta publicada, no salen; el cliente recibe el
-- menú EN TEXTO generado desde la carta (menuAutomatico.js).
--
-- La comprobación es una HUELLA que se recalcula en cada envío, no una marca
-- que alguien tenga que acordarse de invalidar: cubre los cambios del panel,
-- los SQL manuales, la siembra de la 098, los borrados en cascada y el
-- encendido o apagado de categorías, sin triggers sobre las tablas del POS.
--
--   · carta:    (id, nombre, precio, disponible) de cada producto publicado
--               en una categoría activa —el mismo filtro que la carta de los
--               motores (catalogoWhatsapp.js, idsPublicadosEnWhatsapp)—.
--               `agotado` NO entra: es el faltante del día y no retira nada.
--   · imágenes: el CONJUNTO de objetos del menú (páginas, o la columna V1 si
--               no hay páginas). Reordenar no lo cambia; agregar, reemplazar
--               o quitar una página, sí.
--
-- Al revisar se guardan ambas huellas (y la carta revisada, para explicar en
-- el panel qué cambió). Como la huella es del contenido, volver al estado
-- revisado (republicar lo retirado, reactivar el producto) la vuelve a
-- validar sin otra revisión.
--
-- Aditiva e idempotente. Nadie queda aprobado por la migración: todo menú
-- existente nace «nunca revisado» y sale en texto hasta que su administrador
-- lo revise.

ALTER TABLE whatsapp_menu_automatico
  ADD COLUMN IF NOT EXISTS revision_carta_huella    text        NULL,
  ADD COLUMN IF NOT EXISTS revision_imagenes_huella text        NULL,
  ADD COLUMN IF NOT EXISTS revision_carta           jsonb       NULL,
  ADD COLUMN IF NOT EXISTS revisado_at              timestamptz NULL,
  ADD COLUMN IF NOT EXISTS revisado_por             uuid        NULL REFERENCES usuarios(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION carta_whatsapp_canonica(p_negocio uuid) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', p.id, 'nombre', p.nombre, 'precio', p.precio,
           'disponible', p.disponible IS NOT FALSE) ORDER BY p.id), '[]'::jsonb)
    FROM whatsapp_productos wp
    JOIN menu_productos p
      ON p.id = wp.producto_id AND p.negocio_id = wp.negocio_id
    JOIN menu_categorias c
      ON c.id = p.categoria_id AND c.negocio_id = p.negocio_id
   WHERE wp.negocio_id = p_negocio
     AND wp.publicado = TRUE
     AND c.activa = TRUE
$$;

CREATE OR REPLACE FUNCTION huella_carta_whatsapp(p_negocio uuid) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT 'c1:' || md5(carta_whatsapp_canonica(p_negocio)::text)
$$;

-- Mismo orden de precedencia que obtenerPaginas (menuAutomatico.js): las
-- páginas de la 050 y, solo si no hay ninguna, la imagen V1 de la 048.
CREATE OR REPLACE FUNCTION imagenes_menu_whatsapp(p_negocio uuid) RETURNS text[]
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    (SELECT array_agg(i.storage_key ORDER BY i.storage_key)
       FROM whatsapp_menu_imagenes i WHERE i.negocio_id = p_negocio),
    (SELECT ARRAY[m.storage_key]
       FROM whatsapp_menu_automatico m
      WHERE m.negocio_id = p_negocio AND m.storage_key IS NOT NULL),
    ARRAY[]::text[])
$$;

-- Huella de un CONJUNTO de objetos (el orden no cuenta). Opaca: el panel la
-- recibe en vez de las storage keys, que nunca salen al navegador.
CREATE OR REPLACE FUNCTION huella_imagenes_menu(p_imagenes text[]) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT 'i1:' || md5(array_to_string(
    ARRAY(SELECT DISTINCT k FROM unnest(COALESCE(p_imagenes, ARRAY[]::text[])) AS k ORDER BY k), E'\n'))
$$;

-- Estado de la revisión. `p_imagenes` son los objetos que el llamador está a
-- punto de enviar (así se compara exactamente lo que sale); NULL = los de la
-- base. Resultado: sin_menu | sin_imagenes | sin_carta | nunca_revisada |
-- carta_cambio | imagenes_cambiaron | vigente. Solo 'vigente' deja salir
-- imágenes.
CREATE OR REPLACE FUNCTION estado_revision_menu_whatsapp(p_negocio uuid, p_imagenes text[] DEFAULT NULL)
RETURNS text
LANGUAGE sql STABLE AS $$
  WITH m AS (
    SELECT revision_carta_huella, revision_imagenes_huella
      FROM whatsapp_menu_automatico WHERE negocio_id = p_negocio
  ), img AS (
    SELECT COALESCE(p_imagenes, imagenes_menu_whatsapp(p_negocio)) AS claves
  )
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM m) THEN 'sin_menu'
    WHEN cardinality((SELECT claves FROM img)) = 0 THEN 'sin_imagenes'
    WHEN jsonb_array_length(carta_whatsapp_canonica(p_negocio)) = 0 THEN 'sin_carta'
    WHEN (SELECT revision_carta_huella FROM m) IS NULL
      OR (SELECT revision_imagenes_huella FROM m) IS NULL THEN 'nunca_revisada'
    WHEN (SELECT revision_carta_huella FROM m) <> huella_carta_whatsapp(p_negocio) THEN 'carta_cambio'
    WHEN (SELECT revision_imagenes_huella FROM m) <> huella_imagenes_menu((SELECT claves FROM img)) THEN 'imagenes_cambiaron'
    ELSE 'vigente'
  END
$$;
