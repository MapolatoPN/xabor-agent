# Rappi → Xabor POS en Mapolato Obispado — auditoría real (2026-09-18)

Lectura de **solo lectura** de producción (`DATABASE_PUBLIC_URL` del servicio
Postgres de Railway) y del código en `main` (`ae18d7f`). Nada de este
documento se dedujo de documentación histórica: cada cifra sale de una consulta
o de una línea de código citada.

## A. Negocio

| Campo | Valor |
|---|---|
| `negocio_id` | `5de544d8-9a0a-4972-9c92-fd48ff22de66` |
| slug | `mapolato-obispado` |
| sucursal activa | `fdca864c-0593-4d37-8ff6-ccea12f72200` |
| terminal Edge | `ad8a4f9b-6125-4b06-b540-9454c1215fdd` |
| módulo `rappi` | **activo** (junto con pos, impresion, menu, caja, restaurante, tienda_online, whatsapp…) |

Existe también `mapolato-acuna` (`bb27290a-…`), otro negocio: nada de lo que
se haga para Obispado puede resolverse por «el Mapolato».

## B. `integraciones_canal`

Diez filas en total. Para `canal='rappi'` hay **una sola**:

| negocio | identificador (store) | nombre | activo | claves en `configuracion` |
|---|---|---|---|---|
| Nonna Maye (`40351c93-…`) | `1930419809` | Rappi — Nonna Maye | sí | `rappi_pricing` |

**Mapolato Obispado no tiene fila Rappi.** Tiene `whatsapp` (meta) y `pagos`
(clip). No hay ninguna fila en `integraciones_canal_credenciales` para Rappi:
las credenciales de Rappi viven solo en variables de entorno.

## C. Menú real de Mapolato Obispado

- **13 categorías** activas: DESAYUNOS, CHILAQUILES, Combitos, OMELETTES,
  CUERNITOS, HUEVOS, BEBIDAS, Infantil, Especiales, TACOS, EXTRAS, COMIDAS,
  ENVIO.
- **45 productos**, los 45 disponibles y sin agotar. **Ninguno tiene
  `codigo`** (`con_codigo = 0`): el SKU que Xabor publicaría a Rappi sería
  siempre `XB-<id>` (`skuDeProducto`, rappi-api.js). Nombres únicos: no hay
  dos productos con el mismo nombre normalizado.
- **50 grupos de modificadores** y **221 opciones**, todos con `disponible`.
  Ejemplos: Chilaquiles Sencillos (id 85) → Salsa (1/1), Proteína (1/1),
  Guarniciones (1–2); Licuado (112) → Medida, Sabor, ¿Fruta extra?,
  Complementos (1–3), Tipo de leche. Los precios extra van de $0 a $30.
- Precios de $39 (Café Americano) a $225 (Huevos con machacado).
- Los productos de CHILAQUILES llevan `opciones.variante` (discriminadores
  para el bot): no afecta a Rappi.

Conclusión: el catálogo saliente (`construirCatalogoRappi`) ya puede
construirse hoy para Obispado; lo que no existe es el camino de vuelta
(SKU de Rappi → `producto_id` / `opcion_id`).

## D. Impresión y routing reales

Edge **está operando**: 3 impresoras (`windows_spooler`) en la misma terminal:
COCINA, Bebidas, Chilaquil. Trabajos `enviado` recientes de tres orígenes
(`restaurante_comanda`, `pedido`, `prueba_manual`); los últimos de `pedido`
son del 2026-09-17.

14 reglas en `impresion_rutas`, todas `modo='agregar'`:

| ámbito | clave | impresora |
|---|---|---|
| categoria | bebidas | Bebidas |
| categoria | chilaquiles | Chilaquil |
| categoria | combitos | Chilaquil **y** COCINA |
| categoria | desayunos, omelettes, cuernitos, huevos, infantil, especiales, tacos | COCINA |
| documento | comanda | COCINA, Bebidas, Chilaquil (defecto: lo no ruteado sale en las tres) |

No hay regla `ambito='producto'` ni para los documentos `cuenta` ni
`cancelacion`. EXTRAS, COMIDAS y ENVIO no tienen categoría ruteada: caen al
defecto (las tres impresoras).

