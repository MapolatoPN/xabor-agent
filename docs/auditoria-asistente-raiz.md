# Auditoría del asistente de pedidos por WhatsApp

## Dictamen y alcance

El asistente tiene controles útiles de catálogo, cálculo y confirmación; no es simplemente un prompt conectado a WhatsApp. Sin embargo, el recorrido completo todavía tiene huecos de continuidad, procesamiento y significado del catálogo. No hay evidencia suficiente para considerarlo listo para tomar pedidos sin supervisión. Seguir agregando correcciones a frases aisladas no resuelve esos huecos.

Base inspeccionada: `origin/main` 73a412c90592aa72d5ac8b963386710cdde68bb6. Railway mostraba ese commit en el despliegue SUCCESS 4dc000e0-323c-45e5-b038-44d40707a0be. Corrección local aislada: `codex/whatsapp-ingredientes-incluidos`. No se desplegó ni se enviaron mensajes a clientes.

Evidencia utilizada: lectura del código, consulta de mensajes y catálogo de producción en modo de solo lectura, log del incidente confirmado por Mario, reproducción local del validador, pruebas controladas de cola y sesión, y regresiones locales con proveedor de IA simulado. Esto no equivale a revisar manualmente todas las conversaciones de la semana, medir una tasa global de error ni probar la variabilidad del modelo real. Las horas del incidente se citan como texto de la base, sin reinterpretar su zona horaria.

## 1. Ausencia de coincidencia se convierte en una negativa comercial — prioridad alta

**Confirmado en producción y reproducido.** En Obispado, mensajes 6735–6738 del 10 de septiembre: cuatro hotcakes con fruta y luego un waffle con fruta. El bot primero reconoce fruta incluida y después responde que no manejan «con fruta». Una persona retoma la conversación en 6739–6740.

El catálogo leído contiene Hotcakes Tradicionales, id 78, $149, cuya descripción incluye fruta fresca; Waffles, id 81, $159, acompañados de fruta. El log registra `catalogo_conversacional_bloqueado`, `MENCION_NO_RESUELTA`, `mencion:con fruta`. La reproducción con el catálogo pertinente genera exactamente la negativa del mensaje 6738.

Origen: `src/orders/validadorOrden.js`, `cargarCatalogo` y reconciliación de menciones en `validarBorradorPedido`. La consulta original no cargaba descripción; el algoritmo reconocía nombres y opciones, pero no componentes incluidos. `mensajeBorradorParaCliente` traducía la falta de resolución a inexistencia. Además, dos preguntas de topping no identificaban sus respectivos productos.

**Solución de raíz:** catálogo con composición explícita por producto, opciones obligatorias, extras con precio, exclusiones y solicitudes sujetas a confirmación. Separar los resultados «incluido», «opción disponible», «no disponible confirmado» y «no pude resolverlo». Este último debe pedir aclaración, nunca afirmar inexistencia. La misma versión del catálogo debe alimentar interpretación y validación.

**Contención local:** reconocimiento conservador de declaraciones explícitas de inclusión; rechaza negaciones, alternativas, condiciones y extras. No selecciona toppings ni cambia precios. Las preguntas distinguen productos. Es una contención de este defecto, no un sustituto del catálogo estructurado. No desplegada.

## 2. Pedido conversacional en memoria del proceso — prioridad alta

**Comprobado en código y entre dos procesos locales.** `src/agent/session.js:4` conserva sesiones en un `Map`. Historial, datos pendientes y preview confirmable viven allí. Un segundo proceso con la misma clave comienza con cero artículos y cero mensajes. La prueba anterior había escrito un artículo y un mensaje.

`src/channels/whatsapp-meta.js:954–971` recupera cliente y pedidos anteriores, pero no reconstruye el borrador activo. `restaurarPreviewPedido` restaura un snapshot que el mismo flujo ya posee tras un error de registro; no es recuperación después de reinicio. La persistencia de cotizaciones comerciales es otro flujo y no cubre este carrito.

**Consecuencia:** un reinicio o cambio de instancia puede perder lo acordado antes de registrar el pedido. No se atribuye el incidente de fruta a un reinicio.

**Solución:** persistir por negocio y conversación el pedido activo, revisión, pregunta pendiente, catálogo usado y resumen confirmado. Recuperar antes de procesar el siguiente mensaje. Confirmar una revisión concreta y proteger el cambio con una operación atómica. Los pedidos ya registrados deben seguir usando su mecanismo de emisión existente.

