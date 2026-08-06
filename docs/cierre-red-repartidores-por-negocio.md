# Cierre — Red de repartidores por negocio (Frente B)

## Objetivo
Convertir la red de repartidores existente (tokens de aceptación,
notificaciones por plantilla, métricas D.1, aislamiento multiempresa, fixes
de concurrencia de db3d105) en un servicio ACTIVABLE y CONFIGURABLE por cada
negocio, sin reconstruir el motor.

## Rama y commits
- Rama de integración: `integration/red-repartidores-por-negocio`
- Commit base: `c949cdd` (commit desplegado en producción, deployment
  `7aaa64ef`).
- Integrados por merge: `eb16283`, `eb3bc7b`, `ac04d47`, `b3545ae`
  (feat/red-repartidores-por-negocio-mvp) + commits de la revisión de
  integración (gate fail-closed, campos declarativos, predeploy 038).
- Conflictos: solo `test/aplicar-migraciones.mjs` (ambas ramas agregaban su
  migración) — resuelto conservando 037 y 038 en orden. Auto-merges de
  `src/server.js` y `panel/superadmin.html` verificados FUNCIONALMENTE:
  los 3 chequeos `sop` del Frente A intactos, gate/rutas/subvista del B
  presentes. Sin nada del Frente C (039/restaurante).

## Arquitectura
- `migrations/038_red_repartidores_config.sql` (+ `_down`, `_check`): tabla
  `red_repartidores_config` (PK negocio_id). **Sin backfill**: un negocio
  SIN fila conserva el comportamiento anterior EXACTO; crear la tabla no
  activa ni desactiva ninguna red (el predeploy verifica que quede vacía).
- `src/services/redRepartidores.js`: config (upsert validado),
  `evaluarSolicitudRed` (gate), costo, central de reparto.
- Gate en `notificarRepartidoresPorWA` (whatsapp-meta.js): PRIMERA
  evaluación, antes de cargar repartidores o credenciales.

## Gate — contrato verificado
- Config por `negocioId` de la fila del pedido; un negocio jamás afecta a otro.
- `null` (sin fila) → legado intacto. Fila → red_activa / horario (con cruce
  de medianoche) / cobertura por colonias / modo manual bloquean la oferta.
- **`undefined` (ERROR real leyendo config) → NO ofertar** (endurecimiento
  de integración: antes caía al legado, que sí oferta). El pedido principal
  nunca falla por el gate; el motivo queda en log sin datos sensibles.
- Rappi excluido (elegibilidad previa + central lo filtra); idempotencia por
  pedido/repartidor intacta; aceptación atómica intacta; estados de
  repartidor (pausado/suspendido/baja/inactivo) siguen excluidos por el
  motor existente — el gate no toca ese filtro.

## Campos DECLARATIVOS (capturados, NO ejecutados por el motor)
`radio_km`, `fuentes.red_xabor`, `fuentes.externas`,
`politica_reasignacion='reofertar'` (el reintento automático al vencer
tokens no existe todavía; la reoferta es manual vía el endpoint).
Decisión aplicada: **opción A** — `GET /api/config/red-repartidores`
devuelve `camposDeclarativos` con esta lista; cualquier interfaz debe
mostrarlos como "configuración declarativa, sin ejecución automática".
Hay una prueba que lo garantiza.

## Endpoints
| Método | Ruta | Guardia |
|---|---|---|
| GET | `/api/config/red-repartidores` | admin del negocio (o sesión de soporte) + módulo repartidores |
| PUT | `/api/config/red-repartidores` | ídem |
| POST | `/api/pedidos/:folio/solicitar-repartidor` | ídem + rate limit; folio validado contra el negocio de sesión (ajeno = 404); elegibilidad + gate antes de ofertar; idempotente (reintento no duplica ofertas) |
| GET | `/api/superadmin/red-repartidores/central` | superadmin; paginada, estados derivados, Rappi excluido, sin N+1 |

El acceso de Superadmin a la configuración de un negocio es VÍA SESIÓN DE
SOPORTE (diseño del Frente A) — no hay ruta superadmin directa de edición.
`negocioId` sale siempre de la sesión; el body no puede sustituirlo.

