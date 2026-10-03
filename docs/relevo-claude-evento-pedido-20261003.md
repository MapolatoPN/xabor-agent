# Corrección: salir de eventos para ordenar

Fecha: 2026-10-03. Rama: `fix/whatsapp-salir-evento-20261003`.
Base: `059b2027522ccda806ecd465b3deff0b618ecfb5` de `origin/prod/mesero-shadow-v3`.
Worktree: `C:\xabor-agent\.codex\worktrees\whatsapp-salir-evento-20261003`.

## Incidente y causa

La conversación de prueba terminada en 9919 preguntó por eventos el 2 de octubre.
El 3 de octubre escribió «quiero ordenar» y recibió nuevamente la pregunta por el
número de personas. La inspección de producción fue de solo lectura: había una
sesión comercial marcada como catering, con nombre capturado pero sin asistentes.
Los mensajes tenían identificadores diferentes; no era un webhook duplicado.
La captura legacy interceptaba cada turno antes del agente de pedidos. Solo
reconocía la cancelación explícita, no un cambio claro a ordenar.

## Cambio

- Reutiliza el clasificador estricto `solicitudDeEntrada`: una petición completa
  de ordenar cierra la captura comercial y deja continuar ese mismo mensaje.
- Verifica que el cierre quedó guardado; ante fallo conserva la salida a revisión
  humana. Registra el motivo `cambio_a_pedido_por_cliente` mediante el servicio
  existente. No cancela cotizaciones ni ventas.
- También sale de la ficha de evento del agente cuando está activa.
- Con carrito pendiente, abre su edición de forma determinista, conservando
  productos y dirección. Sin carrito, abre la selección habitual.
- Si la solicitud incluye modalidad, la procesa con `definir_entrega`.
- No interpreta negaciones, asistentes, productos concretos ni frases mixtas de
  catering como una orden de abandonar el evento. Conserva las barreras de folio,
  confirmación incierta, programación y hechos ya ejecutados.

El archivo protegido `src/channels/whatsapp-meta.js` se modifica exclusivamente
para esta corrección solicitada. El riesgo principal es salir de una captura por
error; el reconocimiento de frase completa y las pruebas negativas lo acotan.

## Validación local

Node 22.23.3, imagen `xabor-beta-node22:20260930`:

- `test/fase-catering.mjs`: 22 grupos aprobados. Incluye ejecución de la rama real
  del adaptador con dependencias simuladas: cambio a pedido, continuaciones,
  negación y fallo al guardar el cierre.
- `test/fase-agente-menu-evento.mjs`: 31 casos aprobados.
- `test/fase-inicio-mapo-db.mjs`: 18 grupos aprobados en PostgreSQL aislado
  `test_botones_salir_evento_20261003`, con bloqueo de red externa. La regresión
  cubre carrito vacío/guardado, evento del agente presente/ausente, pendiente de
  facturación, dirección conservada, cero llamadas al modelo y un solo outbox al
  repetir el identificador del mensaje.

No se enviaron mensajes reales ni se escribieron datos de producción. No se ha
validado el cambio mediante un webhook real de Meta. No requiere migraciones.

## Entrega y pendientes

El cambio está preparado localmente para revisión; no se integró ni desplegó.
Antes de integrar, comparar con la punta actual de producción y conservar los
cambios concurrentes. Un push a `prod/mesero-shadow-v3` puede desplegar: tratarlo
como acción de producción, conforme a AGENTS.md y CLAUDE.md.

Después del despliegue autorizado, probar «quiero ordenar» en la conversación
afectada y comprobar que abre el pedido guardado. No hace falta borrar su historial
ni editar manualmente su sesión. Si expiró la sesión antes de la prueba, reproducir
primero una captura de evento incompleta en la conversación de prueba.

Este reporte complementa `docs/relevo-claude-whatsapp-20261001.md`, que documenta
los cambios anteriores de navegación y latencia; no los reemplaza ni modifica.
