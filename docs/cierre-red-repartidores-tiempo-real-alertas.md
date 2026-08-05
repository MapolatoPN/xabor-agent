# Cierre técnico — Fase C: Red de Repartidores, tiempo real y alertas

## Estado

**Fase C desarrollada, probada, desplegada, verificada técnicamente y
validada visualmente en producción. La plantilla v2 de WhatsApp permanece
apagada hasta su aprobación en Meta y activación controlada.**

## Validación visual en producción (realizada por el propietario)

El propietario confirmó visualmente, en sesión real de Superadmin contra
`https://xabor.mx`, lo que esta sesión no pudo validar de forma segura
(ver sección "Validaciones post-deploy" más abajo, que dejó esto como
pendiente):

1. La pestaña "Red de Repartidores" carga correctamente.
2. Las tarjetas resumen se muestran con datos reales.
3. El roster carga y muestra **31 repartidores**.
4. La detección de duplicados identifica **7 grupos** de posibles
   duplicados.
5. Los filtros por negocio, estado, actividad, búsqueda y duplicados
   funcionan correctamente.
6. La subvista "Servicios de reparto" carga correctamente.
7. Se muestran folio, fecha, negocio, estado, repartidor asignado,
   notificados y métricas de entregado/leído/falló por servicio.
8. Se observan servicios históricos con repartidor asignado y otros sin
   repartidor visible.
9. Se observan servicios antiguos con métricas 0/0/0.
10. El indicador de conexión WebSocket aparece activo (verde).
11. No se detectaron errores visuales bloqueantes.

### Observaciones de calidad de datos encontradas (sin modificar producción)

Estas situaciones se registran tal como se encontraron, **sin alterar
retrospectivamente ningún dato histórico sin evidencia** — se investigan
y se proponen soluciones en la Fase D, nunca se corrigen de forma
automática ni silenciosa:

- Existen **7 grupos** de repartidores que la detección de duplicados
  (`detectarDuplicadosRepartidor`, ya construida en la fase Superadmin
  anterior) identifica como posibles duplicados.
- Varios repartidores no tienen `ciudad`, `zona` ni `vehiculo` capturados
  (columnas nullable agregadas en la migración 035, informativas, nunca
  usadas como criterio de elegibilidad).
- Algunos servicios con estado `entregado` no muestran un repartidor
  asignado visible en `pedidos_activos.datos->>'repartidor_id'` — esto es
  consistente con pedidos entregados por vías distintas a la Red de
  Repartidores (p. ej. presencial, o asignación manual anterior a este
  módulo) y no necesariamente indica un error; se documenta para
  análisis, no se asume una causa sin evidencia.
- Algunos registros históricos de `notificaciones_repartidor` muestran
  métricas 0/0/0 (sin intentos entregados/leídos/fallidos) — consistente
  con pedidos anteriores a la migración 032 (que introdujo este
  registro) o con notificaciones enviadas en el modo `texto_libre`
  anterior al piloto de plantillas, que no generaban estas filas.

Ver `docs/plan-fase-d-metricas-ranking.md` (actualizado) para el plan de
investigación y las propuestas de normalización — ninguna fusión,
eliminación o corrección retroactiva se ejecutó ni se ejecutará sin un
plan aprobado explícitamente por el propietario.

## Objetivo de la fase

Agregar tiempo real (WebSocket), alertas y mejoras de notificación a la
Red de Repartidores construida en la fase anterior (Superadmin
roster+servicios, `dcf0ee8`), manteniendo aislamiento multi-tenant
estricto y operación segura aunque el canal de tiempo real falle. Requisito
central: desde el primer mensaje de oferta a un repartidor deben verse
nombre del negocio, folio, calle, colonia y tarifa — sin exponer teléfono,
referencias completas ni notas privadas del cliente hasta la aceptación.

## Rama, commits y despliegue

| Campo | Valor |
|---|---|
| Rama | `feat/red-repartidores-tiempo-real-alertas` |
| Commit base | `dcf0ee8` (fork de la fase Superadmin ya cerrada y desplegada) |
| Commit final | `3deb4a8` |
| Deployment ID | `f6ce2ff7-9ce6-47ab-aed1-260a1736894b` |
| Servicio / proyecto Railway | `xabor-agent` / `honest-tenderness`, entorno `production` |
| Fecha y hora del despliegue | 2026-08-05, ~07:41 CST (America/Matamoros) |
| URL | `https://xabor.mx` |

Commits de la fase (sobre el fork `dcf0ee8`):