El routing (`adjuntarCategorias`, impresionService.js) resuelve la categoría
**por `producto_id`** y, si falta, por nombre solo cuando el nombre es único
en el menú. Un pedido Rappi hoy llega sin `producto_id` (ver F), así que
depende del nombre.

## E. Identificador externo del pedido

- No existe ninguna columna ni tabla para el id externo de un pedido. Vive
  **solo** en `pedidos_activos.datos->>'rappi_order_id'` (JSONB, sin índice).
- Precedente de idempotencia durable en el mismo esquema:
  `idx_pedido_activo_checkout_token` (único parcial sobre
  `datos->'tienda'->>'checkout_token'`) y la tabla `webhook_entrante`
  (migración 077, `UNIQUE (canal, referencia)`).
- La deduplicación actual es **en memoria** (`obtenerPedidos(negocioId).some(p
  => p.rappi_order_id === orderId)`, rappi.js). La memoria se recarga de
  `pedidos_activos WHERE estado != 'entregado'`, así que:
  - un reintento **después de entregar** el pedido crea un segundo pedido;
  - dos webhooks simultáneos pasan la comprobación antes de que el primero
    inserte (no hay transacción ni índice);
  - producción ya lo evidencia: `rappi_order_id = 'SAMPLE-ORDER-0001'` existe
    **3 veces** para Nonna Maye.
- Los 35 pedidos Rappi históricos son todos de Nonna Maye y guardan items con
  solo `nombre, cantidad, precio_unitario, notas` (sin `producto_id`, sin
  `modificadores`, sin SKU).

## F. Usos de `RAPPI_STORE_ID`, `RAPPI_CLIENT_ID`, `RAPPI_CLIENT_SECRET`

| Archivo:línea | Uso |
|---|---|
| `src/services/rappi-api.js:13-15` | constantes de módulo `CLIENT_ID`, `CLIENT_SECRET`, `STORE_ID` (cargadas una vez al importar) |
| `rappi-api.js:24-52` | `obtenerToken()` con un solo caché de token global |
| `rappi-api.js:115` | `obtenerOrdenesNuevas()` → `?storeId=STORE_ID` |
| `rappi-api.js:126-135` | `actualizarDisponibilidad()` → `store_integration_id: STORE_ID` |
| `rappi-api.js:141,144-149` | `consultarAprobacionMenu(storeId = STORE_ID)`, `consultarDisponibilidad()` |
| `rappi-api.js:155-159` | `actualizarEstadoTienda()` → `stores:[{store_id: STORE_ID}]` |
| `rappi-api.js:241` | `construirCatalogoRappi(negocioId, { storeId = STORE_ID })` |
| `rappi-api.js:404-437` | `registrarWebhook()` / `configurarWebhooks()` → `stores:[STORE_ID]` |
| `src/server.js:4726,4745` | rutas legacy `/api/rappi/subir-catalogo` y `/actualizar-schedule` resuelven el negocio dueño de `RAPPI_STORE_ID` |
| `src/server.js:4798` | `/api/rappi/setup-webhooks` responde `storeId: RAPPI_STORE_ID` |
| `src/server.js:8541` | `sincronizarRappi()` corre solo si hay `RAPPI_CLIENT_ID/SECRET` y abre/cierra **el store global** con horario fijo L–S 11:00–22:00 |
| `src/channels/rappi.js:233` | `RAPPI_COOKING_TIME` global (20 min) |
| `src/channels/rappi.js:49` | `RAPPI_WEBHOOK_SECRET` solo mencionado en un comentario: la firma **no se verifica** |

El webhook entrante (`resolverIntegracionRappi`) ya es multitienda: resuelve
`store.internal_id` contra `integraciones_canal`. Todo lo saliente no.

## G. Operaciones que dependen de configuración global

1. **Token/credenciales**: un `client_id`/`client_secret` por proceso.
2. **Tomar / rechazar orden** (`tomarOrden`, `rechazarOrden`): no usan
   `STORE_ID` pero sí las credenciales globales.
