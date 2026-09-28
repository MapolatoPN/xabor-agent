# Propuesta: botones de WhatsApp para el Mesero (confirmación y opciones cerradas)

> **Estado: propuesta v2 para revisión (Codex). No hay código y no hay
> ninguna decisión tomada.** Base: `7a933eb`; las líneas citadas son de ese
> commit. Producción corre `dfd9854` desde el 28-sep, 19:18 UTC (deployment
> `b4847518`): la auditoría del panel encima de `7a933eb`, que no toca
> ninguno de los archivos citados aquí. La v2 incorpora la revisión de Codex
> del 28-sep y sus tres aclaraciones posteriores; la sección 11 dice dónde
> quedó cada punto. Lo que falta decidir, y quién lo decide, está en la
> sección 9.

## 1. En una frase

Cuando Xabor le hace al cliente una pregunta de **respuesta cerrada**
(confirmar el pedido, aceptar algo ofrecido, elegir producto, salsa,
guarnición, modalidad o forma de pago), la manda con **botones o lista de
WhatsApp**. Cada botón lleva un identificador opaco. El servidor guarda qué
pregunta, qué renglón y qué opción representa, y al tocarlo lo aplica **sin
pasar por el modelo**, pero con todas las validaciones del pedido. El texto
libre sigue valiendo siempre.

## 2. Por qué

### 2.1 El motor híbrido ya existe; lo frágil es interpretar texto corto

El Mesero ya funciona como proponen los análisis externos:
- el modelo propone con herramientas tipadas (`contratoDeHerramientas.js`);
- el ejecutor decide contra la carta publicada;
- el total lo calcula el código;
- el estado canónico está en base de datos;
- hay una sola pregunta pendiente estructurada;
- si no sabe, pasa a una persona.

Pero varios incidentes reales vinieron de **interpretar una respuesta corta o
la confirmación**:

| Incidente | Qué pasó | ¿Lo evitan los botones? |
|---|---|---|
| Confirmaciones naturales | «Sí», «Va», «Dale», «Ok» no producían CONFIRMAR | **Sí**: [Confirmar] no se interpreta |
| `ofrecidos` duplica el producto | El «sí» a «¿Lo confirmo?» agregaba otra unidad | **Sí**: [Agregar]/[No, gracias] van ligados a la pregunta exacta |
| Plato fantasma en el «Confirmo» (T7) | El turno de confirmación daba de alta un artículo mencionado antes | **Sí**: el botón no pasa por el modelo ni por el reconciliador de texto |
| Cópula sin sujeto | «Es a domicilio» o «Es correcto» caían como consulta | **Sí** para modalidad y confirmación. Si el cliente lo escribe, sigue el camino de hoy |
| Selección fragmentada (28-sep) | «Quiero unos chilaquiles» y las preferencias en mensajes aparte | **Parcial**: con `elegir_producto` en botones o lista, el toque no depende del texto |
| Guarnición perdida; sabor y fruta extra confundidos (25-sep) | Respuestas cortas aplicadas al grupo equivocado | **Parcial**: la repregunta con lista no se confunde; lo que escribió en su primer mensaje sigue siendo interpretación |
| «Salsa roja» pregunta por la proteína | Nombres de platillo que contienen la opción | **Parcial**: igual que el anterior |
| Saludo que afirma un cambio sin guardar | Redacción del modelo | **No** |
| Domicilio sin dirección, fechas de programados | Validación y texto libre | **No** |
| Doble envío del outbox, reentregas de Meta | Infraestructura | **No** (ya corregido) |

**Conclusión honesta:** los botones eliminan de raíz una familia de parches,
la de interpretar respuestas cortas y la confirmación, que es la más
frecuente en los incidentes del Mesero. **No** eliminan los errores de
interpretar el primer mensaje libre, ni los de redacción o infraestructura.
Quitan la interpretación del camino cuando se pulsan, pero **no quitan
ninguna validación del pedido**.

### 2.2 El cliente frecuente no se vuelve más lento

- Si escribe todo de corrido («2 chilaquiles verdes con pollo y un
  americano, para llevar, efectivo»), no ve ningún botón de opciones: pasa
  directo al resumen con [Confirmar].
- Los botones solo aparecen donde hoy ya habría una pregunta. Un toque es más
  rápido que escribir.
- **No se propone navegar el menú con botones**: con 76 productos y los
  límites de WhatsApp sería más lento que escribir.

## 3. Lo que ya existe y se reutiliza

- **Pregunta pendiente tipada:** `PENDIENTES` en
  `src/mesero-agente/estadoCanonico.js:56`: `elegir_producto` (nueva en
  `7a933eb`), `elegir_opcion`, `modalidad`, `direccion`, `pago`,
  `fecha_hora`, `confirmar_resumen`, `aceptar_producto`, `aceptar_promocion`,
  `aceptar_pago_ofrecido` y `datos_evento`. Ya lleva `candidatos` u
  `opciones` (`instrucciones.js:85`).
- **`elegir_producto`** (`seleccionDeProducto.js`): cuando el cliente nombra
  una familia que coincide con 2 a 20 productos y el carrito está vacío. Va
  ligada al ciclo. Al resolverse, reconstruye la solicitud literal y cruza
  los ids contra la carta vigente. Su pregunta puede ser por el producto o
  por un grupo común a todos (`preguntaDeSeleccion`).
