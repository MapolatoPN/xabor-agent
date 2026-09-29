# Carrito en WhatsApp y visibilidad del bot — 29 sep 2026

Estado: desplegado y activado en el piloto existente después de la autorización
«continúa». El detalle verificable está al final. Falta la comprobación
interactiva en los teléfonos de prueba; no se enviaron mensajes desde el agente.

Base de trabajo: `c0f4810`, rama `feat/flows-pedido-agrupado-20260929`, worktree
`botones-integracion-vigente`. Se conserva el editor anterior como alternativa.

## Resultado para el cliente

El nuevo editor permite modificar el pedido como un carrito, dentro de la
misma ventana:

- Cambiar varias cantidades; elegir **0 · Quitar** en varios renglones.
- Agregar platillos mediante las categorías existentes, sin volver al chat.
- Editar preparación y observaciones del renglón elegido.
- Deshacer los últimos cambios de la ventana (hasta diez).
- Guardar todas las modificaciones juntas, sin una revisión de eliminación
  por cada platillo ni intervención humana para editar un borrador.

**Guardar cambios no confirma, cobra ni envía el pedido a cocina.** La
confirmación comercial sigue siendo una acción separada sobre el resumen
actualizado. Eliminar el último platillo vacía el carrito, no cancela un pedido
ya confirmado. Los pedidos confirmados mantienen sus restricciones existentes.

Cerrar la ventana no aplica el borrador al pedido. Las transiciones guardadas
en el servidor se recuperan al reabrir el mismo formulario vigente; los campos
que todavía no se enviaron en una transición no se prometen como autoguardados.

## Resultado para quien atiende

- El acceso **Configurar bot** permanece visible para administradores con el
  bot activo, pausado, cargando o ante un error de lectura.
- Los errores muestran **Reintentar**, sin fingir que el bot está apagado ni
  ocultar la configuración. Una respuesta de red antigua no pisa la nueva.
- Se diferencia **Piloto activo** del estado general. No se afirma que el bot
  atienda a toda persona solo porque el interruptor maestro está encendido.
- El historial representa los formularios como tarjetas: enviado, recibido,
  guardado, no aplicado o pendiente de verificar. El resultado guardado se
  puede desplegar, con negritas y saltos de línea.
- Se muestra únicamente evidencia del servidor. No se exponen tokens, JSON
  entrante ni las selecciones de un borrador sin enviar. Un formulario antiguo
  sin evidencia suficiente no se etiqueta retroactivamente como aplicado.
- El chat visible actualiza el resultado, conserva el texto del operador y
  no duplica mensajes ni cierra el detalle abierto. Si falla la lectura,
  permanece el historial que ya se estaba mostrando.

Un **Hola** ya no abre automáticamente el formulario de compra mediante el
atajo de entrada. El saludo y las consultas siguen el canal conversacional;
**Quiero ordenar** sí puede iniciar el formulario. No se sustituyó el modelo
ni se implementó una nueva arquitectura conversacional.

## Autoridad y riesgo

El carrito usa `carrito_v1` y la configuración nueva `whatsapp_flow_carrito_id`.
Sin esa configuración sigue funcionando el editor previo. Reutiliza las
tablas y el endpoint cifrado existentes; no introduce una migración.

Cada formulario conserva la fotografía del catálogo, renglones, precios,
opciones, entrega y pago. La navegación modifica solo su borrador persistido.
El recibo final resuelve ese borrador en SQL; la entrada del cliente no puede
proponer directamente la lista final de renglones. Los cambios se traducen
al ejecutor canónico, se verifican sobre una copia y se aplican juntos.

Se conservan las barreras de negocio/cliente, sesión, pregunta vigente,
revisión del borrador, idempotencia, horario, pausa humana, bot apagado y
alcance del piloto. La entrega del formulario vuelve a comprobar la ventana
de 24 horas. Un catálogo o pedido cambiado invalida la fotografía anterior.

Componentes sensibles tocados: presentación del panel; dos lecturas de estado
del bot en `server.js`; enriquecimiento de lectura del historial en
`database.js`; integración del nuevo editor en el canal del Mesero. Se explicó
el riesgo antes de los cambios. No se modificaron `brain.js`,
`whatsapp-meta.js`, `orderManager.js`, rutas de pedidos ni integraciones de pago.

## Evidencia local

