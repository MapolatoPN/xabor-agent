# Auditoría: Facturación y Tienda en línea

Fecha: 2026-09-11 · Rama auditada: `main` en `4d77356` (lo que hoy corre en
producción) · Todo lo que sigue está verificado contra el código, no
supuesto. Donde no pude comprobar algo, lo digo.

Esta es una auditoría: describe lo que hay y lo que falta. No cambié nada.

---

# Parte 1 — Facturación

Se pidieron tres caminos. El resumen honesto:

| Camino | Estado |
|---|---|
| Factura por WhatsApp | Existe, pero hoy no puede timbrar |
| Factura autoemitida en portal | **No existe.** Ni página, ni ruta, ni tabla |
| Factura emitida por el personal | Existe, pero solo admin y solo desde Historial |

Y por debajo de los tres hay tres defectos que los afectan a todos. Esos son
los que más pesan.

## 1.1 Factura por WhatsApp — existe el camino, no llega al final

El flujo está completo de principio a fin: el prompt le enseña al bot a pedir
los datos fiscales (`src/agent/prompts.js:711`), el bot cierra con un marcador
`<SOLICITAR_FACTURA>`, `brain.js` lo extrae (`extraerFactura`,
`src/agent/brain.js:1207`) y el canal lo ejecuta
(`src/channels/whatsapp-meta.js:1245`), registrando la emisión en
`facturas_pedido` con `fuente: 'whatsapp'`. Incluso resuelve el folio solo,
del último pedido entregado de ese teléfono. Está bien pensado.

Tiene tres fallas, en orden de gravedad.

**a) Falta el código postal, y sin él el SAT no timbra.** El prompt pide RFC,
razón social, régimen y correo. No pide el CP. `facturapi.js:70` cae entonces
a un valor fijo:

```js
address: { zip: clienteCFDI.cp || '26000' }
```

CFDI 4.0 exige el `DomicilioFiscalReceptor` y lo valida contra el padrón del
SAT: si el CP no es el que el SAT tiene registrado para ese RFC, el timbrado
se rechaza. `26000` es Piedras Negras. Para cualquier cliente que no sea de
ahí, la factura por WhatsApp falla en el timbrado y el cliente recibe el
mensaje genérico *"Hubo un problema generando tu factura"*.

**b) La condición para ejecutar no es la misma que la que usa el servicio.**
El canal se activa con la variable de entorno:

```js
// src/channels/whatsapp-meta.js:1245
if (resultado.factura && process.env.FACTURAPI_KEY) {
```

pero el servicio resuelve la llave de otra manera:

```js
// src/services/facturapi.js:7
return getIntegracion('facturapi_key') || process.env.FACTURAPI_KEY;
```

Si la llave está guardada en la configuración y no en Railway, el bloque
entero se salta **en silencio**. El cliente dio su RFC, el bot le dijo que sí,
y no pasa nada: ni factura, ni aviso, ni error en el log. Es el peor modo de
fallo de los tres.

**c) El bot ofrece facturas aunque el negocio no tenga el módulo.** El bloque
`## FACTURACIÓN (CFDI)` del prompt es incondicional — no está envuelto en
ningún `${...habilitado ? ...}`, a diferencia de Rewards, que sí lo está
(`prompts.js:739`). Y el canal tampoco consulta
`moduloHabilitado(negocioId, 'facturacion')`, mientras que las rutas del panel
sí lo hacen con `requireModulo('facturacion')`. Resultado: en un negocio sin
facturación, el bot promete algo que el sistema no va a entregar.

## 1.2 Factura autoemitida en portal — no existe

Busqué página, ruta, tabla y marcador. No hay nada. Las únicas páginas
públicas del sistema son tres:

| Ruta | Archivo |
|---|---|
| `/` | `public/landing/index.html` |
| `/t/:slug` | `panel/tienda.html` |
| `/seguimiento/:token` | `panel/tienda-seguimiento.html` |

