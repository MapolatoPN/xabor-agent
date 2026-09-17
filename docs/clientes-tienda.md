# Cuenta del cliente en la Tienda en Línea

La tienda deja de tratar cada compra como la primera. Un cliente entra con su
teléfono y un código, guarda sus direcciones, ve sus puntos de Rewards y
compra eligiendo "Enviar a: Casa" sin volver a escribir nada. Es una función
**genérica de Xabor**: cada negocio la enciende para su tienda; Mapolato es
solo el primero.

Rama `feat/tienda-cliente` (base de producción `a6318bb`). **Migración nueva:
080** (`clientes_negocio` y satélites; punteros nullables en
`rewards_accounts` y `pedidos_activos`; interruptor
`tienda_config.cuentas_clientes`).

## La regla que ordena el módulo

**Un solo motor, una sola persona.** No hay un segundo sistema de pedidos ni
un segundo motor de puntos:

```
Cliente (clientes_negocio: UNA fila por negocio + teléfono normalizado)
  ├── cliente_direcciones      libreta: Casa / Trabajo / Otro
  ├── cliente_sesiones         sesiones del lado del servidor (90 días)
  ├── cliente_otp              códigos de acceso (solo su hash)
  ├── cliente_consentimientos  bitácora de marketing (WhatsApp / correo)
  ├── rewards_accounts.cliente_id   → el motor de Rewards, intacto
  └── pedidos_activos.cliente_id    → los pedidos, con su snapshot de siempre
```

Rewards y los pedidos **se relacionan** con el cliente; ninguno se reescribe.

## Cómo se enciende

Tres candados independientes, todos cerrados al desplegar:

| Candado | Dónde | Quién lo mueve |
|---|---|---|
| Cuentas en la tienda | `tienda_config.cuentas_clientes` (DEFAULT FALSE) | El negocio: `PUT /api/admin/tienda { "cuentasClientes": true }` |
| Vía del código OTP | `OTP_PROVEEDOR` (`sms` \| `whatsapp` \| `dev`) | Variable de entorno en Railway |
| Rewards visible en Mi cuenta | Módulo `rewards` + `rewards_config.activo` (los de siempre) | Como hoy |

Sin `cuentas_clientes` la tienda **no pinta ni el botón** de "Iniciar sesión"
y todas las rutas `/api/tienda/:slug/cuenta/*` responden 404, indistinguibles
de una ruta inexistente: se ve exactamente como antes.

Sin `OTP_PROVEEDOR` en producción **no hay OTP** (el login dice que no está
disponible). Un despliegue jamás empieza a mandar mensajes -- que cuestan
dinero -- sin que alguien lo haya decidido con una variable. Fuera de
producción el proveedor es `dev` (el código se imprime en el log).

## Identidad: el teléfono a 10 dígitos

La identidad es el teléfono **normalizado con `normalizarTelefonoMX`** (los
últimos 10 dígitos), la misma regla que POS, tienda y repartidores.
`8781234567`, `878 123 4567`, `+52 878 123 4567` y `5218781234567` son la
misma persona; la `UNIQUE (negocio_id, telefono)` de la base lo impone aunque
el código se equivoque. Se guarda además `telefono_original` (cómo lo
escribió) solo como dato.

El teléfono **no se edita** desde el perfil: es la identidad verificada. Para
cambiarlo se inicia sesión con el número nuevo.

`clientes` (la tabla vieja) **no sirve** como entidad: su PK es el teléfono a
nivel global, anterior a la multiempresa. Sigue existiendo para WhatsApp y
para la FK de `rewards_accounts`; no se tocó.

## Acceso: teléfono → código → sesión

Sin contraseñas. `POST cuenta/otp` con el teléfono; `POST cuenta/otp/verificar`
con el código (y el nombre si es la primera vez) abre la sesión.

**El código**: 6 dígitos de `crypto.randomInt`; vence a los **5 minutos**;
**un solo uso**; **5 intentos** y se quema; pedir otro **revoca** el anterior;
en la base va **solo su SHA-256 con pimienta** del servidor (leer la tabla no
sirve para entrar). Un código incorrecto, vencido o reutilizado responde el
mismo `401 CODIGO_INVALIDO`.

**Rate limit** (mismo `rateLimit` en memoria del proyecto, mismas
limitaciones documentadas): 3 códigos por teléfono cada 15 min
(`XABOR_OTP_LIMITE_TELEFONO`), 20 por IP cada 15 min (`XABOR_OTP_LIMITE_IP`),
15 verificaciones por teléfono cada 15 min. El límite por teléfono es el que
protege a la persona; el de IP se deja holgado porque una IP no siempre es
una persona.

