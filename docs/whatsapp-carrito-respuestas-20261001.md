# Carrito abierto, respuestas y frases de entrada — 1 oct 2026

## Incidente

Mapolato Obispado, 1-oct-2026, 12:08–12:58 UTC, con producción en `f8dcfb6`.
Una clienta real quería mandar unos chilaquiles de regalo. Todo se reconstruyó
desde la base de producción en solo lectura: `agente_turnos`,
`agente_outbox`, `agente_actividad_formulario` y `whatsapp_entradas`.

1. **No salió ni el menú ni el formulario.** «Buenos días / ¿Hablo a Mapolato
   Obispado?», «Me gustaría ordenar un platillo» y «Le podría encargar un
   platillo de desayuno» no encajan en `intencionDeEntrada.js`, que exige
   frases casi literales («Me gustaría ordenar», sin «un platillo»). Las tres
   fueron al modelo, y el modelo contestó con texto.
2. **El carrito se invalidó mientras ella lo tenía abierto.** Mandó el pedido
   y, 17 s después, la dirección. El primer turno tardó 33 s; al guardarse,
   la dirección ya esperaba turno. El segundo turno falló en el proveedor
   (`fallo_proveedor_sin_efectos`) y no aplicó nada, pero mandó otro carrito.
   Ese carrito nuevo invalidó el que ella había abierto 16 s antes: el
   formulario le respondió «ya no está disponible» (`no_disponible`, 12:51:47).
   Lo mismo ocurrió a las 12:54:29.
3. **El aviso de la falla quedó tapado.** El texto «No pude completar tu último
   mensaje» se reemplazó por el texto fijo del carrito. Su dirección se perdió
   sin que nadie se lo dijera.
4. **Cuatro preguntas recibieron solo «Tu carrito».** «¿Qué tipo de pago es?»,
   «¿Qué es el enlace de pago?», «¿Me podrían explicar?» y «¿Me podrían apoyar
   con la info?» no se reconocen como consulta. Con un pedido en curso, el
   texto libre del modelo no sale por diseño: se sustituye por el estado del
   pedido, y luego el formulario lo sustituye por su texto fijo. Siete
   carritos en siete minutos, ninguna respuesta y ningún pedido.

## Corrección

Archivos nuevos `mensajesEnEspera.js` y `test/fase-carrito-respuestas-db.mjs`;
cambios acotados en el canal del agente. No se tocan componentes protegidos
de CLAUDE.md, migraciones, banderas, precios, pagos ni impresión.

- **Preguntas reconocidas como consulta** (`experienciaHibrida.js`, solo con
  la beta híbrida encendida). Se agregan dos grupos: preguntas de cómo pagar
  («¿qué es el enlace de pago?», «¿aceptan transferencia?», «¿puedo pagar con
  tarjeta?») y peticiones de explicación («¿me podrían explicar / apoyar /
  ayudar?», «no entiendo»). Usan la ruta que ya existía para horario y
  dirección: el modelo responde solo con herramientas de lectura, la respuesta
  sale y debajo va «*Tu pedido guardado sigue aquí*» con el botón «Continuar
  pedido». Si el mensaje trae un verbo de cambio («¿me ayudan a quitar el
  café?»), o una decisión que ya reconocía el sistema, sigue siendo pedido.
  **No se relaja** la regla de que, con un pedido en curso, el texto libre del
  modelo no sale.
- **No se manda una pregunta que nacería vieja** (`canalDelAgente.js` +
  `mensajesEnEspera.js`). Si el cliente ya escribió otra cosa mientras se
  atendía el turno, ese turno responde solo con texto, sin carrito, lista ni
  botones. Cuando la pregunta era una elección, sale en su versión completa,
  con las opciones enumeradas. El turno siguiente manda la pregunta vigente.
  Solo cuentan los mensajes del mismo cliente que siguen pendientes y llegaron
  después del inicio del lote. Las respuestas de sistema, por ejemplo «seguir
  pedido» o el menú de Mapo, conservan su formulario. Si la lectura falla, se
  conserva el comportamiento anterior.
- **El aviso de la falla del proveedor encabeza el formulario.** Dice que no
  se completó el último mensaje y que, si traía un cambio o un dato, hay que
  escribirlo de nuevo. Antes el formulario lo tapaba.
- **Frases de entrada** (`intencionDeEntrada.js`):
  - Intención general sin producto: «ordenar / pedir / encargar un platillo,
    algo, comida», con un complemento opcional «de desayuno».
  - Petición cortés: «le podría encargar…», «¿les puedo pedir…?».
  - Pregunta de identidad («¿hablo a Mapolato Obispado?», «¿con quién
    hablo?»): cuenta como saludo, pero solo si lo nombrado son palabras del
    nombre del negocio. «Hablo a mapolato para pedir unos chilaquiles»
    conserva su ruta.

  Sigue exigiéndose la frase completa: un pedido con producto, fecha, negación
  o cancelación no cambia de ruta.

## Límites

- Sigue siendo un reconocimiento por frases. Una pregunta sobre otro tema
  («¿me lo mandan envuelto?») todavía recibe el carrito sin respuesta. La
  regla de fondo, que una pregunta no se tape nunca, exigiría que la respuesta
  del modelo salga sin pasar por el estado del pedido, y eso reabre el riesgo
  de un «ya lo agregué» falso. Queda propuesto como trabajo aparte.
- La pregunta suprimida depende de que el siguiente turno publique la suya.
  Si el mensaje en espera lo atiende un atajo que no pregunta nada (por
  ejemplo, un archivo de facturación), el cliente se queda con el texto
  completo del turno anterior y puede contestar escribiendo.
- No recupera la dirección perdida por la falla del proveedor: avisa para que
  el cliente la repita. Es una pista para el incidente abierto «dirección
  solicitada nuevamente», no su cierre.
