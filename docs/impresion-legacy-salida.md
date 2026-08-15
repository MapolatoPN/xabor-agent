# La salida del camino de impresión legado

## Qué es "legacy" aquí

El print-agent **anterior** a la ruta autenticada. Se conecta a la raíz `/` del
WebSocket y no manda ninguna identidad: ni credencial, ni cabecera, ni query.
Está instalado en la computadora del negocio y no se puede actualizar desde la
plataforma.

## Auditoría: ¿se puede retirar `/` hoy?

**No.** La evidencia, toda del repositorio y de la configuración — nada de
producción:

| Hecho | Dónde se comprueba |
|---|---|
| El agente actual **fuerza** `/ws/print-agent` | `construirUrlAutenticada` en `print-agent.js` le añade la ruta aunque se configure el origen pelado |
| El agente **anterior** se conectaba al origen pelado, es decir a `/` | `git show 3520e60^:print-agent.js` → `WS_URL = 'wss://…railway.app'`, sin ruta |
| Ese agente **imprime todo lo que le llega**, sin deduplicar | mismo archivo: `if (msg.tipo === 'nuevo_pedido') imprimirComanda(msg.pedido)` |
| Un solo negocio está en modo legado, y por semilla | `initDB()` inserta `print_agent_legacy_activo='true'` **solo** para el slug `nonna-maye`, y lo resiembra en cada arranque |
| Los demás negocios ni siquiera pueden imprimir por ahí | sin esa fila, `resolverModoImpresion` devuelve `configuracion_ausente` y `emitirTrabajoImpresion` omite (fail closed) |
| Está declarado como pendiente, no como resuelto | `installer/windows/README.md`: "Nonna Maye permanece en modo legacy hasta que se autorice explícitamente el cambio" |

Conclusión: retirar `/` hoy dejaría a ese negocio **sin imprimir**. La salida
segura no es apagar la ruta, es quitarle todo lo peligroso y dejar que se apague
sola.

## Qué se corrigió

Antes, al conectarse un agente legado, el servidor le mandaba
`obtenerTodosPedidosParaWebSocketLegacy()`: el tablero completo de **todos los
negocios**, sin `printJobId` y sin pasar por ningún registro. Tres consecuencias
reales: la impresora de un negocio imprimía pedidos de otro; cada reconexión
reimprimía todo lo activo; y nada de eso podía deduplicarse.

Ahora:

1. **La conexión pertenece a un negocio.** El servidor lo resuelve en el
   *upgrade*: el único negocio con `print_agent_legacy_activo`. Cero candidatos
   o más de uno ⇒ upgrade rechazado con 403. La plataforma no adivina a quién le
   toca una comanda.
2. **La ruta se cierra sola.** El día que ese negocio migre a Edge y se apague su
   bandera, `/` deja de aceptar conexiones sin tocar una línea de código.
3. **Al reconectar recibe solo sus pendientes**, nunca el tablero. Cada mensaje
   lleva `printJobId` determinista (`<folio>:comanda`).
4. **`destinatarios = 0` ya no significa "impreso".** Si no había agente
   conectado, el trabajo queda `pendiente` (migración 053) y se entrega cuando el
   agente aparece. Antes se registraba igual y se perdía en silencio.
5. **Una entrega, una sola vez.** Los pendientes se reclaman con un `UPDATE`
   condicional: por muchas veces que se reconecte, un trabajo entregado no vuelve
   a salir. Si el envío falla en el último momento, vuelve a la cola.
6. **El volcado global ya no existe.** `obtenerTodosPedidosParaWebSocketLegacy`
   se eliminó del código, no se dejó "sin llamar".

## Lo que sigue sin poder garantizarse

El agente viejo **no manda acuse de recibo**. "Entregado" significa *salió del
servidor hacia un agente conectado*, no *salió el papel*. Si el socket muere
entre el envío y la impresora, ese papel se pierde y el servidor no puede
saberlo. Cerrar esa brecha exige cambiar el binario, y eso es la migración.

## Plan de migración (retirar `/` de verdad)

Sin tocar producción desde aquí. Requiere visita al sitio:

1. Instalar el agente actual en la terminal del negocio
   (`installer/windows/`), que habla `/ws/print-agent`.
2. Dar de alta la terminal en el panel y emparejarla (código de un solo uso).
3. Configurar sus impresoras y rutas.
4. Verificar con una comanda real.
5. Apagar `print_agent_legacy_activo` para ese negocio.
6. A partir de ese momento `/` rechaza toda conexión por sí misma. El código de
   la ruta se puede borrar en una limpieza posterior, ya sin urgencia.

Mientras tanto, `/` existe pero acotado: un negocio, sus pendientes, con
`printJobId`, sin volcados y sin repeticiones.

## Verificación

`test/fase-impresion-legacy-aislada.mjs` (8 casos):

| Caso | Qué fija |
|---|---|
| 1 | El agente de A jamás recibe un pedido de B; el suyo llega una vez, con `printJobId` |
| 2 | Un pedido ya entregado no se reenvía al reconectar |
| 3 | Un pedido creado sin agente conectado queda `pendiente` y llega al reconectar |
| 4 | Seis conexiones seguidas ⇒ una sola entrega |
| 5 | Con Edge activo en B, el agente legado de A no ve nada de B y B ni toca la tabla legado |
| 6a | Dos negocios en modo legado ⇒ upgrade rechazado (403) |
| 6b | Ningún negocio en modo legado ⇒ la ruta se cierra sola (403) |
| 6c | El volcado global ya no existe en el código, y el comentario "MULTIEMPRESA INSEGURO" desapareció porque desapareció la causa |