**No se enumeran cuentas**: pedir un código responde igual exista o no la
cuenta -- la cuenta se crea al verificar, no antes.

**La sesión** vive **en la base** (`cliente_sesiones`), a diferencia de las
sesiones firmadas del panel: cerrar sesión la revoca de verdad, y una sesión
de 90 días se puede cortar sin esperar a que caduque. En la base va el hash
del token; el token de 256 bits va en la cookie `xabor_cliente`: **httpOnly,
SameSite=Lax, Secure en producción, 90 días**. El JavaScript de la tienda
nunca ve el token.

**Aislamiento entre negocios**: la cookie es una por dominio, pero la sesión
está amarrada al negocio que la emitió y **solo se resuelve para ese
negocio** (`sesionDeToken(token, negocioId)` filtra por `negocio_id`). La
misma cookie en la tienda de otro negocio es, para el servidor, no tener
sesión. El mismo teléfono en dos negocios son dos clientes, dos libretas y
dos saldos.

**CSRF**: SameSite=Lax hace que un POST desde otro sitio no lleve la cookie,
y todas las mutaciones son JSON (`express.json` no parsea un formulario
cross-site). **XSS**: la tienda escapa todo lo que pinta (`esc`), incluido lo
que el cliente escribió.

## Direcciones

Libreta con `alias` (Casa / Trabajo / Otro), calle, números exterior e
interior, colonia, código postal, entre calles, referencia, instrucciones de
entrega, **zona de reparto**, latitud/longitud (opcionales) y
`predeterminada`.

- La primera dirección nace predeterminada; marcar otra desmarca la anterior
  en la misma transacción, y un índice único parcial garantiza desde la base
  que **solo hay una**.
- La **zona** se valida contra `reglas_atencion.zonas` del negocio (es lo que
  decide el costo de envío); si el negocio no tiene zonas, la colonia es
  obligatoria porque el repartidor la necesita.
- Tope de 10 direcciones. Borrar la predeterminada hereda la marca a la más
  antigua.
- **Propiedad** en cada consulta: `WHERE negocio_id = $1 AND cliente_id = $2
  AND id = $3`. Una dirección ajena es, para el servidor, inexistente (404).
  Y la FK compuesta `(negocio_id, cliente_id) → clientes_negocio (negocio_id,
  id)` impide en el esquema que una dirección cuelgue de un cliente de otro
  negocio.

## Checkout con sesión

El invitado compra **exactamente como antes** (mismo formulario, mismo
payload, `cliente_id` en NULL). Con sesión:

- el **teléfono del pedido es el verificado**; el que venga en el cuerpo se
  ignora. Es lo que impide gastar los puntos de otro número tecleándolo;
- el nombre sale del cuerpo o, si no viene, del perfil;
- con `direccionId`, la dirección se lee de la libreta **comprobando que sea
  de ese cliente** y entra al pedido por el **mismo camino** que una escrita
  a mano (`direccionParaPedido` → `construirOrdenPOS`): queda **copiada** en
  `datos->'cliente'`. Editar o borrar la dirección después no cambia cómo se
  ve un pedido de hace seis meses (probado);
- las instrucciones de entrega de la dirección viajan en `notas` del pedido
  (lo que lee el repartidor), detrás de las indicaciones del pedido;
- el pedido lleva `cliente_id` en la columna (indexada) y en
  `datos.cliente_id`, y `datos.tienda.direccion_id`.

**Canje de puntos**: en una tienda con cuentas encendidas el canje **exige
sesión**. Antes cualquiera podía canjear los puntos de cualquier teléfono
tecleándolo en el checkout (riesgo residual documentado en
`rewards-tienda-online.md` §9); con la identidad verificada ese hueco se
cierra. El invitado sigue viendo "esta compra te da N puntos" y una
invitación a entrar; el oráculo público `GET /api/tienda/:slug/rewards` solo
responde para la sesión. Sin cuentas encendidas, todo sigue como hoy.

## Rewards: el motor no se toca

`rewards_accounts` conserva su identidad `(telefono, tenant_id)` y toda su
lógica. Gana un puntero `cliente_id` (ON DELETE SET NULL: borrar un cliente
nunca borra puntos). Se llena de dos formas:

1. **Backfill en la 080**: SQL puro e idempotente. Crea un cliente por cuenta
   de Rewards cuyo `tenant_id` sea un negocio real y le apunta **todas** las
   cuentas de esa persona aunque tengan formato distinto (`8781234567` y
   `5218781234567` → un cliente, dos cuentas). Entre varias gana la que
   tiene nombre y la que ya venía en 10 dígitos. Excluye `rappi-…`, `—` y
   teléfonos cortos. **No mueve un solo punto**: el predeploy fotografía
   cuentas, saldos, acumulados y movimientos antes y después y aborta el
   deploy si algo cambió.
