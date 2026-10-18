# Checkout embebido de Clip en la tienda en línea

Rama `feat/clip-checkout-embebido`, un solo commit sobre `prod/mesero-shadow-v3`
(75b56b1, lo que corre en producción el 18-oct-2026 por la noche; el trabajo
empezó sobre 69624c6 y se rebasó limpio). **Sin migración.** El embebido nace
**apagado** para todos los negocios.

## 1. Hallazgos previos, validados contra el código de producción

| Hallazgo | Resultado | Dónde |
|---|---|---|
| La tienda crea el pedido `pendiente_pago` y pide `/v2/checkout` | Confirmado | `tiendaCheckout.crearPedidoTienda` → `pagoDeCheckout` → `pagosService.crearEnlacePago` |
| `tienda.html` abre `payment_request_url` sola, en la misma pestaña | Confirmado | `pedirEnlacePago`: `location.href = d.url` |
| Clip devuelve al seguimiento | Confirmado | `/seguimiento/<token>?retorno=pago` |
| La confirmación depende del servidor, el webhook y la reconciliación | Confirmado | `/webhook/clip` reconsulta; barrido cada 5 min en `server.js` |
| «¡Pedido recibido!» con palomita antes de pagar | Confirmado | `mostrarExitoConPago` |
| `success`, `error` y `default` regresan a la misma URL | Confirmado | `clip-api.crearLinkDePago` |
| La ventana de verificación puede retrasar el reintento | Confirmado, y aplicaba a **cualquier** regreso | 2 min sin botón de pagar en `tienda-seguimiento.html` |
| Se borra el carrito al crear el pedido y no hay acceso claro para retomarlo | Confirmado | `confirmarPedido` borra `xabor_carrito_<slug>`; el pedido solo queda en la liga de seguimiento |

Encontrado de paso y corregido: con el dinero ya asentado en `pagos` y el
pedido todavía en `pendiente_pago` (derivación en curso o cobro tardío en
revisión), `POST /api/tienda/seguimiento/:token/pago` devolvía la liga del
checkout **ya cobrado**. Ahora responde `verificando` sin liga.

## 2. Viabilidad: evidencia

**Documentación oficial** (`developer.clip.mx/reference/integrar-checkout-embebido`,
actualizada 29-sep-2025):

- Se carga `https://sdk.clip.mx/js/v1/checkout.js` como `type="module"`, en un
  `<script id="checkoutClipPlugin" payment_request_id="…">`, junto a un
  `<button class="clipCheckoutButton">`.
- El `payment_request_id` es **el de la respuesta de crear un link de pago**
  (`/v2/checkout`): el mismo checkout que Xabor ya crea. No hace falta otro
  sistema de pagos ni otro endpoint.
- Requisito: **verificación de identidad (KYC) con Clip** «para consumir el SDK
  de Checkout Transparente». Hay que confirmarlo para la cuenta de Acuña.
- No confundir con el *SDK/API de Checkout Transparente* (captura de tarjeta
  propia): no se usa.

**El código del SDK** (v1, `Last-Modified: 13-may-2025`, 31 151 bytes), leído como
texto. Lo que la documentación no dice y la integración necesita saber:

- Lee `payment_request_id` **una sola vez, en `DOMContentLoaded`**. La tienda es
  una sola página que obtiene el id mucho después: por eso el componente vive en
  una página propia, `/pagar/:token`, que nace con el id escrito por el servidor.
- Abre un iframe a `https://pago.clip.mx/v3/<payment_request_id>` dentro de una
  ventana propia (`#clipCheckout`), con una X para cerrar.
- **No expone eventos** (éxito, error, cierre). Al terminar, el iframe le manda
  a la página la URL de regreso por `postMessage`; el SDK cuenta 3 s y navega a
  ella. **No revisa el origen del mensaje**: cualquier ventana con referencia a
  la página podría mandar al cliente a otro sitio. Se cubre con un filtro propio
  (ver §4).
- Su ventana tiene `min-width: 370px`: en un teléfono de 360 px se sale de la
  pantalla. Se corrige con CSS propio.