- **Identidad de la pregunta:** `guardarDialogo`
  (`contratoConversacional.js:83`) le pone un `dialogo_id` nuevo a la
  pendiente en cada respuesta. `respuestaCanonica` (línea 107) guarda en el
  diálogo la huella del pedido cuando la respuesta es el resumen.
- **La pregunta solo autoriza tras el envío:** `acusarDialogo` (línea 97).
  Al entregar, la fila del outbox guarda el `wamid_salida`
  (`entregaDeRespuestas.js:202`). Desde `7a933eb` está escrito: lo que llega
  antes del acuse puede aportar preferencias, pero no aceptar una oferta ni
  confirmar (`docs/mesero-seleccion-fragmentada-20260928.md`).
- **Huella del resumen:** `huellaDelResumen` (`resumenDelPedido.js:146`) es
  el JSON **completo** del resumen: renglones, opciones, precios, modalidad,
  pago, fecha, datos del cliente y totales. No es un hash.
  `resumenSigueVigente` (línea 161) compara dos huellas enteras.
- **Escritura del turno con control de versión:** `confirmarTurno`
  (`persistenciaDelTurno.js:131`) guarda estado, outbox y bitácora del turno
  en una transacción, con `UPDATE … WHERE revision = $4` (línea 160). Si
  otro proceso escribió antes, lanza `ConflictoDeVersionError` y el canal
  repite el turno (`canalDelAgente.js:1177`).
- **Confirmación única por ciclo:** índice
  `uq_agente_confirmacion_conversacion`
  (`migrations/084_agente_operaciones.sql:67`). Protege **solo** la creación
  del pedido.
- **Camino determinista para respuestas cortas:** `respuestaCorta.js`,
  `continuidadDeterminista.js` y `soloElecciones`
  (`contratoConversacional.js:70`).
- **Outbox:** `entregarRespuesta` (`entregaDeRespuestas.js:245`) llama a
  `enviar({ negocioId, telefono, texto })`. Hoy solo manda texto.

## 4. Lo que falta (hallazgos en `7a933eb`)

1. **Enviar:** ni el outbox ni `enviarMensaje` (`whatsapp-meta.js:401`)
   mandan mensajes `interactive`.
2. **Recibir:** el webhook descarta todo lo que no sea
   `text`/`image`/`document` (`whatsapp-meta.js:2207`). Eso incluye
   `interactive` y también `button`, que es como llega el toque de un botón
   de plantilla.
3. **El lote se aplana en texto:** los mensajes que llegan juntos se unen
   con `join('\n')` antes del agente (`whatsapp-meta.js:2593`). Un toque
   perdería su identificador y su `context.id`.
4. **La segunda elección de un grupo no tiene estado.** Un grupo deja de
   estar pendiente en cuanto cumple su mínimo (`gruposSinElegir`,
   `vistaDelPedido.js:121`). Y `modificar_linea` propone
   `cambiar_modificador` con la lista que trae la llamada
   (`ejecutorDeHerramientas.js:711`), que **sustituye** la del grupo
   (`conGrupo`, `motorTransaccional.js:146`). Un segundo toque aplicado así
   borraría la primera salsa.
5. **El esquema de la pendiente es estricto** (`.strict()` en
   `EsquemaPendiente`, `estadoCanonico.js`): un build anterior rechaza un
   campo o un tipo que no conoce, la misma advertencia que trae
   `elegir_producto` para revertir. Por eso la asociación de los botones va
   en su propia tabla (5.2).
6. `whatsapp-meta.js` es **componente protegido**: el cambio exige explicar
   el riesgo y la aprobación del dueño.

## 5. Diseño

### 5.1 Qué pregunta lleva qué

| Pendiente | Formato | Ejemplo |
|---|---|---|
| `confirmar_resumen` | 2 botones | [Confirmar] [Cambiar algo] |
| `aceptar_producto`, `aceptar_promocion`, `aceptar_pago_ofrecido` | 2 botones | [Sí, agrégalo] [No, gracias] |
| `elegir_producto` con 2 o 3 opciones | botones | lo que pregunte `preguntaDeSeleccion`: productos o el grupo común |
| `elegir_producto` con 4 a 10 | lista | — |
| `elegir_producto` con 11 a 20 | texto, como hoy | — |
| `elegir_opcion` con ≤3 candidatos | botones | Salsa: [Verde] [Roja] [Suiza] |
| `elegir_opcion` con 4 a 10 candidatos | lista | Guarnición: lista de 6 |
| `elegir_opcion` con más de 10 | texto, como hoy | — |
| `elegir_opcion` en un grupo que admite **2** | fase 4 (5.8) | Salsa de los Chilaquiles Mixtos |
| `modalidad` | botones con las que el negocio tenga activas | [Recoger] [A domicilio] |
| `pago` | botones o lista con las formas habilitadas para el bot | [Efectivo] [Transferencia] |
| `direccion`, `fecha_hora`, `datos_evento` | texto, como hoy | — |

Límites de WhatsApp:
- máximo 3 botones, con títulos de hasta 20 caracteres;
- listas de hasta 10 renglones, con título de hasta 24 caracteres y
  descripción de hasta 72;
