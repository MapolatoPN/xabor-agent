# Bitácora — fuente de verdad del pedido

Trabajo en `fix/pedido-fuente-de-verdad`, partiendo de `c859e72` (PR 8, lo que
hoy corre en producción). **No se despliega ni se fusiona a main.**

Esta bitácora existe para poder retomar si se corta la sesión. Se actualiza
conforme avanza, no al final.

## Estado verificado al empezar (2026-09-12)

- `origin/main` = `c859e72` — PR 8 de Codex, fusionado hoy 09:25 y desplegado.
  Confirmado que **todo el trabajo del 11-sep sigue dentro** (`9cea9d7` es
  ancestro). No se revirtió nada de nadie.
- Ramas con trabajo fuera de producción: `integracion/obispado-personal` (49),
  `personal/mvp` (3), `mantenimiento/entorno-local-y-eol` (4). Ninguna es de
  este alcance.
- Codex dejó en producción: `session.aclaracionProducto` (instantánea del
  borrador durante UNA aclaración), `continuarAclaracionProducto`,
  `solicitudPersona.js`, y `variantePorLoPedido` reescrito para usar
  `buscarOpcionPorMencion` en vez de comparación de texto propia.

## Diagnóstico unificado

### Confirmadas por Codex, reproducidas localmente

| # | Falla | Dónde |
|---|---|---|
| A | Un ID contradictorio sustituye al producto nombrado | `validadorOrden.resolverProducto` |
| B | Una mención genérica autoriza una opción específica | respaldo de selecciones |
| C | Responder un dato operativo borra el segundo platillo | `brain.js`: el borrador del modelo es la única fuente |

### Encontradas por mí el 11-sep (ya en producción)

Negativas falsas por ambigüedad de producto; negativas sin platillo resuelto;
ambigüedad de opción nombrando grupos en vez de opciones; borrador ilegible
tumbando el turno; pausa eterna; botón de devolver al bot inservible.

### Causa común

En cada turno, **el borrador que emite el modelo ES el pedido**. Todo lo demás
—identidad, cantidades, selecciones— se deriva de esa emisión. Si el modelo
omite, contradice o resuelve de más, el sistema lo toma por la voluntad del
cliente. `aclaracionProducto` tapa un tramo (la elección de presentación) pero
se limpia en `brain.js:692` y el ciclo vuelve a depender del modelo.

## Decisión de diseño

Un **carrito estructurado** que vive todo el ciclo y sobrevive reinicios. El
modelo propone; el carrito se reconcilia. Omitir no borra. Quitar exige
evidencia del cliente. Los datos operativos no tocan artículos.

## Avance

- [x] Leer los tres artefactos de Codex
- [x] Verificar estado real de git y producción
- [x] Rama propia creada
- [x] Portar las reproducciones como suite obligatoria y verlas fallar
- [x] Identidad de producto contra ID contradictorio (falla A)
- [x] Evidencia que distinga entre opciones hermanas (falla B)
- [x] Carrito persistente (falla C)
- [x] Conversaciones completas: sustitución, respuestas cortas, apodos y erratas,
      prosa, borrador vacío, mensajes agrupados, reentregas, dos instancias
- [x] Regresión de las suites vecinas (43 suites)
- [x] Segunda auditoría de Codex: tres fallas del carrito, reproducidas y cerradas
- [x] Tercera ronda: procedencia de la evidencia, términos del catálogo,
      quitar con identidad y modo sombra
- [x] Auditoría de producción en solo lectura
- [x] PR — rama `fix/pedido-fuente-de-verdad` empujada. `gh` no está
      autenticado en esta máquina, así que el PR queda por abrir desde
      https://github.com/MapolatoPN/xabor-agent/pull/new/fix/pedido-fuente-de-verdad
      (el texto listo para pegar está en el último mensaje de la sesión).

## Lo implementado