- `sdk.clip.mx` responde `Access-Control-Allow-Origin: *` (se puede cargar como
  módulo desde xabor.mx) y `pago.clip.mx` responde
  `Content-Security-Policy: frame-ancestors 'self' *` junto con
  `X-Frame-Options: SAMEORIGIN`. Chromium aplica `frame-ancestors` e ignora
  `X-Frame-Options` cuando vienen los dos.

**Comprobado con la red real (18-oct-2026, Chromium):** `panel/tienda-pago.html`
servida desde `127.0.0.1` con un `payment_request_id` inventado. El SDK oficial
cargó, preparó su botón, abrió su ventana, y la aplicación real de `pago.clip.mx`
(`/v3/c3/_next/...`) se pintó dentro del iframe con su pantalla «Página no
encontrada». Cero cargos: Clip no conoce ese checkout. Falta lo mismo con un
checkout real (§7) y en Safari/WKWebView, donde no se comprobó cómo resuelve los
dos encabezados.

Conclusión: viable reutilizando la solicitud de checkout y su
`payment_request_id`, sin cambios en el modelo de pagos.

## 3. Flujo final

```
Resumen ─ «Pagar $300.00 con Clip»
   │  POST /api/tienda/:slug/checkout   → pedido pendiente_pago (sin comanda)
   ▼
«Tu pedido está listo para pagar» (negocio, folio, importe, «Pago procesado por Clip»)
   │  POST /api/tienda/seguimiento/:token/pago  → crea o REUTILIZA el checkout
   │                                               (idempotente, mismo payment_request_id)
   ├─ bandera ENCENDIDA ─► /pagar/:token?abrir=1 ─► componente oficial de Clip
   │        ├─ paga ─► Clip regresa a /seguimiento/:token?retorno=pago&r=exito
   │        ├─ cierra la ventana ─► se pregunta a Clip ─► «No se completó el pago»
   │        │                        [Volver a abrir el pago] (mismo checkout)
   │        └─ el componente no carga (12 s) / el iframe no carga (15 s)
   │                 ─► [Abrir el pago en la página de Clip] (mismo checkout)
   └─ bandera APAGADA ─► liga de Clip, como siempre ─► regreso con r=exito|error|salida
                                         │
/seguimiento/:token?retorno=pago&r=…     ▼
   POST …/pago/verificar  → el servidor consulta a Clip con las credenciales del negocio
   ├─ pagado  → «Pago confirmado» (y el pedido sale a cocina por el camino de siempre)
   ├─ r=exito y aún sin respuesta → «Estamos verificando tu pago…» sin botón (2 min)
   └─ r=error / r=salida y Clip dice pendiente → «No se completó el pago» + [Pagar $300.00 con Clip] de inmediato
```

El parámetro `r` **solo elige el mensaje**: el servidor no lo recibe ni lo usa.
«Pago confirmado» aparece únicamente cuando el servidor dice `pagado` y el
pedido ya no espera pago.

**Retomar el pedido.** Al crear un pedido con pago en línea, la tienda guarda en
`localStorage` `xabor_pedido_pendiente_<slug>` (uno por negocio): token de
seguimiento, folio, importe y una copia del carrito. **Nada de tarjeta, ni del
checkout, ni credenciales.** Al volver a la tienda, el servidor dice qué pintar:
«Tienes un pedido por pagar · #folio» con [Pagar $X con Clip]; «Estamos
verificando el pago»; «Tu pedido está en curso»; o, si se canceló o venció,
«no se completó» con [Volver a pedirlo]. Se borra al entregarse, al cancelarse
(cuando el cliente lo cierra o lo vuelve a pedir), si el token ya no existe o a
las 24 h.

## 4. Garantías que se conservan (y cómo)

- **Credenciales y aislamiento por negocio.** El negocio sale siempre del token de
  seguimiento; las consultas a Clip usan `obtenerCredencialesClipDescifradas` del
  negocio dueño de la fila. Probado con dos cuentas distintas en el mock (E1–E4).
- **Importes del servidor.** El botón muestra el total que calculó el servidor; a
  Clip viaja el monto de la fila de `pagos` (sin cambios).
- **Un solo pedido y un solo checkout ante reintentos.** Abrir, cerrar, reabrir,
  fallar o usar el respaldo nunca crean otro checkout (B1, B3, G2, G3, G5).
