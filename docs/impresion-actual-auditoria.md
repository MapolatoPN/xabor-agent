# Impresión en Xabor — auditoría del estado actual

Hecha sobre `cf7ac6a` (el commit que producción sirve el 9 de agosto de 2026),
antes de escribir una sola línea de Xabor Edge. El objetivo era no volver a
construir nada que ya existiera.

**Resumen en una frase**: Xabor ya sabe imprimir *una* comanda en *una*
impresora Windows por sucursal; lo que no existe es el concepto de **varias
impresoras con reglas de destino**, ni **persistencia del trabajo** (hoy si
nadie escucha, el papel se pierde y nadie se entera).

## Lo que YA existe y se reutiliza

### `src/printing/printRouter.js` (170 líneas)

Único punto de decisión de impresión de todo el backend. Ningún canal
(WhatsApp, voz, Rappi, POS, Restaurante) decide por su cuenta.

- `emitirTrabajoImpresion(pedido)` elige entre modo `legacy` (broadcast a las
  conexiones WebSocket sin autenticar) y modo `autenticado` (broadcast a
  print-agents de un negocio + sucursal concretos).
- **Nunca lanza.** Devuelve `{modo:'omitido', razon}` si algo falta. El
  contrato es explícito: *un fallo de impresión no puede tumbar el pedido*.
  Eso es exactamente el principio que Edge tiene que preservar.
- `construirPrintJobId(pedido)` → `` `${pedido.id}:comanda` ``. Determinista a
  propósito, sin `Date.now()` ni `randomUUID()`: el mismo pedido produce
  siempre el mismo id. El comentario del archivo dice que existe "para la
  deduplicación local que hará el print-agent reescrito" — es decir, esta fase
  estaba prevista.
- Los broadcasts se **inyectan** desde `server.js` (`setBroadcastsImpresion`)
  para evitar un ciclo de imports, y hay una vía de inyección solo para
  pruebas.

### Canal autenticado Cloud → agente local

Ya existe entero, y es sólido:

| Pieza | Dónde | Qué hace |
|---|---|---|
| `terminales` | migración 003 | `id`, `sucursal_id`, `nombre`, `codigo`, `activo` |
| credenciales | migración 010 | `token_hash`, `tipo`, `ultima_conexion` + índice único parcial sobre `token_hash` |
| `/ws/print-agent` | `server.js` | ruta WS dedicada, distinta de la del panel |
| `autenticar_terminal` | `server.js` | primer y único mensaje aceptado; `{terminalId, token}` |
| verificación | `server.js` | SHA-256 + `timingSafeEqual`; el token nunca se loguea, ni se guarda en `ws`, ni se devuelve |
| `broadcastPrintAgentNegocio` | `server.js` | envía **solo** a `ws.tipo==='print-agent'` autenticadas con negocio **y** sucursal exactos; fail closed |

Lo importante: **el cliente declara únicamente `terminalId` + token**. El
`negocioId` y el `sucursalId` se derivan en el servidor con un JOIN
`terminales → sucursales → negocios`, comprobando los tres `activo`. Un
cliente hostil no puede afirmar pertenecer a otro negocio. Esa propiedad es la
base del aislamiento multi-tenant de Edge y no hay que rehacerla.

También hay un timeout de autenticación y una política de "un solo mensaje por
conexión" (hoy no se aceptan mensajes posteriores — eso es justo lo que hay
que ampliar para los ACK).

### `print-agent.js` (637 líneas) + `installer/windows/*.ps1`

Un agente local **ya funcional**, que resuelve más de lo que parecía:

- **ESC/POS real**: `INIT`, densidad de calor, alineaciones, negritas, doble
  alto, corte (`GS V A`), y utilidades de texto (`linea`, `columnas`, `wrap`).
- **Impresión física en Windows**: escribe un `.bin` y lo manda RAW por Win32
  vía PowerShell, con *fallback* a `Out-Printer`.
- **Deduplicación persistente por `printJobId`**: archivo JSON con escritura
  atómica (temporal + `rename`), ventana de 7 días, tope de 1000 trabajos,
  respaldo si se corrompe. Estados `procesando` / `impreso` / `fallido`.
- **Instaladores de Windows**: instalar, iniciar, detener, verificar,
  desinstalar.
- Inyección de la impresión física para pruebas, mismo patrón que printRouter.

El comentario de su deduplicación deja escrita una advertencia que ahora nos
toca de lleno:

> Esta estrategia (iniciar vacío tras corrupción) depende de que el servidor
> NUNCA reenvíe trabajos ya emitidos […]. Si en el futuro el servidor
> implementara algún reenvío o cola de trabajos pendientes, esta estrategia
> dejaría de ser segura.

Edge V1 **sí** introduce reenvío y cola. Por eso Edge no hereda ese archivo
JSON: usa un almacén propio donde el estado del trabajo es un registro, no un
recuerdo que se pueda tirar.

### Restaurante ya produce el snapshot que la comanda necesita

`restauranteService.enviarComanda(cuentaId, negocioId, usuarioId)` devuelve
exactamente lo que hay que imprimir, y solo eso:

```js
{ comanda: numComanda, tipo: 'inicial'|'adicional',
  mesa, personas, mesero,
  items: [ { id, producto, cantidad, precio_unitario, modificadores, notas } ] }
```

Los items son **solo los de esta ronda** (`estado='pendiente'` → `'enviado'`,
numerados con `comanda_num`), dentro de una transacción con `FOR UPDATE`. Un
doble clic no genera una segunda comanda: el segundo llamador no encuentra
pendientes y recibe `SIN_ITEMS_PENDIENTES`. La ronda 2 nunca reimprime la 1.

Ya se emiten tres documentos distintos, todos vía `emitirTrabajoImpresion`:
comanda de cocina, comanda de **cancelación** de un item ya enviado, y
**cuenta final** al cerrar (una sola vez: un reintento responde `yaCerrada` y
no reimprime).

## Lo que NO existe

| Concepto | Estado | Consecuencia hoy |
|---|---|---|
| Impresoras como entidad | **no existe** | un agente = una impresora, por `XABOR_PRINTER_NAME` |
| Routing por categoría/producto | **no existe** | todo va al mismo papel |
| Un item a varios destinos | **no existe** | imposible "chilaquiles → su estación *y* cocina general" |
| Persistencia del trabajo | **no existe** | `broadcast` con 0 destinatarios se registra en el log y se pierde |
| Reintentos / backoff | **no existe** | impresora apagada = comanda perdida |
| ACK del agente | **no existe** | la nube no sabe si se imprimió |
| Reimpresión | **no existe** | solo un botón manual de "última cuenta" en el panel |
| Estado / observabilidad | **no existe** | no hay forma de ver pendientes ni último error |
| Transporte TCP (RAW 9100) | **no existe** | solo spooler de Windows por nombre |
| Ancho 58 mm | **no existe** | `ANCHO_PAPEL` por env, 42 columnas por defecto |
| Simulador de impresora | **no existe** | no se puede probar sin hardware |

Búsquedas que dieron **cero**: `window.print` en `src/`, `escpos` como
dependencia, `spool` fuera de los `.ps1`, `net.connect` hacia una impresora, y
el puerto `9100` en cualquier parte. Es decir: **hoy la nube no abre ningún
socket hacia la LAN**, y eso hay que conservarlo.

Los `80mm` que aparecen son `@page { size: 80mm auto }` en el CSS del panel:
son la impresión desde el navegador con `Ctrl+P`, no tienen relación con el
agente.

## Decisiones que salen de esta auditoría

1. **Edge no es una entidad nueva: es una `terminal`.** Reutilizamos
   `terminales` + `token_hash` + `/ws/print-agent` en vez de crear
   `edge_devices`. Crear una segunda identidad significaría dos caminos de
   autenticación y dos fuentes de verdad sobre "quién puede imprimir para este
   negocio" — exactamente la clase de duplicación que ya causó incidentes de
   aislamiento en este proyecto. `terminales.tipo` es TEXT abierto justamente
   para admitir tipos nuevos sin migración.
2. **Las impresoras cuelgan de la terminal**, no del negocio a secas: una
   impresora la alcanza el Edge que está en su misma red.
3. **El trabajo de impresión pasa a ser una fila en la base**, no un mensaje
   que se emite y se olvida. Es lo que habilita reintento, ACK, reimpresión y
   estado.
4. **`host` y `puerto` son datos, nunca destino de una conexión desde la
   nube.** Solo el Edge los usa.
5. **Se conserva el contrato C8**: si la impresión falla, la comanda ya está
   guardada y la respuesta al mesero es un éxito. Se añade un aviso, no un
   error.
6. **El agente legacy no se toca.** `print-agent.js` sigue existiendo y
   funcionando para quien lo use; Edge vive en `edge/` y se conecta por el
   mismo WS con el mismo tipo de credencial. Migrar de uno a otro es cambiar
   qué proceso se ejecuta, no cambiar el servidor.