## 3. Agrupar mensajes no garantiza procesarlos en orden — prioridad alta

**Reproducido localmente.** `src/utils/colaMensajes.js:29–42` espera una ventana y borra la entrada antes de invocar el procesamiento, sin esperar su resultado. No mantiene un bloqueo mientras responde el modelo. El callback de `whatsapp-meta.js:1735` tampoco espera `procesarConClaude`.

Con dos turnos de la misma clave y la primera respuesta lenta, la prueba produjo `maxActive: 2` y completó `segundo, primero`. Se redujo la ventana de seis segundos a cinco milisegundos mediante el parámetro de prueba existente; no se cambió la lógica. Esto demuestra solapamiento, no una duplicación de ventas reales.

**Solución:** un solo trabajador activo por conversación, conservando paralelismo entre clientes distintos. Revalidar la revisión del pedido antes de aplicar resultados tardíos y ordenar las respuestas pendientes. El agrupamiento de mensajes puede permanecer como comodidad, pero dentro de este mecanismo. Un candado únicamente en memoria no cubre varias instancias o reinicios.

## 4. Registro único del mensaje no garantiza procesamiento único — prioridad alta

**Confirmado por recorrido estático; sin simulación completa del webhook.** `src/services/database.js:1543–1565` evita duplicar la fila por identificador externo, pero devuelve la fila existente. `src/channels/whatsapp-meta.js:1621` continúa hasta encolar sin distinguir mensaje nuevo de reentrega. Por tanto, el filtro de duplicados del historial no impide una segunda ejecución del bot.

Además, el webhook contesta 200 en la línea 1510 antes de guardar el mensaje. Un fallo posterior de guardado no obliga al flujo a detenerse: `guardarMensaje` devuelve null. El flujo normal selecciona solo el primer mensaje del arreglo en la línea 1540; el recorrido de todos los eventos de Coexistence no subsana esto para mensajes normales.

**Solución:** recepción persistida con identificador externo único y estados pendiente/en proceso/completado; confirmar recepción después de asegurar esa escritura rápida, dejando IA fuera de la petición. Procesar todos los mensajes del sobre. Recuperar trabajos interrumpidos y proteger también las respuestas pendientes. Reentregar el mismo evento no debe volver a ejecutar su efecto. No eliminar por ello los controles independientes contra doble registro o doble impresión.

## 5. Un error del validador puede dejar pasar la redacción libre — prioridad alta

**Confirmado por lectura de control de flujo; falta prueba de inyección completa.** `src/agent/brain.js:672` captura errores de validación conversacional y sigue. La sustitución del texto en la línea 807 solo ocurre si hay `textoCatalogo`; sin él puede permanecer la respuesta original del modelo. La fase determinista también tiene una captura que solo registra el error en la línea 647.

No significa que cualquier texto pueda crear una venta: el registro y el pricing tienen otras guardas. Sí deja una diferencia entre lo que puede afirmar el asistente y lo que pudo verificar el sistema.

**Solución:** las afirmaciones operativas sobre disponibilidad, precio, selección o confirmación deben exigir un resultado validado. Si falla la consulta, conservar el pedido, explicar que no se pudo verificar y ofrecer recuperación o atención humana. Las respuestas sociales pueden continuar sin ese requisito. Probar específicamente errores de DB, extracción y timeout.

## 6. Varias interpretaciones y mucha responsabilidad en el coordinador — prioridad media

`src/agent/brain.js` combina respuesta principal, borrador mediante marcadores de texto, extracción forzada cuando falta y extracción independiente de menciones (`201`, `237`, `398`, `491–502`). Después concilia esas representaciones con el historial y sustituye la respuesta. Importa funciones desde `server.js` en su línea 2, lo que acopla las pruebas del motor al arranque del servidor.

La extracción independiente tiene un propósito válido: detectar omisiones del primer modelo. El problema es que la coordinación de estas representaciones no sustituye a un pedido persistido con transiciones explícitas. No se ha demostrado que cambiar a un modelo mayor elimine ninguno de los defectos anteriores.

**Solución:** usar el modelo para proponer operaciones limitadas —agregar, quitar, cambiar cantidad, elegir opción, responder dato— con esquema validado y referencias de producto. Un motor de pedido decide si la operación procede, calcula y genera la siguiente pregunta. Separar transporte, interpretación, estado y reglas mediante dependencias explícitas. Migrar por etapas conservando las validaciones que sí funcionan; no rehacer todo de golpe.