| Comprobación | Resultado |
| --- | --- |
| `npm run test:incident` (incluye gate predeploy obligatorio) | Verde |
| `node scripts/check-flow-carrito.mjs` | Verde: 3/8/50 renglones, páginas, bajas múltiples, cantidades, altas, preparación, deshacer, carrito vacío y entradas inválidas |
| `node test/fase-flows-db.mjs` | 23/23 |
| `node test/fase-flows-webhook.mjs --carrito` | Verde: webhook firmado, endpoint cifrado, dos procesos y reinicio |
| `npm run mesero:tools` | 66/66 |
| `node test/fase-agente-ciclo-terminal.mjs` | 12/12 |
| `node test/fase-panel-bot-formularios.mjs` | Verde: configuración, concurrencia, errores, tarjetas, escape HTML y aislamiento |
| `node test/fase-panel-bot-visual.mjs` | Verde: 1200/390/320 px, sin desborde; actualización del DOM sin duplicar ni perder el borrador del operador |
| `git diff --check` | Verde |

La prueba HTTP usa Postgres local `test_botones_carrito_http_20260929` en
`pg-candidato`, transporte Meta y modelo simulados, con red externa bloqueada.
El escenario elimina dos renglones, cambia otra cantidad, deshace, reinicia y
guarda sin duplicar. Solo la confirmación posterior crea un pedido **local**,
una vez, por el total sintético esperado ($420). No se enviaron mensajes reales,
no se cobraron pagos ni se imprimieron tickets.

La inspección visual se hizo con navegador headless local y las funciones/CSS
reales del panel, en una página aislada con datos ficticios. También comprobó
que una respuesta recibida pase a «Cambios guardados» sin duplicarse y que un
error de red conserve el resultado. No equivale a validar la aplicación completa
con una sesión productiva ni al renderizado nativo de WhatsApp en iPhone/Android.

## Lo pendiente y los límites reales

1. **Meta validó y publicó el nuevo JSON durante el despliegue autorizado.**
   No hubo errores de validación. La aceptación del JSON no sustituye la
   comprobación visual/interactiva del cliente en WhatsApp.
2. El control es un selector de cantidad, no botones gráficos `+/-`. Se
   admiten hasta 50 renglones, 8 por página, y de 1 a 20 unidades por renglón;
   cero significa quitar. No se promete un máximo de seis toques para cualquier
   pedido: depende de cuántas elecciones requieran sus platillos.
3. El importe de la ventana es de **productos**, no el total final. Envío y
   promociones se recalculan al guardar; el texto lo aclara explícitamente.
4. El panel muestra tarjetas y el resultado validado, no una copia interactiva
   del formulario del teléfono ni los cambios que el cliente aún no envió.
5. La actualización consulta el historial del chat visible cada cuatro
   segundos; se aplaza si el panel no está visible. Antes de ampliar mucho el
   piloto conviene medir carga y usar actualización incremental.
6. Sigue separado el fallo histórico DB canónico `05-06` («la segunda» al
   elegir salsa), documentado en `mesero-direccion-zonas-menu-20260929.md`.
   Esa suite completa no se reejecutó ni se declara corregida en este cambio.

## Secuencia de despliegue y recuperación

1. Revisar este diff contra el HEAD productivo vigente y repetir el gate sobre
   la candidata exacta. No sustituir cambios ajenos.
2. Con autorización, crear/validar el DRAFT del alcance `carrito` mediante
   `scripts/publicar-flows-pedido.mjs`; detenerse ante errores de Meta.
3. Desplegar el backend revisado sin activar todavía el nuevo ID. Verificar el
   commit real en Railway, no solo una respuesta 200 de `/health`.
4. Publicar el Flow validado y configurar únicamente `whatsapp_flow_carrito_id`
   para el negocio piloto. Preservar las listas de teléfonos y el alcance
   actuales; no incorporar destinatarios ni enviar mensajes por iniciativa propia.
5. Probar en los teléfonos autorizados: tres platillos, quitar dos juntos,
   cambiar cantidad, agregar otro, volver atrás, deshacer, cerrar/reabrir,
   guardar, comprobar el panel y confirmar una sola vez cuando corresponda.
6. Si falla el nuevo editor, retirar su ID de configuración para volver al
   editor previo. No borrar pedidos ni sesiones para simular recuperación.

## Despliegue completado — evidencia

- Rama productiva comprobada antes del push: `15e4365`; no había commits
  productivos ajenos pendientes de integrar. Gate obligatorio reejecutado en
  verde sobre `25ccf4498a26debe808cffc56514d1e95842e1a4`.
- Push fast-forward desde PowerShell a `prod/mesero-shadow-v3`. Dos consultas
  no mostraron despliegue automático; se ejecutó una sola vez el redeploy
  explícito desde el origen, con proyecto, entorno y servicio fijados.
