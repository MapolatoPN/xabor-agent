# Plan: pedido híbrido consistente y chat con formularios

Actualización del 30 de septiembre: el cierre posterior, la autorización de los
componentes protegidos, las pruebas y los límites de operación se documentan en
[Cierre de WhatsApp híbrido y seguimiento](cierre-whatsapp-hibrido-20260930.md).
El avance parcial siguiente se conserva como evidencia del checkpoint inicial,
no como la lista vigente de cambios por implementar.

Fecha: 30 septiembre 2026. Estado: implementación parcial local, sin desplegar.
Base inspeccionada: código productivo `11ef8d5`; informe de despliegue local
`368e002`. Rama de trabajo: `feat/whatsapp-trazabilidad-20260930`. No se modifican
producción, conversaciones, configuración ni pedidos reales.

## Resultado buscado

El cliente puede escribir su pedido o entrar por categorías; ambos caminos
terminan en el mismo carrito y formulario continuo, conservando lo que ya dijo.
El personal entiende qué se envió, qué interacción se observó, qué contestó
el cliente y qué validó Xabor. Abrir un formulario no confirma ni cobra.

## Evidencia de partida

- XAB-1032: $195, un formulario, cuatro turnos sin modelo, confirmación explícita.
- XAB-1036: $586 + $60, dos formularios y una espera de aproximadamente 44 s
  tras el pedido compuesto. La segunda ventana solo pidió tortilla del taco
  restante. La ruta `flow_configurar` conserva `MAX_LINEAS_FLOW = 3`.
- «Buen dia, quiero hacer un pedido a domicilio» devuelve `null` en
  `intencionDeEntrada`; «Buen día» sí entra al inicio Mapo.
- El primer formulario de XAB-1036 no precargó el chicharrón solicitado; el
  cliente lo seleccionó de nuevo. La entrega tampoco estaba precargada.
- Tras «Gracias», XAB-1036 recibió «ya va en camino» sin un estado que lo respalde.
- XAB-1032 tenía una oportunidad 2x1 calculada, pero no presentada al cliente.
- Zonas estructuradas: Coca Cola $120; texto informativo: $150. Conservar lo
  configurado por el dueño; no modificar la tarifa para conciliar el texto.

## Base antes de estos cambios

- `flowEndpoint.js` autentica y descifra las solicitudes del Flow.
- `flowRepetibleSql.js` vincula token, negocio, conversación, pregunta, ciclo,
  vigencia y barreras de atención; guarda borradores de categorías/carrito.
- Esos formularios usan `data_exchange`; reciben `INIT` y pasos observables.
  No hay aún una bitácora dedicada y visible de aperturas/actividad.
- El formulario agrupado antiguo usa `navigate`; no asumir que emite INIT.
- `historialInteractivo.js` y `contenidoTarjetaFormulario` muestran una tarjeta
  y, cuando existe, el resultado guardado; no una réplica completa del formulario.
- `procesarStatusesWebhook` actualmente actualiza notificaciones de repartidores.
  La aceptación por la API y el estado interno del outbox no prueban por sí
  solos entrega al dispositivo ni lectura del cliente.

## Avance local y límites de esta entrega

El dueño autorizó continuar los pendientes. Esta entrega no completa las cinco
etapas ni autoriza su publicación. Se pidió por separado aprobación para integrar
la vista en `panel/index.html` y los estados de Meta en `whatsapp-meta.js`; ambos
archivos protegidos permanecen intactos mientras esa aprobación esté pendiente.

- Cortesía posterior: «Gracias» y equivalentes puros ya no pasan al modelo tras
  confirmar. No afirman preparación, reparto ni pago. Mensajes mixtos o consultas
  conservan su recorrido. No equivale todavía a certificar toda afirmación
  operativa del bot contra el estado del pedido.
- Carrito unificado: bajo `whatsapp_carrito_unificado_v1=true`, los renglones ya
  capturados por conversación se personalizan en el carrito continuo. Probados
  1, 3, 5 y 8 renglones, notas y cantidades. No cambia el límite del formulario
  agrupado antiguo; conserva respuestas agrupadas vigentes durante la transición.
