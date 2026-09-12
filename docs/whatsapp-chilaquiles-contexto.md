# Pedido detallado que recibía la misma pregunta

## Evidencia y alcance

El historial de Obispado contiene una negativa a «Chilaquiles» y, después,
dos respuestas idénticas ofreciendo cuatro presentaciones aunque el cliente
ya había dado salsa, proteína y guarniciones. El pedido incluía también unos
Hotcakes de Sartén. La solicitud posterior de hablar con una persona sí
estaba en revisión (`ESCALADA_MODELO`); no era evidencia de un envío fallido.

La base de esta corrección es `dcdfaf0`, que incorpora los cambios de negativas
verificadas, manejo de prosa y filtro de variantes de la rama principal. Se
conserva ese filtro y se completa, evitando un segundo camino de pedidos.

## Corrección

- El filtro reconoce abreviaciones con el mismo resolver del pedido: «pollo»
  y «frijoles» no necesitan coincidir literalmente con el nombre de la carta.
  Solo usa selecciones respaldadas por lo escrito en el ciclo del cliente.
- Si quedan varias presentaciones muestra precios base y descripciones de
  ese negocio. No presupone Sencillos frente a Mixtos: ambas admiten esa
  combinación en la configuración actual.
- La aclaración guarda el borrador completo. Una respuesta que solo elige
  presentación recupera ingredientes y los otros platillos, incluso después
  de reiniciar. Una respuesta con cambios no aplica esa recuperación ciega.
- Cuando «frijoles» corresponde a dos opciones del mismo grupo, pregunta por
  naturales o con chorizo; no pregunta en cuál grupo van.
- Pedir explícitamente una persona marca revisión antes de llamar al modelo.
  Conserva el aviso al equipo y la política existente de silencio al cliente.

No hay migraciones, cambios de carta ni modificaciones al registro, cobro o
impresión de órdenes. Los precios finales siguen pasando por el validador.

## Comprobación reproducible

`test/fase-chilaquiles-contexto.mjs` replica únicamente catálogo y grupos de
Obispado en un negocio desechable de la base local. No incluye teléfonos ni
mensajes de clientes en la fixture. Cubre selección, atributos inventados,
segundo platillo, reinicio, ambigüedad de frijoles y separación entre negocios.

`test/fase-continuidad-webhook.mjs` prueba además la solicitud de una persona
por webhook firmado, verificando que no consume una respuesta del modelo.

Las llamadas a Meta y Anthropic son simuladas. Estas pruebas verifican el
tratamiento del borrador y sus efectos; no garantizan que el modelo interprete
correctamente cualquier frase futura. La revisión humana sigue siendo
necesaria para los casos que no puede verificar.