(`src/server.js:2462`, `src/services/tiendaRutasCore.js:64-68`.)

Lo que hay en `panel/finanzas.html` bajo el título «Facturas» son las facturas
**recibidas** de proveedores, descargadas del SAT con la e.firma
(`satSync.js`, `satCredentials.js`). Es lo contrario de lo que se pide aquí:
son CFDI que el negocio recibe, no que emite.

Si esto se construye, hay dos piezas que ya existen y conviene reusar:

- **Para pedidos de la tienda**, `/seguimiento/:token` ya identifica un pedido
  concreto con un token opaco de 192 bits que el cliente tiene en la mano.
  Agregar ahí «Facturar este pedido» es barato y seguro.
- **Para mostrador y caja** —que es el caso normal de autofactura— no hay
  llave. Haría falta imprimir en el ticket algo que el cliente pueda teclear
  (folio + un código corto de un solo uso). Eso toca el ticket y el POS, así
  que es trabajo de diseño, no solo de pantalla.

En ambos casos hace falta además una regla que hoy no está escrita: hasta
cuándo se puede autofacturar (el SAT permite facturar dentro del mes en curso;
después ya no).

## 1.3 Factura emitida por el personal — existe, pero apretada

Funciona: modal en el panel (`panel/index.html:1126`), ruta
`POST /api/admin/pedido/:folio/factura` (`src/server.js:3621`), registro en
`facturas_pedido` con `fuente: 'panel'`, y descarga del PDF por un proxy
autenticado. Lo que limita su uso es dónde vive y quién puede usarlo.

**Solo el administrador.** La ruta usa `requireAdminSeguro`, y la jerarquía es
`{ admin: 2, staff: 1 }` (`src/server.js:268`). Un cajero —el único que
realmente está frente al cliente cuando pide la factura— no puede emitirla.

**Solo desde Historial, y solo después.** El botón «🧾 Factura» se pinta
únicamente en el listado de pedidos entregados (`panel/index.html:6679`). No
está en el modal de cobro, ni en el POS, ni en mesas, ni en mostrador. Es
decir: el flujo real —«me da factura» en la caja, en el momento de pagar— no
está cubierto. Hay que cobrar, irse a Historial, buscar el pedido y facturar
desde ahí.

**El botón no mira el módulo.** Se pinta con `isAdmin && !cancelado`, sin
consultar `MODULOS`. En un negocio sin facturación, el botón está visible y la
ruta responde 403.

## 1.4 Los tres defectos de fondo

### A. Una sola cuenta de Facturapi para todos los negocios

Este es el más grave de toda la auditoría.

```js
// src/server.js:145-152
let integracionesCache = {};
async function cargarIntegraciones() {
  const cfg = await obtenerConfiguracion().catch(() => ({}));   // ← sin negocioId
  ...
}
export function getIntegracion(clave) {
  return integracionesCache[clave] || process.env[ENV_MAP[clave]] || '';
}
```

`obtenerConfiguracion()` sin argumento resuelve **un** negocio
(`resolverNegocioActualId`, `database.js:5012`). El caché es global al
proceso. Así que `facturapi_key` es una sola llave para toda la plataforma:
el CFDI de cualquier negocio se emite con el RFC del titular de esa cuenta.

Es exactamente el incidente P0 que ya se corrigió con Clip, y el propio
comentario del `ENV_MAP` lo deja escrito (`src/server.js:161-165`):

> *clip_api_key/clip_api_secret (Incidente P0) se retiraron de este mapa a
> propósito: eran la causa raíz de que Clip se resolviera con una única cuenta
> GLOBAL en vez de por negocio.*

`facturapi_key` sigue en ese mapa. La diferencia con Clip es que aquí el
documento equivocado no es un cobro: es un comprobante fiscal emitido a nombre
de otro contribuyente. La infraestructura para arreglarlo ya existe
(`integraciones_canal` + `guardarCredencialesCifradas`, cifrado por negocio);
falta darle de alta el canal `facturacion`.