| Archivo | Qué hace |
|---|---|
| `src/orders/carritoDelPedido.js` (nuevo) | El carrito: reconcilia la propuesta del modelo contra el pedido que ya existía, **campo a campo**. Cada cambio —cantidad, modificador, nota, artículo— necesita respaldo del cliente. Módulo puro. |
| `src/orders/evidenciaDeEleccion.js` (nuevo) | Si una palabra del cliente sostiene igual de bien a dos opciones hermanas, no elige ninguna. |
| `src/agent/brain.js` | Engancha la reconciliación en **las tres** fuentes de borrador (marcador del modelo, aclaración y extracción forzada); reinyecta el carrito solo en turnos del pedido; pregunta lo ambiguo. |
| `src/agent/session.js` | Cerrar el ciclo vacía el carrito. |
| `src/agent/sesionDurable.js` | El carrito viaja en la foto durable: sobrevive reinicios. |
| `src/orders/validadorOrden.js` | Señalar desempata, no sustituye: un id que contradice al nombre Y a lo que dijo el cliente ya no gana. Las selecciones exigen distinguir. |

## Pruebas de mordida (primera ronda)

Cada garantía se desactivó por separado y se comprobó que la suite vuelve a
fallar exactamente donde debe. Sin esto, verde no significa nada.

| Mordida | Qué se desactivó | Falla |
|---|---|---|
| A | `if (concuerdan)` → `if (true)` | A1, A2 |
| B | `distingueLaEleccion(...)` → `{distingue:true}` | B1, B2 |
| C | el bloque de reconciliación → `if (false)` | C1, C2, C3, D2, E1-E9 (13 casos) |
| D | el corte de alcance del «quita» | E1 |
| E | `turnoDePedido` → `true` | E4 |
| F | el filtro de renglones ya cambiados | E10 |

## Segunda ronda — Codex audita el carrito (2026-09-12)

Codex revisó esta rama y reprodujo tres fallas más. Las tres tienen la misma
raíz: **el carrito protegía el ARTÍCULO y nada de lo que lleva dentro**. Se
reprodujeron tal cual con su script
(`...\work\auditoria-carrito-claude-pruebas.mjs`, que importa una copia
byte a byte de mi módulo) antes de tocar nada:

| # | Qué hacía el cliente | Qué hacía el sistema |
|---|---|---|
| 1 | decir «Para recoger» | el mismo platillo volvía con cantidad 1 en vez de 2, sin su salsa y sin su «sin cebolla» |
| 2 | «Quita los hotcakes tradicionales» | borraba TAMBIÉN los hotcakes de sartén, por compartir una palabra |
| 3 | decir «Para recoger» | el modelo añadía tres Coca-Colas y entraban al pedido |

Antes (salida literal del script de Codex):

```
1  [{"nombre":"Chilaquiles Sencillos","cantidad":1,"modificadores":[],"notas":""}]
2  []
3  [{"nombre":"Chilaquiles Sencillos",...},{"nombre":"Coca Cola","cantidad":3,...}]
```

Después, el mismo script:

```
1  [{"nombre":"Chilaquiles Sencillos","cantidad":2,
    "modificadores":[{"grupo":"Salsa","opciones":["Suiza"]}],"notas":"sin cebolla"}]
2  [{"nombre":"Hotcakes de Sarten",...}]        ← solo se fue el señalado
3  [{"nombre":"Chilaquiles Sencillos",...}]     ← la Coca no entra
```

### La regla, ahora a nivel de campo

**El modelo propone cambios; no los autoriza.**

| Qué | Qué hace falta |
|---|---|
| omitir un artículo, su cantidad, un modificador o una nota | nada: se conserva |
| cambiar un grupo ya elegido | que el cliente lo diga **en este turno** |
| rellenar un grupo vacío | que lo haya dicho en **cualquier turno del ciclo** |
| cambiar la cantidad | que **ese número** esté en su mensaje, y que la frase diga de qué artículo |
| agregar un producto | que lo haya nombrado (con tolerancia a una errata) |
| quitar | verbo de quitar + que la frase identifique **UN** artículo |

Las dos decisiones que más me costaron, y por qué quedaron así:

**Dónde se busca el respaldo de un cambio.** Rellenar un grupo vacío y cambiar
uno ya elegido no son lo mismo. Buscar los dos en todo el ciclo dejaba que
«dos ramen con **cerdo** chashu y unas gyozas de verdura» prestara la palabra
"cerdo" tres turnos después para cambiarle el relleno a las gyozas. Cambiar de
idea es un acto de un momento: se respalda con el mensaje de ese momento.
Excepción explícita: si la opción vieja no la respaldaba el cliente —la puso el
modelo— no está protegida, o el primer error del modelo quedaría cementado.