- No cambia la vigencia de los formularios. Uno viejo que el cliente busque
  más arriba en el chat sigue respondiendo «ya no está disponible», como se
  diseñó.

## Evidencia local

Entorno: Node 22.23.3 en la imagen `xabor-beta-node22:20260930`, PostgreSQL
18.4 local (`pg-candidato`) con una copia desechable de la base por corrida,
red externa bloqueada (`red-solo-local.mjs`) y modelo simulado. Sin mensajes,
pedidos ni pagos reales.

- **`test/fase-carrito-respuestas-db.mjs`** (nueva). Usa los mensajes reales
  del incidente, con una dirección ficticia.
  - Rama: **8/8**.
  - Código de producción `f8dcfb6`: **3/8**. Fallan justo los cinco casos del
    incidente: respuesta tapada, carrito que nace viejo, aviso tapado,
    continuidad real y frases de entrada. Los tres de control pasan.
  - Uno de los casos usa la continuidad real: el lote marcado en proceso y la
    dirección que llega mientras el modelo atiende el pedido.
- **Guardianes del predeploy**: verdes `check-beta-hibrida`, `check-inicio-mapo`
  (12 saludos, 21 solicitudes, 28 exclusiones), `check-incidentes-conversacion`
  y `predeploy-check-incidentes.mjs`.
- **32 suites existentes, rama contra `f8dcfb6`**, cada una con su propia copia
  de la base: **el mismo resultado en todas**.
  - **28 pasan en ambas**: beta híbrida DB y HTTP; Flows DB, HTTP y endpoint;
    Mapo DB y HTTP; botones (persistencia, HTTP, mixtos, elecciones,
    experiencia, confirmación); continuidad; outbox; pedido canónico;
    continuidad determinista; `mesero:tools` 66/66; `mesero:replay` 26/26;
    incidentes; cierre; agrupamiento; declaración contra consulta; fuera de
    horario; intenciones; canario; seguridad conversacional; facturación por
    ruta única (con siembra desechable).
  - **Fallan igual en ambas**, no por este cambio:
    - `fase-botones-ofertas-db`: aserción vieja que espera «No pude
      identificar esa elección».
    - `fase-pedido-canonico-db`: 34/35, caso 05-06.
    - `fase-continuidad-webhook`: 9/10, porque Puppeteer no arranca dentro del
      contenedor.
- **Mordidas**: 13 garantías, cada una desactivada por separado. **Las 13
  hacen fallar su prueba** (24 corridas; archivos restaurados y verificados por
  hash). Son:
  - la consulta de pago o ayuda y el verbo de cambio;
  - los mensajes en espera, del mismo teléfono y posteriores al lote;
  - la respuesta de sistema que conserva su formulario;
  - el aviso de la falla del proveedor;
  - el texto completo sin lista y la ausencia de botones con mensajes en
    espera;
  - la intención genérica, la petición cortés, la pregunta de identidad, la
    identidad solo con el nombre y el nombre del negocio al canal.
- **Una mordida no mordía en la primera vuelta** (mismo teléfono). La inserción
  del mensaje ajeno fallaba por la llave foránea, el error quedaba tragado como
  falla del proveedor y el caso pasaba por otra puerta. Se corrigió el caso:
  ahora crea la conversación, verifica la precondición y exige que el turno
  aplique su cambio. La garantía no se tocó.
- `git diff --check`: verde.
- **Producción, solo lectura**: desde la apertura de Mapo (30-sep, 13:33 UTC)
  hubo 4 preguntas tapadas por el carrito, todas de esta clienta. El personal
  tomó la conversación a las 13:04 UTC y cerró el pedido.

## Segunda ronda: lo que frenaba los pedidos por formulario

Mario pidió hacer las correcciones necesarias para tener un bot que tome
pedidos por formularios aunque no sea conversacional. Antes de tocar nada se
revisó en producción, en solo lectura, el recorrido de los **31 clientes** que
escribieron desde la apertura de Mapo (30-sep 13:33 UTC) hasta la mañana del
1-oct. Varios terminaron con el pedido tomado a mano por el personal. El
bloqueo más repetido:

- **El carrito no se dejaba guardar y no decía por qué.** Cuatro clientes
  tocaron «Guardar» y recibieron
  «Revisa las opciones, entrega y pago antes de guardar». Lo que faltaba se
  reconstruyó desde el borrador guardado de cada formulario:
  - Uno: la salsa del bowl.
  - Otro: la tortilla de 3 tacos.
  - Los cuatro: las listas de Entrega y Forma de pago, que están al final de
    la pantalla.

  Dos de ellos acabaron atendidos a mano. Además, un «Guardar» rechazado
  redibujaba la pantalla sin la entrega y el pago que el cliente acababa de
  elegir.

Correcciones (sin republicar los formularios en Meta: solo cambian los datos
que el servidor devuelve):

- **Carrito** (`flowCarrito.js`):
  - Desde que se abre, la leyenda junto a las listas dice «Para guardar elige
    Entrega y Forma de pago aquí arriba».
  - Un «Guardar» rechazado dice exactamente qué falta y dónde, por ejemplo
    «Para guardar falta elegir: Salsa, Proteína y Guarnición en Chilaquiles
    Mixtos (ábrelo en «Preparación y notas»); Forma de pago (al final de esta
    pantalla)».
  - Conserva la entrega y el pago elegidos en ese intento.
  - El espacio de error sigue reservado para errores: después de una edición
    válida no se muestra nada.
- **Formulario de platillos** (`flowCategorias.js`): «Falta elegir Salsa,
  Proteína y Guarnición para este platillo» en lugar de «Completa las
  opciones».
