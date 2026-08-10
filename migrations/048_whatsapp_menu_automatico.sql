-- 048 -- Menú automático de WhatsApp, por negocio.
--
-- Por qué existe: hoy el bot YA sabe mandar el menú (marcador <ENVIAR_MENU>
-- en el prompt), pero manda SIEMPRE el mismo archivo:
--
--   enviarImagen(telefono, `${PUBLIC_URL}/public/menu.png`, ...)
--
-- Un único PNG de 657 KB versionado dentro del repositorio, servido en una
-- URL pública, idéntico para todos los negocios. Es decir: si Carnitas Moreno
-- pide el menú, el cliente recibe el menú que esté commiteado, no el de
-- Carnitas. Misma familia de defecto que el enlace de pago de Clip y la
-- comanda cruzada de Alora/Nonna Maye: un recurso global en un producto
-- multiempresa. Esta tabla le da a cada negocio el suyo.
--
-- Por qué NO se reutiliza `integraciones_canal`: esa tabla es la identidad
-- técnica del canal (phone_number_id, waba_id, token cifrado, estado de
-- activación). El menú es contenido comercial del negocio: cambia de dueño
-- (lo edita el admin del negocio, no Xabor), de ciclo de vida (se reemplaza
-- cuando cambian precios) y de sensibilidad (no hay ningún secreto). Meterlo
-- en `configuracion` obligaría a guardar frases como JSON en texto libre y
-- perderíamos el UNIQUE por negocio y el FK del actor.
--
-- Una fila por negocio: el V1 es UNA imagen. Si algún día hay varias páginas
-- o PDF, se agrega una tabla hija, no se multiplica esta.
--
-- La imagen NO vive aquí: en la columna va la storage_key de R2
-- (almacenamiento.js, STORAGE_DRIVER=s3 en producción). La base guarda la
-- referencia, nunca el binario.

CREATE TABLE IF NOT EXISTS whatsapp_menu_automatico (
  negocio_id UUID PRIMARY KEY REFERENCES negocios(id) ON DELETE CASCADE,

  -- El interruptor es independiente de tener imagen: un negocio puede subir
  -- su menú hoy y activarlo mañana, o desactivarlo sin perder la imagen.
  activo BOOLEAN NOT NULL DEFAULT FALSE,

  -- Referencia al objeto en R2. NULL = todavía no ha subido nada.
  storage_key TEXT NULL,
  mime_type TEXT NULL,
  nombre_archivo TEXT NULL,          -- solo para mostrarlo en el panel
  tamano_bytes INTEGER NULL,

  -- Frases que disparan el envío. Array, no texto libre: el matcher compara
  -- frase por frase ya normalizada, y así ninguna frase del cliente llega
  -- nunca a construir una expresión regular.
  frases_disparadoras TEXT[] NOT NULL DEFAULT ARRAY[
    'menu', 'menú', 'carta', 'precios', 'lista de precios',
    'que venden', 'qué venden', 'que tienen', 'qué tienen'
  ]::TEXT[],

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actualizado_por UUID NULL REFERENCES usuarios(id) ON DELETE SET NULL,

  -- No se puede quedar "activo" sin nada que mandar: sería un negocio que
  -- cree que su menú funciona mientras sus clientes no reciben nada.
  CONSTRAINT whatsapp_menu_activo_exige_imagen
    CHECK (activo = FALSE OR storage_key IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_menu_activo
  ON whatsapp_menu_automatico (negocio_id) WHERE activo = TRUE;

DROP TRIGGER IF EXISTS trg_whatsapp_menu_updated_at ON whatsapp_menu_automatico;
CREATE TRIGGER trg_whatsapp_menu_updated_at
  BEFORE UPDATE ON whatsapp_menu_automatico
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
