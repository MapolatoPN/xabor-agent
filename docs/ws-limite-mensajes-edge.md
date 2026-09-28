# Límite de los mensajes WebSocket del Edge (`MAX_PAYLOAD_WS` = 64 KiB)

`src/server.js` acepta mensajes entrantes de **como mucho 65,536 bytes** en
`/ws/panel`, `/ws/superadmin` y `/ws/print-agent`. Sin ese límite, `ws` junta en
memoria frames de hasta 100 MiB antes de que nadie se autentique. Este documento
dice qué cabe, qué no cabe y qué hacer antes de ampliar el protocolo del Edge.
`scripts/check-websocket-lista-cerrada.mjs` (sección 7) falla si el Edge empieza
a mandar un mensaje que no está medido aquí.

## El protocolo publicado sí cabe

Es el Edge de esta rama (`edge/connection.js`). Manda cuatro mensajes:

| Mensaje | Tamaño |
|---|---|
| `autenticar_terminal` | < 4 KiB (se sigue exigiendo aparte) |
| `latido` | 17 bytes |
| `ack_impresion` | unos cientos de bytes |
| `impresoras_detectadas` | 4,413 bytes con nombres normales; 13,173 con 50 nombres ASCII de 200 caracteres; **63,173 en el peor caso** (200 caracteres que JSON escapa a 6 bytes) |

El Edge sanea la lista de impresoras a 50 nombres de hasta 200 caracteres
(`sanitizarImpresoras`), así que 63,173 bytes es un tope por construcción.
`test/fase-print-agent-payload.mjs` (P6) lo manda contra el servidor real.

## Los lotes offline NO caben

Las ramas `offline/sala-v1` (93fff6a) e `integracion/obispado-personal`
(89055d6) añaden `sala_lote`, `llevar_lote` y `solicitar_catalogo`. Cada lote
viaja entero en un solo mensaje: `ws.send(JSON.stringify({ tipo, loteId, lote }))`.

- **Sala:** hasta 500 eventos, más el estado completo de cada cuenta tocada.
- **Mostrador:** todo lo pendiente, sin tope.

Medido el 27-sep-2026 con los módulos de las dos ramas (resultados idénticos),
con datos al estilo de Obispado. Los productos y modificadores se escriben
«Grupo: Opción», igual que `servidorLocal.js`.

| Lote | Eventos | Bytes | ¿Cabe en 64 KiB? |
|---|---|---|---|
| Sala, 1 mesa (abrir, 4 renglones, comanda, pago, cierre) | 5 | 5,689 | sí |
| Sala, 100 mesas (tope de `exportarLote`) | 500 | 557,371 | no (8.5×) |
| Mostrador, 1 pedido (captura, cobro, comanda, entrega) | 4 | 5,314 | sí |
| Mostrador, 125 pedidos | 500 | 626,666 | no (9.6×) |
| Mostrador, 250 pedidos (sin tope: sale entero) | 1,000 | 1,253,173 | no (19.1×) |
| Sala, UNA captura legal de ~0.9 MB | 2 | 2,505,752 | no (38×) |

- **Umbral:** el lote de sala deja de caber con **12 mesas** pendientes (60
  eventos) y el de mostrador con **14 pedidos** (56 eventos). Eso se junta en un
  corte de internet corto a la hora de la comida.
- **Peor caso admitido por los validadores:** no tiene cota útil.
  - Ni `operacionLocal.js`, ni `capturaLocal.js`, ni la ingesta de la nube
    (`sincronizacionSala.js`, `sincronizacionLlevar.js`) acotan el largo de
    producto, notas o modificadores, ni cuántos renglones lleva una captura.
  - La única cota es el cuerpo HTTP del servidor local del Edge: 1,000,000
    bytes por petición.
  - 500 eventos así serían cientos de MB.

## Qué haría 64 KiB con un Edge offline instalado

Hoy ni este servidor ni producción (`41c003b`) atienden esos mensajes. Se
registran como `[Edge] mensaje no reconocido …`; el Edge espera 30 s la
respuesta del lote y reintenta.

