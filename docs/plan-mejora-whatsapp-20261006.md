# Plan de mejora de atención por WhatsApp

Fecha: 6 de octubre de 2026. Destinatarios: Mario y Claude Code. Estado: planificación local; implementación pendiente.

El objetivo es aumentar las solicitudes que reciben atención útil y reducir conversaciones abandonadas. Los formularios seguirán siendo la vía para crear y modificar pedidos; la recepción debe resolver dudas con información aprobada y conectar las excepciones con una persona que las atienda. La finalización del pedido se medirá por separado de la cobertura de atención.

Esta entrega termina en un plan y futuros cambios locales revisables. No incluye push, deploy, activación de banderas, migraciones de producción, mensajes reales, cobros ni impresión.

## Base de trabajo y colaboración

La base local de esta revisión es `48e4150`, referencia observada en `origin/prod/mesero-shadow-v3`. No prueba por sí sola qué binario ni qué configuración están activos en Railway. La rama `feat/ia-recepcionista` contiene trabajo que debe revisarse y adaptarse sobre la base vigente antes de contar con sus mejoras.

Claude Code implementa en su propio worktree y aporta el análisis de conversaciones que está realizando. Codex revisa arquitectura, diferencias y evidencia de pruebas. Mario define información comercial y prioridades de operación. Esta distribución no implica que se hayan enviado instrucciones a otra sesión ni que la implementación esté iniciada.

Antes de cada bloque se comprueban rama y cambios locales. No se mezclan correcciones de caja, facturación, impresión o integraciones de pago con este trabajo. Los cambios en componentes protegidos siguen la revisión de riesgo y aprobación indicada en [CLAUDE.md](../CLAUDE.md); preparar diseño, reproducciones y módulos independientes puede avanzar primero.

## Evidencia que orienta las prioridades

- El análisis registrado del 3 de octubre documenta 63 pausas activas en Obispado. Es un antecedente histórico, no un conteo actual. El vencimiento depende de banderas, motivos y restricciones: [política de pausas](whatsapp-pausa-vence.md).
- Algunas preguntas reciben el carrito en lugar de una respuesta. Las correcciones cubren consultas reconocidas, pero conservan límites para otras frases: [incidentes y correcciones del carrito](whatsapp-carrito-respuestas-20261001.md).
- La base revisada filtra tipos en `src/channels/whatsapp-meta.js`; audio y ubicación no están entre los admitidos. Su peso en la pérdida de atención debe medirse antes de decidir el orden de implementación.
- `48e4150` corrige transiciones y apertura de formularios. Se conservarán esos recorridos en las pruebas para evitar regresiones.
- La aceptación de un envío por Meta y la entrega al cliente son hechos distintos. El outbox llama `entregado` a la aceptación; las métricas deben distinguirla de los estados posteriores de WhatsApp.

## Primera entrega de diagnóstico

Claude Code reúne su análisis de conversaciones y Codex lo cruza con entradas, turnos, pausas, salidas y actividad de formularios. La ventana inicial propuesta es de siete días completos recientes, segmentada por negocio, horario y versión. Si no hay acceso de lectura disponible, se usa un export local anonimizado y se registra su alcance.

No se cuenta cada fragmento del cliente como una solicitud independiente: se relacionan mensajes con lotes y turnos. Un saludo, una duda, una solicitud de pedido y un agradecimiento tienen expectativas diferentes. Se registran tanto las exclusiones justificadas como los silencios indebidos.

| Tarea | Acción | Entregable y condición de cierre |
| --- | --- | --- |
| D01 | Identificar versión y banderas con evidencia disponible de solo lectura; listar diferencias con la base local. | Matriz por negocio con versión, alcance del agente, formularios, rescate y vencimiento; desconocidos explícitos. |
| D02 | Clasificar conversaciones del análisis de Claude y comprobar las causas con registros. | Conteos de respuesta útil, respuesta insuficiente, pausa, atención humana, fallo de procesamiento, fallo de entrega y formato excluido. |
| D03 | Relacionar recepción, turno, salida, estado de Meta y formulario. | Cada caso puede recorrerse por sus identificadores; las relaciones inciertas quedan marcadas, sin atribuir respuestas por proximidad temporal. |
| D04 | Priorizar por clientes afectados, recurrencia, gravedad y esfuerzo. | Lista de los principales fallos con ejemplos anonimizados y reproducción local; no atribuir todas las pérdidas a una sola causa. |

## Orden de implementación

El diagnóstico habilita las siguientes entregas. Las tareas se pueden preparar por separado, pero se integran y verifican en orden para conservar una base evaluable.

