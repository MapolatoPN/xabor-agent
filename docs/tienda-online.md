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

**Un reintento no crea dos pedidos.** El navegador genera un `checkoutToken`
de 192 bits una vez por intento de compra y lo guarda. El servidor reserva ese
token con un `INSERT … ON CONFLICT DO NOTHING` *antes* de hacer cualquier
trabajo; si el token ya existía, espera al pedido de la primera petición y
devuelve el mismo folio. Funciona con varias instancias del proceso porque
quien decide es la base, no la aplicación.

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
minutos y devuelve el cupo. Sin eso, un reinicio del servidor le quemaría el
cupón a un cliente para siempre.

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
- **Impresión física**: la integración con Xabor Edge es la de siempre (vía
  `emitirPedido`) y está probada a nivel de encolado, pero **la validación con
  impresora física está pendiente de hacerse en sitio**.

## Pruebas

| Suite | Casos | Qué responde |
|---|---|---|
| `test/fase-tienda-online.mjs` | 74 | Catálogo, precios impuestos por servidor, envío y zonas, checkout idempotente, promociones, seguimiento, backoffice, aislamiento y adversarial |
| `test/fase-tienda-carreras-cliente.mjs` | 10 | Límite por cliente y primera compra bajo concurrencia real, liberación del cupo y cuadre de contadores |
| `test/fase-tienda-productizacion.mjs` | 21 | Un negocio nuevo se vuelve tienda funcional sin tocar un archivo |
| `test/fase-predeploy-tienda.mjs` | 18 | La cadena railway.toml → runner → 051 → verificación, idempotencia, fail-closed, aislamiento por esquema y rollback |

Ambas contra Postgres real, con los mismos arneses del resto del proyecto.


## Cómo llega la 051 a un deploy real

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
  la aplicación arranca
```

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

Verificado por `test/fase-predeploy-tienda.mjs` (18 casos), que recorre la
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

**Este rollback destruye datos**: configuración de tienda, promociones y su
historial de uso. Los pedidos ya cobrados sobreviven — viven en
`pedidos_activos` y `pedidos` — pero se pierde la atribución de qué promoción
los generó. Respaldar las seis tablas antes de correrlo en una base con
tiendas publicadas.