3. **Ready-for-pickup**: existe (`ordenListaParaRecoger`) y **nadie la llama**.
4. **Catálogo, disponibilidad (stockout), abrir/cerrar tienda, webhooks**: al
   store global. Con Mapolato conectado, `/api/admin/rappi/subir-menu` desde
   la sesión de Obispado construiría el catálogo de Obispado y lo publicaría
   **en el store de Nonna Maye** (`construirCatalogoRappi` fija
   `storeId = STORE_ID`).
5. **Job de horario**: horario escrito en código, un solo store.
6. **Secreto del webhook**: `/api/rappi/setup-webhooks` lo guarda en
   `configuracion.rappi_webhook_secret` del negocio «actual» (sin
   `negocioId`), y el webhook no lo lee.

## H. Otros hallazgos del ciclo de vida (código actual)

- **Auto-rechazo por error interno**: `procesarOrdenRappi` hace
  `rechazarOrden(orderId, 'Error interno: …')` en el `catch`. Un fallo de
  Xabor (base caída, mapeo roto, `negocioId` ausente) cancela la venta ante
  el cliente de Rappi.
- **Formato «clásico»** (`body.id` sin `store.internal_id`): entra sin
  dedupe y sin `negocioId`; `registrarPedido` lanza
  `TENANT_CONTEXT_REQUIRED` y el `catch` **rechaza la orden en Rappi**.
- **Cancelación de Rappi**: solo emite el WebSocket `rappi_cancelacion`; el
  panel no tiene ningún manejador para ese tipo. El pedido sigue en cocina.
- **PING**: la doc de Rappi exige responder `{"status":"OK"}`; hoy se responde
  `{ok:true, received}` a todo, y «if the value is null or different to OK it
  will be considered as unavailable store».
- **Rechazo**: la doc pide `cancel_type` (y `items_skus`); el código manda
  solo `reason` (`items_sku`).
- **Cliente**: la doc trae `customer.first_name/last_name/phone_number`; el
  código lee `customer.phone` (nunca existe) y cae al teléfono sintético
  `rappi-<order_id>`. Ese teléfono sintético hace que el aviso «listo» por
  WhatsApp del `PATCH /pedidos/:id/estado` intente mandar un mensaje a
  `rappi-<id>` (falla en el `catch`).
- **Items**: la doc trae `sku`, `quantity`, `price`, `comments`, `subitems[]
  {sku, name, quantity, price}`. El código ignora `sku` y `comments`, y
  aplana `subitems` a texto en `notas`.
- **Firma**: `Rappi-Signature: t=<ts>,sign=<hex>` con HMAC-SHA256 de
  `<ts>.<payload>` usando el `secret` que devuelve `POST /webhook`. No se
  verifica.
- **Pruebas**: `fase-rappi-catalogo-real` y `fase-rappi-precios-canal` cubren
  el catálogo saliente. **Ninguna** ejercita el webhook, el mapeo, la
  deduplicación ni la cancelación. No hay ningún JSON de orden real como
  fixture.

## I. Doc pública de Rappi consultada (dev-portal.rappi.com, 2026-09-18)

- Un `client_id` gestiona varios stores: «If you don't send this attribute,
  the API takes all the stores of the authenticated user» (webhooks).
- `POST /webhook` devuelve `secret`; `PUT /webhook/{event}/change-url` acepta
  `stores`; `DELETE /webhook/{event}/remove-stores`.
- `PUT orders/{id}/take/{cookingTime}`; `PUT orders/{id}/reject` con
  `reason` + `cancel_type` (+ `items_skus`), solo en estado SENT;
  `POST orders/{id}/ready-for-pickup` («after three requests, the system
  will stop executing additional actions»).
- No documenta política de reintentos ni tiempo de auto-cancelación de una
  orden no tomada.

---

# Diseño e implementación (misma fecha)

## J. Arquitectura elegida