## Migración 038 y predeploy
`scripts/predeploy-038-red-repartidores-config.mjs`, agregado al runner
DESPUÉS de 037 (orden 032→…→037→038; `railway.toml` sin tocar). Validado en
**2 PostgreSQL 18.4 Docker** (misma versión que producción): aplicación
limpia por el runner completo, `_check`, re-ejecución de script y de SQL,
`_down` en base desechable (solo DROP TABLE — pérdida: configuraciones de
red capturadas; ninguna otra tabla se toca) y re-aplicación posterior.
Verificación anti-backfill: la tabla queda vacía o el predeploy aborta.

## Pruebas
- Suite específica: **20/20 en ambas bases PG18** (legado sin config,
  activa/inactiva, horario y cruce de medianoche, cobertura, manual vs
  auto, error de config fail-closed, distinción null/undefined, costo,
  validaciones, aislamiento A/B, roles HTTP, E2E con motor real de ofertas,
  solicitud manual + duplicada idempotente, folio ajeno 404, central con
  estados derivados y Rappi excluido, camposDeclarativos expuestos).
- Regresión (base 1 PG18, todo 0 fallos): Central de Operaciones 25/25
  (incluye toda la seguridad de sesión de soporte), aislamiento P0 29/29,
  pagos multiempresa 48/48, tiempo-real 26/26, superadmin red 26/26,
  universos D.1 15/15, carrera de inserción 2/2, rollout 15/15.
- Build Docker de producción: exitoso.

## Riesgos
- El gate agrega 1 SELECT por pk en cada pedido elegible — costo mínimo;
  error de esa lectura = no ofertar (nunca rompe el pedido, nunca oferta a
  ciegas).
- La cobertura por colonia es por texto normalizado (sin geocoding): errores
  de captura de colonia pueden excluir pedidos — el motivo queda en log.
- Central de reparto es solo lectura; las acciones siguen en sus flujos.

## Plan de deploy
1. Backup lógico de Postgres (patrón establecido).
2. Desde worktree enlazado a honest-tenderness/production/xabor-agent en
   `integration/red-repartidores-por-negocio`:
   `railway up --service xabor-agent --ci`.
3. El predeploy corre solo (032–037 no-op, 038 aplica y verifica vacía).

## Smoke test post-deploy
1. `/health` 200; log `[predeploy-038] ... Tabla creada vacía`.
2. `SELECT count(*) FROM red_repartidores_config` = 0 (lectura).
3. Un pedido elegible de Nonna Maye sigue ofertando igual que antes
   (comportamiento legado intacto sin fila).
4. Superadmin → Red de Repartidores → subvista "Central de reparto" lista
   servicios con estados.
5. Rutas nuevas sin sesión → 401.

## Rollback
Redeploy del deployment anterior. La 038 es aditiva y sin backfill: el
código anterior convive con la tabla sin tocarla; `_down` solo si se decide
revertir del todo (pierde configuraciones capturadas).

## Plan de activación de delivery — Carnitas Moreno (NO ejecutado)
Prerrequisito: cuenta activa (ver plan del Frente A).
1. Registrar repartidores propios (teléfonos normalizados a 521XXXXXXXXXX).
2. `PUT /api/config/red-repartidores`: `red_activa=true`, zonas/colonias de
   Piedras Negras, `horario_inicio/fin` del negocio, `costo_base` (y
   `quien_absorbe`), `contacto`, `instrucciones_recogida`,
   `tiempo_preparacion_min`, `solicitud_automatica=true`.
3. WhatsApp del negocio verificado + `repartidor_notif_modo='piloto'` con
   whitelist (`repartidor_notif_piloto_telefonos`) de 1–2 repartidores de
   prueba + plantilla v2 activa.
4. Pedido de prueba → oferta → aceptación por token → recogido → entregado.
5. Verificar métricas/ranking (universos D.1) y auditoría; verificar que no
   hubo ofertas duplicadas.
6. **Criterio de activación**: "una entrega de prueba completada, sin
   duplicidad, con métricas y auditoría correctas" → cambiar a
   `repartidor_notif_modo='completo'`.
