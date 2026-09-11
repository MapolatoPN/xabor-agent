# Obispado — bitácora de la madrugada (2026-09-10)

Punto exacto de continuación. Rama `offline/sala-v1`, **sin desplegar**.

## Matriz de los dos frentes

### Frente A — Obispado

| Estado | Qué |
|---|---|
| **Terminado y probado** | Motor local de sala · Sincronización idempotente · Foto del catálogo · Herencia de mesas abiertas · Servidor local del Edge · Failover del panel · Caché del shell · Cajón atado al cobro real · Transporte nube↔Edge autenticado · Reintentos con espera creciente · Permisos caja/mesero **en las dos puntas** · Recorrido completo por interfaz con 3 estaciones aisladas (15/15) · **Informes de reconciliación persistidos + pantalla** |
| **En desarrollo** | — |
| **Sin comenzar** | **Para llevar sin internet** (identificadores locales y reconciliación sin duplicar) |
| **Solo hardware** | Comunicación entre equipos físicos · firewall/red · las 4 impresoras · el cajón (conexión física sin identificar) · ensayo de desconexión fuera de servicio |

### Frente B — Personal

| Estado | Qué |
|---|---|
| **Terminado y probado** | — |
| **En desarrollo** | Diagnóstico de arquitectura (`docs/personal-diagnostico.md`) — **listo**, sin código |
| **Sin comenzar** | Las 8 fases del MVP: empleados, horarios, reloj checador, asistencias, incidencias, prenómina, Finanzas, dashboard |
| **Solo hardware** | — (la cámara se prueba en navegador; no necesita Obispado) |

**Siguiente paso ejecutable**, en este orden:

1. Para llevar sin internet. Es el único punto de Obispado sin empezar, y el
   único caso donde el problema de folios de la hoja de ruta SÍ aplica: usa la
   secuencia global `XAB-NNNN`, no el folio derivado del UUID.
2. Personal fase 1 (activación del módulo + empleados + aislamiento), en rama
   aparte `personal/mvp`, según `docs/personal-diagnostico.md`.

## Lo que se cerró esta madrugada

### Los botones "Entrar" y "Abrir mesa" NO tienen ningún defecto

Era la pregunta abierta y ya tiene respuesta. Conducidos con **Puppeteer** y
esperas correctas, "Entrar" funciona **10 de 10** veces en contextos limpios y
"Abrir mesa" abre la mesa siempre.

Lo que fallaba era **cómo los pulsaba yo** con la extensión del navegador: esa
pantalla se repinta entera tras cada cambio, así que una referencia capturada
antes del repintado ya no está en el documento y el clic se pierde **en
silencio**. No hay nada que arreglar en el producto; hay que pulsar esperando.
Queda fijado en `fase-obispado-ui-estaciones` A1.

### Un defecto REAL que sí encontré, y era mío

`/api/auth/me` del Edge contestaba 200 también a un mesero. `mesas.html` decide
con esa respuesta (línea 730): si es 200, da por hecho sesión de panel, deja
`SESION_MESERO` en false y **le pinta "Registrar pago" y "Cerrar cuenta" a un
mesero**. El servidor los rechazaba igual (403), pero ofrecer lo que no le toca
es justo lo que el panel evita con `puedeCobrar()`.