| Commit | Resumen |
|---|---|
| `bea85d4` | (cherry-pick, prerequisito) cierre técnico de la fase Superadmin anterior |
| `c4a3ff6` | Mensaje de oferta enriquecido (calle/colonia/tarifa/folio) + eventos de tiempo real |
| `c944ddc` | Canal WebSocket `/ws/superadmin` + `broadcastSuperadmin` |
| `b566f71` | Cliente WebSocket en `panel/superadmin.html` |
| `3deb4a8` | Suite de pruebas de tiempo real, mensaje enriquecido y aislamiento WS |

No se crearon migraciones nuevas en esta fase (las migraciones 032-035 ya
existían de la fase anterior; el despliegue las encontró ya aplicadas).

## Funcionalidades entregadas

1. Mensaje de oferta a repartidores enriquecido: negocio, folio, ubicación
   (calle/colonia formateados con reglas de fallback), tarifa y enlace de
   aceptación — todo detrás del feature flag `repartidor_notif_plantilla_v2_activo`
   (apagado por defecto; mientras tanto se sigue usando exactamente la
   plantilla v1 ya aprobada por Meta).
2. Canal WebSocket `/ws/superadmin`, exclusivo para el rol Superadmin,
   con el mismo patrón de autenticación por cookie de sesión que el canal
   de panel de negocio ya existente.
3. 4 eventos de tiempo real: nuevo servicio, servicio aceptado, cambio de
   estado de repartidor, y "sin cobertura" (todos los intentos de
   notificación fallaron para un pedido sin repartidor asignado).
4. Cliente WebSocket en `panel/superadmin.html`: reconexión automática con
   backoff exponencial, indicador visual de conexión, protección contra
   listeners/eventos duplicados, refresco debounced de la vista activa.
5. Aislamiento de permisos: Superadmin recibe eventos globales (todos los
   negocios); negocio-admin recibe solo eventos de su propio negocio;
   staff no recibe ningún evento administrativo de esta red.
6. Operación 100% funcional por HTTP si el canal WebSocket falla — el WS
   es únicamente una señal de "algo cambió, vuelve a pedir por HTTP"; el
   dato real siempre viene de los mismos endpoints HTTP ya existentes.

## Arquitectura de tiempo real utilizada

Se reutilizó por completo la infraestructura ya existente — **no se
introdujo ninguna tecnología nueva** (nada de Socket.IO, Redis, SSE ni
colas nuevas). Se extendió el mismo servidor `ws` nativo (`wss`,
`server.on('upgrade', ...)`, `broadcastNegocio`) que ya usaba
`panel/index.html`:

- Nuevo canal `/ws/superadmin`: `autenticarUpgradeSuperadmin(req, socket, head)`
  clona el patrón de `autenticarUpgradePanel` (valida cookie de sesión +
  `esSuperadmin(payload.usuarioId)` en vez de membresía de negocio),
  `contextoWS = { tipo: 'superadmin', usuarioId, negocioId: null, rol: 'superadmin' }`
  (negocioId deliberadamente `null` — cross-negocio por diseño, mismo
  principio que el `requireSuperadmin` HTTP ya existente).
- `broadcastSuperadmin(data)` (nuevo, exportado desde `server.js`): envía a
  todos los clientes `ws.tipo === 'superadmin'`, sin ningún filtro de
  negocio.
- `broadcastNegocio(negocioId, data, opciones)` (ya existente) gana una
  opción aditiva `opciones.soloAdmin` — cuando se activa, omite a los
  clientes con `rol === 'staff'`. Todos los llamadores anteriores omiten
  esta opción, por lo que su comportamiento no cambió.
- Patrón de inyección ya usado en el proyecto (`setWsBroadcast`/
  `setWsBroadcastWA`) replicado como `setWsBroadcastSuperadmin` (en
  `orderManager.js`) y `setWsBroadcastSuperadminWA` (en
  `whatsapp-meta.js`), ambos conectados una sola vez en `server.js`.
- El cliente (WS es solo señal, nunca payload): el navegador recibe
  `{tipo: '...', folio, negocioId?}` y en respuesta vuelve a pedir el
  roster/servicios por los mismos endpoints HTTP ya existentes — por
  construcción, si el WS cae, la operación sigue igual vía refresco
  manual o polling futuro, sin cambio de código.

## Eventos creados y payloads

Todos los payloads son deliberadamente mínimos — nunca incluyen teléfono,
token, credenciales ni datos del cliente.

| Evento | Disparado desde | Payload |
|---|---|---|
| `red_repartidores_nuevo_servicio` | `orderManager.js` → `emitirPedido`, dentro del gate `esPedidoElegibleParaRedRepartidores` | `{ tipo, folio, negocioId }` |
| `red_repartidores_servicio_aceptado` | `whatsapp-meta.js` → `procesarAceptacionTokenRepartidor`, tras `asignarRepartidor` exitoso | `{ tipo, folio, negocioId, repartidorId }` |
| `red_repartidores_estado_cambiado` | `server.js`, las dos rutas PATCH-estado (Superadmin y negocio-admin), tras `cambiarEstadoRepartidor` exitoso | `{ tipo, repartidorId, negocioId, estado }` |
| `red_repartidores_sin_cobertura` | `whatsapp-meta.js` → `procesarStatusesWebhook`, tras marcar un intento `fallido`, vía `esPedidoSinCoberturaAhora` | `{ tipo, folio, negocioId }` |