**Al cliente no se le pregunta por lo inventado.** La primera versión decía
«¿Querías agregar Coca Cola?». Es la misma falla con mejores modales: le ofrece
en su propia voz algo que nunca pidió, y un «sí» de cortesía lo acaba pagando.
Lo inventado se descarta y queda en el log del negocio. Lo AMBIGUO sí se
pregunta —«¿cuál quito, este o este?»— porque ahí la duda es sobre lo que él
dijo y es el único que puede resolverla.

### Identificar no es compartir una palabra

«Quita los hotcakes tradicionales» con dos hotcakes en el carrito se resuelve
con la MISMA regla que ya separaba «Frijolitos naturales» de «Frijolitos con
chorizo»: se compara qué palabras sostienen a cada candidato, y si otro explica
todo lo que explica este, la frase no los separa. Así:

```
"quita los hotcakes tradicionales"   {hotcakes,tradicionales} vs {hotcakes} -> se va uno
"quita los hotcakes"                 {hotcakes} vs {hotcakes}               -> se pregunta
```

No es una regla nueva ni una excepción por producto: es la que ya existía,
aplicada a los artículos en vez de a las opciones.

### Todas las rutas del borrador pasan por el carrito

La reconciliación era un bloque en medio del flujo, y `extraerBorradorForzado`
—la segunda llamada que extrae el pedido cuando el modelo no emitió marcador—
corría **después** y lo rodeaba. Ahora es una función y la usan las tres
fuentes: el marcador del modelo, `continuarAclaracionProducto` y la extracción
forzada. La mordida K lo comprueba: al desconectar esa ruta, el cliente pierde
el segundo platillo y el bot vuelve a preguntarle la proteína que ya había
elegido.

### Mordidas de la segunda ronda

| Mordida | Qué se desactivó | Falla |
|---|---|---|
| G | la fusión campo a campo | F1, F2, F10, F14 |
| H | el desempate al quitar | F3, F4 |
| I | `nombradoPorElCliente` → `true` | F5, F6, F13 |
| J | el respaldo del cambio por turno | F14 |
| K | el carrito en la ruta forzada | F15 |


## Tercera ronda — las tres limitaciones abiertas (2026-09-12)

### 1. La procedencia: lo DICHO no es lo PERCIBIDO

Buscando todas las rutas que crean el primer borrador apareció algo más grande
que la limitación escrita. Cuando llega una foto, el canal **no** le manda la
imagen al cerebro: la analiza aparte y sustituye la marca por el bloque
`[CONTEXTO VISUAL]` **dentro del mensaje del cliente**
(`utils/turnoImagen.js` → `prepararTurnoParaIA`). El turno que acaba en el
historial es un string que mezcla las dos cosas:

```
[CONTEXTO VISUAL]
- productos que parecen aparecer: Hamburguesa Doble (confianza 0.82)
[/CONTEXTO VISUAL]
quiero esto porfa
```

Así que para todo lo que mira «lo que dijo el cliente» —el carrito, el respaldo
de selecciones, el de modalidad y forma de pago— la percepción del modelo de
visión ERA el cliente.

**Antes** (prueba directa contra el módulo, antes de tocar nada):

```
con carrito previo   -> ["Ramen Chico","Hamburguesa Doble"]   sinRespaldo: []
primera propuesta    -> [{"nombre":"Hamburguesa Doble","cantidad":3,
                          "modificadores":[{"grupo":"Queso","opciones":["Doble queso"]}],
                          "notas":"sin cebolla"}]
```

**Después**:

```
con carrito previo   -> ["Ramen Chico"]   porConfirmar: [Hamburguesa Doble · percibido]
primera propuesta    -> []                porConfirmar: [Hamburguesa Doble · percibido]
pregunta al cliente  -> «En la foto veo algo parecido a "Hamburguesa Doble". ¿Te lo agrego?»
```