```
Rappi ─NEW_ORDER─▶ /webhook/rappi (src/channels/rappi.js)
   1. store.internal_id ─▶ integraciones_canal ─▶ negocio  (rappiIntegracion.obtenerIntegracionRappiPorStore)
   2. Rappi-Signature (HMAC-SHA256 sobre req.rawBody)      (rappiFirma.verificarFirmaRappi; modo exigir|registrar)
   3. pedidos_externos: UNIQUE(negocio, canal, id_externo)  (pedidosExternos.reclamarPedidoExterno)
   4. 200 a Rappi (la constancia ya es durable)
   5. catálogo real ─▶ orden canónica                        (rappiMapeo.mapearOrdenRappi) ─▶ registrarPedido()
   6. PUT /orders/{id}/take/{cooking_time}                   (crearClienteRappi de ESA integración)
   7. emitirPedido() ─▶ WS nuevo_pedido + Edge por estación  (routing existente, sin cambios)

Rappi ─ORDER_EVENT_CANCEL─▶ ledger ─▶ folio ─▶ cancelarPedidoActivo + actualizarEstadoPedido('cancelado')
                                          ─▶ papel 'cancelacion' a las impresoras de la comanda ─▶ WS rappi_cancelacion
Panel ─PATCH /pedidos/:id/estado listo─▶ notificarListoARappi ─▶ POST ready-for-pickup (una vez, candado en el ledger)
```

**Abstracción multitienda** (`src/services/rappiIntegracion.js`):

- `obtenerIntegracionRappiPorStore(storeId)` / `obtenerIntegracionRappi(negocioId)` /
  `listarIntegracionesRappi()`: fila de `integraciones_canal` (canal `rappi`)
  con `storeId = identificador`, `configuracion` y si tiene credenciales propias.
- `resolverCredencialesRappi(integracion)` → `{ clientId, clientSecret, origen }`.
  - **Escenario A** (un `client_id` para varios stores): la integración solo
    lleva el store; las credenciales salen de `RAPPI_CLIENT_ID/SECRET`.
  - **Escenario B** (credenciales por tienda): `configuracion.rappi_client_id`
    + `client_secret` cifrado AES-256-GCM en `integraciones_canal_credenciales`
    (misma tabla y cifrado que WhatsApp/Clip). Un secreto ilegible **no cae**
    al entorno.
- `crearClienteRappiParaIntegracion(integracion)` / `clienteRappiDeNegocio(negocioId)`
  → `crearClienteRappi({ storeId, clientId, clientSecret })` (`src/services/rappi-api.js`).
  El cliente lleva el store en todas las operaciones de tienda y **se niega a
  publicar un catálogo dirigido a otro store** (`RAPPI_STORE_NO_COINCIDE`).
  Caché de token por `client_id`.
- Preferencias por integración en `configuracion` (JSONB, no sensible):
  `cooking_time`, `rappi_firma` (`registrar`|`exigir`), `rappi_pricing`;
  y `rappi_webhook_secret` (ver riesgo 3).
- Alta: `vincularTiendaRappi()` / `guardarCredencialesRappi()` /
  `eliminarCredencialesRappi()`, expuestas al Superadmin.

`rappi-api.js` no se duplicó: las funciones sueltas (`tomarOrden`,
`subirCatalogo`, …) delegan en `clienteRappiDesdeEntorno()` y quedan **solo**
para las rutas legadas `/api/rappi/*` y el job de horario.

## K. Archivos

