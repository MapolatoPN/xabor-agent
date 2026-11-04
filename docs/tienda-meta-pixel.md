# Meta Pixel en la tienda pública

Cada negocio puede medir su tienda (`xabor.mx/t/<slug>`) en **su propio** píxel
de Meta (Facebook e Instagram). Sin ID configurado, la tienda no carga nada de
Meta. El panel de administración (`/app`, `/superadmin`) y las demás páginas
internas **nunca** cargan el píxel.

Es el mismo diseño que Google Analytics 4 (`docs/tienda-ga4.md`), con su propia
clave, sus propias rutas y su propia marca de entrega: un canal nunca gasta ni
tapa al otro.

## Configuración

- **Panel → Tienda en línea → Analítica** (solo administradores), debajo de
  Google Analytics: campo **«Meta Pixel ID»**. Formato `^\d{15,16}$`: solo
  dígitos, 15 o 16; se toleran espacios alrededor. Vacío = quitar.
- Se guarda en `configuracion.meta_pixel_id` del negocio (sin migración). Se
  valida al guardar (`PUT /api/admin/tienda/meta-pixel` y también
  `PUT /api/config`) y otra vez al leer: una fila escrita a mano con basura
  queda inerte. El valor tiene que llegar como **texto**: un número de 16
  dígitos ya perdió precisión al pasar por JSON y mandaría los datos a un
  píxel ajeno.
- Un operador (staff) recibe 403 al leer o cambiar el ID.
- `GET /api/tienda/:slug` publica `metaPixel: { pixelId, sucursal }` o `null`.
  `sucursal` es el nombre visible de la tienda (`tienda_config.titular`, o el
  nombre del negocio): «Mapolato Obispado», «Mapolato Acuña».

## Qué se carga

`panel/tienda-meta-pixel.js` (`window.XaborMetaPixel`) es el único punto de
contacto con Meta. Lo cargan `tienda.html`, `tienda-seguimiento.html` y el
marco `tienda-meta-pixel.html`, con huella `?v=<sha256[0:8]>`. Al cargar no
hace nada por su cuenta. En la tienda, con ID, inserta en el `<head>` el código
base oficial de Meta (`connect.facebook.net/en_US/fbevents.js`) y manda:

```js
fbq('set', 'autoConfig', false, ID);   // sin eventos automáticos
fbq('init', ID);
fbq('track', 'PageView');
```

El ID nunca se escribe en el HTML: el servidor no toca la plantilla (una sola
para todos los negocios) y el módulo pasa el ID, validado, a `fbq('init')`.

Toda llamada de la tienda pasa por `pixelMeta(fn, ...)`, que no puede lanzar:
si el módulo no carga o Meta está bloqueado, la compra sigue igual.

## Eventos (todos con `currency: 'MXN'` y `sucursal`)

| Evento | Cuándo | Parámetros |
|---|---|---|
| `PageView` | al abrir la tienda | — |
| `ViewContent` | al abrir un platillo (no al editar un renglón) | `content_ids: [id]`, `content_name`, `content_type: 'product'`, `value` = precio |
| `AddToCart` | al agregar; editar un renglón manda solo las piezas que se sumaron | `content_ids`, `content_name`, `contents`, `value`, `quantity` |
| `InitiateCheckout` | «Continuar» del carrito (entrar al checkout) | `content_ids`, `contents`, `num_items`, `value` = total del carrito |
| `Purchase` | solo con el pedido confirmado (ver abajo) | `value` = total del pedido, `content_ids`, `contents`, `num_items`, y `eventID` = folio |

`value` en los eventos de carrito es el precio unitario con extras × piezas.
Quitar del carrito no manda nada (Meta no tiene evento estándar para eso).

## Purchase

Lo arma el **servidor** desde el pedido guardado
(`src/services/tiendaMetaPixel.js`), nunca desde el carrito del navegador, y
solo si el pedido no está `pendiente_pago` ni `cancelado`:

- **Clip (pago en línea)**: cuando el webhook (o la verificación al regresar)
  confirmó el pago; se reporta en la página de seguimiento.
- **Pago al recibir** (efectivo, y también tarjeta al recibir o transferencia
  si el negocio las ofrece): al confirmar el pedido en la tienda.

`value` es el **total del pedido**: lo que se cobró, con envío, después de
promociones y de los puntos de Rewards. (En GA4 `value` es otro número: sin
envío y sin restar puntos.)

Dos rutas por token de seguimiento:

- `GET /api/tienda/seguimiento/:token/meta-pixel` (limitador de lectura): ID
  del píxel y si el pedido espera pago. Solo lectura; nunca trae la compra.