`procedenciaDeEvidencia.js` separa el turno por la **forma** del bloque
—etiquetas en mayúsculas con cierre—, no por su contenido: cualquier bloque
futuro (audio, PDF, ubicación) queda cubierto sin tocar nada. Tres procedencias
y tres políticas:

| | | |
|---|---|---|
| **DICHO** | lo escribió o lo dictó el cliente | autoriza |
| **PERCIBIDO** | sale de su foto, lo interpretó el modelo | no autoriza: se pregunta |
| **INVENTADO** | no está en ninguna de las dos | ni entra ni se menciona |

La distinción importa: una foto **sí** es una fuente del cliente, así que
descartarla en silencio sería tan malo como creerle. Se pregunta.

Y la puerta se aplica **desde el primer borrador**, no solo cuando ya hay
carrito: aparecer en la primera salida del modelo dejó de dar autoridad, y no
solo al artículo — cantidad, modificadores y notas de un artículo nuevo también
necesitan respaldo.

### 2. Términos genéricos: los pone el catálogo, no una lista

«Ponme un refresco» no comparte una letra con «Coca Cola». No hay columna de
alias en `menu_productos` —se revisó el esquema— pero sí hay algo mejor y ya
construido: `terminosDelCatalogo`, que el guard de negativas falsas usa desde
el 11-sep. Devuelve cada nombre de **categoría**, producto y opción con los
productos que ofrece, que es exactamente la forma que tiene un término genérico
en la carta de un negocio.

| El término cubre | Qué pasa |
|---|---|
| un solo producto | lo identifica |
| varios | no se escoge: se ofrecen y se pregunta |
| nada de la carta | no entra |

Si un negocio quiere que «refresco» funcione, su categoría se llama «Refrescos».
Es configuración suya, no código nuestro, y no hay un solo nombre de producto en
la lógica. El catálogo se consulta **solo** cuando quedó un artículo sin
respaldo, así que el turno normal no paga una consulta de más.

### 3. Quitar: más formas de decirlo, la misma exigencia de identidad

Se añadieron los giros naturales que faltaban (`quítale`, `retira`,
`olvídate de`, `déjalo sin`, `ya no`) sin aflojar nada, porque **lo que decide
qué se va no es el verbo: es la identificación**. Por eso se puede ser generoso
con uno y estricto con la otra.

Un pronombre —«ya no quiero ese», «el otro no»— no nombra ningún artículo, así
que no hay candidatos y no se quita nada. No hizo falta una regla para los
pronombres: caen solos, que es la señal de que la regla general es la correcta.

Dos cosas más salieron de escribir las pruebas:

- **Quitar un ingrediente no se dice como quitar un platillo.** «Sin cebolla» no
  lleva verbo. Se mira el mismo tramo y se exige que la opción esté nombrada
  ahí. Quitar una opción necesita esa evidencia propia, **salvo** en un
  intercambio 1:1 —una sale, otra entra, el grupo tenía una sola—, que es como
  se dice «mejor la salsa roja». Sin esa distinción, o el modelo podía comerse
  una guarnición en silencio, o el cliente no podía cambiar de idea.
- **La fusión de un grupo era todo o nada**, así que «con cebolla» más un
  pepinillo inventado por el modelo tiraba también la cebolla que el cliente sí
  pidió. Ahora es opción por opción.

### 4. Modo sombra

`PEDIDO_SHADOW_MODE=true`. El reconciliador corre igual, sobre un carrito
**paralelo** (`session.carritoSombra`, que vive el mismo ciclo y sobrevive a los
reinicios), y no toca nada más: no escribe el carrito productivo, no reinyecta
borrador, no añade una palabra a la respuesta del cliente.

Cada turno deja una línea `[TXN] evento=carrito_sombra {…}` con: qué dijo el
cliente, qué había antes, qué propuso el modelo, qué habría quedado, **qué se
autorizó y con qué evidencia**, qué se rechazó y por qué, la conversación y el
sello de tiempo.

No se construyó nada nuevo para guardarlo: el repo ya tiene la convención
`[TXN] evento=…` y los logs de Railway ya se leen todos los días. Cuarenta
ciclos son cuarenta líneas legibles, y cuando el modo se apague no queda nada
que limpiar. La conversación se identifica por un **hash corto**, no por el
teléfono, y al mensaje se le tapan las corridas largas de dígitos.

