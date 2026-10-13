# Mejoras de atención y formularios de Mapolato Obispado

Implementación local solicitada por Mario el 12 de octubre de 2026. Base: `cdbb7cf`, verificada como el commit desplegado. Rama: `codex/mejoras-obispado-20261012`, worktree independiente. La queja del fin de semana se considera atendida en Facebook, conforme a la aclaración del dueño. No se envía ningún mensaje retrospectivo a ese cliente.

## Comportamiento preparado

| Situación | Resultado |
| --- | --- |
| Una mala experiencia con alimentos, incluido «Los hotcakes olían feo como a pescado» | Se reconoce como queja; el personal recibe prioridad urgente. |
| Queja nueva fuera de horario | «Lamentamos escuchar que tuviste una mala experiencia. En este momento estamos cerrados y no hay personal atendiendo. Al regresar a primera hora, el equipo dará prioridad a tu caso y te brindará la atención debida por aquí.» El recibo solo se entrega si quedó ligado al traspaso humano de ese turno; conserva las barreras del canal. |
| Nombre o datos de recogida enviados por chat después del formulario | Se pasa al equipo conservando el historial. No responde «no te entendí» ni transforma esos datos en un pedido sin confirmar. |
| Ayuda para agregar bebidas antes de confirmar | Se ofrece el formulario del mismo borrador con instrucciones para «Seguir pidiendo» y «Continuar». También se explica dentro del carrito. |
| Ayuda para agregar bebidas después de confirmar | Interviene el equipo; el texto no crea ni modifica un pedido registrado. |
| Problema explícito de pago | Se pasa al equipo y se indica que no necesita crear otro pedido. El aviso al personal pide revisar folio y pagos y conservar el pedido. No se modifica la integración de Clip ni se mueve dinero. |
| Queja llegada después de pedir una persona y quedar pausado el bot | El barrido en segundo plano detecta el mensaje pendiente y avisa al personal; no rompe la pausa ni responde sobre una conversación tomada por el equipo. |
| Caso urgente fuera de horario, aún sin atención al abrir | Aviso inicial urgente y recordatorio al abrir. Son fases distintas, registradas en PostgreSQL. |
| Solicitud normal pendiente | Recordatorio durante horario de atención después de cinco minutos. |
| El equipo responde en WhatsApp o marca la revisión como atendida | El recordatorio deja de salir. Si se atendió por Facebook, usar «Revisé y atendí los pendientes» en Chats. |

Los avisos van al panel y a su push existente. El WhatsApp al encargado conserva su bandera separada; no se activa ni se envían pruebas reales. Las notificaciones son de mejor esfuerzo: una suscripción vencida puede impedir recibir el push. La revisión pendiente permanece en Chats. El ledger evita repetir avisos tras reinicios; un fallo antes de confirmar el envío permite reintentar y puede producir un aviso adicional.

El barrido considera mensajes de las últimas 48 horas posteriores a la activación y a la última respuesta humana. No interpreta automáticamente el seguimiento en Facebook. Un acuse del bot no cuenta como atención humana. Se verifica otra vez la revisión y la bandera inmediatamente antes de emitir. No se corta la consulta a los primeros 100 pendientes, para que una cola grande no oculte los casos nuevos.

## Horarios e inventario

La discrepancia de horarios proviene de `reglas_atencion`, no de una respuesta inventada por el bot. La lectura productiva mostró sábado 15:00 y domingo 18:00. El personal escribió sábado 14:30 y domingo 14:00. La propuesta exacta está en `horarios-obispado-propuesta-20261012.json`; el dueño debe confirmar que son horarios regulares antes de aplicarlos. Conservar la apertura y los demás días. Bot y tienda ya comparten este calendario; no agregar otro horario escrito a mano.

El formulario ya excluye productos agotados y opciones no disponibles cuando se genera su catálogo. Se verificó con un producto agotado y una proteína retirada. La validación final de la orden vuelve a comprobar disponibilidad en la base. Operación: actualizar agotados al abrir y en cuanto se termine un ingrediente. Un formulario abierto puede conservar una foto anterior; el pedido sigue sujeto a la validación final, por lo que no se certifica refresco instantáneo de esa ventana.

## Medición reproducible

`docs/baseline-obispado-20261010.json` se generó con consultas productivas en una transacción READ ONLY. No contiene teléfonos, nombres de clientes, mensajes ni enlaces de pago. Zona `America/Matamoros`, límites locales del 10 de octubre inclusive al 12 exclusivo. No usar un desplazamiento UTC fijo: la zona cambia con el horario de verano.

