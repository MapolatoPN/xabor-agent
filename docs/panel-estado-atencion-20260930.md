# Estado real de atención en Chats — 30 sep 2026

## Alcance y estado

Corrección local autorizada por el dueño después de reportar «Tomar conversación»
en chats donde el bot no respondía. Base: `3599c09` (producción al iniciar).
Rama: `fix/panel-estado-conversaciones-20260930`. Sin push ni despliegue.

Se revisó el riesgo del panel protegido: informar mal el estado puede provocar
intervenciones equivocadas. No se cambian las reglas del bot, las mutaciones de
tomar/devolver, la confirmación de pedidos ni impresión. No se levantó ninguna
pausa productiva. No hay migración ni configuración nueva.

## Causa comprobada

- El webhook consulta pausa manual y `human_takeover_until`; el GET `estado-bot`
  omitía el segundo. La UI mostraba automatización habilitada durante takeover.
- Si fallaba el GET, la UI fabricaba `pausado:false`.
- Refrescar el acuse de revisión no actualizaba el estado completo del botón.
- Tras tomar/devolver, se invertía un booleano local sin comprobar otros bloqueos.

Esto explica el indicador falso del takeover. No demuestra qué error de red o
estado viejo vio el dueño en los dos chats con pausas manuales históricas; no se
atribuyó esa observación a una causa específica sin capturar su sesión.

## Corrección

- GET de solo lectura, un snapshot SQL, por negocio/teléfono: pausa manual,
  revisión, takeover vigente y vencimiento, interruptor global y hora de consulta.
  Conserva `pausado` como pausa manual/revisión: `/reactivar` no libera takeover.
- Respeta la excepción legacy NULL exclusiva de Nonna Maye; no expone el bloqueo
  de otro negocio. Error de lectura: 503 genérico, nunca «activo». `no-store`.
- Tarjeta diferencia atención manual y temporal. Explica cuándo termina la
  espera, con hora del dispositivo. Si coinciden, «Quitar pausa manual» aclara
  que el bloqueo temporal sigue vigente. Global apagado y revisión conservan prioridad.
- Lecturas compartidas, respuestas obsoletas descartadas y controles deshabilitados
  si no se puede verificar. Refresco al abrir, recibir mensajes/eventos, volver
  a la pestaña y durante el sondeo del historial. No se habilita el bot con el reloj local.
- Después de una acción se consulta el estado real; no se reenvía el POST ante
  error ni se presenta el resultado en otro chat. Lectura/escritura UI con timeout.
- El acuse de revisión solo se puede enviar cuando el `wamid` de la última
  entrada ya está cargado en el historial. Consultar estado no certifica lectura.

## Evidencia local

PostgreSQL local desechable `test_botones_estado_panel_20260930`, red externa
bloqueada y credenciales sintéticas. Backend/gate en Docker Node 22.

- `npm run test:incident`: OK, incluye la nueva regresión en el gate obligatorio.
- `scripts/check-estado-atencion.mjs`: 17/17 (incluye funciones reales de la UI,
  concurrencia, errores, takeover, cambios de chat, POST y acuse no mostrado).
- `test/fase-estado-atencion-http.mjs`: 9/9, servidor y PostgreSQL reales locales.
- `test/fase-tomar-conversacion.mjs`: 17/17, mutaciones y auditoría preservadas.
- `test/fase-chats-mobile-ux.mjs`: 18/18.
- `test/fase-controles-atencion-frontend.mjs`: 10/10.
- `test/fase-panel-responsive.mjs`: 9/9.
- `test/fase-panel-html-render.mjs`: 23/23.
- `test/fase-estado-atencion-visual.mjs`: DOM/CSS reales en Chrome headless;
  5 estados × 1200/390/320 px, sin desbordes y controles de error deshabilitados.
  Capturas en `%TEMP%/xabor-estado-atencion-qa-*`; inspección visual móvil realizada.
- Sintaxis y `git diff --check`: OK.

Dos contratos antiguos de texto esperaban «Bot atendiendo»/«Bot activo» aunque
la base ya usaba «Atención automática habilitada» y texto del servidor. Se
actualizaron esas expectativas y las de la URL/estado capturado; no se quitaron
las pruebas de comportamiento. El fixture visual histórico incorpora los nuevos
hooks del refresco sin cambiar su objetivo (mensajes, formularios y borrador).

Comprobación adicional NO certificada como verde: `fase-impresion-self-service`
dio 51/56 en Linux; cinco casos de enumeración requieren Windows. En Windows
esos casos pasaron, pero el arranque posterior no completó por faltar `qrcode`
en las dependencias nativas del workspace. No se alteró impresión ni se ocultó
el resultado. El backend y el gate usan la imagen Node 22 con dependencias completas.

## Antes de publicar

Revisar el diff y volver a comprobar si producción avanzó. Publicar requiere
otra autorización. Después: confirmar SHA desplegado, abrir un chat con takeover
real y otro pausado manualmente, comprobar vencimiento y errores sin levantar
pausas para «probar». La corrección muestra los bloqueos; no los elimina ni
garantiza que todo cliente sea elegible para el bot.