| Archivo | Cambio |
|---|---|
| `src/channels/rappi.js` | Reescrito: clasificación del sobre, PING con `status: OK`, firma, ledger antes del acuse, `procesarOrdenReclamada` (mapear → persistir → aceptar → publicar), sin auto-rechazo, `procesarCancelacionRappi`, `notificarListoARappi`, `reconciliarPedidosExternosRappi`, stockout por negocio |
| `src/channels/rappiMapeo.js` | **Nuevo**: `normalizarSobreRappi`, `cargarCatalogoParaRappi`, `mapearOrdenRappi` |
| `src/channels/rappiFirma.js` | **Nuevo**: `verificarFirmaRappi` (pura) |
| `src/services/rappiIntegracion.js` | **Nuevo**: integración por negocio, credenciales, cliente, alta |
| `src/services/pedidosExternos.js` | **Nuevo**: ledger (`reclamar`, `retomar`, marcas de creado/fallido/cancelado/listo, pendientes) |
| `src/services/rappi-api.js` | `crearClienteRappi()` con store + credenciales; `rechazarOrden` con `cancel_type`/`items_skus` (doc); `skuDeOpcion`, prefijos exportados; legado delegado |
| `src/services/impresionService.js` | `crearTrabajosDeCancelacionDePedido()` (destino `cancelacion` o, si no hay, las impresoras de la comanda del folio); `destino: RAPPI #id` en la comanda de pedidos Rappi |
| `src/printing/edgeComanda.js` | `entregarTrabajosPorEdge()` para entregar trabajos creados por otro módulo |
| `src/server.js` | `req.rawBody` también para `/webhook/rappi`; `PATCH /pedidos/:id/estado` → `notificarListoARappi` y sin WhatsApp para Rappi; `/api/admin/rappi/{integracion,menu-status,subir-menu,stockout}` por negocio; `/api/superadmin/negocios/:id/integraciones/rappi[/credenciales|/setup-webhooks]`; job de reconciliación (arranque + cada 2 min) |
| `migrations/080_pedidos_externos.sql`, `scripts/predeploy-080-pedidos-externos.mjs`, `scripts/predeploy-run-032-033.mjs` | Migración y registro en la lista de predeploy |
| `test/fase-rappi-mapeo.mjs`, `test/fase-rappi-pos-obispado.mjs`, `test/lib-rappi-mock.mjs`, `test/mordidas-rappi.mjs`, `test/fixtures/rappi/` | Pruebas, doble de la API, mordidas y carpeta de fixtures |
| `CLAUDE.md` | Esquema local (080) y sección «Rappi por negocio» |

**Componentes protegidos tocados** (con la autorización explícita de este
encargo): `src/server.js` solo en `PATCH /pedidos/:id/estado` (dos `if`
adicionales, best-effort, nunca bloquean). `orderManager.js`, `brain.js`,
`whatsapp-meta.js` y `panel/index.html` **no** se tocaron.

## L. Migración — SÍ hay cambio de esquema

`080_pedidos_externos.sql` crea la tabla `pedidos_externos` (UNIQUE
`(negocio_id, canal, id_externo)`, estados `reclamado|creado|fallido|cancelado`,
`folio`, `payload`, `aceptado_en_proveedor`, `listo_notificado_at`,
`cancelacion`, `intentos`, `reentregas`). Idempotente. Se aplica por el
`preDeployCommand` (lista `SCRIPTS`) **antes** de que el binario nuevo atienda
tráfico: sin ella, el webhook responde 503 a Rappi (fail closed, con reintento
del lado de Rappi) en vez de crear pedidos sin constancia.

La idempotencia **no** queda contenida en el canal: depende de esta tabla.

## M. Pruebas nuevas

`test/fase-rappi-mapeo.mjs` (25 casos, sin servidor): sobre en ambos
formatos, ejemplo de la doc, SKU por código, SKU `XB-<id>`, nombre único,
nombre ambiguo, SKU inexistente, SKU de otro negocio, producto agotado,
subitem por SKU / por nombre / de otro producto / de otro negocio /
desconocido, totales-cliente-modalidad, sin totales, sin negocio, cliente
atado a store, firma (válida, secreto distinto, cuerpo re-serializado, sin
secreto, sin header, malformada, fuera de ventana, sin cuerpo), ledger
(procesar/en_curso/duplicado, aislamiento por negocio, fallido→retoma,
caducado→retoma, tope de intentos, **12 reclamos concurrentes → 1**,
cancelación y listo una sola vez), y fixtures `*.real.json` si existen.

`test/fase-rappi-pos-obispado.mjs` (21 casos, servidor real + doble de Rappi
en `lib-rappi-mock.mjs`): PING, NEW_ORDER válido (producto_id, modificador
canónico, notas, take con cooking_time de la integración, ledger), Edge por
estación con destino `RAPPI #id`, tablero, store desconocido, SKU inexistente,
duplicado secuencial, **8 webhooks concurrentes → 1 pedido / 1 take / 1 fila**,
reentrega tras entregar, cancelación (papel en las tres estaciones, idempotente,
tablero en `cancelado`), cancelación de pedido ya listo, ya entregado y nunca
visto, READY una sola vez, firma exigida (401 sin rastro / firma mala / buena
con credenciales de B), firma registrada, **dos negocios a la vez** (cada take
con su `client_id`, menú de A publicado al store de A y sin productos de B),
integración sin secretos, **fallo interno → `fallido` sin reject**,
**reconciliación al reiniciar crea el pedido**, Rappi caído al aceptar →
pedido nace igual sin reject.