- «Quiero hacer un pedido a domicilio» entra directamente al formulario y propone
  la modalidad al ejecutor, que la valida. No se capturan frases con productos,
  negaciones, fechas o dudas adicionales. No resuelve aún todos los fallos de
  precarga de preferencias del pedido compuesto real.
- Editar un platillo ya no exige haber elegido antes entrega y pago. La validación
  final continúa exigiendo elecciones reales; el servidor no las inventa.
- Evidencia del endpoint: migración aditiva 110 y módulo de apertura, pasos,
  validaciones y errores reportados por el cliente. Captura apagada por omisión:
  `whatsapp_trazabilidad_formularios_v1=true` la habilita por negocio. Duplicados
  exactos no crean eventos; máximo 512 por pregunta. No almacena respuestas,
  notas, tokens ni datos fiscales. El savepoint permite conservar un borrador
  válido si falla la escritura de telemetría, por ejemplo por tabla ausente.
- El historial proyecta evidencia por negocio y conversación; nunca devuelve la
  foto completa ni capacidades. Los estados distinguen actividad, aplicación,
  revisión, pregunta sustituida y vigencia vencida. Un borrador copiado al retomar
  no cuenta como una nueva apertura. La inactividad observada de 10 minutos es una
  sugerencia al personal, no un abandono confirmado ni un recordatorio automático.
- `panel/formulariosChat.js` está preparado y probado de forma aislada: seguimiento
  y opciones del snapshot enviado, con secciones desplegables, escape de texto y
  cero peticiones al abrir detalles. Aún no está conectado al panel. No es una
  reproducción exacta ni una vista en vivo del teléfono; catálogos mayores a 50
  productos indican expresamente que la vista es parcial.

Siguen pendientes: integración visual autorizada; estados entregado/leído de
Meta; instrumentar fallos HTTP del endpoint y apertura de formularios antiguos;
renovación segura de formularios caducados; retención física mediante una tarea
de purga revisada (se propone 30 días y la consulta ya excluye eventos anteriores);
promociones proactivas validadas, texto de tarifas, latencia y auditoría completa
de veracidad operativa. No se mide una reapertura independiente cuando Meta
repite exactamente la misma solicitud INIT.

### Pruebas realizadas

PostgreSQL local separado `test_botones_trazabilidad_20260930`, Node 22.23.3 en
Docker, red externa bloqueada y Meta/modelo simulados. No se usaron credenciales
productivas ni se enviaron mensajes, cobros o tickets reales.

- `predeploy-check-incidentes`: verde, incluye los tres checks nuevos.
- `fase-flows-db`: 25/25, incluye ocho renglones incompletos en una ventana,
  recibo duplicado, INIT concurrente, pausa, datos de historial y aislamiento;
  bandera de captura apagada y error real de PostgreSQL sin abortar el borrador.
- `check-seguimiento-formularios`: 7 grupos, falta de evidencia, inactividad,
  caducidad, precedencia del resultado, privacidad, savepoint y HTML seguro.
- `check-carrito-unificado`: cuatro tamaños, modalidades con dos entradas
  naturales y seis exclusiones; no se confirma ni cobra al guardar.
- `check-cortesia-post-pedido`: seis turnos sin modelo/efectos, ocho mensajes
  mixtos preservados y cinco barreras de estado.
- `mesero:replay`: 26/26, cero invariantes críticas rotas.
- `mesero:tools`: 66/66.
- `fase-flow-endpoint`: HTTP firmado/cifrado, ping y rechazo seguro, verde.
- `fase-flows-webhook --carrito`: verde, con dos servidores locales, endpoint
  cifrado, tacos por cantidad, bajas múltiples, deshacer, reinicio y recibos
  duplicados. Solo la confirmación final crea un pedido local de $420; ninguna
  llamada al modelo. Esta regresión conserva el recorrido ya existente.
- Vista aislada en Chrome a 1200, 390 y 320 píxeles: sin desbordes, cero
  peticiones al inspeccionar; captura móvil revisada. No certifica todavía
  la integración en el panel ni el render de Meta en iPhone/Android reales.