- **ventana de 24 h:** Meta la cuenta desde el último mensaje del cliente.
  Un turno puede procesarse tarde (reintento, despachador, reinicio), así
  que no se da por abierta: se comprueba al enviar. Si está cerrada, no sale
  ni texto libre ni interactivo, y aplica la política de rechazo de hoy.

Un nombre que no cabe se abrevia en el título y va completo en la
descripción, o se usa texto. El **cuerpo** del mensaje repite siempre la
pregunta en texto, para que se entienda aunque un cliente no vea los botones.

### 5.2 Identificador opaco y asociación guardada

El botón solo lleva `xb1:<token>`, con un token aleatorio de 128 bits
(22 caracteres en base64url). No lleva la huella, ni índices, ni `linea_id`,
ni datos del cliente: todo lo que va en el identificador pasa por Meta y
regresa.

Cada token apunta a una **asociación guardada e inmutable**. Propuesta: una
tabla nueva, `agente_botones`, que se escribe en la misma transacción del
turno que hace la pregunta (`confirmarTurno`):

| Campo | Qué guarda |
|---|---|
| `token` | la llave; única |
| `negocio_id`, `session_id`, `ciclo` | de qué negocio, qué cliente y qué pedido |
| `dialogo_id` | la pregunta exacta que se mostró |
| `accion` | `confirmar`, `cambiar_algo`, `aceptar`, `rechazar`, `elegir_producto`, `elegir_opcion`, `agregar_a_grupo`, `cerrar_grupo`, `modalidad`, `pago` |
| `linea_id`, `grupo` | cuando aplica: el renglón y el grupo exactos |
| `valor` | la opción, el `producto_id` o la clave canónica, tal como se mostró |
| `precio_mostrado` | el precio o el extra que vio el cliente |
| `huella` | solo en `confirmar`: la huella **completa** del resumen mostrado |
| `outbox_clave` | la fila del outbox que lo lleva, y con ella su `wamid_salida` |
| `consumido_at`, `consumido_por_wamid` | cuándo y con qué mensaje se consumió la pregunta (5.3) |

No existe «la opción 2»: cada renglón mostrado tiene su propio token y su
propio valor, y nunca se resuelve contra una lista regenerada cuyo orden
pueda variar.

### 5.3 Validación y consumo

Un toque se aplica **solo si se cumple todo esto**:
1. el token existe y es de este negocio y de este cliente;
2. su `ciclo` es el vigente y no está terminado (confirmado, cancelado o
   con una persona);
3. su `dialogo_id` es el de la pregunta pendiente actual y no se ha
   consumido;
4. el `context.id` del mensaje es el `wamid_salida` de su `outbox_clave`;
5. en `confirmar`, su `huella` es idéntica, completa, a `huellaDelResumen`
   del pedido actual, como en `resumenSigueVigente`;
6. contra la carta vigente, el producto y la opción siguen publicados y
   disponibles, y el precio es el mostrado. Si el precio cambió, no se
   aplica: se muestra el precio nuevo y se vuelve a preguntar.

**Se consume la pregunta, no el botón.** La primera respuesta válida a un
`dialogo_id` lo consume, y los demás botones de esa pregunta ya no valen:
[Sí] y después [No] no se aplican los dos. Qué se contesta a cada toque lo
fija 5.5.

**El consumo y el efecto van en la misma transacción** que el estado, con el
control de versión de `confirmarTurno`: o quedan los dos, o ninguno. El
estado sigue siendo la fuente de verdad (la pregunta consumida deja de ser
la pendiente); la tabla lo registra además, con
`UPDATE … WHERE consumido_at IS NULL`, como segunda barrera y para auditar.
Así un segundo toque no tiene efecto:
- aunque traiga otro `wamid`, que la deduplicación por `wamid` no detiene;
- aunque llegue a otro proceso: uno gana, el otro choca por versión, repite
  el turno y ya la encuentra consumida;
- aunque llegue después de un reinicio: el consumo está en la base, no en
  memoria.

Esto vale para **todas** las acciones (confirmar, aceptar un producto, una
promoción o un pago, elegir producto u opción, modalidad y pago). El índice
único de confirmación solo cubre la creación del pedido.

El título del botón nunca decide nada.

### 5.4 Recepción: eventos, lotes y acuse (fase 0)

- **Evento estructurado.** `prepararMensajePersistido` convierte un
  `interactive` (`button_reply` o `list_reply`) en un evento con token,
  título, `context.id` y `wamid`. Se guarda en `mensajes` con el título como
  texto (p. ej. «▸ Confirmar»), para que el panel lo muestre. Puede aparecer
  en el historial como contexto, marcado como toque. **Nunca** se une al
  texto del turno, y su título no autoriza nada.
- **Mismas barreras, mismo orden.** El lote pasa por
  `atenderSolicitudHumanaInmediata`, el interruptor maestro, la pausa, la
  toma por una persona y el canario (`whatsapp-meta.js:2576-2592`) antes de
  mirar un solo toque. Ser un botón no salta ninguna.
- **Qué es un lote.** Hoy un lote se atiende cuando pasan 6 s sin mensajes
  nuevos, o 30 s después del primero (`whatsappContinuidad.js:97`, con
  `ventanaMs = 6000`). Un texto escrito dentro de esa ventana cae en el
  mismo lote que el toque; uno posterior cae en otro. El lote conserva el
  orden y el tipo de cada evento.