### Mordidas de la tercera ronda

| Mordida | Qué se desactivó | Falla |
|---|---|---|
| L | la separación de procedencia | G3 |
| M | la depuración de campos del artículo nuevo | G4, G5 |
| N | «término ambiguo» pasa a autorizar | G8 |
| O | quitar una opción sin evidencia propia | G22, G23 |
| P | el guard de contaminación cruzada | G16 |
| Q | en sombra se escribe el carrito productivo | G21 |
| R | la segunda pasada con términos del catálogo | G7, G8 |

### Una garantía que cambió de sitio, no de contenido

`fase-fidelidad-borrador` F2/F5 exigen que un descarte de selección quede
rastreable en producción con su código. Desde que el carrito filtra campo a
campo, ese descarte ocurre **antes** de que el validador lo vea, así que su
línea dejaba de emitirse y las pruebas caían. No se tocaron las pruebas: se
emite el mismo evento con el mismo código desde el carrito. Si la traza se
hubiera quedado solo en el validador, un descarte del carrito sería invisible
para el negocio.


## Auditoría del modo sombra (2026-09-12)

La afirmación auditada, palabra por palabra:

> Con `PEDIDO_SHADOW_MODE=true` podemos tener habilitada la recepción de tráfico
> real de WhatsApp en Obispado y ejecutar el nuevo reconciliador, pero el
> experimento no puede producir ningún cambio ni comunicación observable para el
> cliente ni ningún side effect operativo.

**Era falsa cuando se escribió.** Ahora es cierta, con una salvedad que se
nombra abajo.

### El flujo, paso a paso

```
webhook /webhook/whatsapp
  └─ guarda el mensaje, lo publica al panel, upsert de cliente   EJECUTA (de siempre)
  └─ marcarLeido()  → doble palomita azul                        EJECUTA (de siempre)
  └─ marcarRespuestaCampana()                                    EJECUTA (de siempre)
  ├─ ¿bot apagado / cliente pausado / takeover humano?
  │    └─ observarEnSombra()                                     EJECUTA SOBRE COPIA
  │    └─ return                                                 NO EJECUTA nada más
  └─ si el bot responde:
       procesarConClaude → brain → carrito → validador → preview
       → registrarPedido → comanda → impresión → enlace de pago  EJECUTA (productivo)
```

Con la bandera puesta y el bot apagado, todo lo de la última rama es **NO
EJECUTA**: el canal ya hizo `return`.

### Lo que estaba mal

1. **La bandera vivía dentro del turno productivo.** Apagaba el carrito y nada
   más: con el bot encendido el cliente seguía recibiendo respuestas, se
   registraban pedidos, se imprimían comandas y se generaban cobros. «Sombra»
   nombraba algo que no era sombra.
2. **Con el bot apagado, la sombra no corría.** El canal hace `return` antes de
   llegar a `brain.js`, que es donde vivía. Así que no existía ningún estado en
   el que se pudiera observar sin producir.
3. **El estado del experimento se escribía en la sesión productiva**
   (`session.carritoSombra`) y viajaba en su fila durable.

### Lo que se hizo

La observación se movió a los **tres puntos del canal donde el sistema ya está
callado**. El módulo observador no importa —ni directa ni transitivamente— la
base, el canal, `orderManager`, pagos ni impresión: su grafo completo son cinco
módulos puros y `node:crypto`, y `S12b` lo comprueba en cada corrida.

| | |
|---|---|
| estado | en memoria del observador, con tope; fuera de la sesión y de su fila durable |
| propuesta | el MISMO extractor acotado de `brain.js`, inyectado por el canal |
| evaluación | el MISMO `reconciliar` |
| salida | una línea `[TXN] evento=carrito_sombra` |
| ejecución | suelta del turno, con tope de 8 s y `.catch` en el sitio de llamada |

### El único efecto observable, y no es del experimento

Con el bot apagado, Xabor **ya marca el mensaje como leído** (la doble palomita
azul). Ocurre al recibirlo, muchas líneas antes de decidir si contesta, y es de
siempre: el diff del canal en esta rama solo añade líneas. La suite separa
COMUNICACIÓN de ACUSE para medir lo que dice medir en vez de bajar el listón, y
queda dicho aquí porque el cliente sí lo ve.

