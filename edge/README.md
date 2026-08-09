# Xabor Edge

El proceso que corre en la PC del restaurante e imprime las comandas en las
impresoras de su red local.

No abre ningún puerto: **él** llama a Xabor, nunca al revés. No hace falta IP
pública ni tocar el router.

## Requisitos

- **Node 18 o superior.** Con **22.5 o superior** usa el SQLite integrado en
  Node; con menos, un archivo JSON con escritura atómica. Los dos funcionan y
  **ninguno compila nada**: no hay dependencias nativas.
- Ver las impresoras desde esa PC (misma red).
- Un código de emparejamiento generado en el panel de Xabor.

## Puesta en marcha

### 1. Configurar

Crear `edge/.env` (o exportar las variables de entorno):

```
XABOR_EDGE_WS_URL=wss://xabor.mx/ws/print-agent
XABOR_TERMINAL_ID=<lo entrega el emparejamiento>
XABOR_TERMINAL_TOKEN=<lo entrega el emparejamiento, una sola vez>
```

El token se muestra **una vez**. Si se pierde, se genera otro código de
emparejamiento en el panel; no hay forma de recuperarlo.

### 2. Arrancar

```bash
node edge/index.js
```

Al arrancar debe verse:

```
… [INFO] almacen.abierto tipo=sqlite ruta=…
… [INFO] edge.listo almacen=sqlite pendientes=0
… [INFO] conexion.autenticada terminalId=… negocioId=… sucursalId=…
```

Si falta configuración no arranca a medias: dice exactamente qué falta.

## Probarlo en local, sin impresoras

Se puede ejercitar todo el camino sin hardware y sin la nube.

### Impresora simulada

```bash
node -e "import('./test/simulador-impresora.mjs').then(async m => { const p = m.crearImpresoraSimulada({nombre:'COCINA'}); console.log('escuchando en', await p.encender()); })"
```

Escribe el puerto que le asignó el sistema. Ese puerto se configura en la
impresora del panel con transporte `tcp_raw` y host `127.0.0.1`.

### Las pruebas

```bash
node test/fase-print-routing.mjs
```

```bash
node test/fase-edge-queue.mjs
```

```bash
node test/fase-edge-tcp.mjs
```

Las tres corren sin Postgres, sin internet y sin impresoras: reparto y formato
del papel, cola con reintentos y reinicio, y sockets reales contra el
simulador. `fase-print-jobs.mjs` y `fase-edge-e2e.mjs` sí necesitan Postgres.

## Configuración completa

| Variable | Por defecto | Para qué |
|---|---|---|
| `XABOR_EDGE_WS_URL` | — | **Obligatoria.** WebSocket de Xabor |
| `XABOR_TERMINAL_ID` | — | **Obligatoria.** Identidad del Edge |
| `XABOR_TERMINAL_TOKEN` | — | **Obligatoria.** Su credencial |
| `XABOR_EDGE_ALMACEN` | `auto` | `auto`, `sqlite` o `json` |
| `XABOR_EDGE_DATOS` | `edge/datos` | Dónde vive la cola local |
| `XABOR_EDGE_REINTENTO_MS` | `3000` | Primera espera tras un fallo |
| `XABOR_EDGE_REINTENTO_MAX_MS` | `300000` | Tope de la espera (5 min) |
| `XABOR_EDGE_MAX_INTENTOS` | `8` | Tras esto el trabajo queda `agotado` |
| `XABOR_EDGE_TIMEOUT_IMPRESORA_MS` | `10000` | Paciencia con una impresora muda |
| `XABOR_EDGE_LOG` | `info` | `debug`, `info`, `warn`, `error` |

## Estructura

```
edge/
  index.js          arranque y cableado
  config.js         configuración y backoff
  connection.js     WebSocket saliente hacia Xabor
  worker.js         procesa la cola, reintenta, decide
  logger.js         log estructurado sin secretos
  storage/          cola local (sqlite | json)
  transports/       mock | tcp_raw | (windows_spooler pendiente)
  renderers/        comanda | cuenta | cancelación | prueba
```

## Cosas que conviene saber

- **La cola sobrevive a todo.** Si se corta la luz a media comanda, al volver
  el Edge retoma lo que quedó. Nunca da por impreso lo que no confirmó.
- **Una impresora caída no detiene a las demás.** Cada destino es un trabajo
  independiente.
- **Un corte a media transmisión queda como `incierto` y no se reintenta.**
  Podría sacar el mismo platillo dos veces en cocina; lo revisa una persona.
- **No ejecutar dos Edges con la misma credencial.** El servidor cierra la
  conexión anterior justo para evitar comandas duplicadas, pero lo correcto es
  tener un solo proceso.
- **El token nunca aparece en los logs**, ni el contenido de las comandas.

## Instalar como servicio de Windows

Todavía no automatizado. `installer/windows/*.ps1` cubre el agente anterior
(`print-agent.js`) y sirve de referencia. Se documentará tras la visita a
Obispado, cuando se conozca la PC real. Mientras tanto, arrancarlo a mano o
con una tarea programada al iniciar sesión.