- **Toque y texto en el mismo lote** (propuesta, D1): **ningún toque se
  ejecuta.** El texto sigue el camino de hoy y la respuesta del turno vuelve
  a hacer la pregunta vigente, con botones nuevos.
  - [Confirmar] + «mejor sin pollo»: no se confirma. El texto cambia el
    pedido y sale un resumen nuevo.
  - [Confirmar] + «gracias»: tampoco. Sale otra vez el resumen. Cuesta un
    toque de más en un caso raro, a cambio de no confirmar nunca mientras el
    cliente escribe otra cosa.
  - [Sí, agrégalo] + «mejor no»: no se agrega nada.
- **Toque y texto en lotes distintos:** ver la tabla de abajo. La regla del
  mismo lote no alcanza, porque un toque ya aplicado no se cancela aunque el
  texto llegue después.
- **Dos toques seguidos**, en el mismo lote o en dos: el primero válido
  consume la pregunta y el segundo no hace nada. La única respuesta es la
  del primero (5.5).
- **Toque antes del acuse.** Si el `context.id` todavía no está registrado
  como `wamid_salida`, el toque ni se ejecuta ni se tira: se guarda y se
  vuelve a evaluar cuando llegue el acuse, con una espera acotada
  (propuesta, D5: 2 minutos). Si la fila del outbox termina rechazada o
  incierta, o se acaba la espera, no se aplica y sigue 5.5. Es la regla de
  hoy: antes del acuse nada acepta ni confirma.
- **Botón de plantilla** (`type: 'button'`): se guarda para el panel y no se
  ejecuta.

#### Toque y texto en lotes distintos (propuesta, D3)

| Orden | Qué pasa |
|---|---|
| Toque de opción, oferta, modalidad o pago; el texto llega en un lote posterior | El toque ya quedó aplicado y **no se deshace solo**. El texto se interpreta sobre el pedido ya cambiado, como hoy un «sí» escrito seguido de un «mejor no», y puede cambiarlo: antes de confirmar, modificar es legal. El resumen siguiente trae una huella nueva |
| [Confirmar] aplicado; el texto llega en un lote posterior | El pedido ya existe, con folio y comanda. **No se deshace nada automáticamente:** con el pedido confirmado ninguna mutación es legal (`maquinaDeEstados.js:81`), y un cambio pasa a una persona (`pedir_humano`, `instrucciones.js:284`), igual que hoy después de un «Confirmo» escrito |
| El texto llega primero y el toque en un lote posterior | El texto ya reemplazó la pregunta pendiente. El toque es de una pregunta reemplazada: no se aplica (5.3) y se contesta según 5.5 |

La ventana de 6 s es la única protección entre un [Confirmar] y un cambio
escrito justo después. También retrasa 6 s el efecto de cada toque;
acortarla para los botones quitaría esa protección (D2).

### 5.5 Qué se contesta: una respuesta como máximo por pregunta

Política propuesta (D4): **cada pregunta mostrada produce como máximo una
respuesta a sus toques**, sin importar cuántas veces se toque, en qué
proceso o después de qué reinicio. Todo toque queda guardado y el panel lo
muestra, se conteste o no.

| El toque es de… | Efecto | Respuesta |
|---|---|---|
| la pregunta vigente, y pasa todo 5.3 | se aplica | la del turno, una sola |
| una pregunta ya consumida: doble toque, [Sí] y luego [No], otro proceso, un reinicio | ninguno | **ninguna**: ya la dio el primer toque |
| una pregunta tocada en un lote con texto (5.4) | ninguno | la del turno del texto, que vuelve a hacer la pregunta vigente; cuenta como su respuesta única |
| una pregunta reemplazada (el pedido cambió después de mostrarla), primer toque | ninguno | **una**: avisa que eso ya cambió y repite la pregunta vigente, solo si el flujo automático está activo |
| esa misma pregunta reemplazada, toques siguientes | ninguno | ninguna |
| un ciclo terminado u otro ciclo | ninguno | ninguna |

El aviso de la pregunta reemplazada existe porque callar ahí es peligroso:
quien toca un [Confirmar] viejo cree que confirmó. Se registra como la
respuesta de esa pregunta en la misma transacción que la manda (5.3), así
que dos procesos no la contestan dos veces.

**Flujo automático activo** quiere decir que se cumple todo esto: el bot
del negocio está encendido; la conversación no está pausada ni tomada por
una persona; el teléfono está dentro del canario, si hay canario; el ciclo
sigue abierto; y hay una pregunta pendiente. Si falta cualquiera, **no se
manda nada**. Un botón viejo nunca reabre una conversación, nunca se la
quita a una persona y nunca enciende el bot.

**Con la función apagada** (cualquiera de las dos llaves de 5.7), no salen
botones nuevos y los toques de botones ya enviados **no se ejecutan** (D7).
Si el flujo automático está activo, la respuesta única de esa pregunta es la
pregunta vigente, en texto.

### 5.6 Envío

1. El turno termina con una pendiente de la tabla 5.1. Una función pura
   nueva (`src/mesero-agente/interactivos.js`) arma el mensaje interactivo y
   las filas de la asociación a partir de la pendiente y la vista del
   pedido. Si no cabe (títulos, colisión al abreviar, más de 10 opciones),
   devuelve `null` y sale texto.