### Fail closed

`observarTurno` envuelve todo en try/catch y devuelve `{ok:false}`; el sitio de
llamada añade su `.catch`. Importa porque el catch de `whatsappContinuidad`
marca la conversación con `EJECUCION_NO_VERIFICADA` ante cualquier excepción de
`procesar`: eso pausa el bot para ese cliente y levanta una alerta en el panel.
Un fallo del experimento acabaría señalando una conversación real.

No hay ninguna rama que, ante un fallo de la sombra, ejecute el flujo real: quien
llama ya decidió callar ANTES, y el observador no devuelve nada que pueda
cambiar esa decisión.

### La variable

`sombraActiva()` compara explícitamente contra `"true"`, sin truthiness — una
variable de entorno siempre es un string, y `"false"` y `"0"` son verdaderos en
JavaScript.

| valor | resultado |
|---|---|
| ausente, `""`, `"false"`, `"0"`, `"no"`, `"1"` | apagado |
| `"true"`, `"TRUE"`, `"  true  "` | **encendido** |

### Pruebas

`test/fase-sombra-aislamiento.mjs` — **15 casos**, por el webhook real contra un
servidor levantado con la bandera puesta.

| Mordida | Qué se reintrodujo | Falla |
|---|---|---|
| S10 | el observador vuelve a escribir en la sesión | S10 |
| S10b | la foto durable vuelve a cargar con el experimento | S10 |
| S11 | el observador puede hablarle a Meta | S11 |
| S12 | el observador importa la base | S12 |
| F1 | el catch interno relanza | S6 |
| F2 | el catch interno relanza y se quita el del canal | S6, S9 (el servidor se cae) |
| F3 | volver a esperar la observación dentro del turno | **ninguna** |

**F3 no tumba nada, y hay que decirlo.** Desenganché la observación del turno
creyendo que el bloqueo causaba el fallo de S6b, y no era eso: el fallo era mío,
la limpieza de la suite borraba `whatsapp_conversaciones` antes que
`whatsapp_entradas` —que tiene una clave foránea contra ella— con el error
silenciado, así que una fila vieja con `requiere_revision=true` bloqueaba el
turno y la prueba medía la corrida anterior. El desenganche se queda por lo que
evita —una llamada de red en la ruta de un turno que ya decidió callar— no por
lo que arregló.

S6b tampoco tiene hoy una mordida que la tumbe: pasa porque nada propaga. Se
queda como regresión de punta a punta, no como demostración.


## Regresión: 44 suites vecinas

Elegidas por importación real —todo lo que toca `brain.js`, `validadorOrden.js`,
`session.js` o `sesionDurable.js`— más la recepción compartida de WhatsApp,
Compras y los caminos de imagen (que importan porque el carrito ahora exige que
el cliente haya NOMBRADO lo que se agrega, y un pedido por foto no nombra nada).

**41 de 44 en verde.** Entre ellas:

| Suite | Qué defiende | Resultado |
|---|---|---|
| `fase-confirmacion-determinista` | confirmación explícita, sin registrar de más | 38/38 |
| `fase-dedupe-nuevo-pedido` | un pedido no se duplica ni se reimprime | 24/24 |
| `fase-preconfirmacion-pricing` | precios, extras y totales reales | 18/18 |
| `fase-promociones` / `fase-promo-informativa` | promociones | 19/19, 18/18 |
| `fase-seguridad-transaccional` | idempotencia y aislamiento | 18/18 |
| `fase-p0-aislamiento-pedidos` | aislamiento entre negocios | verde |
| `fase-compras-whatsapp` + `-webhook` | **Compras por WhatsApp sigue funcionando** | 13/13 + verde |
| `fase-bot-calla-y-avisa` | silencio, intervención humana, reactivación | 24/24 |
| `fase-negaciones-injustas` | no negar lo que existe | 63/63 |
| `fase-chilaquiles-contexto` | la suite de Codex para este incidente | 11/11 |
| `fase-vision-whatsapp`, `fase-chat-imagenes` | pedir por foto sigue funcionando | verdes |
| `fase-whatsapp-continuidad`, `fase-agrupamiento-turnos-whatsapp` | reentregas, mensajes agrupados | 13/13, 14/14 |

