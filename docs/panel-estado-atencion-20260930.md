# Estado real de atención en Chats — 30 sep 2026

## Alcance y estado

Corrección local autorizada por el dueño después de reportar «Tomar conversación»
en chats donde el bot no respondía. Base: `3599c09` (producción al iniciar).
Rama: `fix/panel-estado-conversaciones-20260930`. Desplegada con autorización
explícita del dueño: commit `11ef8d5dc4df67bf7d21286a5310ca8acc07489f`.

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

## Despliegue y comprobación — 30 sep 2026

- El dueño autorizó publicar después de recibir el diff y el informe local.
- Se repitieron `npm run test:incident` (incluye 17/17 de estado) y HTTP 9/9
  contra PostgreSQL local con red externa bloqueada. Ambos verdes.
- Producción seguía en `3599c09`; worktree limpio y avance fast-forward de un
  solo commit. Push desde PowerShell, sin force push, a `prod/mesero-shadow-v3`.
- Dos consultas no mostraron auto-deploy; se inició `railway redeploy --yes
  --from-source` sobre el proyecto, servicio y entorno productivos explícitos.
- Deployment `ca678c08-2e89-4a91-af56-098591ac3c84`: **SUCCESS**, actualizado
  a `2026-09-30T15:27:35.181Z` según Railway.
- SSH confirmó SHA `11ef8d5dc4df67bf7d21286a5310ca8acc07489f`, el mismo ID
  de deployment y Node `v22.23.3`. SHA-256 de los dos módulos nuevos coincide
  con el código local revisado.
- `/health`, `/app` y `/estadoAtencionChat.js?v=20260930-1`: HTTP 200;
  el HTML público contiene la referencia nueva y el JS sirve `crearConsulta`.
- El servicio nuevo consultó cinco conversaciones existentes en una transacción
  `BEGIN READ ONLY` terminada con `ROLLBACK`, a las 15:28:37 UTC. Conserva las
  pausas manuales de los chats terminados en 5538 y 1351; sus bloqueos temporales
  ya vencieron. En 2171 y 5836 tampoco quedaba bloqueo temporal vigente. La
  conversación del dueño (9919) sigue con pausa manual y revisión pendiente.
- No se cambiaron banderas, pausas ni configuración; no se enviaron mensajes
  de prueba, no se cobraron pagos ni se imprimieron tickets.

Pendiente de comprobación en la sesión real del dueño: recargar el panel y abrir
los chats indicados. La consulta productiva y los archivos publicados están
verificados; no se afirma haber probado su navegador autenticado ni una nueva
conversación de WhatsApp. La corrección muestra los bloqueos, no los elimina
ni garantiza que todo cliente sea elegible para el bot.

Este registro posterior al despliegue queda en un commit documental local,
sin otro push para evitar un despliegue adicional innecesario.
