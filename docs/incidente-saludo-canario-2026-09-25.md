# Corrección del saludo y recuperación del canario — 25 de septiembre de 2026

## Evidencia

El saludo «Hola» del teléfono terminado en 9919 llegó a la versión 66212cf. El canal registró AGENTE_AFIRMO_CAMBIO_SIN_GUARDAR con cero operaciones y derivó la conversación a revisión. El texto previo a la barrera no quedó disponible en los logs consultados; no se atribuye al modelo una frase concreta no observada.

El borrador conservaba chilaquiles, recoger y efectivo, con programacionRequerida=true y sin fecha. La vista lo presentaba como listo. La corrección anterior de guarniciones no reconstruye retroactivamente una opción que ya se había perdido antes de desplegarse.

## Cambio

- Los saludos simples responden desde el estado guardado y preguntan el dato pendiente sin consultar al modelo.
- Una afirmación de cambio sin operaciones de efecto se sustituye por una pregunta o resumen canónico. Se conserva la derivación si hubo intentos de escritura, confirmación incierta o estados terminales.
- La fecha requerida pasa a ser un pendiente real de la vista e impide presentar el borrador como listo.
- Se incorpora una regresión a la barrera que Railway ejecuta antes del arranque.

## Validación

- Canal WhatsApp real contra Postgres local, con Meta y modelo simulados: saludo con borrador de 90 minutos, conservación de modalidad, recuperación de afirmación sin efectos y duplicado concurrente en dos procesos.
- Recorrido operacional: 13/13, incluyendo pedido, panel, compra durable, trabajo de impresión y confirmación al cliente con el mismo folio; también caída después del registro sin duplicar.
- Herramientas: 65/65. Programados: 56/56. Confirmación perdida: 18/18. Coherencia del prompt: 10/10. Continuidad determinista, seguridad conversacional y predeploy de incidentes: aprobados.
- Se actualizaron fixtures obsoletos: interruptor maestro, reglas completas de horario, catálogo y comprobación del texto canónico de confirmación. Las suites con workers globales se ejecutan secuencialmente sobre la base local.

Los proveedores están simulados en estas pruebas. No se envió un WhatsApp real ni se imprimió papel. Una prueba real del cliente sigue siendo necesaria para validar el comportamiento del modelo en conversación abierta.

## Estado operativo

La conversación productiva está en revisión por el incidente. El despliegue no quita automáticamente esa pausa ni borra el borrador. Se solicita autorización para reiniciar exclusivamente la conversación de prueba, conservando el historial y los pedidos registrados.