**Las 3 que fallan, fallan igual en `c859e72`** —el commit que hoy corre en
producción— comprobado en un worktree limpio de ese commit, con la misma base y
las mismas variables:

- `fase-continuidad-webhook`: 9/1, el mismo caso (captura del panel que expira).
- `fase-hotfix-borrador-recuperable`: 2 de 8, los mismos casos. Es del Asistente
  Comercial, no del pedido del menú.
- `fase-seguridad-transaccional`: 17/1 (T14). Depende del estado acumulado de la
  base local —pasó 18/18 justo después de resembrar y falla ahora en las dos
  ramas—, así que es de entorno, no de código.

Ninguna es de este trabajo. Quedan anotadas, no arregladas.

### Un falso positivo que conviene recordar

En una corrida, `fase-chat-imagenes` dio 33/5 con fallos del worker de
recepción. No era regresión: yo había lanzado otra suite EN PARALELO con el
lote. Sola pasa 38/38. Está escrito en CLAUDE.md —las suites no toleran
ejecución concurrente— y aun así lo hice.

### Corrección: la suite de Codex SÍ se había ejecutado

En la primera entrega escribí que `fase-chilaquiles-contexto` «nunca se había
ejecutado». **Es falso y lo retiro.** Codex la corría con un lanzador propio,
fuera del repo:

    ...workwhatsapp-prueba-live.cjs

que arma el entorno y pasa `ANTHROPIC_API_KEY:'test-audit'` antes de invocar
cada suite. Verificado leyendo el archivo. Lo que observé es otra cosa, y es la
que sigue en pie: **la suite no es autocontenida**. Apunta el SDK al mock pero
no exporta la llave, así que en un checkout limpio con el entorno documentado en
CLAUDE.md su único caso que llega al modelo muere con `Could not resolve
authentication method`. Ejecutarse con un lanzador externo y ejecutarse desde el
repo son cosas distintas; confundí la segunda con la primera.

La línea que añadí (un valor por defecto para la llave) hace la suite
autocontenida sin quitarle nada. Y el dato que sí importa se mantiene: con la
llave puesta pasa 11/11 en esta rama y en `c859e72`, así que la garantía que
defendía era real.

### Nueve suites fallaban por datos de prueba caducados

`test/.datos-prueba.json` apuntaba a cuatro negocios que ya no existían en la
base local, y todo lo que insertaba contra ellos moría en `..._negocio_id_fkey`.
Resembrar los arregló las nueve. Es una nota de entorno, pero explica por qué
una corrida a ciegas parecía catastrófica.

## Producción, en solo lectura (2026-09-12, 14:10)

- `origin/main` = `c859e72`. Último arranque hoy 13:26.
- **El bot está APAGADO para Mapolato Obispado** (negocio 5de544d8): cada
  mensaje se guarda y nadie responde automáticamente; el dueño contesta a mano
  desde la Business App (`takeover humano 30 min` una y otra vez).
- Con el bot apagado, ninguna corrección se puede validar en producción hoy: lo
  que se despliegue no se ejercita hasta que el bot se vuelva a encender.
- A las 13:57 un cliente escribió exactamente el patrón de este trabajo:
  «unos chilaquiles verdes suizos con pollo (...) con papas a la mexicana y
  frij...». Le respondió una persona.
- El rescate de conversaciones sin respuesta está vivo y disparando
  (`cliente_esperando_sin_respuesta`).

## Notas de entorno

La base local no tenía aplicadas las migraciones 076/077/078
(`conversacion_estado`, `whatsapp_entradas`, `whatsapp_conversaciones`), y sin
ellas el arranque que `brain.js` arrastra —importa `server.js`— muere antes de
la primera prueba. La suite ahora aplica esos tres `.sql` al empezar: son
idempotentes y así no depende del estado de la máquina.

Trampa de esta máquina, por si vuelve: escribir código con `` dentro de un
heredoc deja un carácter de retroceso (U+0008) en el archivo en vez de la
secuencia de escape. El regex compila, no casa nunca y no se ve al leerlo. Se
detecta con `JSON.stringify` de la línea.

