# El Mesero Digital de WhatsApp

Nota de arquitectura de la rama `feat/whatsapp-mesero`. El flujo que había antes
está en [mesero-whatsapp-flujo-actual.md](mesero-whatsapp-flujo-actual.md); aquí
va lo que se le agrega y, sobre todo, lo que **no** cambia de lugar.

## La idea en una frase

El modelo conversa, interpreta y propone. El código autoriza.

Eso ya era cierto para el pedido desde el reconciliador V2. Lo nuevo es que
ahora también es cierto para todo lo que hay alrededor: las recomendaciones, las
referencias, las respuestas del cliente a lo que se le ofrece, y lo que el
sistema recuerda de él.

## El turno completo

```
mensaje del cliente
  │
  ├─ procedenciaDeEvidencia    DICHO / PERCIBIDO           (ya existía)
  ├─ intencionesDelCliente     preguntar no es pedir
  ├─ handoffHumano             ¿esto es para una persona?  → sale aquí
  ├─ propuestasDelBot          ¿contestó a lo que se le ofreció?
  ├─ referenciasDelCliente     ¿a qué renglón apunta?
  │
  ├─ [ EL MODELO ]             una PROPUESTA de pedido
  │
  ├─ motorTransaccional        propuestas → borrador
  │     └─ carritoDelPedido    RECONCILIA Y DECIDE          (ya existía)
  │
  ├─ consultasDelMenu          lo preguntado, desde el catálogo
  ├─ recomendaciones           si es momento, y solo de la carta
  ├─ aclaraciones              lo que quedó sin decidir → preguntas
  ├─ faseConversacional        qué falta, qué no repetir
  ├─ resumenDelPedido          desde datos validados
  └─ metricasMesero            eventos, por negocio, sin PII
```

`meseroDigital.atenderTurno` es quien los llama en ese orden. **No envía nada,
no consulta la base, no registra pedidos, no imprime y no cobra**: recibe el
catálogo ya leído y devuelve datos. Por eso una conversación de veinte turnos
corre en una prueba de un segundo, y por eso un error aquí no puede hablarle a
un cliente.

## La frontera, exacta

| | Mesero | Motor transaccional |
|---|---|---|
| conversa, interpreta, recomienda | sí | no |
| propone cambios | sí | no |
| decide qué entra al pedido | **no** | sí |
| dónde vive | `src/mesero/` | `src/orders/carritoDelPedido.js` |

Lo que cruza la frontera:

```js
{ accion, lid, campo, valorAnterior, valorNuevo, evidencia }
```

`motorTransaccional` traduce esas propuestas a un borrador y llama a
`reconciliar`. **No valida.** La tentación era escribir ahí las reglas —son
propuestas explícitas, cada una con su evidencia, sería fácil— y sería un
segundo juego de reglas junto al del reconciliador; a la segunda semana dirían
cosas distintas y la que decidiría de verdad sería la que corre última.

`propuestasDesdeBorrador` convierte lo que el extractor ya emite —un pedido
entero— en «qué quiso cambiar». Un error ahí no autoriza nada: lo que sale
vuelve a pasar por `reconciliar`. Lo que se pierde es precisión en el log.

## Lo que se le agregó al carrito, y por qué es seguro

Tres opciones nuevas en `reconciliar`, las tres inertes sin el mesero:

| Opción | Qué permite | Qué NO relaja |
|---|---|---|
| `lid` en un item propuesto | emparejar por identidad y no por parecido | nada: un `lid` que no existe se ignora |
| `quitarPorLid` | quitar lo que el cliente señaló sin nombrar | el verbo de quitar se sigue exigiendo, sobre lo DICHO |
| `atribuidoPorLid` | «mejor dos» sobre el renglón en foco | el número se sigue exigiendo en el mensaje |
| `dichoDelTurno` / `dichoDelCiclo` | acotar el texto que autoriza | solo puede ser **más pequeño**, nunca más grande |

El modelo nunca ve el `lid`, así que ningún borrador suyo trae ninguna de estas
cosas. Solo el mesero las produce, y solo cuando una resolución determinista lo
respalda.

Y un cambio que **sí** endurece para todos: al decidir si una frase señala un
renglón, ahora compiten también los productos que el cliente acaba de nombrar y
todavía no están en el carrito. «Ponme dos cocas» con un solo platillo en el
pedido lo subía a dos.

## Los interruptores

Todos en `configuracion`, por negocio, y todos apagados por omisión.