**Prueba de mordida** (`node test/mordidas-rappi.mjs`, 9 garantías): cada una
desactivada por separado hace caer la suite exactamente en sus casos:

| Mordida | Cae en |
|---|---|
| A ledger sin dedupe | mapeo 7 casos; e2e duplicado secuencial, concurrente, tras entregar |
| B volver a rechazar por error interno | e2e fallo interno + reconciliación |
| C aceptar cualquier firma | mapeo firma; e2e firma exigida |
| D store desconocido cae a un negocio | e2e store desconocido |
| E ignorar SKU | mapeo 4 casos; e2e 6 casos (producto_id, Edge, …) |
| F ready sin candado | e2e READY |
| G cancelación sin caer a impresoras de la comanda | e2e cancelación |
| H ignorar credenciales propias | e2e firma exigida (client_id) y dos negocios |
| I publicar catálogo en cualquier store | mapeo cliente por store |

Ninguna orden de prueba salió a Rappi: el servidor de las suites apunta
`RAPPI_BASE_URL`/`RAPPI_AUTH_URL` al doble local.

## N. Resultado de todas las suites (2026-09-18, base local privada `edged1_rappi`)

**196 suites `test/fase-*.mjs`: 162 verdes en la primera pasada, 34 no verdes.**
Después de corregir dos pruebas propias, las cuatro de Rappi quedan verdes:
`fase-rappi-catalogo-real` 16/16 (dos aserciones de contrato sobre el texto
fuente actualizadas al llamado multitienda), `fase-rappi-precios-canal` 15/15,
`fase-rappi-mapeo` 25/25, `fase-rappi-pos-obispado` 22/22.

Las **32 restantes** se corrieron con el código base (`ae18d7f`, worktree
aparte, base `edged1_base`) y fallan igual — no son regresiones de esta rama:

| Suite | Rama | Base | Causa visible |
|---|---|---|---|
| asistente-comercial-3-draftbuilder | 6/8 | 6/8 | `negocios_slug_key` duplicado (estado acumulado) |
| b-integraciones | 36/1 | 36/1 | módulo negocio C; credenciales con otra llave de cifrado |
| borrador-admin-whatsapp | 11/2 | 11/2 | `negocios_slug_key` |
| c-bot-global | 20/4 | 20/4 | idéntico |
| c-embedded-signup | 30/1 | 30/1 | idéntico |
| central-operaciones | 24/1 | 24/1 | idéntico |
| chats-mobile-ux | 17/1 | 17/1 | idéntico |
| chilaquiles-contexto | 10/1 | 10/1 | idéntico |
| comanda-edge-exclusiva | 18/5 | 18/5 | los 5 `[PANEL]` conocidos |
| compra-operacional-critica | 4/2 | 4/2 | casos D / D-retry idénticos |
| compras-integracion, compras-whatsapp | — | — | `ECONNREFUSED 127.0.0.1:55454` (Postgres que no existe aquí) |
| continuidad-webhook | 9/1 | 9/1 | Puppeteer `#tab-chats` |
| cutover-059 | — | — | idéntico |
| cutover-063-emision-operacional | TIMEOUT | — | su arnés clona un commit viejo en `%TEMP%` y ahí no resuelve `dotenv` |
| documentos-pdf | 11/2 | 11/2 | idéntico |
| edge-chaos | — | — | «Ya existe un Edge con ese nombre» (estado acumulado) |
| enrutamiento-repartidor-cliente | 5/8 | 5/8 | idéntico |
| hotfix-borrador-recuperable | 2/6 | 2/6 | idéntico |
| ingredientes-incluidos, panel-comercial | — | — | idéntico |
| prospectos-comerciales | 21/2 | 21/2 | idéntico |
| red-repartidores-metricas | 28/1 | 28/1 | idéntico |
| red-repartidores-superadmin | 24/2 → 25/1 | 26/0 → 25/1 | estado: la 4.ª fila «RR Repartidor A» acumulada saca a repA del roster; el código base falla igual contra la misma base |
| repartidores-carrera-insercion-inicial, rollout-completo-repartidores | — | — | idéntico |
| seguridad-transaccional | 17/1 | 17/1 | idéntico |
| sidebar-plegable | 11/5 | 11/5 | idéntico |
| tienda-online, tienda-recuperacion-crash | — | — | idéntico |
| tomar-conversacion | 16/1 | 16/1 | idéntico |
| vision-v2-universal | 62/1 | 62/1 | idéntico |

