# Obispado — bitácora de la madrugada (2026-09-10)

Punto exacto de continuación. Rama `offline/sala-v1`, **sin desplegar**.

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

## Punto exacto de continuación: D5

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

## Lo que sigue sin hacerse (Frente A)

- **Para llevar sin internet.** No empezado. Es el único caso donde el problema
  de folios de la hoja de ruta SÍ aplica: usa la secuencia global `XAB-NNNN`,
  no el folio derivado del UUID. Necesita identificador local y reconciliación
  propia.
- **Reintentos cuando el WebSocket sigue vivo y la nube falla.** Hoy el bucle
  hace 4 intentos y solo vuelve a arrancar al reconectar. Hueco real.
- **Informes de reconciliación persistidos y su pantalla.** Solo existe el
  evento `sala_sincronizada` por WebSocket, que no sobrevive a una recarga.
- **Barrido completo de archivos servidos por el Edge** sin la nube.

## Frente B (Personal)

**No iniciado.** No se tocó nada. El diagnóstico de arquitectura que pide el
encargo está pendiente por completo; se prefirió cerrar hallazgos de Obispado
antes que abrir un frente nuevo a medias.

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