Con el límite, el primer lote de más de 64 KiB se corta con 1009 y entra en un
ciclo:

1. el Edge se reconecta y se vuelve a autenticar, y se le reentregan los
   trabajos sin confirmar;
2. `alAutenticar` vuelve a disparar la sincronización;
3. otra vez 1009.

Eso se repite cada pocos segundos mientras haya 12 mesas o 14 pedidos
pendientes. Se sigue imprimiendo entre ciclo y ciclo, pero con cortes,
reentregas y ruido en los logs. Con el Edge simple (el de esta rama) no cambia
nada.

## ¿Qué Edge está instalado en Obispado?

**No se puede demostrar localmente:**

- el instalador (`installer/XaborEdge.iss`) no guarda el commit, solo un
  `AppVersion` manual (`1.0.0`);
- en esta máquina no hay ningún `XaborEdgeSetup*.exe` compilado ni un Edge
  instalado;
- el vault (18-sep) dice que la operación sin internet de Obispado está «solo
  diseñada», pero es documentación, no prueba del binario;
- la lectura de logs de producción del 27-sep solo contó otros patrones.

Cómo confirmarlo después, en solo lectura y con autorización:

1. **Logs del servicio de producción.** El Edge offline manda
   `solicitar_catalogo` justo después de CADA autenticación
   (`alAutenticar` → `pedirCatalogo`), y producción lo registra así:

   ```
   \[Edge\] mensaje no reconocido de terminal=[0-9a-f-]{36} tipo=(solicitar_catalogo|sala_lote|llevar_lote)
   ```

   Hay que contarlo junto a `\[PrintAgent\] Terminal autenticada — terminal=<T>`
   para la terminal de Obispado, en la misma ventana. Hay N autenticaciones y
   cero `solicitar_catalogo` ⇒ Edge simple. Si aparece ⇒ Edge offline: no
   desplegar el límite hasta fragmentar los lotes.
2. **En la PC del local:** `Test-Path 'C:\Program Files\Xabor\Edge\app\edge\sala\operacionLocal.js'`.
   `True` ⇒ Edge offline.

## Opciones

| | Memoria del servidor | ¿Resuelve los lotes? | Costo |
|---|---|---|---|
| **A. 64 KiB y fragmentar en el Edge** | Sin cambio: 64 KiB por conexión, también antes de autenticar | Sí, si además se acota un evento individual | Cambios en las ramas offline antes de integrarlas |
| **B. Subir el límite global** | Cada conexión, incluidas las anónimas de `/ws/print-agent` antes de autenticar, puede hacer que el servidor junte hasta el límite. Con 1 MiB, 500 conexiones son 500 MiB | No: el mostrador no tiene tope y una sola captura ya mide 2.5 MB | Bajo en código, alto en riesgo |
| **C. Canal aparte para la sincronización** | Solo conexiones ya autenticadas llegan al límite mayor | Sí, con su propio límite | Protocolo nuevo |

Para C hay dos formas:
- un WebSocket propio que autentique la terminal EN el upgrade, con su propio
  `WebSocketServer` y su propio `maxPayload`;
- o un `POST` por lote con token de terminal y `express.json({ limit })`. La
  sincronización ya es petición y respuesta.

## Recomendación

**A**, como condición para integrar offline:
- el Edge parte lo pendiente en lotes de como mucho ~48 KiB serializados;
  cada lote lleva solo las cuentas o pedidos de sus eventos;
- los validadores acotan un evento individual (largo de notas y de nombres,
  renglones por captura), para que cualquier evento con su estado quepa.

La ingesta ya es idempotente por UUID y confirma evento por evento
(`eventosConfirmados`), así que fragmentar no cambia su contrato. El límite
global se queda en 64 KiB. Si algún mensaje futuro no se puede acotar, **C**
con su propio límite; nunca subir el global.

**Implementado hoy**, solo para el protocolo publicado:
- el límite de 64 KiB (`acdd35a`);
- la sección 7 de la barrera, que amarra el límite a los cuatro mensajes
  medidos.