Cada evento se envía dos veces con distinto alcance: una a
`broadcastSuperadmin` (visible para Superadmin, sin filtro) y otra a
`broadcastNegocio(negocioId, ..., {soloAdmin:true})` (visible solo para el
negocio-admin de ese negocio, nunca para staff).

## Permisos y aislamiento multi-tenant

- Superadmin: recibe todos los eventos de todos los negocios vía
  `/ws/superadmin` (mismo principio que el `requireSuperadmin` HTTP:
  `negocioId: null` es intencional, no un descuido).
- Negocio-admin: recibe solo los eventos de su propio negocio, vía el
  canal `/ws/panel` ya existente con la nueva opción `soloAdmin`.
- Staff: conectado al mismo `/ws/panel`, pero explícitamente excluido de
  estos 4 eventos por el filtro `soloAdmin` — verificado con un caso de
  prueba dedicado.
- `/ws/superadmin` rechaza cualquier conexión sin cookie de sesión válida
  o cuyo usuario no esté marcado en `administradores_plataforma`
  (verificado en producción tras el despliegue: `401` sin sesión, igual
  que `/ws/panel`).

## Cambios en las notificaciones a repartidores

- **Antes (v1, sigue activa)**: "Negocio: {{1}} / Pago estimado: {{2}} /
  enlace {{3}}" — 3 variables, sin folio ni ubicación.
- **Nuevo (v2, aún no sometida a Meta, apagada por defecto)**: 5
  variables — negocio, folio, ubicación (calle+colonia formateados con
  reglas de fallback), tarifa, enlace. Ver
  `docs/plantilla-nueva-servicio-reparto-v2-propuesta.md` para el detalle
  completo, ejemplos renderizados y plan de activación.
- La aceptación atómica anti-carrera (`asignarRepartidor`,
  `consumirTokenAceptacionRepartidor`) y la exclusión de repartidores
  pausados/suspendidos/de baja (`activo` como fuente de verdad) ya
  existían de la fase anterior y no requirieron cambios — solo se
  ampliaron las pruebas para cubrir estos casos explícitamente en el
  contexto de Fase C.

## Pruebas ejecutadas

30 pruebas mínimas especificadas, implementadas en
`test/fase-red-repartidores-tiempo-real.mjs` (26 pruebas propias de esta
suite — algunas de los 30 casos numerados se cubren de forma compartida
con `test/fase-red-repartidores-superadmin.mjs`, que aporta las 4
restantes de aislamiento/roster ya construidas en la fase previa). Total:
**26/26 pasadas** en `fase-red-repartidores-tiempo-real.mjs` y **26/26
pasadas** en `fase-red-repartidores-superadmin.mjs`, en dos instancias
Postgres 16 Docker independientes.

Casos cubiertos: calle+colonia, solo calle, solo colonia, sin ninguna,
dirección larga, caracteres especiales, repartidor disponible/pausado/
suspendido/dado de baja/inactivo, pedido ya asignado, pedido cancelado,
aceptación simultánea, enlace incorrecto, enlace vencido, repartidor de
otro negocio, evento global de Superadmin, evento aislado de negocio-admin,
staff bloqueado, reconexión, canal caído con fallback HTTP (por diseño,
verificado por construcción), listener duplicado, evento duplicado,
pedido Rappi excluido, regresión de WhatsApp, regresión de creación de
pedidos, regresión de asignación de repartidores, regresión completa del
sistema, build Docker de producción.

## Resultado de la regresión completa

Ejecutada en dos instancias Postgres 16 Docker frescas e independientes,
32 suites de prueba en total. Resultado: **limpio**, salvo el flake
pre-existente y ya documentado `fase-p0-aislamiento-pedidos.mjs`
(comparte un teléfono hardcodeado con `fase-pagos-multiempresa.mjs`;
reconfirmado 29/29 en ejecución aislada sobre una base de datos
verdaderamente fresca, reproduciendo el mismo comportamiento ya
documentado en el commit base `111b333`, sin relación con los cambios de
esta fase).

Se detectó y corrigió durante esta fase un error de metodología propio
(contaminación de configuración entre suites por no limpiar
`repartidor_notif_modo`/`repartidor_notif_plantilla_v2_activo` al final de
la suite nueva) — corregido con un `DELETE` que restaura la ausencia real
de la clave, no con un valor "neutral" (que empeoraba el problema).
Verificado con dos corridas completas adicionales, limpias.