### B. El CFDI no cuadra con lo que se cobró

`generarFactura` arma los conceptos únicamente de `pedido.items`
(`facturapi.js:82`). Pero el total del pedido es otra cosa:

```js
// src/services/posEnvios.js:130
const total = Math.round((subtotal + envio - desc) * 100) / 100;
```

- **El envío no se factura.** Un pedido a domicilio de Obispado trae $60 de
  costo base: el CFDI sale $60 por debajo de lo cobrado.
- **El descuento no se aplica.** El código lo calcula y luego no hace nada con
  él:

  ```js
  // facturapi.js:105
  const descuento = parseFloat(pedido.descuento || 0);
  ...
  ...(descuento > 0 && { global_information: undefined })
  ```

  Esa línea no agrega ningún dato (`JSON.stringify` descarta las claves con
  valor `undefined`). El CFDI se emite por el precio de lista.

El sistema ya sabe que esto pasa, al menos para los ajustes de cierre: el
aviso 🧾⚠️ del panel dice literalmente *«Si posteriormente se factura desde el
flujo actual, el CFDI se generará con los importes ORIGINALES de la venta»*
(`panel/index.html:6189`). Lo que la auditoría agrega es que no es solo con
ajustes: pasa con cualquier pedido a domicilio y con cualquier descuento del
POS.

### C. Ninguna prueba ejercita la emisión

No hay suite que llame a `generarFactura` ni a la ruta de factura. Lo único
que se prueba es el **registro** local (`facturas_pedido`) en
`test/fase-ajustes-cierre.mjs`. Es decir: se comprueba que anotamos que
facturamos, no que la factura salga bien.

## 1.5 La rama de Codex no está

Verificado con `git fetch origin --prune`: **`codex/facturacion-multiempresa-v1`
no existe en `origin`**. Las únicas ramas `codex/*` publicadas son las de
compras. La migración `075` tampoco está en el repositorio — el repo salta de
`071` a `076`.

Sea lo que sea que se construyó ahí, hoy vive solo en la máquina donde se
trabajó: no está respaldado, no lo puedo revisar y no se puede desplegar. Vale
la pena pedir que lo empuje aunque esté a medias — sobre todo porque el
defecto A de arriba es justo lo que esa rama debía resolver, y conviene saber
si ya está resuelto ahí antes de tocarlo.

---

# Parte 2 — Tienda en línea: pedidos programados

## 2.1 Sí se puede programar, y sí está encendido

El paso existe. Se llama «¿Cuándo?» y ofrece dos opciones grandes: **⚡ Lo
antes posible** y **📅 Programar** (`panel/tienda.html:808-834`). Al elegir
Programar aparece un campo de fecha y hora:

```html
<input type="datetime-local" id="ck-fecha" min="${minProgramable()}" ...>
```

Y el servidor lo valida en serio (`tiendaCheckout.js:64`): que la tienda
acepte programados, la anticipación mínima, una ventana de 14 días, y que el
negocio abra ese día a esa hora.

Además está habilitado para Obispado. Lo consulté en la tienda pública, que es
un GET de solo lectura:

```
GET https://xabor.mx/api/tienda/mapolato-obispado
→ "aceptaProgramados": true, "anticipacionMinutos": 40, "cierraA": "22:00"
```

Así que la impresión de que «no te permite programar» no viene de que la
función falte ni de que esté apagada.

## 2.2 Viene de que la hora se interpreta en la zona equivocada

Un `<input type="datetime-local">` manda un texto **sin zona horaria**:
`"2026-09-15T20:00"`. El servidor hace:

```js
// src/services/tiendaCheckout.js:69
const fecha = new Date(programadoPara);
```

