# Continuidad del asistente: integración con la versión de producción

## Problema y comportamiento resultante

Un mensaje podía quedar guardado en el historial sin que su turno terminara. La cola del proceso no sobrevivía al reinicio y no excluía a otra instancia. Guardar el carrito antes de registrar/enviar la respuesta también dejaba dos momentos distintos de confirmación.

Esta entrega conserva las correcciones de `main` hasta `4d77356`, incluidas las negativas injustificadas, direcciones interpretadas como productos, la tabla de carrito 076 y la constancia de recepción 077. Agrega la migración **078**. No agrega otra vía para registrar pedidos o imprimir: sigue usando `registrarPedido` y la emisión existente.

- `webhook_entrante` conserva el sobre. El acuse HTTP se envía después de guardar también todas las entradas reconocidas y sus marcadores visibles, en una transacción. Un fallo devuelve 503 para permitir reentrega.
- `whatsapp_entradas` registra el avance por negocio y wamid. Una entrega repetida no vuelve a ejecutar la IA. Se recorren todos los mensajes, cambios y entradas del sobre.
- `conversacion_estado` sigue siendo la **única copia durable del carrito**. El trabajador la carga bajo exclusión entre instancias y la guarda al terminar los efectos del canal, junto con el cierre del lote. El envoltorio de Brain no escribe una segunda vez cuando lo llama este trabajador.
- La ventana de agrupación sigue en seis segundos. Un cliente que escribe continuamente deja de posponer su primer turno a los treinta segundos. Cada lote procesa hasta treinta mensajes; hasta cuatro conversaciones avanzan a la vez por instancia.
- El bloqueo de PostgreSQL dura todo el turno. Si el proceso muere, un trabajador nuevo recupera entradas que nunca empezaron; una ejecución ya iniciada queda para revisión, sin repetición automática de sus efectos.
- Los fallos al verificar catálogo/precio o interpretar una extracción no se convierten en promesas del modelo. Un fallo de registro cuyo resultado sea incierto no reactiva el resumen para volver a comprar.
- Las fotos actualizan la misma burbuja al terminar el archivo. La ruta antigua para borrar sesiones exige administrador y solo permite sesiones del simulador de su negocio.

## Atención desde Chats

Las conversaciones pendientes aparecen primero con una advertencia, incluso después de recargar. Al abrirlas, el personal debe revisar mensajes y pedidos registrados, atender lo pendiente y confirmar que lo hizo. El acuse no registra, cancela ni reimprime pedidos. Si llegó un mensaje nuevo desde que se abrió el chat, el servidor rechaza el acuse y pide revisarlo.

La recepción y el acuse humano toman el mismo bloqueo de fila: una entrada concurrente no se puede dar por revisada sin haberla visto. Al devolver la conversación, se descartan los datos conversacionales anteriores; el próximo mensaje empieza un ciclo nuevo. El interruptor general del negocio no se activa por esta acción.

## Transición desde 076/077

No se copia ni borra el carrito existente para instalar 078. La prueba de compatibilidad parte directamente de una fila 076 y demuestra que el trabajador la usa y actualiza.

Un sobre legado pendiente o fallido se convierte en una conversación para revisión durante la migración. No se reejecuta a ciegas. Una reentrega antigua que ya tenga historial pero no un checkpoint 078 también pide revisión. Los sobres históricos terminados siguen disponibles en 077.

Desde esta versión, `webhook_entrante.estado=procesado` significa que terminó la recepción durable; el avance del **turno** se consulta en `whatsapp_entradas`. No equivale a una venta registrada ni a una respuesta entregada.

## Evidencia y límites

Las pruebas usan PostgreSQL local, servidores HTTP reales, firmas del webhook, proveedores simulados y Chrome. Cubren dos instancias, reinicio de ambas, muerte del proceso después de un efecto, confirmación de una venta tras reinicio, reentregas, aislamiento entre negocios, llegada de mensajes durante revisión, transición de tablas y permanencia del aviso en pantalla. También se ejecutan las regresiones de catálogo, precios, confirmaciones, atención manual, imágenes, Compras y Coexistence.

No se promete entrega externa «exactamente una vez»: si la conexión se corta después de que Meta o la base hayan aceptado un efecto, el resultado puede ser incierto. La solución conserva la evidencia y exige revisión; no compra ni envía de nuevo por suposición. La prueba de recepción fallida usa una entrada inválida que revierte la transacción, no una caída de producción.

El recorrido de Chats pasó en Chrome. En el negocio sintético, el arranque del panel también produjo un error de `menuPOSData.map` al recibir una respuesta sin módulo POS; no se presenta ese arranque como una verificación completa del POS.

Estas pruebas no miden una tasa de acierto del modelo real ni cierran el trabajo de composición estructurada del menú. Se conserva esa distinción de la auditoría original: continuidad verificada y calidad semántica de todas las conversaciones son criterios distintos.

Validación de la integración del 11 de septiembre de 2026: 19 suites verificadas sin fallos al terminar las correcciones. Continuidad 13/13; recorrido HTTP/Chrome 9/9; firma y recepción 25/25; compatibilidad durable 11/11; negaciones 39/39; fidelidad 29/29; licuado 5/5; confirmación determinista 38/38; agrupada 11/11; UX 13/13; pricing 18/18; chat manual 22/22; imágenes de chat 38/38; agrupamiento de WhatsApp 14/14; respuesta a imágenes 16/16; visión 37/37; Coexistence 24/24; menú automático 55/55. La suite de Compras verifica sus tres pasos de foto, confirmación y reintento sin cambiar el pago. Los scripts reales de predeploy 076, 077 y 078 también finalizaron correctamente en local.

## Despliegue y recuperación

El runner de predeploy ejecuta 076, 077 y luego 078, y aborta ante un fallo. 078 es repetible y no modifica importes, folios ni pedidos existentes. Después del despliegue se comprueban commit, salud HTTP, logs y estados durables, sin crear pedidos de producción.

No volver a un binario que ignore entradas 078 mientras haya pendientes: podría dejar trabajo sin atender. Ante una incidencia, pausar la atención automática de los negocios afectados, conservar tablas e investigar los estados; nunca limpiar los checkpoints para forzar un reintento de una compra incierta.