2. En la transacción del turno se escriben el estado, la fila del outbox con
   `carga.interactivo` y las filas de `agente_botones`. `entregarRespuesta`
   le pasa `interactivo` a `enviar`, que antes comprueba la ventana de 24 h.
   Si Meta rechaza el mensaje, se aplica la política de rechazo de hoy.
   **Nunca se reintenta como texto dentro del mismo reclamo**, para no
   enviarlo dos veces.
3. Al registrar el acuse, se evalúan los toques retenidos de esa fila (5.4).
4. Si el cliente escribe en vez de tocar, el camino es el de hoy.

### 5.7 Interruptores y reversión

Siguen el patrón actual de dos llaves (`modoDelPedido.js`):
- en el proceso: `WHATSAPP_INTERACTIVOS=true`, que sirve de apagado
  inmediato;
- en el negocio: `configuracion.whatsapp_interactivos_v1 = 'true'`.

Hacen falta las dos. Aplica solo al agente nuevo (`mesero_agente_v1`); el
bot legacy (`brain.js`) no se toca.

**Revertir.** Hasta la fase 3, la asociación vive en su tabla y la
pendiente no cambia de esquema, así que un build anterior las ignora. Pero
un build **sin la fase 0** vuelve a descartar en silencio los toques de los
botones ya enviados. Por eso primero se apaga la llave y después se
revierte. La tabla nueva es una migración más en el arreglo `SCRIPTS` del
predeploy (`scripts/predeploy-run-032-033.mjs`); su número lo fija M2.

### 5.8 Grupos que admiten más de una opción (fase 4)

Los botones y las listas de WhatsApp son de **selección única**: cada toque
manda una respuesta. En la carta real de Obispado (28-sep, solo lectura),
**Chilaquiles Mixtos** ($205) tiene tres grupos obligatorios de 1 a 2
opciones:
- Salsa, con 5 opciones;
- Proteína, con 7 (3 cuestan +$30);
- Guarniciones, con 7 (3 cuestan +$30).

«Chilaquiles Sencillos» también admite 2 guarniciones, de 8 opciones. Además,
**«Bistec en salsa», «Queso panela en salsa» y «Chicharrón cuerito en salsa»
aparecen en Proteína y también en Guarniciones**, que es justo el caso que
hoy obliga al modelo a «interpretar la función en la frase»
(`agenteDelMesero.js:226`).

**Dos toques por grupo, con estado explícito.** Mandar dos listas no basta
(sección 4, punto 4). Hace falta:
1. **Primera lista:** todas las opciones del grupo, con «+$30» en la
   descripción del renglón. El toque aplica una opción a ese renglón y ese
   grupo.
2. **Elección abierta:** si el grupo admite otra, queda guardado que la
   elección de ese renglón y ese grupo sigue abierta, con la primera opción
   puesta. Mientras siga abierta, el motor no pasa al grupo siguiente.
3. **Segunda lista:** las opciones que quedan, con la acción
   `agregar_a_grupo`, más un renglón **«Listo con estas»**
   (`cerrar_grupo`). El toque aplica la **unión** de la primera y la
   segunda, validada contra el máximo; nunca `cambiar_modificador` con la
   segunda sola.
4. **«Listo con estas»** cierra la elección sin cambiar las opciones.
5. **Si el cliente escribe con la elección abierta, no se cierra sola.**
   Cerrarla por escribir podría repetir el problema de la segunda salsa: un
   «y roja» se atendería con la elección ya cerrada y podría sustituir a la
   primera. Antes de tocar el grupo se decide qué hace el texto con él
   (propuesta, D9):
   - **añade** (nombra otra opción del grupo: «y roja», «también roja»): se
     aplica la unión, validada contra el máximo; si se pasa, no se aplica y
     se pregunta;
   - **sustituye** (cambio explícito: «mejor roja», «cambia la verde por
     roja»): se reemplaza;
   - **termina** (cierre explícito: «así está bien», «nada más», «solo
     verde»): se cierra sin cambiar las opciones;
   - **habla de otra cosa** («para llevar», «y un café»): eso se atiende por
     el camino de hoy y la elección **sigue abierta**; la respuesta vuelve a
     preguntarla;
   - **no se puede decidir:** no se toca el grupo y se pregunta.

   La decisión es determinista, sin modelo, y se toma sobre el renglón y el
   grupo de la elección abierta. No parte de cero:
   `varianteDelPedido.js:100` ya aparta «no», «o», «cambia», «reemplaza» y
   «sustituye» de las adiciones, y la línea 101 reconoce la petición
   aditiva (`PETICION_ADITIVA`, línea 11) que agregó `00e82ef`.
6. «Verde y roja» escrito de entrada, sin elección abierta, sigue aplicando
   las dos (`soloElecciones`).

Es imposible que un toque de Guarniciones caiga en Proteína: la asociación
guarda el grupo.

La elección abierta necesita un tipo de pendiente nuevo (D10). Como con
`elegir_producto`, un build anterior no lo reconoce, así que hay que
revisarlo antes de revertir.

**Descartado:** poner combinaciones en una sola lista. Con 5 salsas, 1 o 2
dan 15 combinaciones y no caben en 10 renglones.

**Títulos:** «Chicharrón cuerito en salsa» mide 27 caracteres y el título de
un renglón admite 24. Va como «Chicharrón cuerito» con la descripción «en
salsa · +$30». La colisión con «Chicharrón prensado» se detecta antes de
enviar (8).