Otra sesión de Claude corría suites en esta máquina al mismo tiempo (desde
`C:\xabor-integracion-v3`), por eso esta línea usó base y puertos propios.

## O. Riesgos restantes

1. **Sin orden real de Obispado.** Todo el mapeo se probó contra el contrato
   de la doc pública (`sku`, `quantity`, `price`, `comments`, `subitems`) y
   contra lo que Nonna Maye guardó (`units`/`unit_price` también aceptados).
   Falta confirmar con un JSON real: si `price` es unitario o de línea cuando
   `quantity > 1`, si los subitems traen `sku`, y si el `sku` del item es el
   que Xabor publicó. Por eso la carpeta `test/fixtures/rappi/` y por eso el
   primer pedido real debe revisarse a mano contra su ledger.
2. **Firma en modo `registrar` por defecto.** Sin `RAPPI_WEBHOOK_SECRET` (o
   `configuracion.rappi_webhook_secret`) el webhook acepta y solo deja
   constancia. Es a propósito para no romper a Nonna Maye, cuyo secreto no
   está en ningún sitio conocido. Para Obispado: registrar los webhooks,
   guardar el `secret` devuelto y poner `rappi_firma: 'exigir'`.
3. **El secreto del webhook por integración vive en JSONB sin cifrar**
   (`configuracion.rappi_webhook_secret`), como ya ocurría con
   `configuracion.rappi_webhook_secret` en la tabla `configuracion`. El valor
   por entorno es el recomendado hasta tener una segunda ranura cifrada por
   integración.
4. **Camino legado sigue siendo de una tienda**: `/api/rappi/*` (token global
   sin negocio) y el job `sincronizarRappi` (horario fijo L–S 11–22 sobre
   `RAPPI_STORE_ID`). No afectan a Obispado (que no tiene `RAPPI_STORE_ID`),
   pero si Rappi exige mantener la tienda abierta/cerrada por API, Obispado
   necesitará su propio horario por integración (no implementado).
5. **Rappi no documenta reintentos ni auto-cancelación de órdenes SENT.** Si
   Xabor falla al persistir, la orden queda `fallido` y se reintenta cada 2
   min (5 intentos), pero Rappi puede cancelarla antes por su cuenta. La
   alerta al panel (`rappi_orden_fallida`, solo admin) existe; **el panel aún
   no la pinta** (no se tocó `panel/index.html`). Hoy la señal visible es el
   log y el ledger.
6. **La comanda de un pedido no aceptado en Rappi sale igual a cocina** (la
   venta existe). Queda marcado `datos.rappi.aceptacion.aceptado=false` y hay
   evento `rappi_orden_no_aceptada`, pero el panel tampoco lo muestra todavía.
7. **Ítems sin resolver se imprimen por nombre y caen al destino por
   defecto** (las tres impresoras en Obispado). No se pierden, pero no van a
   su estación. `requiere_revision` queda en el pedido.
8. **PING y MENU_REJECTED comparten forma** (`{store_id}`); ambos reciben
   `status: OK`. Si Rappi manda un MENU_REJECTED, no hay aviso específico
   (antes tampoco lo consumía nadie).
9. **Rewards/red de repartidores**: `esPedidoDeRedExterna` ya excluye Rappi;
   `canal_rappi` de rewards no se tocó.
10. **Nonna Maye**: su fila de `integraciones_canal` no cambia; sus
    credenciales siguen en entorno (escenario A); su webhook pasa por el
    ledger nuevo. Cambios de comportamiento para ella: PING responde `status:
    OK` (antes `ok: true`), un error interno ya no rechaza la orden, y la
    cancelación ahora sí cancela el pedido en el tablero.

