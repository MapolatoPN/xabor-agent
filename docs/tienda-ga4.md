# Google Analytics 4 en la tienda pública

Cada negocio puede medir su tienda (`xabor.mx/t/<slug>`) en **su propia**
propiedad de Google Analytics 4. Sin ID configurado, la tienda no carga nada
de Google.

## Configuración

- **Panel → Tienda → Analítica** (solo administradores): campo «ID de
  medición». Formato `^G-[A-Z0-9]+$`; se aceptan minúsculas y espacios
  alrededor (se normaliza a mayúsculas). Vacío = quitar.
- Se guarda en `configuracion.ga4_measurement_id` del negocio (sin migración).
  Se valida al guardar (`PUT /api/admin/tienda/analytics` y también
  `PUT /api/config`) y otra vez al leer: una fila escrita a mano con basura
  queda inerte.
- `GET /api/tienda/:slug` publica `analytics.ga4MeasurementId` (o `null`).

## Qué se carga

`panel/tienda-analytics.js` (`window.XaborAnalytics`) es el único punto de
contacto con Google. Lo cargan `tienda.html` y `tienda-seguimiento.html` con
huella `?v=<sha256[0:8]>`. Con ID, inyecta gtag.js y configura:

```js
gtag('config', ID, { linker: { domains: ['mapolato.com', 'xabor.mx'] } });
```

En el seguimiento, el token de la URL se tacha (`/seguimiento/token`) en
`page_location` y `page_referrer`: es la llave de un pedido.

Toda llamada de la tienda pasa por `analitica(fn, ...)`, que no puede lanzar:
si el módulo no carga o Google está bloqueado, la compra sigue igual.

## Eventos (moneda MXN)

| Evento | Cuándo |
|---|---|
| `view_item_list` | una vez por categoría y visita, cuando su sección entra en pantalla (`item_list_id` = `cat-<id>`) |
| `view_item` | al abrir un producto (no al editar un renglón) |
| `add_to_cart` / `remove_from_cart` | agregar, quitar o editar; editar la cantidad manda solo la diferencia; cambiar opciones es quitar + agregar |
| `view_cart` | al abrir el carrito |
| `begin_checkout` | «Continuar» del carrito |
| `add_shipping_info` | al confirmar la modalidad; `shipping_tier` = «Entrega a domicilio» / «Recoger en sucursal» |
| `add_payment_info` | al confirmar la forma de pago; `payment_type` = «Tarjeta en línea», «Efectivo», «Tarjeta al recibir», «Transferencia» |
| `purchase` | solo con el pedido confirmado (ver abajo) |

Cada item: `item_id` (id del producto), `item_name`, `item_category`,
`item_variant` (opciones elegidas, separadas por coma), `price` (unitario con
extras), `quantity`.

## Purchase

Lo arma el **servidor** desde el pedido guardado
(`GET /api/tienda/seguimiento/:token/analytics`, `src/services/tiendaAnalytics.js`),
nunca desde el carrito del navegador, y solo si el pedido no está
`pendiente_pago` ni `cancelado`:

- **Pago al recibir**: se reporta al confirmar el pedido en la tienda.
- **Pago en línea**: se reporta en la página de seguimiento cuando el webhook
  del proveedor confirmó el pago.

Parámetros: `transaction_id` = folio (único en toda la plataforma),
`value` = productos después de promociones **sin envío ni impuestos** (como lo
pide GA4), `shipping` = envío cobrado, `coupon` = códigos aplicados, `items`.

- `tax` va en **0**: los precios ya incluyen IVA y el pedido no lo desglosa.
- Los puntos de **Rewards no se restan** de `value`: en Xabor son forma de
  pago, no descuento de mercancía.
- Las promociones bajan `value` pero los `items` llevan el precio de lista.

**Anti-duplicados**: al crear el pedido el navegador guarda una marca
«pendiente» con el token (localStorage); el `purchase` sale una vez y deja
marca de «enviado» por folio (localStorage y sessionStorage). Recargar la
confirmación o el seguimiento no lo repite, y abrir la liga de seguimiento en
otro dispositivo tampoco lo manda.

## Datos personales

Nunca viajan nombre, teléfono, dirección, correo, notas del cliente ni el
nombre de la persona (órdenes por persona). Los items se arman campo por campo
en el servidor y se vuelven a filtrar en el navegador.

## Requisitos del lado de Google

- Usar la misma propiedad (o el mismo ID) en mapolato.com, con el mismo
  `linker`, para que la sesión cruce de dominio.
- En GA4 → Administrar → Flujos de datos → Configurar etiqueta → «Lista de
  referencias no deseadas»: agregar los dominios de la pasarela de pago
  (`clip.mx`, `payclip.com`, `mercadopago.com`), o el regreso del pago abre una
  sesión nueva atribuida a la pasarela.
- El aviso de privacidad del negocio debería mencionar Google Analytics.

## Probar con DebugView

1. Guardar el ID en Panel → Tienda → Analítica.
2. Abrir la tienda con `?ga4_debug=1` (botón «Abrir mi tienda en modo prueba»
   del panel). La marca dura toda la pestaña, también al volver de la
   pasarela al seguimiento; `?ga4_debug=0` la quita. También sirve la
   extensión Google Analytics Debugger o Tag Assistant.
3. GA4 → Administrar → DebugView: recorrer menú, producto, carrito y
   checkout; cada evento aparece en segundos. Para ver `purchase` hay que
   confirmar un pedido, y en producción eso es un pedido REAL (comanda,
   tablero, folio): hacerlo con el negocio avisado y cancelarlo después.

Suite: `test/fase-tienda-ga4.mjs` (A puras, B la tienda real en Chromium
contra un servidor falso, C servidor real con base).
