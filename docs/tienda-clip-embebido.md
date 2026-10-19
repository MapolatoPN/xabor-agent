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
`Referrer-Policy: strict-origin-when-cross-origin` (el token no viaja a Clip).

**Mensajes del checkout** (filtro registrado **antes** del SDK, en fase de
captura; corregido tras la revisión de Codex, §8):

- Ningún texto llega al SDK. Lo único que el SDK hace con un mensaje es navegar
  a la URL que trae, así que la navegación queda solo en manos de la página.
- Un regreso cuenta únicamente si lo manda la **ventana del iframe del checkout**
  (`event.source`), desde el **origen exacto** `https://pago.clip.mx`, y si nombra
  el seguimiento de **este pedido**, en este mismo sitio, con `retorno=pago` y
  una salida conocida (`exito`, `error` o `salida`; sin `r` cuenta como `exito`,
  para checkouts creados antes de que existiera).
- El destino lo arma la página con su propio token y la salida: parámetros extra
  o fragmentos del texto recibido no viajan.
- Si un regreso legítimo no cumpliera esto, el cliente no se queda atorado: al
  cerrar la ventana la página le pregunta a Clip, y el sondeo detecta la
  confirmación del webhook. **No hay evidencia** de que la autenticación bancaria
  requiera una excepción; si apareciera en la prueba con un checkout real, se
  documenta con esa evidencia antes de añadirla.

**Límites de la verificación al regresar:** una consulta en vuelo por pedido;
como mucho una nueva cada 8 s por pedido; como mucho 3 pedidos consultándose a
la vez, y el que llega con los cupos llenos espera turno (hasta 6 s) en vez de
rendirse; **6 s de punta a punta** por pedido para todas sus reconsultas, tras los
cuales la petición real a Clip se cancela y el resultado es `sin_respuesta`. Peor
caso para quien espera: unos 12 s. En el navegador, ninguna consulta espera más
de 20 s, y el seguimiento se pinta sin esperar a Clip. El webhook y el barrido de
5 minutos **no** usan este límite: siguen exactamente como antes. A eso se suma el
rate limit por IP de la tienda.

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