## Implementación por etapas

### 1. Veracidad operativa (prioridad crítica)

- Respuestas de preparación, reparto, pago y confirmación basadas exclusivamente
  en hechos actuales de Xabor. El modelo puede redactar cortesía, no inventar
  cambios de estado, tiempos garantizados ni pagos realizados.
- «Gracias» después de confirmar: respuesta breve sin afirmar que salió el pedido.
- Si falta evidencia, conservar el estado conocido o indicarlo; nunca completarlo
  con una suposición. Leer el pedido del negocio y ciclo correctos.
- Prueba de salida: caso XAB-1036, cada estado real, fallo de consulta,
  pedido anterior y mensajes mixtos; ninguna afirmación operativa sin respaldo.

### 2. Un solo carrito para conversación y formularios

- Reconocer solicitudes naturales de iniciar pedido con modalidad, sin descartar
  productos, notas, negaciones, consultas ni cambios incluidos en el mensaje.
- Si ya expresó intención de ordenar, abrir el recorrido directamente; no obligar
  a volver a elegir Ordenar. Saludo único y conservación de modalidad autorizada.
- Hidratar el formulario continuo desde el carrito existente; categorías y texto
  convergen en el mismo reconciliador. No aumentar solamente el límite de tres.
- Precargar elecciones inequívocas verificadas. Si «chicharrón» es ambiguo en el
  catálogo, pedir una aclaración concreta sin perder pollo ni las demás opciones.
- Configurar 1, 3, 5 y 8 renglones en una ventana, con Agregar más, edición,
  bajas múltiples, volver y ORDEN COMPLETA. Entrega/pago/dirección una vez.
- Mantener resumen y confirmación final separados. Formularios antiguos válidos
  siguen siendo compatibles durante su vigencia; los obsoletos no mutan pedidos.
- Prueba de salida: los dos casos reales y variantes por texto, categorías y mixto;
  mismos renglones, notas y totales; sin omisiones, duplicados ni ventanas extra
  por el límite de tres.

### 3. Tiempo de respuesta y decisiones comerciales

- Medir cola/agrupación, catálogo, modelo, reconciliación y envío por separado.
  No confundir tiempo del cliente en el formulario con latencia del sistema.
- Reducir consultas y rondas de modelo: lectura agrupada del catálogo y opciones,
  interpretación estructurada, validación y aplicación por Xabor.
- Revisar la espera fija para respuestas estructuradas sin romper la protección
  texto+botón, orden de entradas, locks, reintentos ni idempotencia.
- Objetivos iniciales a validar con medición: p95 <= 5 s para rutas deterministas
  y <= 15 s para pedidos compuestos, desde entrada recibida hasta aceptación del
  envío por Meta. Reportar fallos/recuperaciones junto con latencias, sin ocultarlos.
- Proponer 2x1 solo cuando el motor lo detecte; mostrar participantes/condiciones,
  aceptar o seguir sin promoción. Nunca agregar, cambiar salsa ni precio sin permiso.
- Generar textos de envío desde las zonas estructuradas. Conservar Coca Cola $120;
  retirar la contradicción del contexto libre mediante cambio revisado.
- Prueba de salida: promociones aceptadas/rechazadas/caducadas, catálogo cambiado,
  zonas base/especiales/desconocidas, extras y total coherentes en ambos recorridos.

### 4. Trazabilidad de formularios y mensajes

- Registro durable por negocio, conversación, mensaje, pregunta y versión de Flow.
  Guardar eventos y hora de origen/recepción; admitir duplicados y fuera de orden
  sin aplicar acciones de pedido otra vez ni hacer retroceder estados confirmados.
- Estados distintos: aceptado por Meta; entregado/leído si Meta los informa;
  apertura iniciada (INIT válido); último paso observado; respuesta recibida;
  aplicada/rechazada por Xabor; pedido confirmado con folio.
- INIT acredita una solicitud de apertura, no que la pantalla se haya dibujado
  correctamente ni que el usuario siga dentro. Excluir ping, previsualizaciones y
  solicitudes no vinculadas a una sesión productiva válida.
