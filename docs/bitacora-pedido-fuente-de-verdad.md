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
- [x] Regresión de las suites vecinas (38 suites)
- [x] Auditoría de producción en solo lectura
- [ ] PR

## Lo implementado

| Archivo | Qué hace |
|---|---|
| `src/orders/carritoDelPedido.js` (nuevo) | El carrito: reconcilia la propuesta del modelo contra el pedido que ya existía. Módulo puro. |
| `src/orders/evidenciaDeEleccion.js` (nuevo) | Si una palabra del cliente sostiene igual de bien a dos opciones hermanas, no elige ninguna. |
| `src/agent/brain.js` | Engancha la reconciliación; reinyecta el carrito solo en turnos del pedido. |
| `src/agent/session.js` | Cerrar el ciclo vacía el carrito. |
| `src/agent/sesionDurable.js` | El carrito viaja en la foto durable: sobrevive reinicios. |
| `src/orders/validadorOrden.js` | Señalar desempata, no sustituye: un id que contradice al nombre Y a lo que dijo el cliente ya no gana. Las selecciones exigen distinguir. |

## Pruebas de mordida

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

## Regresión: 38 suites vecinas

Se eligieron por importación real: todo lo que toca `brain.js`,
`validadorOrden.js`, `session.js` o `sesionDurable.js`, más la recepción
compartida de WhatsApp y Compras.

**36 de 38 en verde.** Incluye lo que el mandato pide conservar:

| Suite | Qué defiende | Resultado |
|---|---|---|
| `fase-confirmacion-determinista` | confirmación explícita, sin registrar de más | 38/38 |
| `fase-dedupe-nuevo-pedido` | un pedido no se duplica ni se reimprime | 24/24 |
| `fase-preconfirmacion-pricing` | precios, extras y totales reales | 18/18 |
| `fase-promociones` / `fase-promo-informativa` | promociones | 19/19, 18/18 |
| `fase-seguridad-transaccional` | idempotencia y aislamiento | 18/18 |
| `fase-compras-whatsapp` + `-webhook` | **Compras por WhatsApp sigue funcionando** | 13/13 + verde |
| `fase-bot-calla-y-avisa` | silencio, intervención humana, reactivación | 24/24 |
| `fase-negaciones-injustas` | no negar lo que existe | 63/63 |
| `fase-chilaquiles-contexto` | la suite de Codex para este incidente | 11/11 |
| `fase-whatsapp-continuidad`, `fase-agrupamiento-turnos-whatsapp` | reentregas, mensajes agrupados | 13/13, 14/14 |

**Las 2 que fallan, fallan igual en `c859e72`** —el commit que hoy corre en
producción— comprobado en un worktree limpio de ese commit, con la misma base y
las mismas variables:

- `fase-continuidad-webhook`: 8/2 en las dos ramas, los mismos dos casos.
- `fase-whatsapp-invariante-activo`: 13 OK · 2 fallos en las dos ramas (I y J,
  sobre el puente de credenciales por variable de entorno).

Ninguna es de este trabajo. Quedan anotadas, no arregladas: tocarlas sería
entrar en Integraciones, que no es el alcance.

### Dos hallazgos del entorno que valen más que su tamaño

1. **La suite de Codex para este incidente nunca se había ejecutado.**
   `fase-chilaquiles-contexto` apunta el SDK al mock pero no exporta
   `ANTHROPIC_API_KEY`, así que su único caso que llega al modelo —«la
   conversación conserva el borrador aunque el modelo olvide el segundo
   plato»— moría con `Could not resolve authentication method` en cualquier
   máquina sin la llave real. Con la llave puesta pasa 11/11 en las dos ramas:
   la garantía era real, pero nadie lo sabía. Se añade la línea que faltaba.

2. **Nueve suites fallaban por datos de prueba caducados, no por código.**
   `test/.datos-prueba.json` apuntaba a cuatro negocios que ya no existían en
   la base local, y todo lo que insertaba contra ellos moría en
   `..._negocio_id_fkey`. Resembrar los arregló las nueve. Es una nota de
   entorno, pero explica por qué una corrida a ciegas parecía catastrófica.

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
