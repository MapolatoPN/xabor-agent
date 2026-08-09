# Xabor Edge — arquitectura

Xabor Edge es lo que permite que Xabor imprima en las impresoras de un
restaurante sin que Xabor pueda alcanzarlas. Es la pieza que faltaba para
sustituir a un POS como Wansoft: no "mandar a imprimir", sino **repartir cada
comanda entre varias estaciones y responder de que salió**.

## El problema

Las impresoras térmicas de un restaurante viven en `192.168.x.x`. Railway no
puede abrir un socket contra esa dirección, y no debería poder: si pudiera,
cualquiera que consiguiera escribir en la configuración de un negocio tendría
un escáner de puertos dentro de una red ajena.

La solución es un proceso que corre **dentro** del local y llama hacia afuera.

```
   XABOR CLOUD (Railway)
            │
            │  el Edge inicia la conexión, siempre saliente
            ▼
   XABOR EDGE (PC del restaurante)
            │
            │  red local
            ▼
   TICKETS   CHILAQUILES   COCINA GENERAL   BEBIDAS
```

La PC del restaurante **no abre ningún puerto**. No hace falta IP pública, ni
tocar el router, ni pedirle nada a su proveedor de internet.

## Reparto: qué se imprime dónde

El caso que define el diseño es real, de Mapolato Obispado:

> Los chilaquiles se preparan en su propia estación, **y además** cocina
> general necesita verlos para armar el plato completo.

Un item, dos destinos. Eso descarta cualquier modelo de "un producto → una
impresora".

Las reglas viven en `impresion_rutas` y tienen tres ámbitos:

| Ámbito | Clave | Ejemplo |
|---|---|---|
| `categoria` | nombre de la categoría | Bebidas → BEBIDAS |
| `producto` | nombre del producto | Chilaquiles → CHILAQUILES |
| `documento` | `cuenta`, `comanda`, `cancelacion` | cuenta → TICKETS |

### Precedencia

Para cada item:

1. Se toman los destinos de su **categoría**.
2. Se miran las reglas de su **producto**:
   - `modo = 'agregar'` → **suma** destinos. Es el caso de los chilaquiles.
   - `modo = 'exclusivo'` → **sustituye** los de la categoría. Es la excepción
     ("este plato NO va a la plancha, va a cocina general y punto").
3. Si el mismo producto tiene reglas de los dos modos, **manda `exclusivo`** y
   queda un aviso: la intención de excluir es más específica que la de añadir,
   y mezclarlas daría un resultado que nadie sabría explicar.
4. Dos reglas hacia la misma impresora producen **un** destino, no dos. Una
   configuración redundante no puede sacar dos papeles iguales.

La **cuenta** solo mira `ambito='documento'`. Nunca hereda reglas de
categoría, así que es imposible que termine saliendo en cocina.

### Un producto sin ruta

No es un error. La comanda **ya está guardada**; lo que falta es papel. El
item aparece en `sinRuta`, se devuelve como aviso, y los demás items se
imprimen igual.

## El trabajo de impresión

Cada destino produce una fila en `impresion_trabajos` con un **snapshot
congelado** de lo que hay que imprimir: mesa, mesero, ronda, productos,
modificadores y notas. Nunca se reconstruye consultando el menú actual — si
mañana sube el precio del bistec, la comanda de anoche sigue diciendo lo que
decía anoche.

### Estados

| Estado | Significado |
|---|---|
| `pendiente` | creado, ningún Edge lo ha recibido |
| `entregado` | enviado por WebSocket, sin confirmar |
| `impreso` | el Edge confirmó que los bytes salieron |
| `incierto` | los bytes salieron y se perdió la confirmación |
| `fallido` | error definido, con reintentos por delante |
| `agotado` | se acabaron los reintentos; **no se pierde**, se revisa |
| `cancelado` | lo canceló una persona |

### `incierto`: la parte honesta

Una impresora térmica **no confirma que salió papel**. Lo máximo que se puede
afirmar es que recibió los bytes y cerró la conexión ordenadamente.

Cuando el Edge escribe los bytes y la conexión se rompe antes de ese cierre
—se soltó el cable, se apagó a media transmisión— **no hay forma de saber si
imprimió**. Reintentar podría sacar el mismo platillo dos veces en cocina;
darlo por impreso podría perder una comanda. Se marca `incierto`, **no se
reintenta solo**, y aparece en el estado como algo que decide una persona.

Prometer *exactly-once* físico sería mentira. Lo que Xabor garantiza es
**at-least-once en el transporte + deduplicación lógica por id**, y un estado
explícito para el caso ambiguo.

## Idempotencia

Es la parte que más daño puede hacer, y ya hubo un incidente de folios en este
proyecto por confiar en un `ON CONFLICT DO NOTHING` que devolvía éxito sin
comprobar nada.

**En la nube**: cada trabajo lleva `idempotency_key`, con `UNIQUE`:

```
${negocioId}:${origenTipo}:${origenId}:${impresoraId}
```

Determinista: sin `Date.now()`, sin `randomUUID()`. Si el mismo request se
reintenta, la clave es idéntica, el `INSERT` choca, y el código **comprueba de
verdad** si insertó: si `RETURNING` viene vacío, busca la fila existente y
devuelve `duplicado: true`. Diez llamadas simultáneas de la misma ronda dejan
tres trabajos, no treinta (probado en `fase-print-jobs`, caso 18).