En JavaScript, ese formato sin zona se interpreta en la **zona del proceso**.
El `Dockerfile` no fija `TZ` y `node:20-slim` corre en **UTC**. El local está
cinco o seis horas atrás según la época del año. Nadie convierte nada en el
camino: el texto va del navegador al `new Date` tal cual
(`tiendaRutasCore.js:131` → `crearPedidoTienda`).

Reproducido con los parámetros reales de Obispado (abierto 10:00–22:00,
anticipación 40 min), zona `America/Matamoros`, con el proceso en UTC como en
producción:

```
Son las mar, 15/09, 01:00 p.m. en el local.

El cliente elige: hoy a las 3 de la tarde (faltan 2 horas)
   -> RECHAZADO: "Los pedidos programados requieren al menos 40 minutos de anticipación"

El cliente elige: hoy a las 8 de la noche
   -> ACEPTADO, pero queda agendado para mar, 15/09, 03:00 p.m.

El cliente elige: mañana a la 1 de la tarde
   -> RECHAZADO: "Ese día atendemos de 10:00 a 22:00"

El cliente elige: mañana a las 8 de la mañana (cerrado)
   -> RECHAZADO: "Ese día atendemos de 10:00 a 22:00"
```

Léase con calma, porque los cuatro renglones son distintos:

1. Quiere las 3 de la tarde y faltan dos horas. Le dice que necesita 40
   minutos de anticipación. Es la queja tal cual.
2. Quiere las 8 de la noche. **Se acepta, y entra a la cocina para las 3 de la
   tarde.** Este es el peor: no da error, da comida cinco horas antes.
3. Quiere mañana a la 1 de la tarde. Le dice que ese día atienden de 10:00 a
   22:00 — y la 1 de la tarde está dentro de ese horario.
4. Solo este acierta, y acierta por accidente.

En la práctica, únicamente se dejan programar horas que el cliente escriba
tantas horas más tarde de lo que quiere como sea el desfase, y al hacerlo el
pedido se agenda ese mismo desfase antes de lo que pidió.

**Y el desfase cambia dos veces al año.** `America/Matamoros` es municipio
fronterizo y sí observa horario de verano:

| Fecha | Hora en el local cuando en UTC son las 18:00 | Desfase del defecto |
|---|---|---|
| 11 de enero | 12:00 | **6 horas** |
| 11 de septiembre | 13:00 | **5 horas** |

Así que ni siquiera es un error constante que alguien pudiera aprenderse: en
invierno son seis horas y en verano cinco.

### Por qué las pruebas no lo vieron

`test/fase-tienda-online.mjs:538` construye la fecha así:

```js
const cuando = new Date(Date.now() + 3 * 3600 * 1000).toISOString();
```

`toISOString()` produce `"2026-09-15T20:00:00.000Z"`, con la `Z` al final. Eso
es una instante absoluto y `new Date` lo interpreta igual en cualquier zona.
El navegador nunca manda eso. La suite prueba un formato que la tienda real no
usa, y por eso pasa en verde mientras el checkout está roto.

## 2.3 La zona del negocio: confirmada, y sin manera de cambiarla

La zona es `America/Matamoros`, confirmada por el dueño. Coincide con lo que
hace el código, así que aquí no hay defecto — pero sí dos cosas que conviene
dejar anotadas, porque muerden en cuanto haya un negocio fuera de esa zona.

**No hay forma de configurarla.** `tiendaOnline.js:125` lee
`configuracion.timezone` y cae a `TZ_DEFAULT` si no está. Busqué quién escribe
esa clave: **nadie**. No hay pantalla en el panel ni ruta de API que la fije.
En la práctica, `America/Matamoros` no es un valor por defecto sino el único
valor posible, salvo que alguien inserte la fila a mano en la base.

**Y buena parte del sistema no la consultaba.**