- **Pedido escrito que el bot no pudo armar**: si la respuesta se
  descarta (por ejemplo, por nombrar un producto no publicado) o el proveedor
  falla con el carrito vacío, se abre «Arma tu pedido» con el aviso «No pude
  armar tu pedido con ese mensaje», en vez de solo «¿Qué te gustaría pedir?».
  La decisión es una función pura (`pedidoSinArmar`) con cada guarda probada:
  nunca con carrito, pregunta pendiente, consulta, toque, mensajes en espera,
  folio, evento, escalado ni formularios apagados.
- **«¿Cómo lo pago por este medio?»** también es consulta de pago.

Observaciones que no se tocaron:

- Una consulta hecha frente al resumen («¿cómo pago?» antes de confirmar)
  responde y ofrece «Continuar pedido». Para confirmar, el cliente vuelve a
  abrir el carrito y guardar: dos toques más. Es el comportamiento que ya
  tenían las consultas de horario.
- `fase-botones-ofertas-db` espera el aviso «No pude identificar esa elección»
  al escribir una opción inexistente, y en producción ya no sale. Es la ruta de
  texto, preexistente.
- El 30-sep a las 20:15, una conversación recibió «ya cerramos» y un minuto
  después pudo abrir el formulario de pedido. El horario configurado del
  miércoles va de 7:30 a 0:45. Conviene revisar qué horario debe mandar.
- Tras pagar, «Este estado no acredita el pago» confundió a una clienta que sí
  pagó. Consultar el pago registrado sería una mejora aparte.

Evidencia de la segunda ronda (mismo entorno local):

- **`test/fase-carrito-respuestas-db.mjs`**, ahora con 11 casos:
  - Rama: **11/11**.
  - Primera ronda (`6724b71`): **7/11**. Fallan justo los cuatro casos nuevos.
  - Los turnos que no deben llamar al modelo ahora fallan si lo llaman. Un
    error del modelo simulado se trataba como falla del proveedor, y con la
    salida «abrir el formulario» dos casos de frases de entrada pasaban por
    esa otra puerta. Lo destaparon las mordidas.
- **Guardianes del predeploy**: verdes. `check-carrito-unificado` comprueba la
  indicación, el error con nombres y la entrega conservada; `check-beta-hibrida`
  prueba cada guarda de `pedidoSinArmar`; `predeploy-check-incidentes.mjs` los
  incluye.
- **Código final contra `f8dcfb6`**: mismo resultado en las 32 suites
  relacionadas y en las dos que necesitan siembra.
  - Pasan en ambas: 28 más facturación por ruta única.
  - Fallan igual en ambas, por causas preexistentes:
    - `fase-botones-ofertas-db`.
    - `fase-pedido-canonico-db`: 34/35.
    - `fase-continuidad-webhook`: 9/10, Puppeteer en el contenedor.
- **Mordidas sobre el código y las pruebas finales**: las 22 garantías de las
  dos rondas, en 23 mutaciones (una de ellas en dos variantes). **Las 38
  corridas fallan donde deben.** Archivos restaurados y verificados por hash.
- `git diff --check`: verde.

## Tercera ronda: la prueba del dueño con el código publicado

Con `095a7ba` ya en producción, Mario probó desde su teléfono. Funcionó:
- el menú de Mapo y «Arma tu pedido»;
- la respuesta a «Qué es enlace de pago ?»;
- el menú en texto;
- el carrito armado desde texto;
- el mensaje de «Guardar» con nombres: «Proteína y Guarniciones en
  Chilaquiles Sencillos…».

Su prueba destapó un hueco nuevo:

1. Eligió **dos platillos** en «Arma tu pedido», llegó a la pantalla de
   entrega y pago y salió al chat a preguntar qué era «enlace de pago».
2. La respuesta no traía camino de vuelta, y su «Si» recibió un
   «¿qué se te antoja hoy?».
3. El carrito que armó después escribiendo solo tenía los chilaquiles. Los dos
   platillos se quedaron en el borrador del formulario.

Correcciones:
- **El borrador sigue al cliente.**
  - Si escribe algo a mitad de «Arma tu pedido» y el carrito sigue vacío, la
    respuesta sale completa con «Tu pedido guardado sigue aquí» y «Continuar
    pedido». Pasa en una consulta o en un turno que no deja pregunta
    pendiente.
  - El formulario retoma lo elegido: solo navegación que ya llegó al servidor,
    con la misma foto de carta y la misma huella.
  - Todo «Arma tu pedido» nuevo retoma su borrador compatible.
  - Sin borrador previo, una pregunta solo se contesta, como antes.
- **Cada forma de pago se explica en su opción** («Te enviamos un link para
  pagar con tarjeta desde tu celular»). Solo cambia el texto de un campo que
  esas pantallas ya enviaban vacío; la foto del formulario no cambia y no hay
  que republicar en Meta.

Sigue pendiente: si el cliente escribe un platillo mientras tiene platillos
elegidos en el formulario sin enviar, el carrito escrito no incluye los del
formulario. Se le ofrece volver a su formulario, pero no se combinan solos.

Evidencia de la tercera ronda:
- `test/fase-carrito-respuestas-db.mjs` pasa **12/12**. Con `095a7ba` (lo que
  corría en producción) fallan justo los dos casos nuevos: la explicación de
  pago vacía y la pregunta a mitad del formulario sin «Continuar pedido».
- Las 32 suites relacionadas y las 2 sembradas, contra `095a7ba`, dan el mismo
  resultado. Fallan igual en ambas, por causas preexistentes:
  `fase-botones-ofertas-db`, `fase-pedido-canonico-db` (caso 05-06) y
  `fase-continuidad-webhook` (Puppeteer).
- Mordidas: las cinco garantías nuevas hacen fallar su prueba.
  - continuar el pedido tras un mensaje;
  - que todo formulario de pedido retome;
  - que solo aplique con platillos elegidos;
  - la explicación de pagos;
  - el turno sin pregunta.
- `git diff --check`: verde.

