# Tienda Online

Canal de venta pública de Xabor: cada negocio con el módulo `tienda_online`
obtiene una tienda en `xabor.mx/t/{slug}` donde sus clientes piden sin
instalar nada, sin registrarse y sin hablar con nadie.

## La regla que ordena todo el módulo

**Dar de alta una tienda nueva no requiere editar código, copiar HTML, agregar
un `if` por negocio ni desplegar.** Todo lo que distingue a una tienda de otra
es dato: filas en `tienda_config`, `tienda_productos`, `tienda_promociones` y
la configuración que el negocio ya tenía.

Esa regla no se afirma, se comprueba: `test/fase-tienda-productizacion.mjs`
crea un negocio inexistente, lo configura solo con operaciones de panel y
completa una compra real. Incluye la verificación que la sostiene — el HTML
servido en `/t/:slug` no contiene ni el slug ni el nombre del negocio.

## Qué NO hace este módulo

Tres decisiones que evitan que la tienda se convierta en un sistema paralelo:

**No duplica el catálogo.** `tienda_productos` no guarda productos: guarda
*qué productos del menú están publicados*, con su badge y su orden de
escaparate. Precios y modificadores salen siempre de `menu_productos` y
`menu_modificadores_*`. Cambiar un precio en el menú lo cambia en la tienda.

**No duplica las reglas operativas.** Horarios, costo de envío, zonas, pedido
mínimo, tiempos e instrucciones de pago viven donde siempre: la clave
`reglas_atencion` de `configuracion`. La pantalla de Apariencia lo dice
explícitamente para que nadie los busque dos veces.

**No inventa un segundo motor de pedidos.** Un checkout de tienda recorre
exactamente el mismo camino que un pedido del POS:

```
recalcularItemsDesdeMenu → construirOrdenPOS → registrarPedido → emitirPedido
```

`emitirPedido` sigue siendo el único punto de impresión de todo Xabor. La
tienda no imprime por su cuenta.

## De quién es la autoridad

El navegador del cliente **no** es autoridad de: precio, descuento,
elegibilidad de una promoción, costo de envío, total, disponibilidad,
producto ni negocio. Todo eso lo recalcula el servidor en cada cotización y
otra vez en el checkout.

El negocio **siempre** se resuelve desde el slug de la URL. Ningún endpoint
público acepta un `negocioId` del cuerpo de la petición.

## Las dos superficies

### Pública (`src/services/tiendaRutas.js`, sin sesión, con rate limit)

| Ruta | Qué hace |
|---|---|
| `GET /t/:slug` | La página de la tienda (una plantilla para todos) |
| `GET /seguimiento/:token` | Página de seguimiento del pedido |
| `GET /api/tienda/:slug` | Identidad, apertura, modalidades, reglas de entrega |
| `GET /api/tienda/:slug/catalogo` | Productos publicados con sus modificadores |
| `GET /api/tienda/:slug/pagos` | Métodos que el negocio tiene habilitados |
| `POST /api/tienda/:slug/cotizar` | Totales en vivo, con promociones |
| `POST /api/tienda/:slug/checkout` | Crea el pedido (idempotente) |
| `GET /api/tienda/seguimiento/:token` | Avance del pedido por token opaco |

Los topes de rate limit son configurables porque una IP no siempre es una
persona: detrás del NAT de un operador móvil van muchas.

| Variable | Omisión | Qué protege |
|---|---|---|
| `XABOR_TIENDA_LIMITE_LECTURA` | 120/min | Scraping del catálogo |
| `XABOR_TIENDA_LIMITE_COTIZAR` | 60/min | Fuerza bruta de cupones |
| `XABOR_TIENDA_LIMITE_CHECKOUT` | 20/min | Avalancha de pedidos |

### Backoffice (`/api/admin/tienda/*`, sesión + `requireModulo('tienda_online')`)