**En el Edge**: `registrarTrabajo()` devuelve `false` si el id ya estaba. La
nube puede reenviar un trabajo cuantas veces quiera; el papel sale una.

**Una conexión por terminal**: al autenticarse un Edge, el servidor cierra
cualquier otra conexión de esa misma terminal. Dos procesos con la misma
credencial recibirían los mismos trabajos y sacarían **cada comanda por
duplicado** — pasa de verdad cuando alguien deja el agente viejo abierto.

## Reintentos

Espera exponencial con jitter y tope. El jitter existe porque cuatro
impresoras que se cayeron a la vez (se fue la luz de cocina) no deben
reintentar todas en el mismo milisegundo al volver.

Tras `maxIntentos` el trabajo pasa a `agotado`: **deja de intentarse solo,
pero no se borra**. Aparece en el estado con su último error y se puede
reimprimir.

## Reimpresión

Reimprimir es una **intención nueva**: crea otro trabajo, con su propia clave
de idempotencia, que apunta al original con `trabajo_original_id`. El trabajo
viejo **no se resetea** — es la evidencia de que hubo un problema, y borrarla
sería perder la única pista de por qué. Queda registrado quién reimprimió,
cuándo y por qué; el papel sale marcado `*** REIMPRESION ***`.

## Aislamiento entre negocios

Es lo que se prueba con más insistencia, porque este proyecto ya tuvo un
incidente de comandas cruzadas entre restaurantes.

- El Edge declara **solo** `terminalId` + token. El `negocioId` y el
  `sucursalId` los deriva el servidor con `terminales → sucursales →
  negocios`, comprobando los tres `activo`.
- Los trabajos se entregan filtrando por `terminalId` de la **conexión**.
- El ACK actualiza con `WHERE id = $1 AND terminal_id = $2`, donde
  `terminal_id` sale de la conexión, no del mensaje. Un Edge que conozca el
  uuid de un trabajo ajeno no consigue nada (`fase-edge-e2e`, caso 10).
- Crear impresoras y rutas resuelve la pertenencia en el backend; el
  `negocioId` sale de la sesión y nunca del cuerpo del request.

## SSRF: por qué la nube nunca abre el socket

`host` y `puerto` son **datos de configuración**. El servidor los guarda, los
muestra y los manda al Edge, y jamás los usa para conectarse.

La garantía no es una promesa: `fase-print-jobs` (caso 43) y `fase-edge-tcp`
(caso 11) leen el código fuente de `server.js`, `impresionService.js`,
`routingEngine.js` y `edgeService.js` y fallan si aparece `net.connect`,
`node:net` o un import del transporte TCP. El único módulo que abre sockets
hacia la LAN es `edge/transports/tcpRaw.js`, y vive del lado del Edge.

## Credenciales

Cada Edge tiene la suya. **Nunca** `PANEL_SECRET`, ni la contraseña de un
usuario, ni el PIN de un mesero, ni un secreto compartido.

El alta es en dos pasos, para no dictar por teléfono un token de 64
caracteres:

1. El administrador genera un **código de emparejamiento** en el panel:
   `ABCD-2345`, sin caracteres que se confundan al dictarlos (`0/O`, `1/I/L`),
   válido 15 minutos y de un solo uso. En la base solo queda su SHA-256.
2. Alguien lo teclea en el Edge. El canje es atómico (`UPDATE ... RETURNING`
   sobre `usado_at IS NULL AND expira_at > NOW()`), entrega el token
   permanente **una sola vez** y guarda solo su hash.

Revocar es poner `token_hash = NULL`. La siguiente autenticación falla.

## Almacenamiento local

El Edge tiene dos almacenes que cumplen el mismo contrato:

- **SQLite** (`node:sqlite`, integrado en Node ≥ 22.5) con WAL y
  `synchronous = FULL`. Se eligió el SQLite del runtime y **no**
  `better-sqlite3` a propósito: es una extensión nativa que hay que compilar o
  bajar por versión y arquitectura, y en la PC de un restaurante —sin
  herramientas de compilación, con Node actualizándose solo— es exactamente el
  tipo de dependencia que rompe una instalación un viernes por la noche.
- **JSON con escritura atómica** (temporal + `rename`) como respaldo si el
  runtime no trae `node:sqlite`. Es el patrón que ya probó `print-agent.js`.

`auto` prefiere SQLite. Las pruebas corren contra los dos.

## Qué NO resuelve esta fase

**Xabor Edge V1 hace impresión local resiliente. No hace restaurante sin
internet.** Si se cae la conexión, las comandas ya entregadas se siguen
imprimiendo y reintentando, pero **no se pueden capturar pedidos nuevos**: eso
depende de la nube. La hoja de ruta para el modo sin conexión está en
`docs/xabor-edge-offline-roadmap.md` y no está implementada.

Tampoco están: el transporte por spooler de Windows (queda para la visita a
sitio, cuando se pueda probar contra la PC real), ni la unificación de colores,
ni el logotipo por negocio en los tickets.

## Relación con el agente anterior

`print-agent.js` sigue existiendo y funcionando. Xabor Edge vive en `edge/`,
se conecta por el **mismo** WebSocket con el **mismo** tipo de credencial, y
lo que cambia es que soporta varias impresoras, cola persistente, reintentos y
confirmación. Migrar de uno a otro es cambiar qué proceso se ejecuta en la PC,
no cambiar el servidor.