## Cuarta ronda: la dirección de entrega, sin el modelo

Mario decidió el 1-oct que los pedidos se toman por formularios y que la parte
conversacional se apaga (ver la decisión en el vault). Antes de apagar la IA
hay que cerrar el único dato que hoy solo ella interpreta: **la dirección**.

Cómo estaba:
- Con domicilio elegido, el pedido pregunta con texto fijo «¿Cuál es la
  dirección completa para la entrega?» (`continuidadDeterminista`).
- La respuesta **solo la leía el modelo**. Las respuestas cortas no tienen
  caso para la dirección (`respuestaCorta`) y ningún formulario la pide, así
  que el turno caía al modelo, que llamaba `definir_entrega`.
- Una falla del proveedor perdía la dirección (el incidente de esta nota). Con
  la IA apagada, todo pedido a domicilio se quedaría atorado en esa pregunta.

Corrección (`src/mesero-agente/direccionPorTexto.js`):
- **Solo con la pregunta de dirección abierta** de un pedido a domicilio en
  curso. Requiere platillos en el carrito y que no haya folio, evento,
  confirmación incierta, programación pendiente ni escalado.
- **Solo toma un mensaje que es ÚNICAMENTE una dirección.** Cada tramo (línea
  o parte entre comas) tiene que ser parte de un domicilio:
  - calle con número o S/N, o nombre con número de casa («Hidalgo 405»,
    «Pino #45»);
  - colonia o CP;
  - ciudad;
  - una referencia («frente al Oxxo», «casa blanca»);
  - cortesía («Hola buenas»).

  Además tiene que haber un ancla: calle con número o un nombre con número de
  casa. Une las líneas con coma y no recorta: si pasa de 240 caracteres, no
  la toma.
- **Todo lo demás lo lee el modelo, como hoy**, aunque traiga una calle:
  - preguntas, también sin «?»;
  - pedidos y cambios («y 2 hotcakes», «pónganle queso», «2 burritos»);
  - notas para la cocina («sin cebolla»);
  - correcciones y dos destinos («antes era 407», «o en la UTNC»);
  - recoger;
  - pagos;
  - horas y fechas;
  - teléfonos;
  - otro pedido o mesa;
  - facturas y nombres;
  - persona o cancelar.
- **Zonas de envío.** Solo se toma una zona como destino cuando es lo único:
  una zona con el lugar dentro de ella («UTNC edificio 3», «Cervecera puerta
  2»). En estos casos decide el modelo, porque la tarifa depende de eso:
  - una zona como referencia («frente a la Comisión Federal»);
  - una zona negada («ya salí de la UTNC»);
  - dos zonas;
  - una zona sola («estoy en la UTNC»).

  «Coca Cola» es a la vez zona y refresco: siempre la lee el modelo.
- **Guarda por la misma herramienta y las mismas validaciones** que el modelo
  (`definir_entrega`: respaldo textual, zona y tarifa). La respuesta sale del
  pedido ya guardado (el resumen con «Dirección: …», el envío y los botones de
  confirmar), **nunca de un «anoté tu dirección» escrito antes de saber si se
  guardó**.
- **Contador propio.** Cuenta los intentos mientras la pregunta siga abierta,
  aunque en medio conteste el modelo. A los dos intentos, el turno vuelve a su
  camino de siempre; cada turno del modelo suma su repregunta y a la tercera
  pasa a una persona. Se olvida al cerrarse la pregunta.
- **Mensajes en espera.** Si el cliente ya escribió otra cosa, el resumen sale
  sin botones que nacerían viejos, como una respuesta del modelo.
- **Activación: APAGADA por omisión** (decisión de Mario, 1-oct, después de
  la tercera revisión). Solo se prende con `whatsapp_direccion_texto_v1 = 'true'`
  en `configuracion`, dentro de la beta híbrida. Sin esa clave, producción no
  cambia: la dirección la sigue leyendo el modelo.

Revisiones adversariales (tres rondas, cada una con revisores y un verificador
que intentó refutar cada hallazgo):
- **Ronda 1.** La versión que solo excluía lo que reconocía como «no
  dirección» aceptó 103 de 121 mensajes que no lo eran. Ejemplos:
  - «Que sean 2»;
  - «Coca cola light», cobrando $120 de la zona;
  - «… y también 2 hotcakes», donde los hotcakes nunca se agregaban;
  - preguntas escritas sin «?».

  La pregunta de zona también podía repetirse sin llegar a una persona.
- **Ronda 2.** El rediseño a «solo forma de domicilio» todavía aceptó 193 de
  230 mensajes armados con una calle más otra cosa. Ejemplos:
  - «Hidalgo 405 Centro, sin cebolla»;
  - «Quítenle 2 porfa»;
  - «…, frente a la Comisión Federal», cobrando $200;
  - «…, el 15 de octubre».

  La línea «Referencias» que se había agregado al resumen disparaba además un
  detector de «cambio no guardado» (por ejemplo, con «Registro Civil»). Se
  quitó.
- **Diseño final: cola cerrada.** Cada tramo tiene que ser de domicilio, y la
  pregunta de zona se retiró: la zona solo se toma como destino único y con
  lugar.
- **Corpus de pruebas.** Todos los ejemplos de las revisiones quedaron en
  `scripts/corpus-direccion.json`, con la carta real de Obispado: 614 mensajes
  que no son solo una dirección y 379 direcciones. El chequeo previo al
  despliegue exige que no se acepte ninguno de los 614 y que se acepte al menos
  el 90 % de las 379; hoy se aceptan 349.
- **Fuera de este cambio.** El problema de «registro» ya existe en producción
  con las direcciones que guarda el modelo. Quedó como tarea aparte.

Lo que NO hace todavía:
- No pide la dirección dentro del formulario. Eso es la quinta ronda (fase 1a,
  abajo).
- No une una dirección partida en dos mensajes separados por más de 6 s.
- No ofrece la dirección guardada del cliente (`cliente_direcciones`).
- Lo que no reconoce lo lee el modelo. Con la IA apagada (paso 3) tendrá que
  repreguntar «escribe solo tu dirección» y, a la segunda, pasar a una
  persona.

Calibración contra Obispado (solo lectura, sin imprimir direcciones):
- **Primeras respuestas a la pregunta de dirección:** de 21, acepta 11. Todas
  son direcciones y no acepta ninguna que no lo sea. La única dirección que no
  toma trae «a nombre de…».
- **Direcciones guardadas en pedidos de 120 días:** acepta 7 de 11. Las 4
  restantes son colonias o referencias sin calle con número; las lee el modelo.

- **Ronda 3.** La cola cerrada todavía aceptó 191 de 211 mensajes nuevos.
  Ejemplos:
  - «Hidalgo 405 Centro: tacos de barbacoa»;
  - «…, burritos 3»;
  - «…, un té verde»;
  - «…, hasta las 3».

  Con 15 arreglos más bajaría a unos 15 de 211, pero no a cero. La integración
  sí quedó limpia: el ejecutor nunca rechazó una dirección aceptada, no hay
  bucles y nada cambia en otros caminos.
- **Decisión de Mario (1-oct):** la dirección va en el formulario (fase 1). La
  lectura por texto queda guardada y apagada.

Evidencia de la cuarta ronda:
- `scripts/check-direccion-zonas.mjs` (corre en el predeploy): 159/159. Incluye
  el corpus: 0 de 614 aceptados y 349 de 379 direcciones.
- `scripts/predeploy-check-incidentes.mjs`: completo, en verde.
- `test/fase-direccion-texto-db.mjs`: 9/9 con la clave prendida. El modelo
  simulado falla si se le llama. Con `2a03a5c` (producción) fallan los 3 casos
  de captura y los 6 de control pasan igual, incluidos «sin la clave» y «sin la
  beta».
- Mordidas: las 13 garantías que importan con la lectura apagada muerden:
  - apagada por omisión y solo dentro de la beta;
  - ruta del canal y botones con mensajes en espera;
  - cola cerrada, ancla, zonas, platillos y cocina;
  - tope de intentos y respuesta desde el pedido.

  Las 62 de la versión anterior también mordieron.
- 37 suites relacionadas y 4 sembradas dan el mismo resultado que `2a03a5c`.
  Las fallas comunes ya existían: `botones-ofertas-db`, el caso 05-06 de
  `pedido-canonico-db` y `continuidad-webhook`.

## Quinta ronda (fase 1a): la dirección dentro del formulario

Decisión de Mario (1-oct): la dirección se escribe en el formulario y la zona
se elige de una lista. Así nadie tiene que adivinar qué parte del mensaje es
dirección ni a qué zona pertenece.

Qué cambia para el cliente, con domicilio elegido:
- **«Arma tu pedido» (categorías):** Entrega → **Dirección** → resumen.
- **«Tu carrito»:** Guardar → **Dirección** → resumen.
- **Pregunta de dirección abierta:** el botón dice «Escribir dirección» y abre
  el carrito directo en la pantalla de dirección. Solo si el carrito unificado
  está encendido; si no, la pregunta sigue en texto, como hoy.
- La pantalla trae cuatro campos:
  - **Zona de entrega:** lista con el envío de cada zona; la primera es «En
    la ciudad», con el envío base. Solo aparece si el negocio tiene zonas.
  - **Calle y número:** obligatorio, de 3 a 120 caracteres.
  - **Colonia:** opcional, hasta 80.
  - **Referencias:** opcional, hasta 200.
- Recoger en tienda no pasa por la pantalla de dirección.

Reglas:
- **El envío sale de la lista, no del texto.** Una zona cobra su tarifa
  exacta y «En la ciudad» cobra la base. Esa elección se respeta también
  después: un cambio posterior que solo repite la modalidad (el modelo, un
  botón, otro formulario) no vuelve a deducir la zona del texto, mientras la
  dirección siga siendo la del formulario.
- **Aviso de zona, una sola vez.** Si la calle o la colonia mencionan una zona
  y se eligió «En la ciudad», o mencionan otra zona con otro envío, el
  formulario lo avisa. Si el cliente lo vuelve a mandar igual, se guarda. El
  aviso se vuelve a mostrar mientras siga pendiente (un reintento o un regreso
  con «Atrás» no lo pierden).
- **Atrás y recoger.** Si después del aviso el cliente regresa y cambia a
  recoger (o vacía el carrito), la dirección escrita se descarta y el pedido se
  aplica normal.
- **Retomar.** Un formulario retomado con la dirección a medias abre en
  «Entrega y pago» (o en el carrito), para que pueda cambiar a recoger.
- **Se guarda por `definir_entrega`**, con las mismas validaciones de zona y
  tarifa. La única diferencia es que no exige respaldo en el texto del chat:
  la dirección la escribió el cliente en el formulario y el servidor comprueba
  que los argumentos son exactamente los que el formulario validó.
- **Se limpian** los caracteres de control, de dirección de texto, los
  invisibles (incluidos los rellenos que se ven vacíos, como U+3164) y las
  pilas de acentos sueltos, antes de validar y de guardar.
- **Referencias** van a `cliente.referencias`, que el panel ya muestra. El
  formulario muestra las que ya hay, también las dichas por chat; si el
  cliente vacía el campo, se borran. El resumen de WhatsApp todavía no las
  muestra: espera el arreglo de «registro», que va en otra rama.
- **Precarga:** calle y colonia solo si sus partes forman exactamente la
  dirección guardada. Si la zona que había elegido ya no está en la lista, la
  lista queda sin elegir.
- **Zonas repetidas:** un nombre de zona repetido se ofrece una sola vez, la
  misma que cobra el ejecutor.

Activación (nada cambia sin esto):
- Los formularios con dirección son **formularios nuevos en Meta**. Los que
  están publicados no se tocan; el chequeo fija su huella.
- Se encienden por negocio con dos claves en `configuracion`:
  `whatsapp_flow_categorias_dir_id` y `whatsapp_flow_carrito_dir_id`. Cada
  una solo vale si también está la clave de siempre de ese formulario.
- `scripts/activar-flows-direccion.mjs` las escribe. Antes comprueba:
  - que producción corre el commit indicado;
  - que los dos flowId son distintos entre sí y de los formularios de siempre,
    y que no hay claves *_dir_id puestas a mano;
  - que los dos Flows son de la WABA de ese negocio;
  - que los dos formularios están publicados en Meta, sin errores, con el
    endpoint `https://xabor.mx/webhook/flows/pedido` y con el nombre igual a
    la huella de su definición;
  - que no hay formularios abiertos en los últimos 30 minutos
    (`--con-formularios-abiertos` lo fuerza).

  Consulta Meta antes de abrir la transacción, así que no bloquea los mensajes
  ni la impresión del negocio mientras espera. Guarda un respaldo para revertir.
- Un formulario sin dirección que quedó abierto al activar se corta desde el
  principio («ya no está disponible»), en lugar de perderse en el recibo final.
- **Revertir sin desplegar:** `activar-flows-direccion.mjs <negocio> <sha>
  revertir`. No espera a que se cierren los formularios: es la salida de
  emergencia, y uno con dirección abierto responde «ya no está disponible».
  También funciona si alguien ya borró las claves a mano.
- **Sin las claves, nada cambia:** la foto, los Flows publicados, la huella del
  resumen y las respuestas del ejecutor por el camino del modelo son las de
  `2a03a5c`.

Revisión adversarial (cinco frentes: validez ante Meta, máquina de estados,
dinero, sin claves y entrada del cliente; cada hallazgo con un verificador que
intentó refutarlo):
- **Validez ante Meta:** ninguna falla. La pantalla manda exactamente las
  claves que declara, con su tipo, en 26 caminos probados.
- **24 hallazgos confirmados**, que se reducen a 15 problemas. Los de severidad
  media:
  - aviso → Atrás → recoger: el formulario decía «listo» y el recibo se
    rechazaba entero;
  - un cambio posterior con solo la modalidad volvía a deducir la zona del
    texto («En la ciudad» pasaba de $60 a $150);
  - sin carrito unificado, la pregunta de dirección mandaba el formulario viejo
    sin dirección, en ciclo;
  - la huella del resumen cambiaba sin claves para pedidos con referencias.

  Todos quedaron arreglados como se describe arriba, salvo uno.
- **Verificación de los arreglos** (tres revisores más su verificador): los 14
  arreglos cierran sus hallazgos. Aparecieron 8 detalles más, todos arreglados:
  - **media:** una zona corregida por chat después del formulario se perdía con
    el siguiente cambio de solo modalidad. Ahora una dirección o una zona dichas
    por chat quitan las partes del formulario, y se vuelve a la regla de siempre;
  - el aviso de zona no se veía si la respuesta traía otro error (una revisión
    vieja). Ahora se muestra junto, sin repetirse;
  - la limpieza no daba lo mismo dos veces con un invisible entre una letra y
    su acento, y el recibo de un aviso confirmado se rechazaba. Ahora es
    idempotente;
  - con domicilio y sin pago, la pregunta de dirección mandaba el carrito con
    el texto genérico. Ahora dice «elige la forma de pago y toca Guardar
    cambios»;
  - unas referencias dichas por chat impedían retomar «Arma tu pedido». Ahora
    la precarga no cuenta para retomar ni para la vigencia;
  - activar con claves puestas a mano dejaba una reversa que no apagaba nada.
    Ahora se niega;
  - la activación no comprobaba que los Flows fueran de la WABA del negocio.
    Ahora lo comprueba;
  - el chequeo dejaba variables de entorno falsas al resto del predeploy. Ahora
    las restaura.
- **Pendiente (no se arregló):** las direcciones escritas en un formulario
  quedan guardadas en `agente_flows_borradores` y `agente_botones.datos` sin
  fecha de purga. Hace falta una purga por lotes de los borradores viejos.
- **Fuera de esta fase:** el portal del repartidor muestra «Sin dirección» en
  todo pedido tomado por WhatsApp, porque lee calle y colonia y la orden solo
  lleva la dirección completa. Ya pasa en producción; quedó como tarea aparte.

Evidencia de la quinta ronda:
- `scripts/check-flow-direccion.mjs` (corre en el predeploy): 41/41, con y
  sin las variables de Flows en el entorno (en Railway sí existen).
- `test/fase-flows-direccion-db.mjs`: 7/7. El modelo simulado falla si se le
  llama. Cubre el carrito con zona, «Escribir dirección», categorías con aviso,
  sin claves, revertir, activar con un formulario viejo abierto y aviso →
  Atrás → recoger.
- Mordidas: las 66 garantías muerden (32 de la implementación, 24 de los
  arreglos de la revisión y 10 de la verificación).
- 40 suites relacionadas y 4 sembradas dan el mismo resultado que `2a03a5c`. La
  única diferencia es `direccion-texto` (9/9 contra 6/3), que es de la cuarta
  ronda.

## Sexta ronda (fase 1b): entrega y pago en su propia pantalla del carrito

Decisión de Mario (1-oct, opción B): hacerla antes de publicar, para que el
carrito nuevo salga a Meta una sola vez con la dirección.

Problema: en «Tu carrito» las listas «Entrega» y «Forma de pago» estaban hasta
abajo de una pantalla larga. Cuatro clientes tocaron «Guardar» el 1-oct sin
verlas.

Con el contrato `direccion_v1` (las mismas claves de la quinta ronda), el
carrito va por pasos:
1. **Tu carrito:** solo platillos y cantidades. El botón dice «Continuar».
   Exige los platillos completos y dice cuál falta; ya no menciona entrega ni
   pago.
2. **Entrega y pago:** la misma pantalla de «Arma tu pedido», con las dos
   listas obligatorias.
3. **Dirección:** solo si eligió domicilio.
4. Resumen del pedido.

- Atrás recorre los pasos al revés: de Dirección a Entrega y pago, y de ahí al
  carrito.
- Un formulario retomado a medias abre en el carrito.
- Vaciar el carrito se guarda como hoy, sin pedir entrega.
- «Escribir dirección» (el pedido ya tiene entrega y pago) sigue abriendo
  directo en la dirección.
- Sin las claves, el carrito es el publicado: sus huellas no cambian.

Revisión adversarial (una ronda, dos frentes: validez ante Meta y sin claves, y
el recorrido del carrito):
- Validez ante Meta y sin claves: sin hallazgos.
- Dos detalles bajos, arreglados:
  - «Deshacer» en el carrito revertía también la entrega y el pago elegidos
    después en su pantalla. Ahora solo devuelve los platillos;
  - algunos mensajes todavía decían «guardar». Ahora dicen «continuar».

Evidencia de la sexta ronda:
- `scripts/check-flow-direccion.mjs`: 46/46. Comprueba también, en cada
  pantalla del carrito nuevo, que la respuesta manda exactamente las claves que
  la pantalla declara y que todo enlace a datos o campos existe.
- `test/fase-flows-direccion-db.mjs`: 8/8. Incluye el carrito de punta a punta
  con domicilio y con recoger.
- Mordidas: las 23 garantías nuevas muerden. Se repitieron las 11 de la quinta
  ronda que viven en los archivos del carrito, porque sus pruebas se
  reescribieron, y también muerden. Una (retomar en «Entrega y pago») no mordía
  al principio: la prueba nunca llegaba a esa pantalla. Se corrigió.
- 42 suites contra `2a03a5c`: iguales salvo `direccion-texto` (cuarta ronda) y
  la suite nueva de la dirección. El predeploy completo pasa en Docker.

## Publicación

Las tres primeras rondas están en producción desde el 1-oct: `095a7ba`
(deployment e2c99e87) y `2a03a5c` (deployment 2181e00c). De la cuarta a la
sexta ronda no cambian nada en producción mientras sus claves no existan. Son
tres pasos separados y cada uno necesita la autorización de Mario.

**Hecho el 2-oct con la autorización de Mario («adelante con los 3»):**
- **Despliegue:** `prod/mesero-shadow-v3` avanzó (fast-forward, sin forzar)
  de `a287b5a` a `059b202`. Ese candidato integra `a287b5a` y `26f6546`, sin
  conflictos.
  - El push no disparó el build; se lanzó con `redeploy`.
  - Deployment `1bcc0351`: SUCCESS.
  - SHA dentro del contenedor: `059b2027…`. `/health` responde 200.
  - Los logs solo traen los errores simulados del propio predeploy.
  - Para volver atrás: redeploy de bf17fdfa (`a287b5a`).
- **Meta:** «Arma tu pedido» con dirección `919900754308365` y «Tu carrito»
  con dirección y duplicar `3697155080422639`. Los dos validaron sin errores y
  están PUBLISHED.
- **Activación en Obispado:** se hizo con 0 formularios abiertos; las claves y
  el respaldo se comprobaron leyendo la base. La lectura por texto sigue
  apagada.
- **Revertir sin desplegar**, desde `C:\xabor-agent`:
  `railway.cmd ssh -- node scripts/activar-flows-direccion.mjs <negocio> 059b2027522ccda806ecd465b3deff0b618ecfb5 revertir`.

**Paso 1 — desplegar el código (sin claves, sin cambio de comportamiento).**
1. Leer de Railway la rama configurada (al 1-oct, `prod/mesero-shadow-v3` en
   `2a03a5c`).
2. Verificar que `git log <rama>..fix/whatsapp-carrito-respuestas` traiga solo
   los commits de la cuarta a la sexta ronda, y que
   `git log fix/whatsapp-carrito-respuestas..<rama>` esté vacío.
3. Correr `node scripts/predeploy-check-incidentes.mjs`.
4. Avance rápido de la rama de despliegue a este candidato. El push no dispara
   el build: esperar ~90 s y desplegar a mano.
5. `railway.cmd redeploy --yes --from-source --json` desde `C:\xabor-agent`.
6. Comprobar `meta.commitHash` y `SUCCESS`.

No hay migraciones. Para revertir el código: redeploy de 2181e00c (`2a03a5c`).

**Paso 2 — publicar los formularios nuevos en Meta.** Es una escritura en Meta:
`validar` ya crea un borrador. Los formularios publicados no se tocan.
- `node scripts/publicar-flows-pedido.mjs <negocio> validar categorias-direccion`
  y después `publicar categorias-direccion`.
- Para el carrito, `carrito-direccion`, o `carrito-direccion-beta` si el
  negocio tiene `whatsapp_flow_carrito_duplicar_v1 = 'true'`. Primero `validar`
  y después `publicar`.
- Anotar los dos flowId que devuelve.

**Paso 3 — activar en Obispado, a una hora sin formularios abiertos.**
`node scripts/activar-flows-direccion.mjs <negocio> <sha> activar <categoriasDirId> <carritoDirId>`.
Para revertir sin desplegar: `… <negocio> <sha> revertir`.

Prueba del dueño desde su teléfono, con un pedido a domicilio:
- «Arma tu pedido»: un platillo, domicilio → tiene que pedir la dirección con
  la lista de zonas; con UTNC, el resumen dice «Dirección: …, UTNC» y envío
  $150; con «En la ciudad», envío $60;
- «Tu carrito»: «Continuar» → «Entrega y pago» (no deja seguir sin las dos) →
  con domicilio, la dirección; con recoger, el resumen;
- «Calle Cervecera 210» con «En la ciudad»: tiene que avisar una vez; al
  reenviar igual, envío $60;
- recoger en tienda: no pide dirección.

La lectura de la dirección por texto (cuarta ronda) sigue apagada. Se prende
solo con `whatsapp_direccion_texto_v1 = 'true'`.

## Séptima ronda (3-oct): lo que dejó la evaluación del 2-oct en Obispado

De 20 clientes que querían pedir, 15 pidieron. Lo que el bot hizo mal ese día
y cómo queda:

- **Tiempo de entrega.** El equipo escribió a mano «45 minutos aprox.» en 7
  conversaciones. Ahora la confirmación y la respuesta de estado dicen el
  tiempo de las reglas del negocio (`tiempoEstimado.js`). Con enlace de pago se
  cuenta desde el pago, y un programado no promete tiempo de hoy. Se retiró
  «Este estado no acredita el pago», que confundía a quien paga al recibir.
- **«¿Qué contiene el Desayuno Sorpresa?»** se volvía «¿Agregamos Desayuno
  Sorpresa a tu pedido?». Una pregunta de contenido ya es de solo lectura, no
  deja oferta y se contesta con la descripción de la carta. Lo que no está en
  la carta sugiere categorías con ejemplos publicados, en vez de un callejón
  sin salida.
- **Mesas.** Al quitar «comer aquí» de las modalidades, el bot negó tres veces
  que Obispado tuviera mesas. La frase fija ya no lo niega: dice que por
  WhatsApp se toma para recoger o a domicilio y, si el negocio tiene una
  pregunta frecuente sobre mesas, la pone primero con sus palabras.
- **Formularios «no disponible».** Hubo 7 el 2-oct. El diseño se mantiene:
  un texto del cliente invalida el formulario abierto. Ahora el «Tu carrito»
  nuevo retoma lo que el cliente había editado en el anterior, siempre que el
  carrito sea el mismo. El aviso del viejo lo manda al más reciente. Mantener
  vivo el formulario abierto necesita una migración y queda para otra ronda.

Pruebas: `fase-tiempo-estimado` (8), `fase-pregunta-de-contenido` (6), un
caso nuevo en `fase-carrito-respuestas-db` (13 en total) y el de mesas en
`fase-agente-emision`. Cada garantía se quitó y su prueba falló (16
mordidas). El predeploy completo pasa en Docker. `fase-pedido-canonico-db`
05-06 ya fallaba en la base 12fd7c3.

## Octava ronda (3-oct): Fase 1 tras la prueba del dueño

Todo va en la rama `fix/whatsapp-carrito-respuestas`. Lo que cambia la
experiencia sin bandera:

- **Botón vencido** (74261e4): un toque viejo solo reabre lo de Mapo si el
  botón era de Mapo. El 2-oct «Cambiar algo» de un resumen de 3 h antes
  reenviaba el Flow de factura.
- **Resumen con el grupo de cada opción** (df1c4d7): «Sabor: Melón ·
  Complementos: Chocolate, Vainilla», en el orden del menú. Se usa solo si el
  resumen mide ≤590 caracteres; si no, sale el formato plano. El renglón
  también sale plano si parece afirmar un cambio o coincide con una frase
  prohibida.
- **Mayúsculas visibles** (df1c4d7, d3cd806): «Modalidad: Recoger en tienda»
  y las listas del chat. La foto de los formularios y ETIQUETAS no cambian.

Detrás de una bandera por negocio, apagada por omisión:

| Bandera / activación | Qué hace | Commit |
|---|---|---|
| `whatsapp_flujos_caducan_v1` | Formulario de factura o evento, menú de inicio o ficha de evento vencen a los 30 min o al cambiar el día | 143b4d9 |
| `whatsapp_eventos_formulario_v1` + quitar `cotizacion_perfil=catering` | Una solicitud de evento escrita abre «Datos del evento» (con carrito, no abre nada de eventos) | 47a49a5 |
| `activar-flows-nota.mjs` (Meta + configuración) | «Nota del pedido» en Entrega y pago, impresa en la comanda; sin «Opcional» en lo obligatorio | ab6f4e9, e4409e0, f74a2e4 |

Datos de Obispado cambiados con autorización (3-oct): `reglas_atencion`
(mesas, horario 7:30–15:00, entrega 45 min) y «Sin fruta extra» primero en el
grupo «¿Fruta Extra?» del Licuado. Los respaldos están en el scratchpad de la
sesión.

### Activar en Obispado, después de desplegar (cada paso con autorización)

1. `whatsapp_flujos_caducan_v1 = 'true'`.
2. Eventos: comprobar en Meta que el Flow de evento (957762156770578) está
   PUBLISHED. Después `whatsapp_eventos_formulario_v1 = 'true'` y
   `cotizacion_perfil` sin «catering», con respaldo del valor anterior.
3. Nota: en el contenedor desplegado, `publicar-flows-pedido.mjs <negocio>
   validar|publicar` para `categorias-direccion-nota` y el carrito que use el
   negocio (`carrito-direccion-nota-beta` si `whatsapp_flow_carrito_duplicar_v1`
   es 'true'). Revisar la vista previa en el teléfono, sobre todo que
   «Agregar más» con un grupo obligatorio vacío se comporte bien. Después,
   fuera de horario: `activar-flows-nota.mjs <negocio> <sha40> activar
   <categoriasNotaId> <carritoNotaId>`. Reversa: `… revertir`.

Pendiente conocido: el panel (protegido) no muestra la nota del pedido; la
imprime el Edge en el primer artículo. El repartidor también la ve en sus
observaciones.