- 33 conversaciones, 369 mensajes.
- 16 conversaciones con formulario ofrecido; 10 formularios recibidos y confirmados. Las otras seis no tienen confirmación registrada, lo cual no demuestra abandono de compra.
- 24 conversaciones con respuesta humana; cuatro también completaron formulario.
- Ocho pedidos del formulario entregados, uno cancelado sin recuperación registrada y uno cancelado y recuperado manualmente.
- Una conversación asociada a una compra entregada de tienda online; 12 pedidos de tienda entregados sin conversación en el periodo.

El script separa formularios de WhatsApp, atención mixta, recuperaciones manuales y tienda web. Cuenta motivos registrados en `agente_turnos`, sin inferirlos del estado actual de la pausa. No todos los mensajes manuales provienen de un traspaso automático; la ausencia de motivo registrado no significa ausencia de atención. Tampoco calcula conversión de toda intención de compra a partir de una simple consulta de menú.

```powershell
node scripts/analizar-conversaciones.mjs --negocio mapolato-obispado --desde 2026-10-10 --hasta 2026-10-12
```

Requiere `DATABASE_URL`; el cliente fuerza `default_transaction_read_only=on`. Para comparar el próximo fin de semana, cambiar las fechas a `2026-10-17` y `2026-10-19`. No se creó una automatización programada ni un envío del reporte.

## Riesgo, liberación y operación

Los cambios no registran pedidos por texto ni alteran cobros o impresiones. `src/server.js` recibe únicamente el job y la prioridad de notificaciones; sus rutas de pedidos no cambian. No se editaron `brain.js`, `whatsapp-meta.js`, `orderManager.js` ni `panel/index.html`. Los textos nuevos están en la lista cerrada de recibos; no pueden saltar una pausa ajena. El job solo escribe su ledger de avisos y está apagado por omisión.

Orden para liberar, tras revisión del diff y autorización explícita de producción conforme a `AGENTS.md` y `CLAUDE.md`:

1. Revisar/confirmar los dos cierres propuestos y la responsabilidad de responder en Chats a primera hora.
2. Integrar la rama revisada. El runner incluye la migración aditiva 116, antes del binario. Revisar la lista de commits del origen antes de un despliegue Railway.
3. Aplicar los cierres confirmados en la configuración del Asistente, preservando el resto de `reglas_atencion`.
4. En Obispado únicamente, guardar `whatsapp_seguimiento_atencion_desde` con la hora UTC de activación en formato ISO (`YYYY-MM-DDTHH:mm:ss.sssZ`) y después `whatsapp_seguimiento_atencion_v1='true'`. La fecha evita reabrir la queja atendida por Facebook y otros pendientes históricos. No activar el WhatsApp al encargado automáticamente.
5. Observar las nuevas solicitudes y la cola al abrir. Cerrar en Chats los casos atendidos fuera de WhatsApp. Repetir la medición con el próximo periodo.

Reversión del seguimiento: poner `whatsapp_seguimiento_atencion_v1='false'`; el job vuelve a comprobarla antes de emitir. El ledger puede conservarse. Revertir el commit de código para las nuevas respuestas si aparece una regresión. No bajar el modo formulario para volver al motor anterior como forma de rollback.

Esta entrega no autoriza un despliegue, cambios en datos productivos ni contactar clientes. Todo lo productivo realizado fue de solo lectura. La implementación y los artefactos quedan preparados para que la revisión y la aprobación sean el paso final.

## Verificación

Pruebas deterministas con Node 22.23.3 (versión mayor de producción) y PostgreSQL local 18.4; transporte y modelo simulados. La red externa está bloqueada en las pruebas de base. No se enviaron mensajes, cobraron pagos ni imprimieron tickets.

| Prueba | Resultado |
| --- | --- |
| Casos nuevos de Obispado: queja, horarios, formulario, inventario, pago, privacidad y medición | 25 casos correctos |
| Recordatorios y embudo en esquema PostgreSQL aislado | 10 casos correctos |
| Adaptador real, outbox y recepción con PostgreSQL local dedicado | 47 casos correctos, incluidos tres nuevos escenarios |
| Recepcionista | 189 casos correctos |
| Aviso de rescate | 26 casos correctos |
| Cierre y pedido escrito | 37 casos correctos |
| Motor del formulario tienda | 28 casos correctos |
| Plomería de tienda | 19 comprobaciones correctas |
| Barrera completa de incidentes de predeploy en Node 22, sin red | Correcta, incluida validación de Flow 96/96 y control del modo formulario |
| Barrera de Asistente exclusivo en Node 22 | 9 grupos correctos |

Los resultados de notificaciones verifican emisión simulada y persistencia; no prueban la recepción real en un teléfono del personal.