> **Corrección, el mismo día.** Una versión anterior de este documento decía
> que el corte de caja traía la zona escrita a mano. **Es falso, y era
> justamente el punto más delicado de la lista.**
> `src/services/cortesCaja.js:70` tiene `zonaHorariaNegocio(negocioId)`, que
> lee `configuracion.timezone`, la valida y cae al default; con
> `fechaOperativaDe`, `fechaOperativaHoy` y `rangoUtcDeFecha` alrededor. El
> corte, el fondo de caja y los ajustes de cierre ya pasaban por ahí, y
> `comprasFinanzas.hoyNegocio` también. **Nada del camino del dinero dependía
> de una zona fija.**

Lo que sí estaba escrito a mano era el resto: el prompt del bot
(`prompts.js:267`, `313`), el recordatorio de pedidos programados por WhatsApp
(`whatsapp-meta.js:741`, `1139`), las ventas del día (`server.js:3726`), el
reporte diario (`server.js:8369-8424`), `normalizarFecha.js:39` y los valores
de respaldo de las promociones.

Con un solo negocio no se notaba. Con dos en zonas distintas, el segundo
tendría el reloj del bot y las horas de sus confirmaciones en la zona del
primero, aunque su corte de caja saliera bien.

Dos detalles sueltos del mismo tema:

- `src/channels/voice.js:46` usaba `America/Monterrey` en vez de Matamoros.
  Monterrey no cambia de horario desde 2022 y Matamoros sí, así que de marzo a
  noviembre el canal de llamadas saludaba con una hora de diferencia respecto
  a todo lo demás.
- `inicioDelDiaTexto`, en el reporte diario, fijaba `T06:00:00.000Z` con el
  comentario *«UTC-6 midnight ≈ 06:00Z»*. El «≈» era literal: medio año la
  medianoche local cae a las 05:00Z, así que lo vendido entre las 00:00 y la
  1:00 se contaba en el día anterior.

## 2.4 Sobre el calendario que pides

Tu instinto acierta, y arregla más de lo que parece. Pero el orden importa:
**un calendario sobre el defecto de zona horaria seguiría agendando mal.**
Primero lo de abajo, después lo de arriba.

1. **Que la hora viaje con su zona.** O el navegador manda un ISO con offset,
   o el servidor resuelve el texto en la zona del negocio. Sin esto, cualquier
   selector bonito sigue mandando la hora equivocada. Es el arreglo real.

2. **Después, el selector que describes.** Un calendario que solo ofrezca lo
   que el negocio puede servir: días cerrados apagados, horas limitadas al
   horario de ese día y a la anticipación mínima, en bloques (cada 15 o 30
   minutos). Hoy el cliente elige a ciegas y se entera de que no se puede
   hasta el final del checkout, cuando ya llenó dirección y teléfono.

3. **Y el techo de la ventana.** El servidor rechaza más de 14 días
   (`tiendaCheckout.js:79`) pero el campo solo tiene `min`, no `max`
   (`tienda.html:828`). El cliente puede elegir una fecha que el servidor va a
   rechazar.

Un detalle menor del mismo tema: `minProgramable()` (`tienda.html:835`)
calcula el mínimo con la zona **del teléfono del cliente**, no la del negocio.
Un cliente de visita desde otra zona ve un mínimo corrido.

---

# Qué haría yo, en orden

Por impacto, no por esfuerzo:

| # | Qué | Por qué primero | Estado |
|---|---|---|---|
| 1 | Zona horaria de los programados en la tienda | Es un pedido que hoy entra a la cocina a la hora equivocada, y ya está en producción | ✅ hecho |
| 2 | Facturapi por negocio (canal `facturacion` en `integraciones_canal`) | Un CFDI con el RFC de otro contribuyente es un problema fiscal, no un bug | pendiente |
| 3 | Envío y descuento en el CFDI | El comprobante no cuadra con lo cobrado | pendiente |
| 4 | CP en el flujo de WhatsApp + alinear el gate con `getIntegracion` | Es lo que hace que la factura por WhatsApp no llegue nunca | pendiente |
| 5 | Facturar desde el cobro, y que el cajero pueda | Es el momento en que el cliente realmente la pide | pendiente |
| 6 | Selector de día y hora en la tienda | Lo que pediste; sobre el punto 1 ya arreglado | ✅ hecho |
| 7 | Portal de autofactura | El más grande; conviene diseñarlo aparte (llave en el ticket, ventana de tiempo) | pendiente |

