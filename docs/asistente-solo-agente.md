# Asistente: un solo motor de WhatsApp

## Comportamiento

La pantalla configura y simula el agente de herramientas (`mesero_agente_v1`).
Se conserva `reglas_atencion.bot` para mantener saludo, tono, personalidad,
FAQs, prohibiciones y transferencias ya guardadas, sin migrar ni borrar datos.
Guardar estas reglas no activa la atención ni modifica el alcance.

WhatsApp Meta ya no importa ni ejecuta `brain.js`, tampoco para catering ni
observaciones en sombra. El adaptador Twilio antiguo responde 410 y no tiene
acceso al motor ni al registro de pedidos. Los archivos históricos del motor
anterior permanecen para pruebas e investigación; no son un respaldo operativo.

El corte maestro, las pausas y la atención humana conservan su prioridad.
Cuando se permite procesar un turno, solo hay dos destinos: agente nuevo si
está disponible para ese número, o revisión humana durable. Si no se confirma
la revisión, se propaga el error; no se afirma un handoff ni se reintenta el
pedido con otro motor. Se conserva la observación del agente nuevo.

Catering nuevo sigue el agente y sus herramientas de captura/handoff. Una
sesión comercial abierta por el motor retirado pasa al personal: no se inventa
una ficha nueva a partir de una respuesta corta. Sus datos se conservan. Las
cancelaciones y cambios explícitos de esas sesiones conservan su tratamiento
determinista, sin convertirlos en pagos o pedidos.

## Activación y panel

`disponibilidadAsistente` es compartida por la selección del agente, el estado
del panel y la activación. Exige proceso habilitado, bandera por negocio y
alcance válido. La lista prevalece sobre porcentaje; un piloto de solo prueba
requiere lista. No interpreta `false`, `1` o `yes` como activación.

Las APIs de administrador y superadmin devuelven 409 al intentar activar un
agente no disponible. La comprobación corre dentro de la transacción del
interruptor, antes de modificarlo. Pausar siempre sigue permitido. El panel
muestra motor y alcance, no los números, y deshabilita la activación cuando
falta disponibilidad. Un corte maestro encendido sin agente disponible se
muestra como atención humana, sin tarjeta verde de atención automática.

## Riesgo y publicación

La revisión inicial partió de `7fd4883`. El release se adaptó sobre producción
`1f09e58`, conservando recepción de órdenes escritas y atención durante cierre.
No modifica datos ni
interruptores productivos y no amplía pilotos. No necesita migración.

Al publicarlo, cualquier negocio que aún dependa del motor anterior pasa a
atención humana cuando recibe un turno: debe revisarse su alcance antes de
integrar. No debe activarse el agente para todos para resolver esa situación.
El dueño autorizó el despliegue del diff revisado.

## Validación local

- `fase-asistente-solo-agente`: disponibilidad, activación, diagnóstico,
  rutas de catering, ejecución del procesador real fuera de alcance y barrera
  contra importar el motor anterior.
- `fase-asistente-solo-agente-http`: seis grupos con servidor y PostgreSQL
  aislados: pausa, rechazo de activación, guardado sin activar y alcance intacto.
- `fase-asistente-solo-agente-webhook`: webhook firmado, pilotos fuera de
  alcance y bandera antigua encendida, revisión durable y ausencia de pedidos
  y respuestas del motor anterior.
- Reglas del Asistente, fallo/handoff, catering y herramientas de eventos,
  panel/formularios y webhook de botones.
- Panel en Chrome real a 1200, 390 y 320 px, sin desbordes. La prueba carga
  el helper de formularios que usa la página real y conserva detalle abierto
  y borrador del operador al actualizar o fallar la lectura.
- Predeploy completo, incluidas las barreras de incidentes, migraciones
  idempotentes y comprobaciones financieras/datos, sobre base local.
- La barrera está en `scripts/check-asistente.mjs`; el archivo de test solo
  la invoca. Se verificó en una imagen Node 22 Linux sin `test/` ni red,
  respetando `.dockerignore`, para asegurar que llegue al predeploy.
- Sobre la base productiva actual: recepción 189 casos puros y 40 con
  PostgreSQL, órdenes escritas/cierre 37, selector 15, activación 14 y
  mensajes fijos/selector 20 con PostgreSQL; todos correctos.

Las pruebas de integración exigen base `test_botones_*` en localhost y el
preload `test/red-solo-local.mjs`. Meta e IA se simulan en el equipo; ninguna
prueba envía WhatsApp real, realiza cobros o imprime físicamente.