Config, checklist, publicar/pausar, publicación de productos, CRUD de
promociones y campañas, y métricas. El negocio sale de la sesión, como en el
resto del panel. En el panel vive en **Catálogo → Tienda en línea**, no en
Configuración: lo que se administra es qué del catálogo sale a la calle.

## Idempotencia y carreras

**Un reintento no crea dos pedidos, ni siquiera tras un crash.** El navegador
genera un `checkoutToken` de 192 bits una vez por intento de compra y lo
guarda. Con ese token hay tres defensas, en capas:

1. **Reserva**: `INSERT … ON CONFLICT DO NOTHING` en `tienda_pedidos` antes de
   hacer cualquier trabajo. Cubre el doble click y las peticiones paralelas.
2. **El token viaja DENTRO del pedido** (`datos->'tienda'->>'checkout_token'`),
   estampado antes de crearlo. Si el proceso muere entre crear el pedido y
   vincularlo, el reintento encuentra ese pedido y lo recupera en vez de crear
   otro. La recuperación no consulta memoria de proceso — que en un crash real
   ya no existe — sino la base.
3. **Un índice único parcial** sobre `(negocio_id, checkout_token)` en
   `pedidos_activos`. Es la última línea: aunque el código se equivocara, la
   base rechaza el segundo pedido.

La ventana peligrosa es la que va de `registrarPedido` (el pedido ya es
durable) a las derivaciones. Ahí el `catch` **no** puede limpiar como si nada
hubiera pasado: le pregunta a la base si el pedido existe. Si existe, no
libera nada, marca el checkout como `incompleto` y deja que el reintento lo
termine. Si no existe, sí suelta token y promociones para que el cliente
corrija y reintente.

**Tener folio no significa estar terminado.** El vínculo checkout→pedido se
escribe *antes* de emitir la comanda y de atribuir promociones. Por eso un
reintento que encuentra `pedido_folio` no responde 200 y se va: llama a
`finalizarCheckout` y **después** responde. Si no, el cliente vería "pedido
recibido" mientras la cocina nunca vio el papel.

**Las derivaciones llevan ledger persistente.** No basta con repetir los pasos.
Se auditó qué hace `emitirPedido` y no todo es idempotente:

| Efecto | ¿Repetible? |
|---|---|
| Comanda por Edge | Sí — clave de idempotencia por `(negocio, pedido, impresora)` |
| Oferta a repartidores | Sí — deduplicada por `(folio, repartidor)` en `notificaciones_repartidor` |
| Impresión legacy (negocios aún sin Edge) | Sí — desde la 052, por `impresion_legacy_emitida` |
| Aviso `nuevo_pedido` al panel | Por el consumidor — el panel descarta un folio que ya está en el tablero |

Por eso cada derivación deja marca en `tienda_pedidos.derivaciones` (jsonb):
`historial`, `emision`, `atribucion`. Un reintento retoma solo lo que falta;
cinco reintentos seguidos no hacen nada la segunda vez.

**El claim de cada derivación es atómico.** Consultar "¿está pendiente?",
ejecutar y marcar después no basta: dos finalizadores concurrentes leen
"pendiente" a la vez y los dos ejecutan. `derivacion()` toma
`pg_try_advisory_xact_lock(checkout, derivación)` y escribe la marca **en la
misma transacción**, así que cuando el lock se suelta la marca ya es visible.
Quien no obtiene el lock no espera: otro proceso ya está en eso, y esperar solo
retendría una conexión del pool que el dueño necesita.

**200 significa confirmado, no "confío en que al otro le salga".** Perder el
lock no es haber terminado. Si otro proceso está ejecutando una derivación
crítica, este espera —del lado del servidor, sondeando la marca persistente sin
retener ninguna conexión— a que la marca APAREZCA. Si aparece, responde 200. Si
no aparece dentro de la ventana, responde **409 `CHECKOUT_EN_CURSO`**, y el
siguiente intento encontrará el lock libre (el ganador murió) y retomará el
trabajo. Nunca se responde 200 apostando a que el ganador acabe bien: si se
cayera, el cliente tendría "pedido recibido" y la cocina nada.