## Para publicar (cuando lo autorices)

1. Abrir y fusionar el PR a `main`.
2. Mirar qué más entra: `git log HEAD..origin/main` antes de desplegar —
   `--from-source` saca **todo** lo que haya en el origen, no solo esto.
3. Desde `C:«or-agent`: `railway redeploy --yes --from-source`.
   (El push a `main` **no** despliega; el auto-deploy está apagado.)
4. Verificar que llegó: la confirmación real de un cambio de servidor es una
   conversación de prueba, no `/health` —que responde 200 con el build viejo
   igual que con el nuevo.
5. **Encender el bot de Mapolato Obispado.** Hoy está apagado: mientras siga
   así, esto no se ejercita y no se puede verificar nada en producción.
6. En los logs, buscar `[TXN] evento=carrito_reconciliado`: dice qué artículos
   se conservaron pese a no venir en la propuesta del modelo. Es la falla que
   esto cierra, vista desde producción.

## Cómo encender el modo sombra

**El bot de Obispado se queda APAGADO.** No es una precaución de más: es donde
vive la observación. Con el bot encendido, el turno es productivo y la sombra no
mira nada.

1. En Railway, variable `PEDIDO_SHADOW_MODE=true`. El único valor que enciende
   es `true`; cualquier otro —incluido `"false"`— deja el experimento apagado.
2. Desplegar la rama con `railway redeploy --yes --from-source` desde
   `C:«or-agent`. Antes, mirar `git log HEAD..origin/main`: `--from-source`
   saca todo lo que haya en el origen.
3. Dejar el bot apagado. Los clientes escriben, el dueño contesta a mano como
   hoy, y cada uno de esos turnos se observa.
4. Leer: `railway logs` filtrando `evento=carrito_sombra`. Una línea por turno,
   JSON en una sola línea. Para 30–50 ciclos: juntar las líneas de un día y
   agrupar por `conv`.
5. Cada línea responde las cuatro preguntas: `propuso` (qué quiso el modelo),
   `quedaria` (qué habría permitido), `rechazado` (qué bloqueó y por qué) y
   `autorizado` (con qué evidencia dejó pasar lo que dejó pasar). Además trae
   `evidencia_dicho` y `evidencia_percibido` por separado, y
   `requeria_aclaracion`.
6. Para apagarlo: quitar la variable. No queda nada que limpiar; el estado del
   experimento vive en memoria y se va con el proceso.

Lo que el modo sombra **no** hace: no escribe el carrito del cliente, no toca su
sesión ni la fila durable, no reinyecta borrador, no confirma pedidos, no
imprime, no cobra y no añade una palabra a lo que el cliente lee. Lo único que
el cliente ve —la doble palomita azul— ya la veía antes de que esto existiera.

## Lo que este trabajo NO resuelve

- **Un producto que el cliente nombra sin ninguna palabra en común y que su
  carta no agrupa.** «Ponme un refresco» funciona si el negocio tiene una
  categoría llamada así; «ponme algo de tomar» no, porque eso no es una
  categoría de nadie. El cliente lo ve en el resumen y lo repite. Es el lado
  seguro del error, pero es un límite.
- **Un término genérico que cubre varios productos nunca se resuelve solo**: se
  pregunta, siempre. Para el cliente son dos turnos en vez de uno.
- **Una foto no construye el pedido por sí sola**: se pregunta antes de agregar.
  Si el negocio quisiera que la visión pidiera directo, haría falta una decisión
  suya, no un cambio aquí.
- **La detección de «quitar» sigue siendo léxica** (verbo o giro + artículo
  identificado). Una forma que no use ninguno no quita nada: se conserva.
- **Cambiar de idea sin decirlo en el turno** no cambia nada: el bot pregunta.
- **Las 3 suites que fallan desde antes** (`fase-continuidad-webhook`,
  `fase-hotfix-borrador-recuperable`, `fase-seguridad-transaccional` T14).
- **El modo sombra no se ha corrido contra tráfico real todavía**, y el bot de
  Obispado sigue apagado. Nada de esto se ha visto con un cliente.