### 5.9 Formulario de WhatsApp (Flows): prueba de viabilidad aparte

Verificado en la documentación de Meta (28-sep), **no probado con
clientes**:
- selección múltiple con límites: `CheckboxGroup` tiene
  `min-selected-items` y `max-selected-items`, y los dos aceptan datos
  (`${data...}`); hasta 20 opciones por grupo, con títulos de hasta 30
  caracteres;
- un formulario genérico, «Arma tu platillo», con los grupos, las opciones,
  los extras y los límites de ESE producto en `flow_action_payload.data`
  (`flow_action: navigate`), sin servidor aparte;
- la respuesta llega al mismo webhook como `interactive.type =
  "nfm_reply"`, con `response_json` (que trae el `flow_token`) y
  `context.id`. El `flow_token` sería un token de 5.2 y se valida igual;
- requisitos: negocio verificado en Meta y buena calidad de mensajes; el
  formulario se publica y, publicado, ya no se edita: se versiona;
- según Meta, funciona en la app y en WhatsApp Web desde diciembre de 2025.

**Lo que no está comprobado:** que se vea bien en los teléfonos reales de
los clientes, y que haya forma de saber cuándo no. Meta no avisa si el
teléfono no puede mostrarlo, así que no hay cambio automático a listas. Por
eso el cuerpo lleva la pregunta en texto y el texto libre sigue valiendo.

Merece una prueba de viabilidad propia, sobre todo con platillos de varios
grupos. **No es requisito** para las fases 0 a 3. Si sale bien, puede
reemplazar los dos toques de la fase 4.

## 6. Fases

| Fase | Alcance | ¿Lo ve el cliente? | Tamaño |
|---|---|---|---|
| **0** | Recepción segura: eventos estructurados, lotes mixtos, toque antes del acuse, barreras, tabla de asociación y consumo, llaves. **No se envía ningún botón** | No | M |
| **1** | Confirmación: [Confirmar] [Cambiar algo]. «Cambiar algo» invalida la confirmación **sin borrar el carrito** y le pide al cliente que escriba el cambio | Sí | M |
| **2** | Aceptar o rechazar ofertas: producto, promoción, pago ofrecido | Sí | S |
| **3** | Opciones simples: grupos de una opción, `elegir_producto`, modalidad y pago | Sí | M |
| **4** | Grupos de más de una opción: dos toques (5.8) o formulario, según la prueba de 5.9 | Sí | M |
| Aparte | Prueba de viabilidad de Flows (5.9) | — | S |
| Aparte | «Repetir mi último pedido» para clientes frecuentes | — | M |

Cada fase: canario solo con el teléfono del dueño, igual que el actual.

## 7. Pruebas propuestas

- **Unitarias:**
  - armar el mensaje para cada tipo de pendiente, incluida
    `elegir_producto`;
  - respetar los límites de caracteres y detectar colisiones al abreviar;
  - validar el token: formato inválido; token inexistente; de otro negocio,
    de otro cliente o de otro ciclo; pregunta consumida o que ya no es la
    vigente; `context.id` ajeno; huella distinta en **un solo** campo
    (precio, opción, modalidad, pago, fecha, cliente); producto agotado;
    precio cambiado.
- **Fase 0, con servidor real y Meta simulado:**
  - un toque nunca llega al texto del turno;
  - cada barrera (persona, bot apagado, pausa, fuera del canario, ciclo
    terminado) le gana a un toque: se guarda, no se responde, no se
    reactiva nada;
  - [Confirmar] + «mejor sin pollo» dentro de la ventana: mismo lote, no
    confirma; el pedido cambia por el texto y sale un resumen nuevo;
  - [Confirmar] y, pasada la ventana, «mejor sin pollo»: el pedido queda
    confirmado una sola vez, no se modifica y el cambio pasa a una persona;
  - [Sí, agrégalo] y, pasada la ventana, «mejor no»: el texto se atiende
    sobre el pedido ya cambiado y nunca quedan dos unidades;
  - texto primero y toque después, en otro lote: el toque es de una
    pregunta reemplazada, no se aplica y recibe una sola respuesta (5.5);
  - toque antes del acuse: se retiene y aplica solo tras el acuse; si la
    fila queda rechazada o incierta, no se aplica;
  - llave apagada: los botones viejos no se ejecutan, y solo se contesta en
    texto si el flujo automático está activo.
- **Duplicados, para cada acción** (confirmar, aceptar producto, promoción y
  pago, elegir producto y opción, modalidad, pago):
  - dos toques con `wamid` distintos: un solo efecto y una sola respuesta;
  - [Sí] y luego [No] de la misma pregunta: solo el primero y una sola
    respuesta;
  - dos procesos a la vez: un solo efecto (el otro choca por versión) y una
    sola respuesta;
  - un reinicio entre el primer toque y el segundo: un solo efecto y una
    sola respuesta;
  - reentrega del mismo `wamid`: ningún efecto (la continuidad de hoy).
- **Una respuesta por pregunta (5.5):**
  - una pregunta consumida no recibe otra respuesta por más que se toque;
  - una pregunta tocada en un lote con texto no recibe otra respuesta si se
    vuelve a tocar después;
  - una pregunta reemplazada recibe una sola respuesta aunque se toque tres
    veces, y ninguna si el flujo automático no está activo;
  - dos procesos que atienden a la vez toques de la misma pregunta
    reemplazada mandan una sola respuesta.
