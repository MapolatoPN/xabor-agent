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
(`src/services/tiendaAnalytics.js`), nunca desde el carrito del navegador, y
solo si el pedido no está `pendiente_pago` ni `cancelado`. Dos rutas por token
de seguimiento:

- `GET /api/tienda/seguimiento/:token/analytics`: ID de medición y si el pedido
  espera pago. Solo lectura; **nunca** trae la compra.
- `POST /api/tienda/seguimiento/:token/analytics/compra`: entrega la compra
  **una sola vez por folio**, a un solo navegador (ver «Anti-duplicados»).

Cuándo se reporta:

- **Pago al recibir**: se reporta al confirmar el pedido en la tienda.
- **Pago en línea**: se reporta en la página de seguimiento cuando el webhook
  del proveedor confirmó el pago.

Parámetros: `transaction_id` = folio (único en toda la plataforma),
`value` = productos después de promociones **sin envío ni impuestos** (como lo
pide GA4), `shipping` = envío cobrado, `coupon` = códigos aplicados, `items`.

- `tax` va en **0**: los precios ya incluyen IVA y el pedido no lo desglosa.
- Los puntos de **Rewards no se restan** de `value`: en Xabor son forma de
  pago, no descuento de mercancía. Ejemplo: un pedido de **$300** donde el
  cliente paga **$100 con puntos** y $200 con dinero manda **`value` = 300**.
  Por eso **los ingresos de GA4 van a ser mayores que lo cobrado en
  efectivo/tarjeta**: la diferencia es lo pagado con puntos. Para cuadrar
  contra caja, usar el corte de Xabor, no GA4.
- Las promociones bajan `value` pero los `items` llevan el precio de lista.

**Anti-duplicados**, en dos capas:

1. **Servidor (la que vale entre dispositivos).** El `POST …/compra` reclama la
   entrega con un `UPDATE` atómico que solo escribe si el pedido no tiene la
   marca `ga4_purchase` en `tienda_pedidos.derivaciones` (sin migración). De
   dos o diez reclamos simultáneos, exactamente uno recibe la compra; los demás
   reciben `motivo: 'ya_entregada'`. Un pedido pendiente de pago, cancelado o
   de una tienda sin ID no gasta la entrega.
2. **Navegador.** Solo el navegador que creó el pedido guarda la marca
   «pendiente» (localStorage) y solo él reclama; un dispositivo que abre la
   liga de seguimiento (p. ej. desde WhatsApp) nunca reclama. Tras mandarlo,
   la marca de «enviado» por folio (localStorage y sessionStorage) evita volver
   a pedirlo al recargar.

Límite aceptado: si el navegador que recibió la compra no alcanza a mandarla
(la pestaña se cierra en ese instante, o un bloqueador frena a Google), esa
compra se pierde y no se vuelve a entregar. Se prefiere perder una a
duplicarla.

## Datos personales

Nunca viajan nombre, teléfono, dirección, correo, notas del cliente ni el
nombre de la persona (órdenes por persona). Los items se arman campo por campo
en el servidor y se vuelven a filtrar en el navegador.

## Requisitos del lado de Google

- **Una propiedad por sucursal** (decisión del 13-oct-2026): Obispado y Acuña
  con IDs distintos. El `linker` solo une la sesión con mapolato.com si los dos
  sitios usan el mismo ID; con IDs por sucursal, quien llega desde
  mapolato.com aparece en cada propiedad como «mapolato.com / referral» (sirve
  para medir cuánto tráfico manda a cada ciudad). No agregar mapolato.com a
  referencias no deseadas.
- En cada propiedad: Administrar → Flujos de datos → Configurar etiqueta →
  «Lista de referencias no deseadas»: agregar los dominios de la pasarela de
  pago (`clip.mx`, `payclip.com`, `mercadopago.com`), o el regreso del pago
  abre una sesión nueva atribuida a la pasarela.
- En cada propiedad: **Administrar → Recopilación y modificación de datos →
  Retención de datos → 14 meses** (por omisión GA4 guarda 2 meses de datos a
  nivel evento para exploraciones).
- El aviso de privacidad del negocio debería mencionar Google Analytics.

## Probar con DebugView

1. Guardar el ID en Panel → Tienda → Analítica.
2. Abrir la tienda con `?ga4_debug=1` (botón «Abrir mi tienda en modo prueba»
   del panel). La marca dura toda la pestaña, también al volver de la
   pasarela al seguimiento; `?ga4_debug=0` la quita. También sirve la
   extensión Google Analytics Debugger o Tag Assistant.
3. GA4 → Administrar → DebugView: recorrer menú, producto, carrito y
   checkout; cada evento aparece en segundos. Para ver `purchase` hay que
   confirmar un pedido (ver abajo).

## Pedido de prueba en producción (para ver `purchase`)

**No existe forma de marcar un pedido como prueba**: todo pedido confirmado
de la tienda saca folio, entra al tablero e imprime comanda. (`pedido_prueba`
en Superadmin es solo una casilla del checklist de alta, no una marca del
pedido.) Por eso:

1. Antes, una vez por propiedad: crear el filtro **Tráfico de desarrolladores**
   (Administrar → Recopilación y modificación de datos → Filtros de datos →
   Crear filtro → Tráfico de desarrolladores → Excluir) y dejarlo **Activo**.
   Así lo hecho con `?ga4_debug=1` sigue viéndose en DebugView pero no entra a
   los reportes ni a los ingresos. Ojo: un filtro activo descarta para siempre
   lo que excluye, y puede tardar en empezar a aplicar.
2. Elegir un momento **sin servicio**, con la sucursal abierta (cerrada, la
   tienda solo acepta programados, y un programado se imprime al activarse).
   Avisar a cocina: va a salir una comanda que no se prepara.
3. Abrir la tienda con `?ga4_debug=1`, pedir **un producto barato**, **Recoger**
   y **pago al recibir** (efectivo). Nunca pago en línea: cobraría de verdad.
   Si la tienda de esa sucursal solo tiene habilitado el pago en línea (es el
   valor por omisión de `tienda_metodos_pago`), no hay pedido «al recibir»
   posible: o se habilita efectivo un momento (Configuración → Tienda →
   Pagos) y se quita después, o se prueba con un cobro real y su reembolso.
4. Confirmar y ver en DebugView el `purchase` con el folio.
5. **Cancelarlo de inmediato** en el panel (🚫, administrador): queda
   `cancelado` y fuera del corte.

Suite: `test/fase-tienda-ga4.mjs` (A puras, B la tienda real en Chromium
contra un servidor falso, C servidor real con base, incluidos dos navegadores
y diez reclamos simultáneos del mismo folio).