- `test/fase-tienda-clip-embebido.mjs` (42 casos; 32 originales y 10 por la
  revisión de Codex, §8): API real contra un mock de
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
- **Mordidas**: 32 en total tras la revisión de Codex (§8), todas muerden. Las 22
  originales: garantías desactivadas una por una (bandera, validación del
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

## 8. Revisión de Codex sobre 07a352e y correcciones

**P1. Una consulta a Clip que acepta la conexión y no contesta.** `consultarEstadoPago`
usaba `fetch` sin tiempo límite; el seguimiento esperaba esa verificación para
pintar; y tres consultas retenidas ocupaban los tres cupos.
Corrección: `consultarEstadoPago(…, { timeoutMs })` cancela la petición real con
`AbortSignal` (conexión, cabeceras y cuerpo) y solo lo usa la tienda; presupuesto
de 6 s por pedido para todas sus reconsultas; espera de turno cuando los cupos
están llenos; el seguimiento pinta con la base y verifica aparte; la página de
pago deja reabrir el mismo checkout mientras revisa; tope de 20 s en el navegador.

**P2. El filtro de mensajes aún permitía redirecciones externas.** Validaba una
familia amplia de dominios, pero no la ventana emisora ni el destino.
Corrección: ventana del iframe del checkout + origen exacto + seguimiento de este
pedido, y el destino lo arma la página (§4).

**Pruebas escritas ANTES de corregir** (con conexiones que quedan abiertas, no solo
errores HTTP). Las nueve primeras fallaban con 07a352e:

| Caso | Con 07a352e | Corregido |
|---|---|---|
| I1 verificación con Clip colgado | quedaba colgada (9 s y contando) | `sin_respuesta` en ~2 s |
| I2 tres colgadas + un pedido de otro negocio | el otro, `omitida` (sin cupo) | el otro consulta y obtiene `pendiente`; las tres terminan |
| I3 reintento de pago con el checkout anterior colgado | el POST quedaba colgado | `verificando`, sin cobro nuevo |
| I4 seguimiento al regresar con Clip colgado | «Cargando tu pedido…» | folio y estado en < 1,2 s |
| I5 cerrar la ventana con Clip colgado | «Revisando tu pago…» indefinido | aviso y «Ya pagué, verificar» |
| J1 origen de Clip desde otra ventana | navegaba al destino externo | se ignora |
| J2 destino externo desde el checkout | navegaba al destino externo | se ignora |
| J3 seguimiento de OTRO pedido | navegaba al otro pedido | se ignora |
| J4 parámetros extra en el regreso | navegaba con `&siguiente=…` | destino exacto de este pedido |
| J5 la ventana del checkout ya en otro origen | (ya se bloqueaba) | se ignora; cubre el chequeo de origen |

Mordidas añadidas (todas muerden): sin tiempo límite en la tienda; `clip-api` ignora
el tiempo límite; sin espera de turno; el seguimiento vuelve a esperar a Clip para
pintar; sin ventana emisora; sin origen; sin destino de este pedido; sin sitio del
destino; URLs al SDK; navegar al texto recibido. La de «esperar a Clip para pintar»
no mordió a la primera porque el tiempo límite del servidor la tapaba; se corrigió
el caso (I4 exige pintar muy por debajo de ese límite), no la garantía.

## 9. Despliegue y prueba controlada en Mapolato Acuña

### Desplegado (19-oct-2026, ~01:15 UTC, con autorización de Mario)

- Puntero `prod/mesero-shadow-v3` `75b56b1..1db56a7` (avance rápido: producción
  corría exactamente 75b56b1, sin cambios posteriores). El push no disparó el
  build; `railway redeploy --yes --from-source` → deployment **dd12955d**
  SUCCESS con `meta.commitHash` 1db56a7. Predeploy completo en verde (gate
  financiero y barrera de datos, 12/12).
- Verificado en xabor.mx: tienda, seguimiento, página de pago y panel servidos
  idénticos byte a byte a 1db56a7; `last-modified` 23:47:04 GMT y el validador
  anterior recibe 200; `/health` 200; `POST …/pago/verificar` con un token
  inexistente responde 404 JSON. Lectura de producción: **ningún negocio tiene la
  bandera**; Acuña y Obispado ofrecen «Te llevamos a la página segura de Clip».
- Flujo redireccionado en un navegador real (móvil y escritorio), hasta el
  resumen y **sin crear pedidos** (todo POST de checkout/pago abortado por
  interceptación): «Pagar $39.00 con Clip» y «Pago procesado por Clip», sin
  cargar el SDK de Clip y sin errores de página.
- No verificable en producción sin crear un checkout: el regreso con `r=` y la
  consulta a Clip al regresar (probados en local, §6).
- Revertir el código: `git revert 1db56a7 07a352e` sobre el puntero y redeploy
  (no hay migración que deshacer).

### Prueba SIN cargo: preparación (19-oct)

**¿Se puede completar el checkout con la tienda cerrada?** Sí, pero solo como
pedido **programado**: con Acuña cerrada, «Lo antes posible» está deshabilitado y
la tienda ofrece programar desde la siguiente apertura (anticipación de 40 min).
El cobro llega a Clip igual: en 60 días hubo 8 programados de Acuña y 15 de
Obispado pagados por Clip, y el recorrido en producción llegó al resumen con
«Programado: lunes 19 de octubre, 07:00 a.m.» y «Pagar $39.00 con Clip».

**Pero hace falta la corrección `a64566d` antes de probar con la tienda cerrada.**
A menos de un minuto de crearse, el servidor mueve todo programado a su reserva
en `pedidos_programados`, y el código desplegado solo miraba `pedidos_activos`.
Pasado ese minuto, un programado sin pagar:
- se presentaba como confirmado (seguimiento «Pedido confirmado · Recibimos tu
  pago», y el aviso nuevo de la tienda «Pago confirmado»);
- ya no podía volver a pagarse ni verificarse;
- en el embebido, sacaba al cliente de la página de pago a mitad del cobro (el
  sondeo de cada 6 s lo mandaba al seguimiento);
- se reportaba a GA4 como compra.

`a64566d` resuelve todo con un solo resolvedor (activo o reserva); casos P1–P8
(los siete primeros fallaban con el código desplegado), suite 50/50 y regresión
igual a producción. Entra limpia sobre `5281339`. **Sin desplegarla**, la
alternativa es probar con la tienda **abierta** («Lo antes posible»): el pedido
no se programa, queda `pendiente_pago` sin cocina y vence a los 30 minutos.

Visto en producción el 19-oct: XAB-1996 (Acuña, programado sin pagar, creado a las
02:03 UTC, después del despliegue de 1db56a7) quedó expuesto a ese
comportamiento; su espera de pago vencía a las 02:33 UTC.

**KYC.** Clip lo pide para «consumir APIs, Plugins y SDK de Checkout»
(developer.clip.mx/reference/kyc). Se revisa en la app de Clip de la cuenta de
Acuña: Más → Información personal → Validación de identidad (debe decir validada).
Indicio favorable: la cuenta ya cobra por la API de Checkout (48 cobros), que
exige el mismo KYC. Para confirmar que el Checkout Embebido está habilitado y si
hay lista de dominios permitidos: soporte-checkout@clip.mx o WhatsApp 55 6393-2323.
La prueba sin cargo es la confirmación técnica: si el iframe muestra el
formulario real de Clip, la cuenta lo acepta.

**Qué deja la prueba sin cargo:** un checkout real en la cuenta de Clip de Acuña
(sin cargo) y un pedido en su historial, cancelado al vencer (30 min). El pedido
no llega a cocina ni imprime: sin pago no sale de `pendiente_pago`.

### Comandos exactos (los corre Mario)

Desde `C:\xabor-agent` (`railway link` es por carpeta), sin imprimir la cadena de
conexión. `estado` solo lee; `activar` y `desactivar` sin `--aplicar` son
simulacro (transacción con ROLLBACK). Con `--aplicar` guardan respaldo del valor
anterior en `C:\xabor-respaldos\clip-embebido-2026-10\`.

```powershell
cd C:\xabor-agent
$pg = railway variables --service Postgres --json 2>$null | Out-String | ConvertFrom-Json
$env:DATABASE_URL = $pg.DATABASE_PUBLIC_URL
$s = '.claude\worktrees\xabor-clip-embedded-checkout-27d369\scripts\ops\clip-embebido-2026-10\bandera.mjs'

node $s estado --negocio=mapolato-acuna                       # debe decir: checkout redireccionado
node $s activar --negocio=mapolato-acuna                      # simulacro: ANTES/DESPUÉS, nada se guarda
node $s activar --negocio=mapolato-acuna --aplicar            # ENCIENDE (efecto inmediato)
node $s estado --negocio=mapolato-acuna                       # debe decir: checkout EMBEBIDO

node $s desactivar --negocio=mapolato-acuna --aplicar         # APAGA (borra la fila)
node $s estado --negocio=mapolato-acuna                       # debe volver a: checkout redireccionado
$env:DATABASE_URL = $null
```

Comprobación pública sin la base (no crea nada): con la bandera encendida,
`https://xabor.mx/api/tienda/mapolato-acuna/pagos?modalidad=recoger` dice
«Pagas aquí mismo · Pago procesado por Clip»; apagada, «Te llevamos a la página
segura de Clip». El script se probó en una copia local (simulacro, aplicar,
respaldo, reversa y freno sin Clip) y `estado` contra producción el 19-oct.

### Guion de la prueba sin cargo

0. **Antes**: `estado` (redireccionado); Claude confirma en solo lectura qué
   commit corre y si Acuña tiene programados esperando pago (si hay uno de un
   cliente, se espera a que pague o venza: mientras la bandera esté encendida,
   ese cliente vería el embebido).
1. **Encender** (`activar --aplicar`) y comprobar `estado` y la API pública.
2. **En cada dispositivo** (Android con Chrome, iPhone con Safari, y la liga abierta
   desde WhatsApp y desde Instagram), en `xabor.mx/t/mapolato-acuna`: un Café
   Americano → programar → «Pagar $39.00 con Clip».
   - Debe abrirse la ventana de Clip dentro de xabor.mx con el **formulario de
     pago real**. Si sale «Página no encontrada» o un error de Clip: **parar** y
     apagar; es la evidencia para soporte de Clip.
   - **No capturar ninguna tarjeta.** Esperar más de un minuto con la ventana
     abierta (el pedido pasa a la reserva): la ventana debe seguir ahí.
   - Cerrar con la X → «No se completó el pago» → «Volver a abrir el pago» abre
     el MISMO checkout → «Abrir el pago en la página de Clip» abre la misma liga
     en la página de Clip; volver con «atrás».
   - Volver a `xabor.mx/t/mapolato-acuna`: aviso «Tienes un pedido por pagar» (no
     «Pago confirmado»).
   - Anotar por dispositivo: ¿se ve el formulario?, ¿algo bloqueado o en blanco?,
     ¿el aviso «¿No carga el pago?» apareció?
3. **Apagar** (`desactivar --aplicar`) y comprobar `estado` y la API pública.
4. **Claude, solo lectura**: un checkout y una fila de `pagos` por folio, ningún
   trabajo de impresión, y que cada pedido vence a los 30 minutos y queda
   cancelado.

La prueba CON cargo ($39 y su reembolso) queda para una autorización aparte.
