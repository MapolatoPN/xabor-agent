# Contrato del pedido y liberación controlada — 25 septiembre 2026

## Problema observado

La conversación de Obispado perdió una guarnición, confundió elecciones de sabor y fruta extra y derivó al equipo por fallas recuperables. La configuración repartía el agente al 100 %; eso selecciona un motor, pero no constituye un piloto aislado. El dueño autorizó pausar la atención automática del negocio durante la corrección.

La causa atraviesa interpretación, estado y ejecución: una opción mencionada sin variante no estaba siempre guardada como pendiente; una respuesta corta podía aplicarse a varios grupos; una consulta recibía una recuperación que hablaba del carrito; una respuesta truncada del proveedor escalaba sin intentar recuperarla. El saludo y el ciclo durable ya estaban corregidos en la base de esta entrega.

## Contrato aplicado

- La consulta reconocida se limita a herramientas de lectura, con una segunda barrera en el ejecutor. Su recuperación responde con datos de la consulta.
- Las menciones ambiguas sobreviven al guardado, aunque otra opción ya satisfaga el mínimo del grupo. El producto explícito y las elecciones inequívocas se conservan; la variante adivinada se omite y se pregunta.
- La respuesta corta pertenece al renglón y grupo de la última pregunta. Una mención no puede rellenar dos grupos, incluso repartiendo llamadas en el mismo turno. El catálogo determina opciones, límites y precios.
- Completar las opciones del renglón pendiente no crea otra unidad. Producto y renglón tienen identificadores distintos y explícitos en el contexto del modelo.
- Las elecciones canónicas que expresan ausencia, como «sin azúcar», conservan su polaridad; no se confunden con borrar esa elección.
- Una respuesta truncada por tokens permite un solo reintento antes de ejecutar sus herramientas. No reintenta confirmaciones inciertas ni estados terminales.
- Registro, impresión y pago siguen usando los mecanismos existentes. La unicidad de confirmación y la revisión humana ante efectos inciertos se mantienen.

## Aislamiento del piloto

La nueva bandera `configuracion.bot_whatsapp_solo_prueba=true` aplica una lista cerrada de `mesero_agente_telefonos` antes de entrar a cualquier motor de WhatsApp. El porcentaje no puede saltarla. Lista vacía o error al consultar la configuración dejan el turno en atención manual. Números mexicanos 52/521 equivalentes se normalizan; otro país no obtiene autorización por coincidir en los últimos diez dígitos.

El interruptor maestro `negocios.bot_whatsapp_activo=false` sigue teniendo precedencia. Desplegar código no lo enciende. El cambio en `whatsapp-meta.js` está limitado a importar y aplicar esta barrera; el riesgo es bloquear respuestas por una mala configuración, por lo que se prueba tanto el número admitido como uno excluido.

## Evidencia reproducible

1. `npm run test:incident`: regresiones del contrato, guarniciones, saludo, ciclo, recuperación y protecciones existentes.
2. Suites `fase-agente-tools`, `fase-agente-programados`, `fase-agente-confirmacion-perdida`, `fase-agente-ciclo-terminal`, `fase-agente-prompt-coherente` y `fase-agente-reglas-asistente`.
3. Base local aislada: `test/fase-agente-recorrido-operacional.mjs` comprueba registro, panel, comanda, outbox y caída posterior al COMMIT sin duplicar pedidos.
4. Base local aislada, dos procesos: `test/fase-continuidad-canario.mjs` con `TEST_CANARIO_RETORNO=1` comprueba reentregas, recuperación y aislamiento de teléfonos.
5. `test/fase-agente-conversacion-real.mjs snapshot.json resultado.json`: proveedor real, catálogo exportado en solo lectura y confirmación en memoria. No inicia el canal ni produce pedidos, pagos o impresiones reales. Recarga el estado entre cada turno; exige dos guarniciones, un solo licuado, sabor/extra separados, modalidad, pago y una única confirmación. Clave del proveedor solo por variable de entorno.
6. `scripts/release-gate.mjs --db-only`: integridad de producción en transacción de solo lectura.

Las repeticiones con el modelo real son necesarias: una primera ejecución pasó, pero las siguientes descubrieron una variante adivinada, un segundo licuado y pérdida del producto al rechazar su opción. Las pruebas deben fallar ante estas regresiones; no basta con verificar que el servidor arranque.

## Puertas de apertura

Mantener la atención general pausada. Publicar y verificar el commit exacto, sin habilitar clientes. Antes de activar el piloto, guardar de forma auditada la lista de un único teléfono, porcentaje cero y aislamiento activo; revisar y reiniciar solo el borrador de prueba fallido, sin pedidos registrados ni confirmaciones inciertas. Esa activación requiere autorización del dueño, porque modifica la pausa solicitada.

El piloto debe comprobar una conversación nueva por WhatsApp, conservación de todas las elecciones, modalidad explícita, total correcto, un solo folio y entrega a panel/comanda. No abrir atención general hasta completar también domicilio, correcciones, cancelación, reinicio/reentrega y derivación humana con evidencia. Ante pérdida de opciones, duplicación, confirmación falsa o derivación inexplicable, volver a pausar y conservar los registros para diagnóstico.

## Límites

Esto corrige los defectos reproducidos y refuerza el contrato entre interpretación y ejecución; no demuestra cero errores para cualquier frase. La detección de consultas es conservadora y lingüística. Las pruebas reales aisladas usan efectos simulados y no sustituyen la aceptación del canal productivo. No se debe describir el bot como listo para todos los clientes antes de cruzar esas puertas.