Corregido: para rol `mesero` contesta 401, que lo manda al camino de estación
—el suyo, y el mismo que usa la nube—. Sin esto, la prueba D3 ("al mesero no se
le ofrece cobrar") era un **falso positivo**.

### Permisos alineados en las dos puntas (turno anterior, confirmado aquí)

Nube: `/pagos` y `/cerrar` pasan por `requireOperacionRestaurante` + `soloCaja`.
`fase-estacion-meseros` 26/26, y 23-24 **fallan** sin el cambio.

## Estado de las pruebas

`test/fase-obispado-ui-estaciones.mjs` — **11 de 13**, con tres contextos de
navegador aislados (caja + dos meseros) contra el mismo Edge:

| | |
|---|---|
| A1 | "Entrar" 10/10 |
| A2 | PIN equivocado no entra y lo dice |
| B1-B3 | Tres sesiones simultáneas, tres tokens distintos, cada una con su identidad |
| C1-C2 | Dos meseros abren mesas distintas a la vez, por la interfaz |
| D1 | Captura con modificadores; el precio lo resuelve el servidor |
| D2 | Comanda enviada |
| D3 | Al mesero NO se le ofrece cobrar (real, tras el arreglo) |
| D4 | Y si lo intentara, 403 |
| **D5** | **FALLA** — ver abajo |
| **D6** | **FALLA** — depende de D5 |

## D5 — RESUELTO (`271e3e8`)

No era el contrato servidor-interfaz. Volcar el estado real de la página lo
dijo en una línea: `cu-secundarias` **sí** contenía "Registrar pago" y "Cerrar
cuenta". A 800×600 —el viewport por defecto de Puppeteer— la pantalla de mesas
colapsa el panel de la cuenta detrás de un botón "Ver cuenta", así que los
botones quedaban en el DOM pero fuera de la vista, y yo esperaba por **texto
visible**. La caja de Obispado es una PC de escritorio: la prueba no modelaba
la estación real.

Detrás había un segundo bloqueo: cerrar cuenta pide confirmación con un diálogo
nativo, que sin atender deja la página congelada.

Y el mismo volcado sacó **cuatro 404 por pantalla**: el Edge no servía
`public/` (favicon e iconos de marca). Corregido; ahora resuelve contra
`panel/`, `public/` y `public/brand/`. Verificado: cero peticiones fallidas.

De paso, **D3 era un falso positivo**: miraba texto visible. Ahora comprueba
que el mesero no tenga en el DOM `abrirPago`, `cerrarCuenta` ni captura libre.

<details><summary>Diagnóstico original (histórico)</summary>


**Síntoma:** en el contexto de la caja, tras entrar con PIN 3333, ir a
`/restaurante`, pulsar "Todas" y abrir la Mesa 1, la pantalla **no llega a
mostrar "Registrar pago"** en 15 s.

**Lo ya descartado:**

- El servidor está bien. Con la cookie de sesión, `/api/auth/me` devuelve 200
  con `rol: "cajero"` y `modulos: ["restaurante","pos","menu"]`, y
  `/api/restaurante/meseros` devuelve `sesionMesero: false`. Comprobado
  directamente.
- Por tanto `puedeCobrar()` (`= !SESION_MESERO`, mesas.html:318) debería ser
  verdadero para la caja.

**Lo siguiente que hay que mirar**, en este orden:

1. Volcar `document.body.innerText` y el valor de `SESION_MESERO`/`CUENTA` en
   el contexto de la caja justo después de pulsar la Mesa 1. Es lo que no
   alcancé a hacer.
2. Comprobar si la vista de detalle llega a abrirse: puede que el clic sobre la
   mesa en la pestaña "Todas" no seleccione la cuenta, y entonces
   `cu-secundarias` ni se pinta.
3. Si la vista abre y aun así no hay botón, seguir `arrancarOperacion()`: puede
   estar fallando alguna llamada que el Edge todavía no sirve.

</details>

## Lo que sigue sin hacerse (Frente A)

- **Para llevar sin internet.** No empezado. Es el único caso donde el problema
  de folios de la hoja de ruta SÍ aplica: usa la secuencia global `XAB-NNNN`,
  no el folio derivado del UUID. Necesita identificador local y reconciliación
  propia.
- ~~Reintentos cuando el WebSocket sigue vivo y la nube falla.~~ **HECHO**
  (`bc64cb4`): al agotarse los intentos rápidos con cola pendiente y enlace
  vivo se programa uno nuevo con espera creciente, 30 s → 5 min. No se
  reprograma sin conexión ni ante un conflicto.
- ~~Informes de reconciliación persistidos y su pantalla.~~ **HECHO**
  (`798f15a`): migración 072, `panel/reconciliacion.html`, y R1-R6 en
  `fase-sala-sincronizacion`.
- ~~Barrido de archivos servidos por el Edge.~~ **HECHO** (`271e3e8`): cero
  peticiones fallidas al cargar el panel local.

## Frente B (Personal)

**Diagnóstico listo, código sin empezar.** Ver `docs/personal-diagnostico.md`:
qué se reutiliza (`usuario_sucursales` ya resuelve el multi-sucursal), el
esquema propuesto, las migraciones 073-076 y las 8 fases.

Dos hallazgos de ese diagnóstico que condicionan el diseño:

- **El almacenamiento privado YA EXISTE y se reutiliza**: `almacenamiento.js`
  (`guardarArchivo`/`leerArchivo`/`eliminarArchivo`, drivers local y S3, sin
  URL pública permanente), `imagenes.js` para validar y comprimir, y el patrón
  de acceso autenticado de `comprasRutas.js:130`. Las evidencias guardan
  `storage_key` y metadatos, nunca bytes ni credenciales.
  *(Corrección: antes afirmé que no existía. Lo deduje de una búsqueda
  truncada — `limit: 10` — que dejó fuera `almacenamiento.js`.)*
- **`getUserMedia` exige contexto seguro**, así que el panel servido por el
  Edge en `http://192.168.x.x` no puede pedir la cámara. La asistencia offline
  queda fuera de alcance **por decisión del encargo**, no por imposibilidad:
  de esa limitación concreta no se sigue que sea técnicamente imposible.

## Cómo repetir lo de esta madrugada

```bash
node test/fase-obispado-ui-estaciones.mjs     # navegador, 3 contextos
node test/fase-obispado-recorrido-completo.mjs # el día entero, por HTTP
node test/fase-estacion-meseros.mjs            # permisos en la nube
```

Y para mirarlo a mano:

```bash
node scripts/edge-local-demo.mjs 7071
```
PINs: Mesero Uno `1111` · Caja Principal `3333` · Para Llevar `4444`.
