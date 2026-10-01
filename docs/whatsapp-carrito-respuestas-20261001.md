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

## Publicación

Nada publicado. Mario pidió publicar las dos rondas juntas con una sola
autorización. Pasos:

1. Leer de Railway la rama configurada (al 1-oct, `prod/mesero-shadow-v3` en
   `f8dcfb6`).
2. Verificar que `git log <rama>..fix/whatsapp-carrito-respuestas` traiga solo
   los dos commits de esta rama y que `git log fix/whatsapp-carrito-respuestas..<rama>`
   esté vacío.
3. Avance rápido de la rama de despliegue a este candidato.
4. `railway.cmd redeploy --yes --from-source --json` desde `C:\xabor-agent`.
5. Comprobar `meta.commitHash` y `SUCCESS`.

No hay migraciones ni cambios en los formularios publicados en Meta.

Prueba del dueño desde su teléfono:
- las tres frases de entrada;
- una pregunta de pago con el carrito abierto;
- dos mensajes seguidos mientras el bot responde;
- un carrito con una opción sin elegir, tocando «Guardar».