- Railway deployment `060a3e28-a77e-4b42-b838-618a7b000ac0`: **SUCCESS**,
  commit exacto `25ccf44`. Logs contienen la regresión nueva del carrito y
  «Todos los pasos completados» del predeploy.
- `/health` respondió 200; `/app` contiene las funciones nuevas de tarjetas,
  configuración estable y actualización del historial. El endpoint público
  respondió `active` a un ping firmado y cifrado, sin token de conversación,
  escritura de pedido ni envío de mensajes.
- Flow `1402954261994599`, nombre `xabor_carrito_agrupado_0cf5cf31a300`,
  **PUBLISHED**, sin errores de validación. SHA256 de la definición:
  `0cf5cf31a3006ec5da7858cfdb06fc4f03b82dbf3048886a567ae1dff38906c9`.
- Meta conserva el aviso WABA `141006` sobre el método de pago para
  conversaciones iniciadas por la empresa. El piloto responde al cliente
  dentro de su ventana; no se cambió facturación ni se enviaron plantillas.
- Después de SUCCESS y PUBLISHED, una transacción SERIALIZABLE, con bloqueo
  y comparación de configuración, agregó solo `whatsapp_flow_carrito_id`:
  ausente → `1402954261994599`. Pertenencia a la cuenta, nombre/hash, estado
  publicado y endpoint de Meta verificados antes de escribir.
- SHA256 de todas las demás claves, idéntico antes/durante/después:
  `d34db7817ec43aadb39f573765556bad7884ca330c4f0aed8f94e2935899acd5`.
  Siguen las mismas nueve personas y 18 representaciones por lista,
  porcentaje 0, shadow false y piloto restringido. Bot maestro y pausas
  intactos. Editor anterior `1668610027961778` conservado como alternativa.
- Borrador del dueño antes/después de activar: revisión 444, ocho renglones,
  sin folio, MD5 del estado idéntico `dd2ba2e3b7bfe7599d6dc5eb494dfb9c`.
  No se eliminaron productos ni se reinició ninguna conversación por consola.

Para probar, obtener una invitación nueva desde **Cambiar algo → Abrir carrito**;
no reutilizar un formulario anterior. Elegir **0 · Quitar** en varios renglones
y **Guardar cambios** debe aplicar todo junto y producir el resumen actualizado.
La confirmación del pedido permanece separada. Recargar el panel para recibir
la nueva presentación del historial.

Rollback de interfaz: retirar exclusivamente `whatsapp_flow_carrito_id` para
recuperar el editor anterior; preservar pedidos, sesiones, pausas y listas.
El rollback no se ejecutó.

`STATUS: DESPLEGADO_PILOTO_ACTIVO_PENDIENTE_PRUEBA_EN_TELEFONO`

## Ajuste operativo posterior — piloto exclusivo del dueño

Por solicitud explícita del dueño tras pausar la atención general, se dejó
habilitado únicamente su teléfono terminado en **9919**, con sus dos
representaciones 52/521. Este alcance sustituye al piloto de nueve personas
documentado arriba; los otros ocho participantes quedan fuera del piloto.

- El interruptor maestro estaba apagado. La implementación lo exige también
  para pruebas: se encendió en la misma transacción SERIALIZABLE que restringió
  `mesero_agente_telefonos` y `whatsapp_flows_telefonos` al dueño.
- `bot_whatsapp_solo_prueba=true` y porcentaje 0 se conservaron. La barrera
  común bloquea a los demás antes de la atención automática, incluido el
  fallback. No se habilitó atención general.
- Se bloquearon y compararon negocio/configuración antes de escribir. Solo
  cambiaron las dos listas y el interruptor maestro; IDs de Flow, catálogo,
  zonas, tarifas, horarios y pausas individuales permanecieron intactos.
- Las funciones reales de alcance, Flows y barreras interactivas aceptaron
  ambas representaciones del dueño y rechazaron las 16 representaciones de
  los otros participantes, más dos representaciones ajenas al piloto.
- Una lectura posterior al COMMIT verificó nuevamente el alcance exclusivo.
  Auditoría de producción: `125066b6-b288-4a67-a937-d221ddc0a5be`, con ejecución
  asistida por Codex y solicitud explícita del dueño documentadas en contexto.
- Carrito conservado: revisión 444 y MD5
  `dd2ba2e3b7bfe7599d6dc5eb494dfb9c`, idénticos antes y después.
- Sin despliegue, mensajes salientes, reinicios de conversación ni cambios
  de pedidos. La atención manual de otros clientes sigue disponible.

`STATUS: PILOTO_EXCLUSIVO_DUENO_ATENCION_GENERAL_BLOQUEADA`