| Clave | Qué enciende | Depende de |
|---|---|---|
| `pedido_reconciliador_v2` | el reconciliador V2 | — |
| `pedido_shadow` | observar el reconciliador | `PEDIDO_SHADOW_MODE` del proceso |
| `mesero_whatsapp_v1` | el mesero, productivo | **exige `pedido_reconciliador_v2`** |
| `mesero_whatsapp_shadow` | observar al mesero | `MESERO_SHADOW_MODE` del proceso |

**`mesero_whatsapp_v1` sin `pedido_reconciliador_v2` no enciende nada.** El
mesero es lo que más propone y el reconciliador es lo único que lo frena;
encenderlo sobre LEGACY sería la única configuración en la que el mesero es
menos seguro que el bot al que sustituye. Se avisa en el log y se queda apagado.

Los dos maestros de proceso son distintos a propósito: un interruptor por
experimento, para poder apagar el que estorbe sin tocar el otro.

## Fase L — tool calling interno: evaluado, no implementado

La pregunta era si conviene que el modelo pida herramientas
(`consultarProducto`, `proponerAgregar`, `solicitarAclaracion`…) en vez de
devolver un borrador.

**Conviene, y no esta noche.** Las razones, en orden:

1. **El valor ya está capturado.** Lo que hace atractivo el tool calling es que
   el modelo diga QUÉ quiere hacer en vez de emitir un estado final. Eso es
   exactamente lo que hace `propuestasDesdeBorrador`, y sin tocar `brain.js`:
   la diferencia entre las dos formas es quién escribe el diff, no qué se puede
   auditar.
2. **El resto es riesgo.** Cambiar la interfaz con el modelo significa reescribir
   la llamada, el prompt y el manejo de errores de `brain.js`, que es un
   componente protegido y el único camino a la respuesta del cliente. Eso es un
   big bang, y el encargo dice que no.
3. **Falta una medición.** No sabemos todavía dónde falla el extractor actual.
   Las métricas del mesero (`whatsapp_mesero_cambio_bloqueado`,
   `whatsapp_mesero_invento_bloqueado`) están para contestar eso. Cambiar la
   interfaz antes de tener el dato es elegir la solución antes del problema.

Si más adelante se hace, la forma segura ya está: las tools serían
`proponer*`, devolverían propuestas del mismo formato, y el motor no cambiaría
una línea. Ninguna tool puede crear un pedido, imprimir, cobrar ni confirmar —
esas rutas no están en `src/mesero/` y el grafo de imports lo comprueba en la
prueba V8.

## Lo que se protege en la confirmación

- El resumen se construye **desde el carrito validado**, nunca desde memoria del
  modelo. Es la última oportunidad de detectar una divergencia, y si saliera del
  modelo la confirmación sería teatro.
- El total solo existe si **todos** los renglones tienen precio. Un total parcial
  parece completo.
- `huellaDelResumen` / `resumenSigueVigente`: si entre el resumen y el «sí»
  cambió algo, ese sí no vale para lo que hay ahora.
- `listoParaConfirmar` exige cero aclaraciones abiertas y cero faltantes.

## Handoff

Reutiliza `enviarARevision` de la continuidad —el mismo camino que ya usa el
canal— y aporta el criterio y el equipaje: qué pedido provisional llevaba, qué
quedaba pendiente, qué se acababa de preguntar, qué se ofreció y no se contestó.
Sin el historial, que el panel ya enseña, y sin el texto del cliente.

La decisión de escalar se toma **antes** de tocar el pedido: quien entre ve lo
que el cliente pidió, no lo que el bot alcanzó a interpretar en el turno que
provocó el escalado.

## Lo que NO está hecho

- **No hay integración con el canal.** `whatsapp-meta.js` y `brain.js` no
  llaman al mesero todavía. Es deliberado: el mesero está completo y probado
  como capa, y conectarlo es un cambio en dos componentes protegidos que merece
  su propia sesión y su propio smoke.
- **No hay prompt nuevo.** `paraElModelo` produce el briefing —hechos, nunca
  frases hechas— pero nadie lo mete todavía en el system prompt.
- **Las notas se reconocen poco.** `AGREGAR_NOTA` solo dispara con marcadores
  explícitos. Se prefirió que se quede corta: una nota que no se detecta viaja
  igual por el camino normal del carrito.
- **`popularidad` no la calcula nadie.** El parámetro existe y se usa si se le
  pasa; el trabajo de calcularlo desde `pedidos_activos` está sin hacer.
- **`complementos` no tiene UI.** Se lee de la configuración del negocio; hoy
  habría que escribirlo a mano.