- **Verificación autoritativa.** La consulta al regresar es `verificarYAsentarClip`
  → `asentarPagoRealVerificado` → `derivarPedidoPorPagoAsentado`, el mismo camino
  del webhook y del barrido, con el mismo aviso al panel y recibo automático.
- **Nada de cobro nuevo sobre uno incierto.** Si `pagosService` fuera a abrir un
  checkout distinto del vigente y hay uno anterior de Clip sin evidencia terminal,
  primero se le pregunta a Clip: pagado → no se abre; sin respuesta → no se abre
  (D1–D3).
- **Cocina e impresión bloqueadas hasta confirmar.** Sin cambios en el gate de
  `pendiente_pago`; un cobro tardío se asienta y queda en revisión sin comanda (D2).
- **Enlaces de WhatsApp.** El bot sigue llamando a `crearEnlacePago` sin
  `urlRetorno` y conserva `/pago/gracias` en las tres salidas (prueba 20 de
  `fase-tienda-pago-online-ui`).
- **Otros métodos de pago.** Efectivo, terminal y transferencia no cambian; el
  texto «Pagar $X con …» solo aparece con proveedor en línea.

Protecciones nuevas de `/pagar/:token`: solo lee (jamás crea un checkout), escribe
el id únicamente si cumple `^[A-Za-z0-9][A-Za-z0-9-]{7,63}$`, `Cache-Control:
no-store`, `X-Frame-Options: DENY` y `frame-ancestors 'none'`, y
`Referrer-Policy: strict-origin-when-cross-origin` (el token no viaja a Clip). Un
filtro registrado **antes** del SDK descarta todo `postMessage` que no venga de un
origen `https://*.clip.mx` o `https://*.payclip.com` (G4).

Límites de la verificación al regresar: una consulta en vuelo por pedido, como
mucho una nueva cada 8 s por pedido, como mucho 3 pedidos consultándose a la vez,
y el rate limit por IP de la tienda.

## 5. Banderas (tabla `configuracion`, sin despliegue para cambiarlas)

| Clave | Valor | Efecto |
|---|---|---|
| `tienda_clip_checkout_embebido` | `'true'` | Checkout embebido. Sin fila (o cualquier otro valor): redireccionado, como antes |
| `tienda_pago_verificar_al_regresar` | `'false'` | Apaga la consulta a Clip al regresar. Sin fila: encendida |

Script: `scripts/ops/clip-embebido-2026-10/bandera.mjs` (simulacro por omisión,
respaldo del valor anterior, `desactivar` borra la fila).

**Qué cambia para todos al desplegar, aun con la bandera apagada:** los textos
(«Pagar $X con Clip», «Tu pedido está listo para pagar», «Pago confirmado»), el
regreso con `r=exito|error|salida` en los checkouts **nuevos**, la consulta a
Clip al regresar (apagable por negocio) y el aviso para retomar el pedido.

## 6. Pruebas

- `test/fase-tienda-clip-embebido.mjs` (32 casos): API real contra un mock de
  Clip v2 que separa cuentas por credencial, y siete recorridos en Chromium con el
  **SDK oficial** descargado al iniciar (si no hay red usa un doble y lo avisa) y
  un checkout falso servido en `https://pago.clip.mx/v3/<id>`. Móvil 360 px y
  escritorio 1280 px. `CEM_CAPTURAS=<dir>` guarda capturas.
- Ajustadas, por cambio de texto o de retorno pedido en este encargo:
  `fase-tienda-pago-online-ui` (19 y 26) y `fase-tienda-solo-pago-online` (M).

Resultados del 18-oct-2026 (base local `test_botones_dia_tpl`, una copia por
suite y por versión):

- **Tras rebasar sobre 75b56b1**: 19 suites de tienda, pagos, Clip, permisos y
  los dos chequeos estáticos del predeploy, idénticas en rama y base; la nueva,
  32/32.
- **Regresión rama contra 69624c6**: 48 suites de tienda, pagos, Clip, bot de
  enlace de pago y los dos chequeos estáticos del predeploy. Resultado idéntico
  en las 48. Las que ya fallaban en producción fallan igual, caso por caso:
  `fase-bot-enlace-pago` 4/12, `fase-bot-pedido-tras-pago` 3/5,
  `fase-predeploy-tienda` 29/2, `fase-tienda-catalogo` 19/1,
  `fase-zona-horaria` 24/1, y `fase-pagos-multiempresa`, `fase-tienda-db` y
  `fase-tienda-vitrina-db` por su fixture o por su entorno.