## 7. Las pruebas y alertas no miden todavía todo el resultado comercial

**Evidencia mixta.** Las suites existentes de negaciones, fidelidad y licuado pasaron 27/27, 27/27 y 5/5 con el proveedor simulado. Eso protege numerosos casos históricos, pero el incidente de fruta seguía existiendo en la base. Las pruebas nuevas cubren 17 casos de inclusión, negación, extra, ambigüedad y aislamiento entre negocios. Un total de 76 comprobaciones pasa en la rama local; no son 76 conversaciones reales ni una certificación global.

`whatsapp-meta.js:66–80` cuenta excepciones y alerta a partir de tres en cinco minutos. El rechazo incorrecto de fruta fue un resultado normal del validador, no una excepción. Este contador no permite medir por sí solo cuántas conversaciones terminan mal.

**Solución:** corpus anonimizado de conversaciones reales con resultado esperado, pruebas de varios turnos, reinicio, concurrencia, reentrega y dos negocios. Registrar por turno la versión del menú, revisión del pedido, decisión del validador y motivo de aclaración o escalamiento. Medir pedidos completados, negativas corregidas por humanos, repeticiones y abandono con revisión humana de muestras; no inventar porcentajes a partir de mensajes enviados.

## Qué conviene conservar

- Precio y previsualización oficiales en backend (`src/orders/orderManager.js:167`), validación de cantidades y opciones, y controles de confirmación. Las regresiones verificadas no deben descartarse.
- Clave de sesión con negocio y teléfono y credenciales de WhatsApp resueltas para ese negocio. Evitan compartir contexto por usar el mismo número en sucursales diferentes.
- Pausa por cliente, interruptor por negocio e intervención humana.
- Registro e idempotencia de emisiones del pedido ya implementados. El nuevo ingreso durable debe integrarse con ellos, sin crear otra ruta de impresión.

## Orden de implementación y criterios de cierre

1. **Contener el defecto confirmado.** Revisar y completar un recorrido de conversación hasta registro del caso de fruta, con modelo simulado y luego prueba controlada. Verificar preguntas, total y una sola venta. La prueba nueva actual llega al validador, no al envío real ni al registro completo.
2. **Fortalecer recepción y continuidad en un mismo frente.** Inbox persistida, procesamiento secuencial por conversación, pedido versionado y respuestas pendientes. Cierre: reentrega y reinicio en cada frontera no pierden mensajes, no mezclan revisiones ni duplican efectos; un cliente lento no bloquea a los demás.
3. **Unificar semántica del menú y decisiones.** Componentes incluidos estructurados, operaciones limitadas y resultado desconocido distinto de inexistencia. Cierre: opciones cobrables, exclusiones, sustituciones, dos productos y dos negocios mantienen selección y total correctos.
4. **Recuperación y calidad observable.** Fallas de proveedor/DB conservan el pedido y no prometen datos no verificados. Ejecutar corpus real anonimizado y piloto supervisado antes de ampliar autonomía. Los umbrales de latencia y calidad deben acordarse y medirse; no quedan aprobados por esta auditoría.

## Reproducciones y estado de entrega

- `test/fase-ingredientes-incluidos.mjs`: 17/17, base local aislada; elimina su esquema de prueba.
- Regresiones: negaciones 27/27, fidelidad 27/27, licuado 5/5, en base local de auditoría con datos sintéticos y modelo simulado.
- `../whatsapp-audit-probes.mjs` respecto a la raíz del checkout: demuestra concurrencia y pérdida de sesión entre procesos, sin DB ni red. El archivo está en el directorio de trabajo compartido, no dentro del repositorio.
- `../whatsapp-repro-fruta.mjs`: reproducción de la versión anterior. `../WHATSAPP-DIAGNOSTICO-FRUTA.md` conserva el diagnóstico inicial; Mario confirmó después que era el caso reportado.
- No corregidos todavía: persistencia, serialización, reentregas, procesamiento del arreglo completo y salida ante fallo de validación. No se ha cerrado la auditoría de todos los subsistemas de seguridad, pagos o infraestructura de Xabor: este alcance es el asistente de pedidos.
- Corrección de fruta y este informe quedan en una rama local. No hubo push, merge, deploy ni mensajes a clientes.