- **Outbox:** la fila interactiva se reclama, se envía, recibe su acuse y
  entra a la conciliación igual que una de texto. Un rechazo de Meta no
  produce un segundo envío. Con la ventana de 24 h cerrada no se envía.
- **Grupos de 2 (fase 4):**
  - el segundo toque conserva la primera opción;
  - «Listo con estas» cierra sin cambiar nada;
  - con la elección abierta no se pasa al grupo siguiente;
  - nunca se excede el máximo;
  - por escrito, con la elección abierta: «y roja» añade, «mejor roja»
    sustituye, «así está bien» cierra, «para llevar» se atiende y la
    elección sigue abierta, y un texto que no se puede clasificar no toca el
    grupo y pregunta. Ningún texto la cierra solo.
- **Mutaciones.** Cada una debe hacer caer su prueba:
  - quitar la validación de ciclo, de pregunta vigente, de consumo, de
    `context.id`, del acuse o de la huella;
  - comparar un prefijo de la huella en vez de la huella completa;
  - resolver un índice contra la lista regenerada;
  - aplicar por el título en lugar del token;
  - unir el toque al texto del lote;
  - ejecutar un toque en un lote con texto;
  - consumir fuera de la transacción del efecto;
  - contestar un toque con el bot apagado o con una persona atendiendo;
  - contestar un toque de una pregunta ya consumida, o contestar dos veces
    una pregunta reemplazada;
  - permitir que un texto posterior modifique un pedido ya confirmado;
  - aplicar la segunda opción de un grupo como sustitución;
  - cerrar la elección abierta al recibir cualquier texto.
- **Regresión:** `test:incident`, `mesero:tools`, `mesero:replay`, el
  canario abierto y cerrado, la continuidad del webhook,
  `check-seleccion-fragmentada`, `check-correccion-variante` y
  `fase-seleccion-fragmentada-webhook`.

## 8. Riesgos

- **Toca `whatsapp-meta.js`** (componente protegido), en envío y recepción.
- **Botones viejos:** WhatsApp los deja visibles en el chat. La asociación y
  el consumo (5.2, 5.3) son la barrera; sin ellos, un toque tardío
  confirmaría un resumen viejo.
- **Lotes mixtos:** la regla estricta cuesta un toque de más cuando el
  cliente toca y además escribe. Se mide en el canario.
- **Un [Confirmar] ya aplicado no se deshace.** Un cambio escrito después de
  la ventana de 6 s pasa a una persona, como hoy después de un «Confirmo».
- **La ventana de 6 s retrasa cada toque.** Acortarla para los botones
  quitaría la protección del mismo lote (D2).
- **Toque antes del acuse:** se retiene en vez de tirarse; hay que acotar la
  espera y probar el caso de la fila incierta.
- **Revertir:** un build sin la fase 0 pierde en silencio los toques de
  botones ya enviados. Primero se apaga la llave.
- **Títulos truncados:** dos opciones pueden verse iguales al abreviarlas.
  Hay que detectar la colisión y caer a lista o a texto.
- **Panel:** el chat del panel debe mostrar qué botón tocó el cliente.
- **Migración nueva** (`agente_botones`): tiene que entrar al arreglo
  `SCRIPTS` del predeploy, o no llega a producción.
- **Costo:** un turno por botón no llama al modelo, así que baja.

## 9. Decisiones pendientes

**Nada de lo que sigue está decidido.** Lo que propone esta v2 es solo el
punto de partida de la revisión. Las decisiones de diseño las revisa Codex y
las aprueba Mario; las del dueño son solo de Mario. Ninguna fase empieza
mientras siga abierta una decisión que la bloquee.

### 9.1 De diseño

| # | Qué hay que decidir | Lo que propone esta v2 | Alternativa | Bloquea |
|---|---|---|---|---|
| D1 | Toque y texto en el mismo lote | No se ejecuta ningún toque; se atiende el texto (5.4) | Aplicar los toques de opción antes que el texto | Fase 0 |
| D2 | Ventana antes de atender un toque | La de hoy, 6 s: junta un [Confirmar] con el cambio escrito justo después (5.4) | Acortarla para los botones: más rápido, pero sin esa protección | Fase 1 |
| D3 | Texto que llega en otro lote después de un toque ya aplicado | No se deshace nada solo. Antes de confirmar, el texto cambia el pedido como hoy; después de [Confirmar], el cambio pasa a una persona (5.4) | Una espera adicional solo para [Confirmar] | Fase 1 |
| D4 | Respuestas a los toques que no se aplican | Como máximo una respuesta por pregunta; una pregunta reemplazada avisa una sola vez (5.5) | Callar siempre; el riesgo es que quien tocó un [Confirmar] viejo crea que confirmó | Fase 0 |
| D5 | Toque antes del acuse | Se retiene, con una espera acotada de 2 minutos (5.4) | No aplicarlo y volver a preguntar | Fase 0 |
| D6 | Dónde vive el consumo | Estado canónico con control de versión, y la tabla como segunda barrera (5.3) | La tabla como única fuente | Fase 0 |
| D7 | Llave apagada con botones ya enviados | No se ejecutan; si el flujo está activo, se contesta en texto (5.5) | Que sigan valiendo los que pasen todas las validaciones | Fase 0 |
| D8 | `elegir_producto` cuando `preguntaDeSeleccion` pregunta por un grupo común | Los botones son las opciones de ese grupo, y el toque se resuelve como `resolverSeleccion`: reconstruir la solicitud y cruzar ids | Preguntar siempre por el producto | Fase 3 |
| D9 | Texto con la elección abierta: qué añade, qué sustituye, qué termina y qué habla de otra cosa | Clasificación determinista a partir de las reglas de `varianteDelPedido.js`; si no se puede decidir, se pregunta; nunca se cierra sola (5.8) | — | Fase 4 |
| D10 | Cómo se guarda la elección abierta | Un tipo de pendiente nuevo, con el mismo cuidado al revertir que `elegir_producto` (5.8) | Expresarla sin tocar el esquema | Fase 4 |
| D11 | Dos toques o formulario para los grupos de más de una opción | Lo decide la prueba de viabilidad de Flows (5.9) | — | Fase 4 |