- **Mordidas**: 22 garantías desactivadas una por una (bandera, validación del
  id, vencimiento y versión, filtro de `postMessage`, tope y coalescencia,
  revisión antes de otro cobro, liga de un checkout cobrado, bandera de la
  verificación, derivación, aislamiento por negocio, textos, tres salidas,
  limpieza de la referencia, ancho en móvil, `X-Frame-Options`, ventana de
  espera, verificación al cerrar y detección de fallo del componente). Las 22
  hacen caer los casos que las sostienen. Archivos restaurados y comprobados por
  hash.
- **Red real**: ver §2 (SDK oficial y `pago.clip.mx` dentro del iframe).
- **Script de la bandera**: probado en una copia local (simulacro sin efectos,
  aplicar, respaldo, reversa, y freno con un negocio sin Clip).

## 7. Lo que no se pudo probar y depende de Clip

- **Un checkout real dentro del iframe.** En Xabor no hay ambiente de pruebas de
  Clip (el adaptador declara `sandbox: false`) y las credenciales locales no son
  reales. Falta ver `pago.clip.mx/v3/<id>` con un checkout de verdad creado por
  `/v2/checkout`, y qué URL manda por `postMessage` al terminar.
- **KYC** de la cuenta de Acuña para el checkout embebido.
- **3-D Secure / autenticación bancaria** dentro del iframe. Si un banco exige una
  ventana nueva o salir de la página, el respaldo redireccionado cubre el pago.
- **Navegadores internos de WhatsApp e Instagram** (WebView): no probados. Pueden
  bloquear cookies de terceros dentro del iframe. La página detecta esos
  navegadores y deja visible «Abrir el pago en la página de Clip».
- **Cambios del SDK.** Se carga `v1` sin versión fija (`Cache-Control: no-cache`).
  Si Clip lo cambia, la página cae al respaldo en 12 s y la prueba H1 avisa del
  contrato roto.
- Apple Pay / Google Pay: `pago.clip.mx` declara `Permissions-Policy: payment=()`.

## 8. Probar, activar en Mapolato Acuña y revertir

Requiere autorización de Mario en cada paso que escribe. Lectura de producción
con `DATABASE_PUBLIC_URL` (ver memoria `leer-produccion-xabor`).

1. **Desplegar** el commit (cherry-pick sobre la rama de despliegue; no hay
   migración). Verificar en xabor.mx que `/pagar/<token inválido>` da 404 y que
   `tienda.html` lleva `xabor_pedido_pendiente_`.
2. **Ver el estado** (solo lectura):
   `node scripts/ops/clip-embebido-2026-10/bandera.mjs estado --negocio=mapolato-acuna`
   Debe decir proveedor principal `clip` y checkout `redireccionado`.
3. **Prueba sin cargo**: en `xabor.mx/t/mapolato-acuna`, armar un pedido, tocar
   «Pagar $X con Clip», llegar a la página de Clip y **no pagar**; volver con
   «atrás». Debe verse «No se completó el pago» o el aviso «Tienes un pedido por
   pagar», y ningún pedido en cocina. El pedido vence solo.
4. **Activar** (primero simulacro, luego `--aplicar`):
   `node scripts/ops/clip-embebido-2026-10/bandera.mjs activar --negocio=mapolato-acuna --aplicar`
5. **Prueba en el teléfono** (Chrome/Safari, y desde la liga abierta en WhatsApp
   e Instagram): repetir el paso 3; ahora debe abrirse la ventana de Clip dentro
   de xabor.mx. Cerrarla: «No se completó el pago» y [Volver a abrir el pago].
   Una compra real de monto mínimo (con reembolso si Mario lo decide) confirma el
   regreso, «Pago confirmado» y UNA comanda.
6. **Revertir** (inmediato, sin despliegue):
   `node scripts/ops/clip-embebido-2026-10/bandera.mjs desactivar --negocio=mapolato-acuna --aplicar`
   Para quitar también la consulta al regresar: `apagar-verificacion`. Para
   revertir el código: `git revert` del commit sobre la rama de despliegue.
