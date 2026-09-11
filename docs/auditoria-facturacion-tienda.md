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

**Y casi nadie la consulta.** Solo la tienda (`tiendaOnline.js`) y el
validador de órdenes (`validadorOrden.js:937`) pasan por esa configuración.
El resto del sistema trae la zona escrita a mano, en unos quince lugares: el
corte de caja y su fecha operativa (`server.js:3726`, `3750`, `7561`,
`7720-7721`), el reporte diario de las 22:01 (`server.js:8342-8424`), el
recordatorio de pedidos programados por WhatsApp
(`whatsapp-meta.js:741`, `1139`), el prompt del bot (`prompts.js:267`, `313`)
y `normalizarFecha.js:39`.

Con un solo negocio esto no se nota. Con dos en zonas distintas, el segundo
tendría el corte de caja, el reporte diario y las horas que dice el bot en la
zona del primero.

Un detalle suelto del mismo tema: `src/channels/voice.js:46` usa
`America/Monterrey` en vez de Matamoros. Monterrey no cambia de horario desde
2022 y Matamoros sí, así que de marzo a noviembre el canal de llamadas evalúa
la hora con una hora menos que el resto del sistema.

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

| # | Qué | Por qué primero |
|---|---|---|
| 1 | Zona horaria de los programados en la tienda | Es un pedido que hoy entra a la cocina a la hora equivocada, y ya está en producción |
| 2 | Facturapi por negocio (canal `facturacion` en `integraciones_canal`) | Un CFDI con el RFC de otro contribuyente es un problema fiscal, no un bug |
| 3 | Envío y descuento en el CFDI | El comprobante no cuadra con lo cobrado |
| 4 | CP en el flujo de WhatsApp + alinear el gate con `getIntegracion` | Es lo que hace que la factura por WhatsApp no llegue nunca |
| 5 | Facturar desde el cobro, y que el cajero pueda | Es el momento en que el cliente realmente la pide |
| 6 | Selector de día y hora en la tienda | Lo que pediste; sobre el punto 1 ya arreglado |
| 7 | Portal de autofactura | El más grande; conviene diseñarlo aparte (llave en el ticket, ventana de tiempo) |

Nada de esto está hecho: es una auditoría. Antes de tocar Facturación conviene
saber qué trae la rama de Codex, que hoy no está publicada.
