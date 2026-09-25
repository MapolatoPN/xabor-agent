# Corrección del incidente de guarniciones y modalidad — 25 septiembre 2026

Base de producción revisada: `b225cdea1322b3abbea6db30282538d11e0baa80`.
Rama aislada: `fix/guarniciones-ciclo-raiz`.

## Problema y resultado

En Mapolato Obispado, «Frijolitos y papas a la mexicana» guardó únicamente
las papas. El resolvedor aceptaba la coincidencia inequívoca y olvidaba la
mención ambigua. Como Guarniciones exige mínimo una opción, el pedido dejaba
de mostrar pendientes. Ahora conserva una aclaración durable para los
frijolitos, mantiene las papas y pregunta naturales o con chorizo. La
confirmación permanece bloqueada hasta resolver o retirar esa elección.

La modalidad a domicilio provenía del borrador del día anterior. Los ciclos
sin terminar no caducaban. Ahora un borrador sin folio, sin evento de catering
y sin confirmación incierta abre un ciclo limpio después de más de seis horas
de inactividad. Se usa el intervalo calculado por PostgreSQL; la simulación
local usa su reloj. Al cambiar de ciclo se descartan el historial y el texto
de respaldo recibidos para el turno anterior, además del carrito anterior.

## Alcance

- Pendientes vinculados a renglón, grupo y candidatos del catálogo; no se
  elige una variante por el cliente.
- Varias menciones ambiguas del mismo grupo permanecen independientes.
- Aclarar una opción conserva las elecciones ya guardadas; resolver varias
  en un turno aplica una mutación conjunta.
- Retirar explícitamente una elección pendiente usa el mismo criterio de
  eliminación que el reconciliador del carrito.
- La vista canónica, el resumen y el contexto del modelo reflejan los
  pendientes; la puerta de confirmación existente impide emitirlos.
- Los pedidos recientes y las confirmaciones inciertas se conservan. No se
  añade caducidad de borradores a eventos de catering ni a estados con folio.
- No requiere migración: las aclaraciones viajan en el estado JSON existente.

## Verificación

Pasaron el gate `test:incident` (incluye la nueva regresión), herramientas
65/65, continuidad determinista, ciclos, ciclo terminal 12/12, lectura de
estado, coherencia de prompt 10/10, seguridad conversacional y confirmación
perdida 18/18. `git diff --check` sin errores.

La regresión nueva recorre selección parcial, serialización/recarga,
confirmación bloqueada, aclaración, recogida, efectivo y confirmación con un
efecto simulado. Comprueba total $195 y ambas guarniciones. También cubre dos
ambigüedades, resolución conjunta, retirada explícita, elecciones exactas y
desfase entre relojes. Está dentro de scripts para ejecutarse en el gate de
la imagen antes de desplegar.

## Estado de entrega y límites

Corrección local preparada para revisión. No se integró ni desplegó y no se
cambió la configuración ni el borrador de producción. Las pruebas de este
cambio son aisladas: no enviaron WhatsApp, cobraron pagos ni imprimieron.
No se realizó una conversación real de Meta ni un E2E nuevo contra PostgreSQL.

La caducidad de seis horas afecta borradores abandonados, incluso si contienen
productos todavía sin confirmar. El pedido registrado tiene sus protecciones
independientes. Un borrador que ya perdió una selección antes de esta versión
no puede reconstruirla automáticamente: el cambio protege los turnos nuevos.
