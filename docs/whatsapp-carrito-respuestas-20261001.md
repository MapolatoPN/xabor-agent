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

## Publicación

Nada publicado. Para desplegar hace falta la autorización de Mario. Pasos:
cherry-pick sobre la rama que Railway tenga configurada, verificando que
`git log <rama>..<candidato>` traiga solo este commit; `railway.cmd redeploy
--yes --from-source`; comprobar `meta.commitHash`; y una conversación de prueba
del dueño con las cuatro preguntas y las tres frases del incidente. No hay
migraciones.