## Resultado del build

Build Docker de producción: **exitoso**.

## Validaciones post-deploy (en producción, todas de solo lectura)

- `/health` → `200 OK`.
- Logs de arranque: limpios (migraciones 032-035 ya aplicadas, sin
  errores/excepciones/fallas/OOM en búsqueda de texto).
- `/superadmin.html` → `200 OK`.
- `/ws/superadmin` sin cookie de sesión → `401` (rechazado), igual que
  `/ws/panel` (patrón ya existente) → `401`.
- Endpoints protegidos sin autenticación → `401` (`GET
  /api/superadmin/red-repartidores/roster`, `GET /api/admin/repartidores`).
- Config de producción confirmada por `SELECT` de solo lectura: el flag
  `repartidor_notif_plantilla_v2_activo` **no existe** para ningún
  negocio (ausencia = apagado); `repartidor_notif_modo=completo` y
  `repartidor_notif_plantilla_activo=true` (Nonna Maye) permanecen
  intactos — la plantilla v1 sigue siendo la única en uso.
- Producción permaneció `Online` durante todo el proceso; el despliegue
  anterior (`c4563a01`) no se detuvo hasta que el nuevo pasó a
  `RUNNING` (comportamiento estándar de Railway, sin interrupción
  observada).
- **Validación interactiva con sesión real de Superadmin: completada por
  el propietario** (esta sesión no dispone de credenciales de Superadmin
  de producción y no las creó, adivinó ni restableció, por política
  explícita — el propietario ejecutó el checklist entregado y confirmó
  los 11 puntos listados en "Validación visual en producción" arriba).

## Riesgos conocidos

- La plantilla v2 no está sometida a Meta — hasta que se apruebe y active
  manualmente por negocio, el mensaje de oferta sigue sin folio/ubicación/
  tarifa en producción real (comportamiento actual sin cambios).
- El criterio de "sin cobertura" (`esPedidoSinCoberturaAhora`) depende de
  que todos los intentos de notificación para un folio estén en
  `fallido`/`error_envio` — es una aproximación heredada de la fase
  anterior, no un cálculo de tiempo transcurrido.
- No existe todavía un timestamp explícito de "asignado" o "entregado"
  independiente de `pedidos_activos.updated_at` (se sobrescribe en cada
  actualización) — suficiente para lo entregado en esta fase (tiempo de
  aceptación se deriva de `notificaciones_repartidor.created_at` →
  `token_usado_at`, que sí es preciso), pero es una limitación relevante
  de cara a la Fase D (ver plan de Fase D).
- No se validó interactivamente en un navegador real contra producción
  (ver sección de validaciones pendientes).

## Funcionalidades diferidas

- Envío real de la plantilla v2 (depende de aprobación de Meta, fuera del
  alcance de esta sesión).
- Fase D: métricas y ranking de repartidores (plan preparado, no
  implementado — ver `docs/plan-fase-d-metricas-ranking.md`).
- Botón de plantilla (call-to-action URL dinámica) para la v2 — se evaluó
  y se decidió no incluirlo en esta propuesta para no ampliar el alcance
  de la aprobación de Meta.

## Procedimiento de rollback

- **Código**: revertir los 4 commits de esta fase
  (`c4a3ff6`, `c944ddc`, `b566f71`, `3deb4a8`) sobre `dcf0ee8` — no hay
  migración de base de datos que revertir (esta fase no agregó ninguna).
- **Producción**: `railway rollback` al deployment anterior
  (`c4563a01-90c4-46db-8076-2f6398ad0762`) restaura el estado previo sin
  pérdida de datos, ya que no hubo cambios de esquema.
- **Plantilla v2**: como el flag está apagado por defecto, no requiere
  ninguna acción de rollback adicional — el comportamiento en producción
  ya es idéntico al de antes de esta fase mientras el flag no se active.

## Estado actual de la plantilla v2 y pasos para activarla

Ver `docs/plantilla-nueva-servicio-reparto-v2-propuesta.md` (sección
"Plan de activación controlada") para el procedimiento completo de 15
pasos. Resumen: plantilla NO sometida a Meta; código listo y probado;
activación es un cambio de configuración por negocio
(`repartidor_notif_plantilla_v2_activo = 'true'`), sin deploy, una vez
que Meta apruebe.

## Confirmación de que producción permanece Online

Confirmado en el momento del despliegue (`railway status` → `xabor-agent:
● Online · https://xabor.mx`, deployment `f6ce2ff7-9ce6-47ab-aed1-260a1736894b`)
y no se ha ejecutado ninguna acción posterior en esta sesión que reinicie,
detenga o modifique el servicio.