| Prioridad | Tarea | Trabajo de Claude Code | Revisión de Codex y aceptación |
| --- | --- | --- | --- |
| P0 | A01 Atención bloqueada | Revisar pausas, takeover y revisiones; completar motivo, antigüedad y origen visibles; simular vencimiento con datos locales. | Todo bloqueo tiene causa; no se reactivan automáticamente pagos o efectos inciertos. La simulación no modifica pausas reales. |
| P0 | A02 Seguimiento humano | Preparar estados pendiente, tomada, atendida y cerrada, con responsable y plazo configurable. Reutilizar la bandeja y el rescate existentes. | Pausar o avisar no equivale a atender. Un nuevo mensaje pendiente no queda cerrado por un acuse anterior. |
| P0 | A03 Entrega fallida | Correlacionar aceptación, entrega y fallo; revisar conciliación y traspaso durable a humanos. | Un envío aceptado no se reporta como recibido. No se reintentan envíos inciertos que puedan duplicarse. |
| P1 | R01 Recepcionista | Revisar `feat/ia-recepcionista` contra la base vigente; conservar formularios para pedidos y respuestas aprobadas para dudas. | Ningún texto libre crea o modifica pedidos ni afirma cambios sin persistencia. Las precondiciones se evalúan por negocio y alcance. |
| P1 | R02 Preguntas con pedido abierto | Conservar la respuesta informativa antes del acceso a continuar; aclarar mensajes ambiguos y tratar preguntas mezcladas con solicitudes. | La pregunta no queda sustituida por el carrito; el borrador se conserva y no se modifica por una consulta. |
| P1 | R03 Rutas anteriores al agente | Auditar imágenes, comprobantes, facturación, seguimiento, cerrado y mensajes del personal antes del recepcionista. | Las rutas anteriores respetan las mismas reglas; el bot guarda silencio durante atención humana vigente y esa causa queda trazada. |
| P1 | M01 Formatos excluidos | Medir audio, ubicación y otros formatos; preparar registro y respuesta alternativa. Priorizar audio si explica una parte relevante de las pérdidas. | Ningún formato se descarta sin trazabilidad. Audio no entendido ofrece aclaración o atención humana; su transcripción no confirma pedidos. |
| P2 | F01 Abandono del formulario | Medir apertura, navegación, errores, guardado y confirmación; corregir primero los pasos con mayor abandono. | Recorridos principales conservan elecciones, indican qué falta y producen un único pedido al confirmar. |
| P2 | F02 Continuidad | Verificar salir al chat, reabrir, volver desde consultas, formularios viejos y cambios de menú. | El borrador compatible se recupera; el incompatible recibe una explicación; se conserva la corrección de transiciones de `48e4150`. |

El plazo de atención humana se define con Mario según personal y horario. Vencer una pausa no sustituye ese seguimiento. La transcripción de audio queda condicionada a su frecuencia y a una evaluación local de precisión, latencia y costo.

## Arquitectura a conservar

La recepción registra y clasifica la entrada; la continuidad agrupa mensajes y serializa turnos; el router decide información, formulario, seguimiento o atención humana. La información proviene de configuración aprobada, catálogo publicado y estado persistido. El formulario valida cambios y la confirmación crea el pedido por el circuito existente. La entrega registra la aceptación de Meta y concilia los estados posteriores.

Se reutilizan `whatsappContinuidad.js`, `estadoAtencionConversacion.js`, `bandejaChats.js`, `seguimientoFormulario.js`, `estadosMensajeWhatsapp.js`, `rescateHumano.js` y `entregaDeRespuestas.js`. Antes de crear tablas, routers o despachadores adicionales se comprueba si estos módulos ya representan el estado necesario. La instrumentación no debe añadir trabajo pesado al camino de respuesta al cliente.

## Métricas y criterios de evaluación

| Métrica | Definición |
| --- | --- |
| Cobertura útil | Solicitudes evaluadas con respuesta pertinente o derivación útil, sobre solicitudes elegibles. La calidad se verifica con revisión etiquetada; no basta con existir una salida. |
| Silencio indebido | Solicitudes que requieren atención y superan el plazo acordado sin respuesta ni persona atendiendo. El plazo distingue operación abierta y fuera de horario. |
| Entrega | Respuestas con estado entregado de Meta sobre respuestas aceptadas; se separan las de estado desconocido y la demora del recibo. |
| Rescate atendido | Derivaciones con atención humana efectiva sobre derivaciones pendientes de atención. |
| Finalización | Conversaciones con intención de compra que terminan en pedido confirmado; se distingue formulario abierto, guardado y confirmado. |
| Tiempo de atención | Mediana y percentil 95 desde recepción hasta respuesta y desde rescate hasta primera respuesta humana. |

Metas propuestas para el conjunto local de evaluación: al menos 95% de solicitudes elegibles con ruta explícita y al menos 90% con respuesta correcta. Son objetivos iniciales, no resultados observados ni garantías productivas. Se informan numeradores, denominadores y resultados por categoría para evitar que los saludos oculten fallos en dudas o pedidos.

El banco de casos se divide entre ejemplos usados para corregir y ejemplos reservados para evaluación. Los casos reales se anonimizan. Las conversaciones derivadas siguen contando en la atención total; no se excluyen para mejorar artificialmente la cobertura del bot.

## Validación local y entrega de cambios

Cada corrección incluye una reproducción del fallo real y pruebas de comportamiento relevantes. Se usa base desechable, proveedor simulado y bloqueo de red externa. No se envían mensajes, generan cobros ni imprimen tickets reales.

Casos mínimos: dos mensajes seguidos, deduplicación, reinicio durante un turno, fallo del proveedor, respuesta incierta, pausa manual, takeover humano, comprobante, pregunta con carrito, formulario vencido, reapertura, aislamiento entre negocios y confirmación única. Las pruebas de formulario incluyen la pila de navegación del teléfono.

Se aprovechan las suites existentes de rescate, pausas, entrega, carrito, transiciones y recepcionista según los módulos modificados. El replay de siete días distingue omitido de aprobado: si falta el export, no demuestra calidad. Los fallos preexistentes se comparan con la misma base y no se presentan como pruebas verdes.

Una verificación con teléfono real y Meta queda como paso futuro separado, con alcance y efectos concretos autorizados; las pruebas locales no certifican esa integración.

Por entrega, Claude Code prepara diff local, explicación del cambio, resultados y limitaciones. Codex revisa riesgos, alcance y regresiones. La activación o publicación futura necesitará un encargo separado: la aprobación de este plan no autoriza push ni deploy.

## Siguiente acción concreta

Completar D01 a D04 con el análisis que Claude está preparando y presentar el ranking de causas. Comenzar A01 y A02 por los silencios y derivaciones que expliquen más clientes desatendidos, preparando antes sus reproducciones. Después revisar el recepcionista y ajustar el orden de formatos y formularios con los conteos obtenidos.