2. **Al entrar** (`vincularRewards`): cualquier cuenta sin puntero cuyo
   teléfono normalizado sea el del cliente pasa a apuntarle.

Lo que el cliente ve (`GET cuenta/rewards`): saldo total (suma de sus cuentas
vinculadas), `puntosCanjeables` (el saldo de la cuenta en 10 dígitos, que es
la que usa el checkout), nivel, mínimo de canje y valor del punto, cuánto
cabe canjear hoy, si el canje en tienda está encendido, totales ganados y
canjeados, y los últimos 50 movimientos (leídos con
`obtenerMovimientosCliente`, la función del motor).

**Cuentas duplicadas por formato**: no se fusionan saldos (sería una
operación sobre puntos, fuera de esta entrega y de la regla "no modifique
saldos"). La UI lo explica: "N pts de tu saldo están registrados con otro
formato de tu número; se canjean en el negocio". El predeploy reporta cuántos
clientes tienen varias cuentas para decidir una fusión con datos reales.

## Consentimiento

Los datos para **entregar** un pedido (nombre, teléfono, dirección) no son
consentimiento de marketing. Eso es aparte y es una **bitácora**:
`cliente_consentimientos (canal ∈ whatsapp|email, otorgado, fuente,
created_at)`; el estado vigente es la fila más reciente por canal. **El
checkout no escribe aquí nunca** (probado); solo el cliente desde Perfil, con
fuente `mi_cuenta`, y cada cambio deja fila. No hay campañas.

## API pública (bajo `/api/tienda/:slug`, negocio SIEMPRE desde el slug)

| Ruta | Sesión | Qué hace |
|---|---|---|
| `POST cuenta/otp` | no | Manda el código (`{ ok, canal, expiraEn, telefono }`) |
| `POST cuenta/otp/verificar` | no | Verifica y abre sesión (cookie); `{ ok, nuevo, cliente }` |
| `POST cuenta/logout` | — | Revoca la sesión y limpia la cookie |
| `GET cuenta` | sí | Cliente, direcciones, consentimientos y resumen de Rewards |
| `PATCH cuenta` | sí | Nombre y correo (el teléfono no) |
| `PUT cuenta/consentimientos` | sí | `{ whatsapp, email }` booleanos |
| `GET/POST cuenta/direcciones` · `PUT/DELETE …/:id` · `POST …/:id/predeterminada` | sí | Libreta |
| `GET cuenta/rewards` | sí | Saldo, nivel, reglas y movimientos |
| `GET cuenta/pedidos` | sí | Últimos pedidos con liga de seguimiento |
| `POST checkout` | opcional | Con sesión acepta `direccionId` |
| `POST cotizar` | opcional | Con sesión usa el teléfono verificado |

`GET /api/tienda/:slug` expone `cuentas: true|false`. Errores: `401
NO_AUTENTICADO`, `404` con cuentas apagadas o dirección ajena, `429
OTP_DEMASIADOS`, `503 OTP_NO_DISPONIBLE`, `502 OTP_ENVIO_FALLIDO`.

## La pantalla

Un botón en la cabecera ("Iniciar sesión" / "Hola, Ana") y una hoja
(`#hoja-cuenta`) con las mismas piezas de la tienda: login (teléfono →
código → nombre la primera vez), Mi cuenta (Perfil, Mis direcciones,
Rewards, Mis pedidos, Cerrar sesión). En el checkout con sesión: teléfono
verificado no editable, "Enviar a" con la predeterminada preseleccionada,
"Escribir otra dirección" solo para este pedido, "+ Agregar nueva dirección"
que desvía a la libreta y regresa, y "Cambiar" en el resumen. Probado en 375,
390, 768 y escritorio sin scroll horizontal.

## Variables de entorno

| Variable | Omisión | Para qué |
|---|---|---|
| `OTP_PROVEEDOR` | (ninguno → sin OTP en producción; `dev` fuera) | `sms` \| `whatsapp` \| `dev` |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_SMS_NUMBER` | ya existen en Railway | Proveedor `sms` |
| `OTP_SMS_PREFIJO` | `52` | Prefijo E.164 del SMS |
| `OTP_WA_PLANTILLA` | (ninguna → canal no disponible) | Nombre de la plantilla de AUTENTICACIÓN aprobada en Meta |
| `OTP_WA_IDIOMA` | `es_MX` | Idioma de la plantilla |
| `OTP_WA_PREFIJO` | `521` | Prefijo del destinatario de WhatsApp |
| `XABOR_OTP_LIMITE_TELEFONO` | 3 | Códigos por teléfono / 15 min |
| `XABOR_OTP_LIMITE_IP` | 20 | Códigos por IP / 15 min |
| `XABOR_OTP_DEV_EXPONER` | (no) | SOLO pruebas: devuelve el código en la respuesta (imposible en producción) |
| `SESSION_SECRET` | ya existe | Pimienta del hash del código |

## Migración 080

Corre sola en el deploy: `railway.toml` → `scripts/predeploy-run-032-033.mjs`
→ `predeploy-080-clientes-tienda.mjs` → `migrations/080_clientes_tienda.sql`
→ verificación (5 tablas + 3 columnas + Rewards intacto). Aditiva,
idempotente (`IF NOT EXISTS` en todo; `ON CONFLICT DO NOTHING` en el
backfill), bajo advisory lock. Fail-closed: si falta algo o un saldo cambió,
sale con 1 y Railway aborta.

A mano, contra cualquier base:

```powershell
$env:DATABASE_URL = '<url>'
node scripts/predeploy-080-clientes-tienda.mjs      # dos veces: la segunda dice "Ya aplicada"
```

Imprime cuántos clientes creó desde Rewards, cuántas cuentas quedaron
vinculadas, cuántas no (teléfonos sintéticos o cortos) y cuántos clientes
tienen varias cuentas por formato.

**No enciende nada**: `cuentas_clientes` nace en FALSE para todas las tiendas.

## Rollback

1. Revertir el código (`git revert` de los commits de la rama; nunca parchear
   producción). Con el código viejo y la 080 puesta, nada la lee: las
   columnas nullables y las tablas nuevas son inertes.
2. Solo si hace falta deshacer el esquema: `psql -f
   migrations/080_clientes_tienda_down.sql`. **Destruye** direcciones,
   sesiones, códigos y consentimientos. **No destruye puntos** (suelta el
   puntero; el saldo, los movimientos y la identidad de Rewards quedan
   intactos) ni toca ningún pedido (el snapshot sigue en `datos->'cliente'`).

## Bloqueos y pendientes

- **OTP real**: hay que fijar `OTP_PROVEEDOR=sms` (usa el Twilio ya
  configurado; cada código es un SMS) o preparar WhatsApp: crear y aprobar
  en Meta una plantilla de categoría *Authentication* con botón "copiar
  código" para el número de cada negocio y fijar `OTP_WA_PLANTILLA`. Sin una
  de las dos, el login no está disponible en producción (a propósito).
- **Interruptor desde el panel**: hoy se enciende con `PUT /api/admin/tienda
  { cuentasClientes: true }` (o SQL). La casilla en la pantalla de Tienda del
  panel toca `panel/index.html` (componente protegido) y queda para después.
- **Dominios propios** (`mapolato.com` → `/t/<slug>`): no existen todavía;
  `resolverTienda` está preparado para recibir un host resuelto a slug.
- **Fusión de cuentas duplicadas por formato**: decisión con datos reales
  (el predeploy los reporta); mueve puntos, así que no se hace en automático.
- **Sesiones y rate limit en memoria**: el rate limit es por proceso (como
  todo el proyecto); las sesiones sí son durables (base).

## Pruebas

| Suite | Casos | Qué responde |
|---|---|---|
| `test/fase-cliente-tienda.mjs` | 44 | Nuevo, OTP (incorrecto, quemado, vencido, reutilizado, revocado, hash, rate limit), tres formatos = un cliente, perfil, direcciones (Casa, Trabajo, predeterminada única), checkout con dirección guardada, snapshot inmune a ediciones, Mis pedidos, propiedad de dirección, invitado intacto, consentimiento, aislamiento entre negocios (también en el esquema), Rewards correcto e intacto, canje requiere sesión, logout, tokens falsos, interruptor apagado, backfill de la 080 |
| `test/fase-cliente-tienda-ui.mjs` | 33 | Puppeteer en 375, 390, 768 y escritorio: login, dirección, Rewards, compra con "Enviar a: Casa", sesión tras recarga, logout, invitado; sin scroll horizontal, cero errores de JS; capturas en `test/.capturas-cuenta/` |

Mordidas (cada garantía apagada pone en rojo exactamente sus pruebas):
sesión sin filtro de negocio → 31; cualquier código aceptado → 7 y 8; código
reutilizable → 10; sin normalización de teléfono → 15; dirección sin exigir
el cliente → 26; pedido sin `cliente_id` → 22; canje sin sesión → 38.