### 9.2 Del dueño (Mario)

| # | Qué hay que decidir | Bloquea |
|---|---|---|
| M1 | Aprobar el cambio en `whatsapp-meta.js`, que es componente protegido | Fase 0 |
| M2 | Aprobar la tabla `agente_botones`, que es una migración nueva. No puede usar la 101 ni la 102: ya son de la auditoría del panel | Fase 0 |
| M3 | Autorizar el canario de cada fase con su teléfono | Cada fase visible |
| M4 | Revisar en Meta que el negocio esté verificado y cómo va la calidad de sus mensajes | Prueba de Flows |
| M5 | Prioridad frente a los fallos abiertos del bot. Esta propuesta no corrige ninguno: Codex señaló el del licuado (28-sep), que se corrige y se prueba aparte | El orden de trabajo |

## 10. Lo que no incluye

- Navegar el menú con botones.
- El catálogo de Meta (Commerce).
- Plantillas de mensaje fuera de la ventana de 24 h.
- Cambiar el bot legacy.
- Corregir fallos abiertos del bot: cada uno se corrige y se prueba aparte.
- Activar nada en producción.

## 11. Cambios por la revisión de Codex (28-sep)

**Revisión de la v1:**

| Punto de la revisión | Comprobado en `7a933eb` | Dónde queda |
|---|---|---|
| 1. Una huella de 12 caracteres no sirve | `huellaDelResumen` es un JSON: todo resumen con renglones empieza con `{"items":[["` | Token opaco y huella completa del lado del servidor (5.2, 5.3) |
| 2. Asociación guardada e inmutable por botón | — | Tabla `agente_botones`; sin «opción 2» (5.2) |
| 3. Texto y botones en el mismo lote | `join('\n')` en `whatsapp-meta.js:2593` | Eventos estructurados, regla de lotes mixtos, toque antes del acuse (5.4) |
| 4. La segunda elección | `gruposSinElegir` se da por cumplido con el mínimo; `cambiar_modificador` sustituye el grupo | Elección abierta, unión y «Listo con estas» (5.8, fase 4) |
| 5. Duplicados en todas las acciones | El índice único solo cubre la creación del pedido | Consumo en la transacción del efecto y pruebas por acción (5.3, 7) |
| 6. Apagado y persona primero | Barreras en `whatsapp-meta.js:2576-2592` | 5.4, 5.5 y 5.7 |
| Base de producción | Producción corre `7a933eb` | Encabezado; `elegir_producto` en 3 y 5.1 |
| Ventana de 24 h | — | Se comprueba al enviar (5.1) |
| Flows | — | Prueba de viabilidad aparte, sin suponer soporte ni cambio a listas (5.9) |
| Fases | — | Recepción segura primero; luego confirmación; ofertas, opciones simples y multiselección por separado (6) |

**Aclaraciones de Codex sobre la v2 (28-sep, 19:12 UTC):**

| Aclaración | Comprobado en `7a933eb` | Dónde queda |
|---|---|---|
| Texto y botón en lotes distintos: la regla del mismo lote no cancela un toque ya ejecutado | Un lote se atiende tras 6 s sin mensajes (`whatsappContinuidad.js:97`); con el pedido confirmado no hay mutación legal (`maquinaDeEstados.js:81`) | Tabla de lotes distintos (5.4), D2 y D3, pruebas (7) |
| Segunda opción escrita: cerrar la elección al escribir podría repetir lo de la segunda salsa | `cambiar_modificador` sustituye el grupo (`motorTransaccional.js:146`) | Añade, sustituye, termina o habla de otra cosa, sin cerrarse sola (5.8); D9 |
| Doble toque: la v2 decía en un sitio que se muestra el pedido y en otro que hay una sola respuesta | — | Una respuesta como máximo por pregunta (5.5), D4, pruebas (7) |

Preguntas de la v1 que la revisión resolvió: la huella (token opaco), «Cambiar
algo» (lo escribe el cliente, sin borrar el carrito) y el `linea_id` (va en
la asociación, no en el identificador). Las preguntas sobre Flows pasan a su
prueba de viabilidad. Las seis preguntas abiertas de la v2 son ahora las
decisiones D1, D5, D6, D7, D8 y D10 (9.1).