Críticas son `emision` siempre, y `atribucion` cuando hay promociones —el
descuento ya se dio, el cupo tiene que quedar amarrado al folio—. `historial`
no lo es: si falla, el pedido sigue siendo válido y el siguiente intento la
repone.

**El claim vive en un pool de conexiones APARTE.** El lock se sostiene mientras
corre el efecto, y el efecto necesita conexiones para trabajar. Con un solo
pool, N checkouts simultáneos (N = tamaño del pool) retienen todas las
conexiones y todos esperan una más que nunca llega: no es lentitud, es un
cuelgue permanente, porque el pool principal no tiene timeout. Separar los pools
lo elimina de raíz —quien sostiene una conexión de claim jamás pide otra de
claim— y el `connectionTimeoutMillis` del pool de claims convierte una
saturación en error explícito, nunca en espera infinita.

Sostener el lock durante el efecto es deliberado: **es la señal de vida**. Si el
proceso muere, la conexión muere, el lock se suelta, y el siguiente reintento
sabe que puede retomar. Soltarlo antes obligaría a inventar un *lease* con
relojes y a recuperar claims abandonados por tiempo.

**Un lock resuelve la concurrencia y nada más.** El crash *después* del efecto
y *antes* de la marca lo resuelve la idempotencia propia de cada efecto. Por
eso el camino legacy dejó de ser un broadcast a ciegas:

- sale con `printJobId` determinista (`<folio>:comanda`), el mismo del camino
  autenticado, para que un agente actualizado también pueda deduplicarlo;
- y el servidor recuerda lo que ya emitió en `impresion_legacy_emitida`
  (migración 052). Tiene que ser Postgres y no un `Map` ni un archivo: los
  agentes legacy son binarios viejos en máquinas ajenas que no se pueden
  actualizar desde aquí, y la memoria debe sobrevivir a reinicios, redeploys y
  a que haya más de una instancia del servidor.

La fila se escribe **después** de emitir, dentro del `pg_advisory_xact_lock`
del trabajo. Registrarla antes cambiaría "papel repetido" por "pedido sin
papel", que es peor. Queda una ventana de microsegundos — crash entre el envío
y el COMMIT — en la que un reintento reemitiría: es inherente a un broadcast
sin acuse de recibo, y el lado en que cae es el de que el papel salga.

Mismo criterio para la marca del ledger: se escribe **después** del éxito. Al
revés — marcar antes de hacer — el riesgo sería un pedido sin comanda que nadie
vuelve a intentar.

`emitirPedido` se **espera** (`await`): "finalizado" no puede significar
"disparé una promesa y ojalá sobreviva al proceso".

**Ningún límite de promoción se puede rebasar.** Hay tres, y cada uno necesita
que decida la base:

| Límite | Mecanismo |
|---|---|
| Global (`limite_usos`) | `UPDATE … WHERE usos < limite_usos`: gana quien logre incrementar |
| Por cliente (`limite_por_cliente`) | Transacción serializada con `pg_advisory_xact_lock(promoción, teléfono)`: se cuenta y se reclama dentro del lock |
| Primera compra (`solo_primera_compra`) | El mismo mecanismo con tope 1 — quien ya la reclamó no vuelve a ser primerizo |

El reclamo escribe una **fila de reserva** en `tienda_promocion_usos` con folio
provisional `reserva:<checkoutToken>`. Esa fila es lo que hace visible el
reclamo al checkout de al lado: sin ella, el segundo contaría cero usos aunque
el primero ya hubiera ganado. Al confirmar el pedido, la reserva se convierte
en el uso real (se le pone el folio y los montos); si el pedido no llega a
existir, se libera.

Una reserva huérfana — proceso caído entre reservar y crear — caduca a los 15
minutos. Pero antes de devolver el cupo se comprueba si ese checkout llegó a
producir un pedido:

- **Sí produjo pedido** → no se devuelve nada. La reserva se convierte en el
  uso real contra ese folio. Nunca puede quedar un pedido con descuento y un
  cupón como si nadie lo hubiera usado.
- **No produjo pedido** → ahí sí se libera el cupo, para que un intento
  fallido no le queme el cupón a un cliente para siempre.

`reconciliarReservasVencidas(negocioId)` hace ese barrido y sirve además como
herramienta de operación si hiciera falta reparar a mano.

Todo esto se reserva **antes** de crear el pedido: descubrir que el cupón se
agotó cuando el cliente ya tiene folio es descubrirlo tarde.

## Seguridad

- **Aislamiento en las consultas**: cada una lleva `negocio_id`. Un negocio no
  ve, edita ni borra promociones, productos, pedidos ni campañas de otro.
  Probado con dos negocios reales y sesiones legítimas de cada uno.
- **Aislamiento en el ESQUEMA**: las relaciones internas son claves foráneas
  compuestas `(negocio_id, id)`. Ligar una promoción a la campaña de otro
  negocio, o publicar en una tienda el producto de otro, es imposible a nivel
  de base — aunque un servicio futuro se equivoque. Son cuatro FKs:
  `tienda_productos → menu_productos`, `tienda_promociones → tienda_campanas`
  y las dos de `tienda_promocion_usos`.
- **Módulo apagado = tienda inexistente**: sin el módulo activo, la ruta
  pública responde 404, indistinguible de un slug que no existe.
- **Seguimiento**: token opaco de 192 bits, no enumerable. Expone folio,
  etapa, total e items — nunca teléfono, dirección, ids internos ni el
  negocio_id.
- **Texto libre**: se limpian caracteres de control (que romperían la comanda
  impresa) y se recorta longitud en el servidor; el escape de HTML lo hace la
  vista, que escapa todo lo que pinta.
- **Errores**: los del carrito salen como 400 con el motivo real; los internos
  como 500 genérico, sin stack ni SQL.

## Promociones

Tipos: envío gratis, porcentaje y monto fijo. Cada una puede tener código o
ser automática, compra mínima, tope de descuento, vigencia, días y horas (en
la zona horaria del negocio), límite global y por cliente, solo primera
compra, y alcance por producto o categoría.

Las campañas agrupan promociones para responder una pregunta concreta: *quién
me trajo clientes nuevos, no solo pedidos*. Cada campaña reporta usos, ventas,
descuento otorgado, clientes nuevos y ticket promedio.

Los códigos de cupón son únicos **por negocio**: dos restaurantes pueden tener
`BIENVENIDO` sin pisarse.

## Estados de la tienda

`borrador` → `publicada` ⇄ `pausada`

Publicar exige un checklist calculado con datos reales (datos del negocio,
horarios, identidad, productos publicados, modalidades, costo de entrega,
métodos de pago). Una tienda incompleta no se publica en silencio: el error
dice exactamente qué falta.

Pausar deja la liga viva y el historial intacto, pero deja de aceptar pedidos.
Es para vacaciones y para cuando el negocio se satura.

## Deuda conocida

- **Zona horaria**: `XABOR_TZ_DEFAULT` (por omisión `America/Matamoros`) se usa
  cuando el negocio no tiene `timezone` en `configuracion`. Cuando haya
  negocios en otro huso, esa clave deja de ser opcional.
- **Imágenes**: logo, portada e imagen de producto se capturan como URL. No
  hay subida de archivos desde el panel de tienda todavía.
- **Dirección**: el cliente escribe una sola línea y elige zona (o escribe su
  colonia si el negocio cobra tarifa plana). No se parte en calle/número: el
  repartidor prefiere leer lo que el cliente escribió a una separación
  adivinada por expresiones regulares.
- **Impresión física**: la integración con Xabor Edge es la de siempre (vía
  `emitirPedido`) y está probada a nivel de encolado, pero **la validación con
  impresora física está pendiente de hacerse en sitio**.

