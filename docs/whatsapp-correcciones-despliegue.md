# Correcciones del asistente: alcance de este despliegue

Base: main 73a412c. Rama: codex/whatsapp-ingredientes-incluidos.

Incluye:
- Reconocer componentes explícitamente incluidos en la descripción sin convertirlos en extras ni elegir modificadores por el cliente. Preguntas de topping identifican cada producto.
- Serializar los lotes del mismo cliente dentro del proceso, esperando hasta que termine el callback del canal. Clientes diferentes mantienen procesamiento independiente.
- Ante una excepción de validación conversacional, impedir que salga la promesa libre del modelo, deshabilitar el preview anterior y pedir recuperación o apoyo humano.

Validación local: 176 comprobaciones en 10 suites, todas aprobadas: ingredientes incluidos 17, cola serial 3, negaciones injustas 27, fidelidad del borrador 28, licuado E2E 5, confirmación determinista 38, confirmación agrupada 11, confirmación UX 13, preconfirmación pricing 18 y firma del webhook 16. IA simulada y base de auditoría local aislada. La suite de firma requirió aplicar predeploy-070 a esa base (faltaba compras_whatsapp_autorizados); pasó después sin modificar la suite.

No introduce migraciones ni cambia configuración de negocios. No incluye las ramas de Obispado, Personal o Facturación.

Límites pendientes de la auditoría: persistencia del pedido conversacional tras reinicio, coordinación entre instancias, inbox/outbox durables y deduplicación del procesamiento. La serialización actual es por proceso. El reconocimiento de ingredientes es una contención conservadora; queda pendiente un catálogo de componentes estructurado. Estas correcciones no certifican funcionamiento autónomo completo.

La auditoría original es evidencia del estado previo. Sus puntos 1, 3 y 5 tienen las contenciones descritas aquí, con los límites indicados. No se enviaron mensajes reales a clientes durante las pruebas.

Plan de reversión: revertir el PR de estas correcciones y desplegar el commit resultante. No hay cambio de esquema que revertir. Confirmar commit y estado SUCCESS en Railway, además de health; health por sí solo no identifica versión.