Antes de tocar Facturación conviene saber qué trae la rama de Codex, que hoy
no está publicada.

---

# Lo que ya quedó hecho

En la rama `fix/zona-horaria-por-negocio`, en dos commits separados. **Sin
desplegar.**

## Etapa 1 — la hora que elige el cliente es la que llega a la cocina

`src/services/zonaHoraria.js` (módulo nuevo y puro) resuelve el texto sin zona
en la zona del negocio y da el mismo instante corra el proceso donde corra.
Los dos días raros del año son decisiones explícitas: la hora que no existe se
corre hacia adelante, la repetida toma la primera.

El catálogo de zonas separa la frontera del resto, que es la única división
que cambia las cuentas, y se valida contra ICU en vez de contra una lista
nuestra. Config → Operación trae el selector, junto a los horarios y
guardándose con ellos. Y la tienda ofrece día y hora en vez de un campo crudo:
días cerrados apagados, horas dentro del horario de ese día y por encima de la
anticipación, todo contado en la zona del negocio.

Un ISO con zona explícita se sigue respetando tal cual: los clientes de API y
las suites viejas no cambian.

## Etapa 2 — la zona deja de estar escrita a mano

`cortesCaja.zonaHorariaNegocio` ya existía y ya era por negocio, así que **no
se creó un segundo resolvedor**: los sitios que faltaban se enchufaron a ese.
Quedaron por negocio el reloj del bot, las dos horas que WhatsApp le dice al
cliente sobre un pedido programado, el saludo del canal de voz, las ventas del
día y el reporte diario. De paso se arreglaron el `America/Monterrey` de
`voice.js` y el `T06:00:00.000Z` del reporte.

El literal `America/Matamoros` vive ahora en un solo archivo, y una prueba
recorre `src/` para que no vuelva a aparecer en ningún otro. La única
excepción permitida es `clip-api.js`, que usa CDMX por una razón distinta y
documentada.

**Lo que NO se tocó, y por qué.** El disparo del reporte de las 22:01 y el job
de horario de Rappi siguen siendo de un solo negocio. No es la zona lo que les
falta: el reporte va a un único `WHATSAPP_ADMIN_NUMERO` y el horario de Rappi
está escrito en el código en vez de salir de `reglas_atencion`. Ponerles una
zona configurable habría dado apariencia de multiempresa sin serlo. Queda
anotado en el propio código.

## Pruebas

`test/fase-zona-horaria.mjs`, 25 casos. Prueba de mordida en las dos etapas:

- Etapa 1: con el defecto de vuelta y `TZ=UTC` caen los casos 10, 11 y 12, y
  el 10 muestra `15:00` donde debía decir `20:00`.
- Etapa 2: ignorando `reglas.timezone` cae el caso 22, y el 23 —la red de
  seguridad, que exige que un negocio sin zona propia se comporte igual que
  antes— sigue pasando.

Sin regresión en tienda (online, desktop, productización, solo-pago-online,
pago-online-ui, scroll-estable, overlay-desktop, recuperación-crash), caja
(cortes, ajustes de cierre), bot (forma-pago, ux-cierre, fidelidad-borrador,
negaciones-injustas), promociones (9 suites), compras y repartidores.

Tres fallos que **ya estaban en `main` limpio** y no son de este cambio: uno de
promociones de primera compra en `fase-tienda-online`, el `K5` de
`fase-tienda-recuperacion-crash` y las cinco de `fase-comanda-edge-exclusiva`
(esas están resueltas en `integracion/obispado-personal`). Y
`fase-promociones-pagos` no corre en esta máquina: el puerto 4343 lo ocupa un
servicio de Acer.
