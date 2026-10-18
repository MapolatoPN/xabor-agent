# Correcciones de WhatsApp: Obispado y Acuña

Implementación local sobre `69624c6f309382ccc81b8df07ba32e12444f85ff`, en la rama `codex/correcciones-whatsapp-20261018`. No se ha hecho push, integración ni despliegue. No se modificaron datos, horarios, métodos de pago ni banderas de producción.

## Comportamientos corregidos

| Problema | Corrección |
|---|---|
| El lector rechazaba el esquema de comprobantes antes de analizar la imagen | Se simplificó el esquema enviado al proveedor, incluidos versión y moneda nullable. La validación local sigue exigiendo la versión y los valores exactos. Un comprobante compatible conserva el acuse «Gracias por tu comprobante.». |
| Un saludo del personal invalidaba el formulario abierto | El panel y los ecos de Business App distinguen ayuda sobre un formulario vigente de atención personal. Se conservan carrito, capacidades e idempotencia; las pausas, revisión humana y takeover vigentes siguen bloqueando. |
| No se podía elegir explícitamente cómo intervenir | El chat permite elegir envío automático, ayuda al formulario o atención personal. La ayuda explícita se rechaza antes de enviar si no existe un formulario vigente. |
| El cierre de venta parecía recepción del cliente | En seguimiento público y consultas de WhatsApp, el cierre administrativo de un pedido a domicilio aparece «en camino» hasta que el repartidor confirma la recepción. La asignación sola conserva «listo». |
| El repartidor perdía el pedido al cerrarlo en panel | Los cierres administrativos de las últimas 12 horas con reparto pendiente siguen en su lista. La confirmación final conserva aislamiento por negocio, propiedad del repartidor e idempotencia concurrente. Se guarda `entrega_recibida_at` sin sustituir la fecha del cierre de venta. |
| Variantes habituales caían en «no te entendí» | Se reconocen solicitudes breves de pedido, preguntas de servicio/horario, salsas del catálogo y reclamos por pedidos que figuran entregados. Los reclamos de retraso se canalizan al personal. |
| Dos preguntas recibían una sola respuesta | Se componen los temas explícitos con respuestas configuradas y datos del catálogo, dentro del límite de WhatsApp. |
| El bot negaba globalmente transferencias mientras el personal las atendía | Se describen solamente los métodos habilitados y se ofrece ayuda del personal para alternativas. El enlace se explica como pago con tarjeta únicamente cuando está habilitado. No se habilitan transferencias ni proveedores. |
| Pedidos grandes recibían automáticamente el tiempo estándar | Desde 10 unidades se solicita confirmar el tiempo con el personal y se muestra una advertencia en la comanda. El helper admite `reglas.pedidos.umbral_pedido_grande` de 2 a 100; no se agregó un editor de ese umbral al panel. |
| Recordatorios por agradecimientos ya atendidos | Se omiten cierres inequívocos posteriores a una respuesta humana. «Sí», «ok» y «listo» siguen requiriendo seguimiento; las urgencias conservan prioridad. |
| Confusión entre menú en imagen/texto y sucursal | El fallback indica que se entrega el menú actualizado en texto. Una solicitud explícita de otra sucursal recibe orientación, sin enviar la imagen local ni adivinar datos de otra empresa. Se mantiene la revisión obligatoria de imágenes contra la carta. |
| Horarios difíciles de encontrar | La tienda muestra los horarios configurados de esa sucursal en un bloque desplegable. No inventa ni modifica horarios. |

## Límites y controles conservados