- `POST /api/tienda/seguimiento/:token/meta-pixel/compra` (limitador de
  checkout): entrega la compra **una sola vez por folio**.

El navegador consulta con el GET en cada sondeo y solo reclama con el POST
cuando el pedido ya no espera pago. Esto importa: el limitador de checkout
(20/min por IP) ya lo comparten el reclamo de GA4 y la verificación del pago
con Clip en la ventana de regreso, y un reclamo de Meta en cada sondeo lo
habría rebasado.

**Anti-duplicados**, en tres capas:

1. **Servidor.** El POST reclama la entrega con un `UPDATE` atómico que solo
   escribe si el pedido no tiene la marca `meta_purchase` en
   `tienda_pedidos.derivaciones`. De diez reclamos simultáneos, exactamente
   uno recibe la compra; los demás, `motivo: 'ya_entregada'`. Un pedido
   pendiente, cancelado o de una tienda sin píxel no gasta la entrega.
2. **Navegador.** Solo el navegador que creó el pedido guarda la marca
   «pendiente» y solo él reclama; un dispositivo que abre la liga de
   seguimiento (p. ej. desde WhatsApp) no consulta nada. La marca de
   «enviado» por píxel y folio evita volver a pedirla al recargar.
3. **Meta.** `eventID` = folio, para que Meta pueda deduplicar si algún día
   llega la misma compra por otra vía (p. ej. la API de conversiones).

Límite aceptado: si el navegador que recibió la compra no alcanza a mandarla,
esa compra se pierde y no se vuelve a entregar. Y si el cliente paga desde
otro dispositivo distinto al que armó el pedido, esa compra no se reporta.

## Datos personales y el token del pedido

- Nunca viajan nombre, teléfono, dirección, correo, notas del cliente ni el
  nombre de la persona (órdenes por persona). Los parámetros se arman campo
  por campo en el servidor y se vuelven a filtrar en el navegador.
- `autoConfig` apagado: el píxel no manda clics de botones ni metadatos de la
  página por su cuenta.
- **El píxel manda siempre la URL de la página (`location.href`) y su
  referente**, y la URL no se puede tachar. La del seguimiento lleva el token
  del pedido, así que **la página de seguimiento no carga el píxel**: la
  compra que se confirma ahí se manda desde un marco oculto del mismo origen
  con URL sin token (`/t/<slug>/pixel`, sin referente, `X-Frame-Options:
  SAMEORIGIN`). Ese marco no manda `PageView`.
- Si la tienda se abre viniendo del seguimiento o del pago, el token se tacha
  del referente antes de cargar el píxel.
- **En Meta hay que dejar apagadas las «Coincidencias avanzadas
  automáticas»** del píxel (Administrador de eventos → el píxel →
  Configuración). Si se prenden, el píxel lee por su cuenta los campos del
  formulario (correo, teléfono) y manda sus huellas; eso no se puede impedir
  desde el código de la tienda.
- El aviso de privacidad del negocio debería mencionar a Meta.

## Verificar

### Meta Pixel Helper (extensión de Chrome)

1. Guardar el ID en Panel → Tienda en línea → Analítica.
2. Abrir `https://xabor.mx/t/<slug>` en Chrome con la extensión: debe salir el
   píxel con su ID y `PageView`. Abrir un platillo (`ViewContent`), agregarlo
   (`AddToCart`) e ir al checkout (`InitiateCheckout`); cada evento muestra
   `currency`, `value` y `sucursal`.
3. En `/app` o `/superadmin` la extensión no debe encontrar ningún píxel.

### Administrador de eventos → Probar eventos

1. Administrador de eventos → el píxel → **Probar eventos** → pestaña
   «Confirmar eventos del navegador» → escribir `https://xabor.mx/t/<slug>` →
   «Abrir sitio web».
2. En la pestaña que se abre, recorrer la tienda: los eventos aparecen en
   segundos con sus parámetros.
3. Para ver `Purchase` hay que confirmar un pedido real: mismo procedimiento
   que en `docs/tienda-ga4.md` («Pedido de prueba en producción»): momento sin
   servicio, producto barato, Recoger, **pago al recibir**, y cancelarlo de
   inmediato en el panel. El `Purchase` debe salir una sola vez, con el folio
   como identificador del evento, aunque se recargue la confirmación.

Suite: `test/fase-tienda-meta-pixel.mjs` (A puras, B la tienda real en
Chromium con un `fbevents.js` falso que registra URL y referente de cada
evento, C servidor real con base, incluidos dos navegadores y diez reclamos
simultáneos del mismo folio).
