# Cierre de WhatsApp híbrido y seguimiento

30 de septiembre de 2026. Esta entrega integra el trabajo de trazabilidad que
estaba local y completa las correcciones sobre la base productiva `aed6348`.
El dueño autorizó terminar, desplegar y activar las funciones para Mapolato,
incluyendo los cambios limitados del panel, webhook y migración aditiva.
La publicación se comprueba por SHA de Railway y archivos servidos, no solo por
`/health`. El recibo final del despliegue se entrega por separado.

## Resultado para el cliente y el personal

- Texto y categorías desembocan en el mismo carrito continuo. Se conservan
  renglones, cantidades, opciones y notas; no se divide la personalización
  por el límite de tres del formulario anterior. Probados 1, 3, 5 y 8 platillos;
  el límite técnico del carrito es 50 renglones, no una promesa de pocos toques.
- Se pueden ajustar cantidades, quitar varios platillos, deshacer y agregar
  más dentro de la ventana. Editar un platillo no obliga a elegir entrega y
  pago antes de tiempo. Guardar no confirma ni cobra; el resumen final sigue
  requiriendo aceptación explícita.
- El chat muestra el formulario ofrecido desde su foto histórica, actividad
  observada, respuesta final recibida y resultado aplicado por separado. Los
  detalles abiertos se mantienen durante el refresco. La vista es solo lectura.
- Si Meta reporta enviado, entregado, leído o fallido, el historial lo indica.
  Leer el mensaje no prueba apertura del formulario. Un callback tardío no
  rebaja un estado ya entregado o leído; los duplicados no disparan respuestas.
- Un formulario vencido indica cómo pedir otro con «seguir pedido». Puede
  recuperar un borrador recibido en las últimas 24 horas únicamente si negocio,
  sesión, ciclo, huella, catálogo, precios y opciones coinciden. El token nuevo
  conserva vigencia de 30 minutos; el viejo nunca recupera autorización.
- El motor puede sugerir completar una promoción vigente, con participantes y
  condiciones. El cliente decide agregar o confirmar lo existente; no se agrega
  automáticamente ni se cambia una salsa para forzar el descuento.
- Las zonas estructuradas prevalecen sobre textos libres contradictorios de
  envío. No se modifica ninguna tarifa configurada por el dueño.
- «Gracias» tras confirmar no llama al modelo ni anuncia reparto. Otras salidas
  generativas posteriores a confirmar se sustituyen por información verificada
  del folio, negocio y cliente correctos, o por una explicación de que no se
  pudo consultar el estado. Listo no significa en camino ni pagado. No cambia
  el estado de ningún pedido, pago, impresora o repartidor.

## Seguimiento y privacidad

Las migraciones 110 y 111, incorporadas al runner oficial, agregan telemetría.
No alteran pedidos. La firma del webhook y el descifrado del endpoint anteceden
a la captura; el recorrido conserva las barreras del bot, atención humana,
vigencia, ciclo y permisos por negocio. Los eventos contienen códigos cerrados,
revisión y fecha, no notas, RFC, direcciones, tokens ni el contenido de errores.

La retención es de 30 días, con purga horaria en lotes de hasta 1000 filas por
tabla nueva. Leer el chat no borra datos. Un error de captura no invalida una
transacción de borrador válida; las incidencias fuera de la transacción tienen
un timeout de consulta. El historial no expone capacidades ejecutables.

La falta de actividad durante 10 minutos genera una sugerencia de ayuda al
personal, no un recordatorio automático. INIT solo acredita la solicitud
observada de apertura. No permite saber que la pantalla se dibujó, que sigue
abierta, que hubo una segunda apertura idéntica o que el cliente perdió interés.
Los formularios antiguos sin endpoint no permiten reconstruir aperturas que
nunca registraron. La transición admite respuestas antiguas aún válidas.

## Tiempo de respuesta

Se paralelizan lecturas independientes de estado y promociones; las mutaciones
siguen serializadas y no se introducen cachés compartidas de catálogo o precios.
La corrección de opciones sin evidencia conserva el avance y pide aclaración,
sin repetir seis intentos del modelo.

La traza incluye lecturas, modelo, herramientas y total. El diagnóstico
`scripts/medir-latencia-whatsapp.mjs UUID_NEGOCIO 24` usa solo SELECT y devuelve
conteos y percentiles agregados, sin teléfonos ni mensajes. Separa el tiempo
estimado de cola/agrupación, ejecución y aceptación del envío, con errores,
recuperaciones y respuestas sin acuse visibles. No incluye el tiempo que el
cliente pasa completando el formulario.

