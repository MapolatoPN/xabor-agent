# Piloto de selección agrupada en WhatsApp — 29 sep 2026

Solicitud del dueño: desplegar la opción de selección múltiple y continuar las
pruebas con el mismo número terminado en 9919. No ampliar la atención a clientes.

## Experiencia y alcance

- Botón «Elegir platillos»: hasta tres renglones por carrito en este piloto.
  Un mismo producto puede elegirse tres veces con configuraciones distintas.
- Botón «Personalizar pedido»: un formulario agrupa las opciones de los tres
  platillos; casillas para grupos múltiples y selectores para opciones únicas.
  Entrega y pago se eligen una vez. Se conservan las elecciones existentes.
- El resumen con total exacto y el botón «Confirmar» siguen siendo otro paso.
  Completar el formulario no confirma, cobra ni imprime el pedido.
- Domicilio aún solicita la dirección por el recorrido existente. No se promete
  un máximo de seis toques físicos: se eliminan las preguntas/envíos por grupo,
  pero las elecciones reales del cliente siguen requiriendo interacción.
- Capacidad de este piloto: tres renglones, seis grupos por producto, veinte
  opciones por grupo. Los productos que no caben conservan el recorrido anterior;
  no se inventa ni cambia ninguna regla de catálogo para hacerlos caber.

## Autoridad, riesgos y mitigación

La respuesta de Meta solo trae códigos de opción. Xabor los resuelve contra la
foto completa guardada con el token opaco: negocio, cliente, ciclo, pregunta,
renglones, nombres, precios y cardinalidades. No se interpretan con el modelo.
Caduca a los 30 minutos y se rechaza al cambiar el pedido, catálogo o configuración.

Se validan todos los campos antes de ejecutar. Las mutaciones internas pasan por
el ejecutor/reconciliador sobre una copia: ante cualquier rechazo no se copia nada
al estado original. Carrito y consumo del token se comprometen juntos mediante
la persistencia existente. Un reinicio con reserva incierta conserva el freno
existente; no se reejecuta a ciegas.

No se tocaron los componentes protegidos de `CLAUDE.md`, incluido
`whatsapp-meta.js`. Se reutiliza su recepción de interacciones y envío genérico.
La migración 106 solo amplía las acciones de `agente_botones`; no activa banderas.
El runner 105 reconoce el esquema ampliado para no degradarlo al repetirse.

La modificación del reconciliador permite vaciar un grupo opcional únicamente
mediante la capacidad interna validada, vinculada al estado y argumentos exactos.
Los argumentos del modelo no crean esa autorización.

## Meta

Ambos Flow JSON 7.3 fueron aceptados sin errores y publicados:

| Formulario | ID | SHA-256 del JSON |
| --- | --- | --- |
| Productos | 3522433771237691 | 5ddd12f3ba3b3a122210cf813bbcacca34fb16fac6b76086efb74759d8491b15 |
| Configuración | 1433558705393808 | 9ff0dbe24104401ef9ac4bc3713d587ccedb6e987c599da11b303e3157f7485b |

Meta reporta advertencia/bloqueo WABA 141006: problema de método de pago para
conversaciones iniciadas por el negocio. El propio Flow, negocio y aplicación
aparecen disponibles. Meta permitió publicar ambos. Este piloto no envía plantillas
ni inicia conversaciones: exige una entrada reciente y revalida la ventana de
24 horas antes del envío. No se cambió facturación. La entrega y presentación
en el WhatsApp real del dueño siguen pendientes de prueba; publicar no las prueba.

Lectura del catálogo real: 71 productos elegibles. Sencillos, Mixtos, Bowl y
Combito de Chilaquiles entran; los Mixtos tienen hasta dos salsas, dos proteínas y
dos guarniciones según su catálogo vigente. No se alteraron sus mínimos ni precios.

## Evidencia local

- `scripts/predeploy-check-incidentes.mjs`: OK, incluye `check-flows-pedido`.
- `mesero:tools`: 66/66; continuidad determinista y pedido canónico: OK (19 casos).
- `fase-flows-db`: 12/12; recorrido agrupado, tres platillos iguales independientes,
  reenvíos, precios nuevos, caducidad, payload falso, edición opcional, texto mixto,
  bot apagado, pausa humana, contexto/cliente ajenos, 24 h y migraciones repetidas.
- `fase-flows-webhook`: HTTP firmado, inbox y outbox reales, dos servidores,
  reinicio con formulario abierto, tres platos, doble respuesta y doble confirmación;
  exactamente un pedido LOCAL de $425, cero acciones del modelo.
- `fase-botones-experiencia-db`: 10/10, ruta anterior sin Flows.
- `fase-botones-ofertas-db`: fallo previo en caso 6 (texto ambiguo esperado
  «No pude identificar esa elección»). Reproducido idéntico en worktree separado
  de la base `e256efe`, sin estos cambios. No se modificó ni se ocultó esa prueba.
- Red externa bloqueada en suites; Postgres local desechable. Ningún pedido,
  cobro, ticket o mensaje de cliente real se generó durante las pruebas locales.

## Activación y reversión

Código y migración deben verificarse primero en Railway por commit y despliegue
SUCCESS, no solo por `/health`. Después `configurar-piloto-flows.mjs` permite
modificar exclusivamente cuatro claves del negocio autorizado:
`whatsapp_flows_v1`, `whatsapp_flows_telefonos`, `whatsapp_flow_productos_id` y
`whatsapp_flow_configurar_id`. Exige el mismo número, solo prueba y porcentaje cero.
No cambia el bot maestro, pausas, horario, configuración de pagos ni conversación.

Reversión de la feature: apagar `whatsapp_flows_v1` conservando código y esquema.
No redeployar una versión antigua que intente estrechar el CHECK de acciones
mientras existan tokens Flow. No borrar pedidos ni conversaciones como rollback.

## Despliegue y activación verificados

- Commit publicado: `116c47e4683db218aae5133802620e4e5dcb3527`.
- Railway: `65f82b11-c569-4405-81bb-1d5c51dfcca2`, **SUCCESS** con ese commit.
- El push no generó deployment automático en las comprobaciones; se lanzó una
  sola vez `redeploy --from-source`, verificando previamente el SHA remoto.
- Logs del predeploy: 105 y 106 OK; gate financiero y barrera de datos productivos
  completados. `/health`: HTTP 200, utilizado solo como comprobación adicional.
- Se activaron únicamente las cuatro claves nuevas para el mismo número 9919
  (formatos 52/521), sin cambiar porcentaje cero ni atención solo de prueba.
- Valores anteriores de esas cuatro claves: inexistentes. No se modificaron
  bot maestro, pausas, horario ni conversación. No se envió una prueba artificial
  a Meta ni se generó un pedido real.
- Falta la prueba del dueño en WhatsApp: abrir formulario, elegir y revisar el
  resumen. El aviso 141006 de facturación sigue presente; si Meta rechaza el envío
  del piloto también dentro de la ventana, detener las pruebas y atender la
  restricción de la cuenta, sin tocar tarjetas ni ampliar alcance automáticamente.