## Pruebas

| Suite | Casos | Qué responde |
|---|---|---|
| `test/fase-tienda-online.mjs` | 74 | Catálogo, precios impuestos por servidor, envío y zonas, checkout idempotente, promociones, seguimiento, backoffice, aislamiento y adversarial |
| `test/fase-tienda-carreras-cliente.mjs` | 10 | Límite por cliente y primera compra bajo concurrencia real, liberación del cupo y cuadre de contadores |
| `test/fase-tienda-recuperacion-crash.mjs` | 29 | Crash inyectado en cada punto de la ventana peligrosa: un solo pedido, una sola atribución, un solo juego de comandas |
| `test/fase-tienda-productizacion.mjs` | 21 | Un negocio nuevo se vuelve tienda funcional sin tocar un archivo |
| `test/fase-predeploy-tienda.mjs` | 24 | La cadena railway.toml → runner → 051 → verificación, idempotencia, fail-closed, aislamiento por esquema y rollback |

Ambas contra Postgres real, con los mismos arneses del resto del proyecto.


## Cómo llegan la 051 y la 052 a un deploy real

Producción no lee `migrations/`. Lo que corre es lo que declara `railway.toml`:

```
railway.toml
  preDeployCommand = "node scripts/predeploy-run-032-033.mjs"
       ↓
  el runner ejecuta su lista de scripts, cada uno como proceso propio,
  y aborta el deploy (exit 1) si cualquiera falla
       ↓
  scripts/predeploy-051-tienda-online.mjs
       ↓
  migrations/051_tienda_online.sql
       ↓
  verificación: 6 tablas + CHECK con 'tienda_online' + 4 FKs compuestas
       ↓
  scripts/predeploy-052-impresion-legacy-idempotente.mjs
       ↓
  migrations/052_impresion_legacy_idempotente.sql
       ↓
  verificación: la tabla CON su PK compuesta (negocio, printJobId)
       ↓
  la aplicación arranca
```

La 052 no toca nada preexistente: crea la tabla que le da memoria al camino de
impresión viejo. Su gate exige la PK compuesta, no solo la tabla — la PK *es*
la garantía: sin ella, "reclamar el trabajo" volvería a ser una carrera.

**Idempotente**: el script comprueba el estado antes y no hace nada si ya está
aplicada; el SQL además es re-ejecutable (`IF NOT EXISTS`, `DROP … IF EXISTS`
antes de cada `ADD`). Un deploy repetido no cambia nada.

**Fail-closed**: si la verificación posterior no encuentra las seis tablas, el
CHECK actualizado y las cuatro FKs, sale con código 1 y Railway aborta el
deploy. La aplicación no arranca sobre un esquema a medias.

**Válida sobre una base existente**: la comprobación de "ya aplicada" incluye
las FKs compuestas, así que una base migrada antes de que existieran las
recibe en el siguiente deploy en vez de quedarse sin ellas.

**No enciende nada**: la migración no activa el módulo para ningún negocio. El
predeploy reporta cuántos lo tienen contratado, para que quede en el log del
deploy que nadie quedó con una tienda abierta por accidente.

Verificado por `test/fase-predeploy-tienda.mjs` (24 casos), que recorre la
cadena entera, corre el predeploy dos veces contra una base real, comprueba el
aborto con base inalcanzable, y exige que todo `predeploy-NNN` del repositorio
esté en el runner — el descuido que dejó huérfana a la 051 en primer lugar.

## Rollback

`migrations/051_tienda_online_down.sql` deshace las **dos** cosas que hace la
051, en este orden y dentro de una transacción:

1. `DELETE FROM negocio_modulos WHERE modulo = 'tienda_online'`
2. Restaura el CHECK con los dieciocho módulos previos
3. Suelta la FK compuesta y el índice que la 051 puso sobre `menu_productos`
   (lo único que tocó fuera de sus propias tablas)