Los objetivos p95 de 5 y 15 segundos del plan **no están certificados**.
Se conserva la ventana de agrupación de 6 segundos que protege texto y botón
juntos. Reducirla sin otra protección permitiría ejecutar una selección antes
de recibir una corrección del cliente. La medición productiva debe reportarse
con tamaño de muestra; los mocks locales no prueban velocidad real de Meta/IA.

## Pruebas y revisión

Node 22.23.3 y PostgreSQL 18.4 locales. Bases desechables independientes para
suites de DB y HTTP, red externa bloqueada, Meta y modelo simulados. Ningún
mensaje, cobro o ticket real se usa como prueba automática.

- `predeploy-check-incidentes`: verde, incluye carrito, cortesía, seguimiento
  y cierre nuevo; no se omiten comprobaciones anteriores.
- `fase-flows-db`: 25/25, fotos, compatibilidad, cardinalidad, pausas, duplicados,
  cambio de precios, ocho renglones y evidencia de historial.
- `fase-incidentes-conversacion-db`: 14/14, saludo/pedido natural, foto ambigua,
  facturación, opciones sin evidencia y acuse humano con sus barreras.
- `fase-cierre-whatsapp-db`: 8/8, transporte concurrente, aislamiento, promoción
  sin mutación, vencimiento/renovación, incidencias, cambio de catálogo, retención,
  consulta operativa por dueño y diagnóstico agregado.
- `fase-beta-hibrida-db`: 11/11, incluye recuperación segura después de 30 minutos.
- `fase-flows-webhook --carrito`: HTTP firmado y cifrado, dos procesos,
  categorías, tacos, notas, bajas múltiples, cantidades, reinicio y reentregas.
  La confirmación crea una sola orden local de $420; no llama al modelo.
- `fase-flow-endpoint`: firma, RSA/AES, ping sin DB, rechazo cifrado y apagado.
- Replay: 26/26, cero invariantes críticas rotas; herramientas: 66/66.
- Reglas: 9/9; ciclo terminal: 12/12; emisión: verde.
- Pruebas puras del render: escape HTML, vista sin efectos, respuesta separada
  y persistencia de detalles abiertos; sintaxis y `git diff --check`.
- HTML servido e integridad de scripts: 23/23; contratos móviles: 18/18;
  controles de atención: 10/10. Son pruebas de código, no inspección visual manual.

La primera ejecución HTTP encontró outboxes ficticios de otra suite; se repitió
en una base HTTP exclusiva. Una nueva fixture excedía los 20 caracteres del
folio; se corrigió la fixture y se repitió. No se debilitaron barreras para pasar.

La herramienta de control del navegador detuvo la revisión visual porque no
pudo verificar la URL de Windows. No se certifica la inspección manual de la
integración visual nueva ni su render en teléfonos reales. La evidencia visual
aislada del checkpoint anterior no sustituye esa comprobación.

## Activación autorizada y reversión

Solo para Mapolato Obispado, negocio `5de544d8-9a0a-4972-9c92-fd48ff22de66`,
después de verificar el deployment SUCCESS y su commit:

- `whatsapp_carrito_unificado_v1=true`
- `whatsapp_trazabilidad_formularios_v1=true`
- `whatsapp_promociones_proactivas_v1=true`

Antes de publicar, las tres claves estaban ausentes. El bot maestro y la atención
general ya estaban activos y se conservan. No se libera ninguna pausa, no se
resetean conversaciones, no se alteran tarifas ni se envían campañas o pruebas
a los contactos. No hace falta publicar nuevos assets de Flow para este cierre.

Reversión de funciones: poner esas tres claves en false únicamente para ese
negocio. Reversión del código, si hay una regresión: desplegar el SHA anterior
verificado `aed634893de05985f57d4e1458f1ca608983d3b3`, sin borrar las tablas nuevas.
Las capacidades emitidas siguen sujetas al código/configuración compatibles;
un formulario incompatible se rechaza y se retoma, nunca se aplica a ciegas.

## Límites del producto

No es un espejo en vivo del teléfono. No registra elecciones que no llegaron
al servidor, ni decide que hubo abandono. Las sugerencias comerciales se omiten
si no caben junto con el resumen íntegro en 1024 caracteres. La vista histórica
muestra hasta 50 productos y señala cuando es parcial. No se promete que un
pedido de ocho platillos requiera solo seis toques físicos. Esta entrega no
implementa automáticamente todas las capacidades posibles de Meta.