- `data_exchange` acredita únicamente los pasos que llegan al servidor. No
  registrar pulsaciones o elecciones que permanecen locales en el teléfono.
- Cierre/abandono: mostrar «sin actividad reciente» como inferencia, no como
  evento de cierre confirmado. Ausencia de INIT/lectura = no observado.
- Aperturas no confirman, no reactivan pausas y no disparan recordatorios automáticos.
- Integrar statuses de clientes sin alterar el procesamiento de repartidores.
- Prueba de salida: reconexión/reinicio, doble INIT, respuesta antes de status,
  reabrir, cancelar, formulario obsoleto, error del endpoint, aislamiento de negocios.

### 5. Chat operativo con aspecto familiar y formularios inspeccionables

- Burbujas con texto, formato, imágenes/documentos, botones/listas ofrecidos y
  la opción elegida; diferenciar cliente, Mapo Bot y personal.
- Tarjeta de formulario con título, última actividad observada, resultado y acciones
  de solo lectura: Ver formulario enviado / Ver respuesta / Ver cambios aplicados.
- Vista lateral con secciones y opciones del formulario de esa versión, usando
  el snapshot enviado; nunca reconstruir historia con el catálogo actual.
- Mostrar lo enviado por el cliente separado de lo aplicado por Xabor. Borradores,
  si se muestran, etiquetados explícitamente y solo para datos recibidos por servidor;
  nunca presentarlos como compra confirmada.
- Vista propia en HTML/CSS, no espejo de WhatsApp Web ni sesión remota del cliente.
  Abrir la vista del operador nunca consume tokens, envía mensajes o modifica el carrito.
- No exponer flow_token, secretos, JSON crudo ni IDs de capacidades al navegador.
  Autorización por negocio y permisos, escape de contenido y acceso limitado a
  información fiscal/direcciones. Definir retención antes de almacenar nuevos eventos.
- Historial anterior: reconstruir solo donde haya evidencia conservada; marcar
  «detalle no disponible» si falta el snapshot. No inventar aperturas históricas.
- Prueba de salida: móvil/escritorio, historial tras recarga, mensajes con HTML malicioso,
  cambio rápido de chat, WS perdido, lectura sin efectos y sin filtraciones entre negocios.

## Medición del producto

Medir formularios enviados, aperturas observadas, respuestas recibidas, aplicación,
confirmación, reaperturas y ayuda humana. Separar tiempo de sistema, tiempo total
de conversación y tiempo observado entre pasos. No declarar abandono por falta
de telemetría. Medir los regresos al chat separados de los toques dentro del Flow:
ocho platillos personalizados no pueden prometerse en seis toques físicos.

## Publicación y límites de autorización

Primero fixtures anonimizados de ambos pedidos y regresiones locales con red
externa bloqueada. Luego revisión del diff, gate obligatorio, prueba controlada
con el dueño y comprobación visual en iPhone/Android; publicación general solo
tras autorización y verificación de SHA/Flow activos. Banderas independientes
para recorrido, telemetría y panel; reversión compatible con preguntas pendientes.

La etapa 1 debe poder publicarse sin esperar a la reconstrucción visual del panel.
Antes de implementar integraciones en `whatsapp-meta.js` y `panel/index.html`,
revisar y aprobar su riesgo: pueden afectar recepción, atención humana, permisos
e impresión. La eventual migración de eventos debe usar un número disponible y
el runner oficial. Este plan no autoriza migraciones ni despliegues por sí solo.

## Referencias primarias comprobadas

- Meta: ejemplo oficial del endpoint, INIT al abrir y data_exchange:
  https://github.com/WhatsApp/WhatsApp-Flows-Tools/blob/main/examples/endpoint/nodejs/basic/src/flow.js
- Meta: ejemplo oficial de envío con data_exchange, correlación por flow_token
  y recepción de respuesta mediante nfm_reply:
  https://github.com/WhatsApp/WhatsApp-Flows-Tools/blob/main/examples/webhook/nodejs/flows-webhook/server.js

Los ejemplos ilustran capacidades, no son código listo para producción. Se
contrastaron con el endpoint, el historial y la ruta de statuses de Xabor.