4. Borra las seis tablas en orden inverso

El orden de 1 y 2 no es negociable: Postgres valida un CHECK nuevo contra las
filas existentes, así que restaurarlo antes de borrar las filas fallaría en
cualquier base donde alguien tenga el módulo contratado.

`migrations/052_impresion_legacy_idempotente_down.sql` borra la tabla de
memoria de impresión legacy. **Solo tiene sentido junto con revertir el código
que la consulta**: con la tabla fuera y el código dentro, ningún trabajo se
reconocería como ya emitido; con la tabla fuera y el código fuera, se vuelve al
comportamiento anterior — papel repetido en cada reintento.

**Este rollback destruye datos**: configuración de tienda, promociones y su
historial de uso. Los pedidos ya cobrados sobreviven — viven en
`pedidos_activos` y `pedidos` — pero se pierde la atribución de qué promoción
los generó. Respaldar las seis tablas antes de correrlo en una base con
tiendas publicadas.


## Recuperación ante crash

Los fallos no se esperan a que ocurran: se inyectan. `XABOR_TIENDA_FALLA_EN`
provoca un error en un punto exacto del checkout —
`despues_de_registrar`, `despues_de_vincular`, `antes_de_emitir`,
`despues_de_emitir` — y la suite comprueba qué queda después.

La variable **no funciona en producción**: lo primero que evalúa
`fallaInyectada` es `NODE_ENV === 'production'`, y con eso retorna sin hacer
nada aunque la variable esté puesta. Hay una prueba que verifica ese orden.

Escenarios cubiertos:

| Crash en | Qué se exige del reintento |
|---|---|
| Tras crear el pedido, antes de vincularlo | Un solo pedido, mismo folio, mismo tracking, vínculo reparado |
| Tras vincular, antes de confirmar la promoción | El retry normal deja la promoción confirmada contra el folio real — sin ejecutar ningún script de mantenimiento |
| Tras vincular (el folio YA existe) | La comanda faltante se emite: exactamente 1 trabajo por destino |
| Antes de emitir la comanda | 0 comandas tras el crash, exactamente 1 tras el reintento |
| Cinco reintentos posteriores | Sigue habiendo 1 pedido y 1 comanda |
| Concurrencia (10 intentos) tras un crash | Un pedido, una atribución, exactamente una comanda |
| Domicilio con repartidores | Tres reintentos no mandan una sola oferta de más |
| Crash entre CADA derivación, en cadena | Una reanudación deja 1 pedido y 1 comanda |
| 10 reintentos SIMULTÁNEOS en modo legacy | Un solo broadcast al print-agent viejo |
| Dos finalizadores a la vez | Solo uno entra a `emision`: un aviso al panel, no dos |
| Crash tras imprimir por legacy, antes de marcar | El reintento (en otro proceso) NO reimprime |
| El ganador del lock falla y otro pierde el lock | El perdedor responde 409, nunca 200 |
| El ganador del lock termina bien | El perdedor espera la marca y responde 200; una sola emisión |
| Más checkouts simultáneos que conexiones del pool | Todos terminan; ninguno se cuelga |
| Antes de crear el pedido | Sí se libera token y promociones; el cliente puede reintentar |

Las comandas se cuentan con una impresora y una ruta **reales** montadas en el
fixture, y se exige `=== 1`, no `<= 1`: sin ruta configurada, "cero comandas" y
"no se duplicó" serían indistinguibles.

Verificado también por el lado contrario: con la recuperación desactivada, los
casos A, A2, D, G y H fallan — el cliente queda atrapado en
`CHECKOUT_EN_CURSO` con su pedido ya en la cocina.

**Límite conocido**: la recuperación busca el pedido en `pedidos_activos`. Un
pedido ya archivado y purgado de esa tabla no se encontraría; en la práctica
la ventana de un checkout se mide en segundos y ningún pedido se archiva tan
rápido, pero conviene saberlo si alguna vez se acorta la retención.