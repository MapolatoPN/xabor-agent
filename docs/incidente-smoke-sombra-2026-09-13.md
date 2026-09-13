# Incidente — el bot contestó durante el smoke de sombra (13-sep-2026)

## Qué se reportó

Durante el smoke del modo sombra en Mapolato Obispado, el cliente recibió tres
respuestas del bot: un saludo, el menú y el aviso de que el restaurante estaba
cerrado. El negocio debía estar con el bot apagado y observándose en sombra, así
que se dio por perdido el aislamiento y se pidió rollback.

## Qué pasó de verdad

**No fue una fuga.** La auditoría del interruptor del bot —`auditoria_plataforma`,
que solo escribe `actualizarBotWhatsappActivoNegocio`, la ruta del panel— dice:

```
04:12:44Z  mapolato-obispado   bot_whatsapp_activo: false -> TRUE
04:15:24Z  mapolato-obispado   bot_whatsapp_activo: TRUE  -> false
```

Y la conversación entera cae dentro de esa ventana:

| hora (UTC) | qué |
|---|---|
| 04:12:44 | **alguien enciende el bot** |
| 04:12:54 | entra «Hola» |
| 04:13:03 | sale el saludo (`origen=bot`) |
| 04:13:11 / 04:13:13 | «Quiero ordenar» / «Me pasas el menú?» |
| 04:13:30 | sale el menú, dos mensajes (texto + imagen de 4 páginas) |
| 04:14:20 | entra el pedido de chilaquiles |
| 04:14:33 | `NEGATIVA_INTERCEPTADA` → conversación a revisión humana |
| 04:14:53 / 04:14:56 | «Quiero unos chilaquiles» / «Suizos» |
| 04:15:09 | sale el aviso de cerrado |
| 04:15:24 | **alguien apaga el bot** |

En todo el log **no hay una sola línea** `Bot de WhatsApp desactivado`, y **cero**
líneas de sombra. Las dos cosas son coherentes con lo mismo: para el proceso, el
bot estaba encendido.

El canal hizo exactamente lo que debía para la configuración que de verdad
estaba puesta. La expectativa «bot OFF» la rompió la acción del operador, no el
código.

## Por qué el modo sombra no intervino

Está diseñado así, y es la decisión correcta: la observación vive en los tres
puntos donde **el sistema ya está callado** (bot apagado, cliente pausado,
takeover humano). Con el bot encendido, el turno es productivo y la sombra no
mira nada — observar a quien ya está siendo atendido no mediría nada nuevo y
duplicaría llamadas al modelo.

Lo que faltaba no era código: era que eso estuviera **escrito en una prueba**.
Nada desmentía la expectativa contraria.

## Quién generó cada mensaje

Los dos mensajes los redacta **el modelo**, no una función del canal:

- el saludo sale del bloque «TONO Y SALUDO CONFIGURADOS POR EL NEGOCIO» del
  system prompt (`prompts.js`);
- el aviso de cerrado sale de «HORARIO — REGLA CRÍTICA», que `construirSystemPrompt`
  inyecta con el estado calculado por `obtenerEstadoRestaurante(reglas)`.

No existe ninguna rutina de horario ni de saludo capaz de enviar por su cuenta:
las dos frases solo son alcanzables a través de `brain.js`, que a su vez solo se
alcanza si el gate del bot deja pasar. El `[Meta WA] Respuesta enviada` que
aparece en el log lo emite `whatsapp-meta.js:1443`, ya dentro de `procesarConClaude`.

## El canal calla dos veces, no una

`test/fase-canal-callado.mjs` (R1–R8) fija el horario cerrado los siete días y
comprueba que con el bot apagado no sale **nada**: ni saludo, ni menú —que va por
otra ruta, con imagen—, ni aviso de cerrado, ni error, ni en ráfaga agrupada por
el debounce real, ni si el bot se apaga a media ventana de agrupación.

Las mordidas dejaron ver algo que no sabíamos: **hay dos gates independientes**.

| Mordida | Qué se reintrodujo | Falla |
|---|---|---|
| Q1 | aviso de «cerrado» ANTES del gate | 9 casos |
| Q2 | saludo automático ANTES del gate | 3 casos |
| Q3 | quitar el `return` que sigue a la sombra | **ninguno** |
| Q3b | quitar ese `return` **y** la re-comprobación del turno agrupado | 9 casos |
| Q4 | leer el estado del bot como cadena (`"false"` es truthy) | 9 casos |
| Q5 | cachear el estado: el turno diferido decide con el valor viejo | INC |

Q3 sola no tumba nada porque el segundo gate —el de `continuidadWA.procesar`,
antes de procesar el turno agrupado— la ataja. Los dos juntos sí. Es defensa en
profundidad real, y ahora está medida.

## Lo que sigue pendiente, y no se tocó

El operador encendió el bot creyendo que la sombra lo silenciaría. Es un hueco de
**producto**, no de código: no existe un estado «recibe tráfico, observa, no
contesta» distinto de apagar el bot, y la combinación `bot ON` + `pedido_shadow`
se ignora en silencio.

Un aviso en el log cuando esa combinación aparece habría ahorrado el susto en
segundos. **No se implementó**: cuesta una consulta por turno en el camino
caliente de todos los negocios con bot encendido, y meterlo durante un incidente
—en la rama que estaba desplegada— es exactamente lo que no se debe hacer.
Queda propuesto para decidirlo en frío.
