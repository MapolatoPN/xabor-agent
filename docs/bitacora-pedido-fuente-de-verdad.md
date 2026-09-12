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


## Regresión: 43 suites vecinas

Elegidas por importación real —todo lo que toca `brain.js`, `validadorOrden.js`,
`session.js` o `sesionDurable.js`— más la recepción compartida de WhatsApp,
Compras y los caminos de imagen (que importan porque el carrito ahora exige que
el cliente haya NOMBRADO lo que se agrega, y un pedido por foto no nombra nada).

**41 de 43 en verde.** Entre ellas:

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

**Las 2 que fallan, fallan igual en `c859e72`** —el commit que hoy corre en
producción— comprobado en un worktree limpio de ese commit, con la misma base y
las mismas variables:

- `fase-continuidad-webhook`: 9/1 en las dos, el mismo caso (captura del panel
  que expira a los 5 s).
- `fase-hotfix-borrador-recuperable`: 2 de 8 en las dos, los mismos casos. Es
  del Asistente Comercial, no del pedido del menú.

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

## Lo que este trabajo NO resuelve

- **Un nombre sin ninguna palabra en común.** Agregar un producto exige que el
  cliente lo haya nombrado, con tolerancia a una errata. Quien diga «ponme un
  refresco» y el modelo lo lea como "Coca Cola" se queda sin refresco: no hay
  ninguna letra que los una. Lo ve en el resumen y lo pide otra vez. Es el lado
  seguro del error —perder algo se repara en la conversación, cobrar algo que
  nadie pidió llega a la puerta— pero es un límite real.
- **La primera propuesta de un ciclo no pasa por esa puerta.** Si el modelo
  inventa un artículo en el PRIMER borrador, el carrito no tiene nada que
  proteger todavía y lo acepta; lo auditan las menciones y el validador, no
  esto. La puerta existe para el modelo que añade cosas a un pedido que ya
  estaba, que es lo que Codex reprodujo.
- **Cambiar de idea sin decirlo en el turno.** Cambiar un grupo ya elegido pide
  respaldo en el mensaje de ese turno. Un cliente que dice «suiza» en el primer
  mensaje y luego solo contesta «sí» a una pregunta del bot sobre la salsa no
  cambia nada: el bot le pregunta otra vez.
- **La detección de «quitar» es léxica.** Verbo + artículo identificado dentro
  de su alcance. Una forma de pedirlo sin ninguno de esos verbos no quita nada:
  se conserva y el cliente lo corrige en el resumen.
- **Las dos suites que fallan desde antes** (`fase-continuidad-webhook`,
  `fase-hotfix-borrador-recuperable`).
- **Nada de esto se ha visto contra un cliente real**, porque el bot de Obispado
  sigue apagado.