- Leer una captura y agradecerla **no acredita un abono bancario** ni cambia el pago del pedido. Los controles de conciliación y cobro permanecen vigentes.
- Los cambios del esquema se comprobaron con respuestas simuladas del proveedor; falta comprobar una lectura real después de un despliegue autorizado. No se enviaron comprobantes reales a servicios externos durante estas pruebas.
- La ayuda al formulario solo aplica a una pregunta entregada, vigente y compatible con el ciclo actual. Se rechaza ante otra intervención del cliente, confirmación incierta, pedido confirmado, pausa o configuración no habilitada. No recupera capacidades caducadas.
- Los pedidos históricos no se reabren. Los reportes de caja e historial conservan el cierre administrativo existente; esta corrección separa el estado de recepción mostrado al cliente y el trabajo pendiente del repartidor.
- Los pedidos programados desde las 08:00 y su visibilidad al agendar ya tenían mecanismos en la base revisada. No se cambiaron esas reglas ni se afirma haber validado su activación en producción en esta entrega.
- No se alteraron la queja que ya atendió el equipo, los proveedores de pago ni las reglas para liberar un pedido pendiente de pago. La opción existente de pago presencial permanece sujeta a sus controles y banderas.

## Verificación local

Node.js 22.23.3, PostgreSQL local en `127.0.0.1:55454`, negocios y teléfonos ficticios. `test/red-solo-local.mjs` bloqueó conexiones fuera del equipo; Meta, Anthropic y Clip se simularon cuando fue necesario. Chrome se ejecutó sin impresión física.

| Prueba | Resultado |
|---|---|
| `scripts/predeploy-check-incidentes.mjs` | Completo, correcto; incluye las 11 regresiones nuevas y 32 controles de comprobantes |
| `test/fase-comprobante-sdk.mjs` | 7 correctas; rechazo del esquema anterior, lectura, moneda nullable, acuse y caché |
| `test/fase-vision-v2-universal.mjs` | Correcta |
| `test/fase-comprobantes-vision-db.mjs` | Correcta |
| `test/fase-ia-recepcion.mjs` | 189 correctas |
| `test/fase-recepcion-dudas-acuna.mjs` | 33 correctas |
| `test/fase-mejoras-obispado.mjs` | 25 correctas |
| `test/fase-tiempo-estimado.mjs` | 8 correctas |
| `test/fase-flows-direccion-db.mjs` | 14 correctas; ayuda conserva confirmación, takeover la bloquea, aislamiento |
| `test/fase-tienda-db.mjs` | 15 correctas; ayuda en tienda y desactivación de banderas |
| `test/fase-entrega-cliente-db.mjs` | 5 correctas; seguimiento, lista del repartidor, confirmación concurrente y aislamiento |
| `test/fase-listo-entregado-repartidor.mjs` | 11 correctas; HTTP, Meta simulado y Chrome, incluido chat a 390 px |
| `test/fase-portal-repartidor.mjs` | Correcta |
| `test/fase-pago-presencial-libera-pendiente.mjs` | Correcta; conserva restricciones financieras y banderas |
| `test/fase-menu-revision-carta.mjs` | 28 correctas; revisión, aislamiento, cambios de carta, fallback y otra sucursal |

La prueba del menú se ajustó al enrutamiento vigente: las conversaciones autorizadas prueban el menú y las que quedan fuera del alcance prueban revisión humana. Su expectativa anterior de usar el motor legacy contradecía la protección existente en la base. Se revisó visualmente la captura móvil del chat; el selector cabe y un envío rechazado conserva el texto.

## Trabajo operativo pendiente

1. Personal de cada sucursal: actualizar productos y opciones agotados al abrir y cuando se terminen. El sistema solo conoce el catálogo registrado, no la existencia física.
2. Responsable de cada sucursal: conciliar los métodos aceptados con la configuración del bot; definir quién valida transferencias y excepciones sin duplicar el pedido.
3. Personal de turno: confirmar disponibilidad y tiempo de pedidos grandes; registrar tiempos realistas cuando cambie la capacidad de cocina o reparto.
4. Administrador: revisar las imágenes del menú contra la carta vigente antes de autorizarlas.
5. Tras revisión del diff y un despliegue autorizado por separado: comprobar un comprobante real, un formulario con ayuda humana, el recorrido de un reparto y la visibilidad inmediata de una reserva desde las 08:00. Esta comprobación no se ejecutó en producción.

No hace falta una migración de base de datos para estas correcciones.