## P. Lo que hay que obtener de Rappi para el corte de Obispado

1. **`store.internal_id` de Mapolato Obispado** (el id numérico con el que
   Rappi identifica la tienda en la Restaurants Integrations API; para Nonna
   Maye es `1930419809`). Es lo único que se necesita para vincularla:
   `PUT /api/superadmin/negocios/5de544d8-9a0a-4972-9c92-fd48ff22de66/integraciones/rappi`
   con `{ storeId, nombre: "Rappi — Mapolato Obispado", configuracion: { cooking_time: 20 } }`.
2. **Confirmación de bajo qué `client_id` queda la tienda.**
   - Si Rappi la agrega al integrador actual (mismo `client_id` que Nonna
     Maye): no hace falta nada más (escenario A).
   - Si entregan credenciales propias: `client_id` + `client_secret` →
     `PUT .../integraciones/rappi/credenciales` (escenario B, cifradas).
3. **Desconexión de Wansoft como integrador de esa tienda** en Rappi Partners
   (una tienda solo tiene un integrador activo). Coordinar la fecha: desde
   ese momento las órdenes solo llegan por el webhook de Xabor.
4. **Registro de los webhooks para ese store** (NEW_ORDER,
   ORDER_EVENT_CANCEL, PING, MENU_APPROVED, MENU_REJECTED) apuntando a
   `https://xabor.mx/webhook/rappi`: `POST .../integraciones/rappi/setup-webhooks`
   (o pedirle a Rappi que los registre). **Guardar el `secret`** que devuelve
   y ponerlo en `RAPPI_WEBHOOK_SECRET` (o en la integración) + `rappi_firma:
   'exigir'`.
5. **Publicar el menú de Obispado en su store** desde el panel (`Menú → Subir
   menú a Rappi`, ahora dirigido al store del negocio) y esperar el
   MENU_APPROVED. Confirmar con Rappi que aceptan los SKU `XB-<id>` /
   `XB-op-<id>` (los mismos que ya usa Nonna Maye).
6. **Confirmar el contrato del payload con una orden real** (punto O.1):
   guardar su JSON anonimizado en `test/fixtures/rappi/`.
7. **Política de la tienda en Rappi**: si el store exige que el integrador
   la abra/cierre por API (`/availability/stores/enable`), definir el horario
   de Obispado; hoy solo existe el job fijo del entorno para Nonna Maye.
8. **Sandbox** (opcional, recomendado): credenciales de
   `microservices.dev.rappi.com` para una orden de prueba de punta a punta
   antes del corte.

## Q. Pasos exactos para publicar (los ejecuta Mario)

1. Revisar y fusionar la rama en la rama de despliegue vigente (ver
   `railway status`), **nunca** apuntar el servicio a `main`.
2. Variables en Railway (servicio `xabor-agent`): opcional
   `RAPPI_WEBHOOK_SECRET`, `RAPPI_FIRMA_MODO` (dejar sin definir = `registrar`
   hasta tener el secreto). No tocar `RAPPI_CLIENT_ID/SECRET/STORE_ID`.
3. Desplegar: el `preDeployCommand` aplica la 080. Verificar en logs
   `[rappi] Migración 080 verificada.` y `SELECT to_regclass('pedidos_externos')`.
4. Huella del build nuevo: `GET https://xabor.mx/webhook/rappi` responde igual
   que antes; la huella real es `POST` con `{"store_id":999}` → `{"status":"OK"}`
   (antes `{"ok":true}`).
5. Vincular el store de Obispado (P.1) y publicar el menú (P.5) **sin**
   desconectar Wansoft todavía: Rappi no manda órdenes a Xabor hasta que el
   webhook esté registrado para ese store.
6. Corte: registrar webhooks (P.4) + desconectar Wansoft (P.3) en la misma
   ventana, con alguien mirando el tablero y el ledger:
   `SELECT id_externo, estado, folio, aceptado_en_proveedor FROM pedidos_externos ORDER BY recibido_at DESC LIMIT 20;`
