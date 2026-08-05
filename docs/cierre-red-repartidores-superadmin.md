# Cierre técnico — Red de Repartidores (Módulo Superadmin, Fase A + Fase B mínima)

**Estado de la fase:** Desarrollada, probada, desplegada, verificada y pendiente
únicamente de sincronización administrativa con `main`.

## 1. Objetivo de la fase

Dar visibilidad y administración desde Superadmin al proceso de repartidores
que ya operaba en producción (notificaciones por plantilla WhatsApp,
aceptación atómica, rollout piloto/completo con exclusión de Rappi) pero que
hasta este cierre solo era observable consultando la base de datos o los
logs directamente. Alcance acordado explícitamente con el dueño: **Fase A
completa** (roster y administración de repartidores) + **Fase B mínima**
(lista de servicios de reparto con estado agregado y repartidor asignado).
WebSocket en tiempo real, alertas, métricas avanzadas, ranking, ganancias e
historial detallado completo quedaron explícitamente diferidos a fases
futuras.

## 2. Funcionalidades entregadas

- **Roster de repartidores** (Superadmin, cross-negocio; negocio-admin,
  aislado a su propio negocio): tarjetas resumen (total/disponibles/
  ocupados/pausados/suspendidos/bajas/duplicados), filtros (negocio, estado,
  actividad, búsqueda, solo duplicados), detalle con edición de perfil
  (ciudad/zona/vehículo) y cambio de estado.
- **`cambiarEstadoRepartidor`**: única función que sincroniza atómicamente
  `estado` (disponible/pausado/suspendido/baja) con `activo` (el campo que
  el motor de notificaciones sigue usando sin cambios). "Baja" nunca borra
  historial ni usa el `DELETE` legado (`eliminarRepartidor`).
- **"Ocupado"**: estado derivado en la consulta (disponible + pedido activo
  asignado), nunca persistido.
- **Detección de duplicados**: agrupa por teléfono normalizado con el mismo
  criterio (`normalizarTelefonoMX`) que ya usa producción para el dedupe de
  envío — extraído a `src/utils/telefono.js` para que ambos consumidores
  compartan una única implementación.
- **Servicios de reparto (Fase B mínima)**: lista de pedidos con estado
  derivado (buscando/asignado/entregado/cancelado/sin_cobertura) y detalle
  por folio con los repartidores realmente notificados. Rappi se excluye
  **siempre** de la lista principal (por `canal='rappi'` o por
  `rappi_order_id` presente aunque el canal esté mal etiquetado) y se
  muestra solo en la sección separada "Entregas gestionadas por plataformas
  externas", nunca contado en las métricas de cobertura de la Red Xabor.
  El criterio vive en `src/utils/elegibilidadRepartidor.js` (extraído de
  `orderManager.js` para evitar un ciclo de imports con `database.js`).
- **Endpoints**: Superadmin (`requireSuperadmin`, sin negocioId — cross-
  negocio por diseño) para resumen/roster/duplicados/servicios y sus
  detalles; negocio-admin (`PATCH /api/admin/repartidores/:id/estado`,
  `requireAdminSeguro` + `requireModulo('pos')`) reutilizando la misma
  `cambiarEstadoRepartidor` con el `negocioId` de sesión.
- **Panel**: nueva pestaña "Red de Repartidores" en `panel/superadmin.html`,
  siguiendo el molde ya usado por "Negocios" (fetch + `api()`, badges CSS,
  master-detail, tablas responsivas con `data-label` para móvil).

## 3. Commit desplegado

**`dcf0ee8`** — `test(repartidores): suite Red de Repartidores Superadmin
(roster, estado, duplicados, servicios)` — rama `feat/red-repartidores-superadmin`.

Los 4 commits de la fase (todos en `origin/feat/red-repartidores-superadmin`):

| Commit | Resumen |
|---|---|
| `1fdf7c9` | Migración 035 (perfil/estado) + servicios de base de datos |
| `0e47c38` | Endpoints Superadmin y negocio-admin |
| `b6aa3a2` | Pestaña "Red de Repartidores" en `panel/superadmin.html` |
| `dcf0ee8` | Suite de pruebas `fase-red-repartidores-superadmin.mjs` |

Rama forkeada del commit previamente desplegado `111b333`.

## 4. Despliegue

- **Deployment ID (Railway, producción):** `c4563a01-90c4-46db-8076-2f6398ad0762`
- **Fecha:** 2026-08-04 19:59:25 -05:00
- **Resultado:** `SUCCESS`
- **Estado actual del servicio:** `Online` (verificado en el cierre)
- **Servicio:** `xabor-agent` — `https://xabor.mx`

## 5. Migraciones aplicadas

**Migración 035** (`estado`, `ciudad`, `zona`, `vehiculo` en `repartidores`):

- Predeploy log de producción: `[predeploy-035] Aplicando
  migrations/035_perfil_repartidor.sql... Aplicada. Corriendo
  verificacion... Verificacion OK.`
- **Verificado directamente contra la base de datos real de producción**
  (consulta de solo lectura vía `railway run --service Postgres`, usando
  `DATABASE_PUBLIC_URL`): las 4 columnas existen con el tipo y default
  esperados —
  `estado TEXT DEFAULT 'disponible'::text`, `ciudad TEXT`, `zona TEXT`,
  `vehiculo TEXT`.
- Migraciones 032/033/034 (repartidores, ya desplegadas en fases previas):
  confirmadas como "ya aplicada -- no se ejecuta nada" (idempotentes, sin
  cambios).
- `activo` (campo que lee el motor de notificaciones) **no fue tocado** por
  esta migración — sigue siendo la única fuente de verdad de elegibilidad.

## 6. Pruebas ejecutadas

- **Suite nueva** `test/fase-red-repartidores-superadmin.mjs`: 26/26 casos,
  verificada en **dos** instancias Docker Postgres 16 independientes.
- **Regresión completa** (~30 suites preexistentes): limpia en ambas bases.
- **Build Docker de producción** (Dockerfile real de Railway): exitoso.
- **3 fallos intermitentes observados en el batch grande** (`fase-b-
  integraciones`, `fase-p0-aislamiento-pedidos`, `fase-rollout-completo-
  repartidores`): investigados a fondo — los tres pasan limpio en
  aislamiento, y uno se reprodujo **idéntico contra el commit base sin
  ninguno de estos cambios** (`111b333`), confirmando que es carga de
  máquina preexistente del entorno de pruebas, no una regresión de este
  trabajo.
- **Verificación visual** (Browser tool, vía `read_page`/interacción real
  ya que el screenshot no compositaba en este entorno): login, roster,
  filtros, cambio de estado end-to-end, sub-vista de servicios con Rappi
  correctamente aislado en su sección separada. Responsivo verificado por
  CSS computado en 375px (mismo patrón `data-label`/`flex` del resto del
  panel).
- **Smoke test de producción post-deploy** (solo lectura): `/health` OK,
  logs de arranque sin errores, los 3 endpoints nuevos de Superadmin
  responden `401` sin sesión (fail-closed correcto), `superadmin.html`
  sirve `200`, tráfico real de clientes (WhatsApp, Rappi, pedidos) siguió
  fluyendo sin interrupción durante todo el proceso.

## 7. Riesgos conocidos

- **`main` está 155 commits detrás de lo desplegado** — ver sección 9. No es
  un riesgo introducido por esta fase, es un estado preexistente del
  repositorio (main no se ha sincronizado desde hace mucho tiempo; el
  despliegue real siempre se ha hecho vía `railway up` directo desde ramas
  de feature/release, no vía auto-deploy de GitHub).
- **"Elegibles notificados" en Servicios de reparto** se aproxima al número
  real de intentos generados (a quién se le envió), no a "quién pudo ser
  elegible en ese momento" — un conteo histórico exacto requeriría capturar
  una foto del roster en el momento de la notificación, fuera de alcance de
  esta fase mínima.
- **Detalle de servicio** solo muestra repartidores que SÍ generaron una
  fila en `notificaciones_repartidor` — los excluidos por whitelist (modo
  piloto) o por modo apagado no aparecen con un "motivo de exclusión"
  explícito, porque hoy esa decisión solo se loguea a consola, no se
  persiste. Documentado como límite conocido en el propio código
  (`obtenerDetalleServicioReparto`).
- **Problema de Railway CLI con git worktrees** — ver sección 10.

## 8. Funcionalidades diferidas (alcance explícitamente fuera de esta fase)

- WebSocket de tiempo real para Superadmin (`/ws/superadmin`).
- Alertas automáticas (sin repartidor > X min, % de fallos alto, etc.).
- Métricas avanzadas y ranking de repartidores.
- Historial detallado completo / línea de tiempo visual por servicio.
- Red de repartidores compartida entre negocios.
- Ganancias/liquidación de repartidores.

## 9. `main` vs. commit desplegado — estado exacto

```
merge-base(origin/main, dcf0ee8) == origin/main (177c6e0)
```

`origin/main` es un **ancestro directo** de `dcf0ee8` — no hay divergencia,
un fast-forward es seguro y no perderá ningún commit de `main`.

- Commits en `dcf0ee8` que **no** están en `origin/main`: **155**
- Commits en `origin/main` que no están en `dcf0ee8`: **0**

La lista completa (155 commits, orden cronológico) queda documentada aparte
en el historial de `git log --oneline origin/main..dcf0ee8` — cubre, en
resumen, todo el trabajo de: aislamiento multiempresa (incidente P0),
Embedded Signup de WhatsApp, control global del bot, rewards, memoria del
cliente, pagos multiempresa (Clip), documentos/cotizaciones PDF, asistente
comercial (IA), chat de imágenes, PWA/push, hotfix de fechas/sesión, y toda
la suite de repartidores (piloto → rollout completo → Red de Repartidores
Superadmin).

### Procedimiento recomendado para sincronizar `main` (NO ejecutado — requiere autorización explícita)

```bash
git fetch origin
git checkout main
git merge --ff-only origin/dcf0ee8   # o el nombre de rama que apunte a dcf0ee8
git push origin main
```

Al ser un fast-forward puro, este comando falla limpio (sin efectos
secundarios) si por alguna razón `main` hubiera recibido commits nuevos
entre este cierre y el momento de ejecutarlo — señal segura de que hay que
revisar antes de forzar nada.

## 10. Problema de Railway CLI con git worktrees (hallazgo operativo)

Al ejecutar `railway up` desde `C:\Users\mario\claude\xabor-chat-imagenes`
(cuyo `.git` es un **worktree pointer** hacia
`C:\Users\mario\claude\xabor-consolidacion-pagos-documentos\.git\worktrees\...`,
no un repositorio normal), los primeros 3 intentos de deploy fallaron con:

```
couldn't locate the dockerfile at path ./Dockerfile in code archive
  -  not found at Dockerfile
  -  not found at Dockerfile
```

El archivo subido pesaba ~11MB (vs. ~1.7MB de un deploy exitoso normal) y
aun así no incluía el Dockerfile — a pesar de que el archivo existe,
está trackeado en git, y no está excluido por `.gitignore` ni
`.dockerignore`. Se descartó que fuera un problema de caché (se repitió
con hashes de snapshot distintos tras modificar el Dockerfile).

**Diagnóstico confirmado:** el empaquetado de `railway up` se confunde al
operar sobre un worktree vinculado, en vez de un checkout normal.

**Remediación aplicada:** clonar la rama ya pusheada (`git clone --branch
feat/red-repartidores-superadmin --single-branch <repo> carpeta-temporal`)
en una carpeta temporal fuera de cualquier worktree, vincular ahí el mismo
proyecto/servicio de Railway (`railway link -p <projectId> -e production -s
xabor-agent`), y ejecutar `railway up` desde esa carpeta — funcionó al
primer intento, con el tamaño de archivo esperado (~1.7MB).

**Recomendación para futuros despliegues:** desplegar siempre desde un
**clon Git convencional** (nunca desde un worktree vinculado a otro
repositorio). Si el trabajo de desarrollo se sigue haciendo en un worktree
por conveniencia, el paso de `railway up` debe hacerse desde un clon
aparte de la rama ya pusheada — nunca desde el worktree directamente.

## 11. Rollback

- **Código:** revertir los 4 commits de la fase (`git revert
  b6aa3a2..dcf0ee8` o equivalente) y redeployar, o hacer `railway up` desde
  un clon del commit `111b333` (el commit previamente desplegado y
  verificado).
- **Migración 035:** aditiva y no destructiva (columnas nuevas, nullable o
  con default, `activo` sin tocar). Si se necesitara revertir el esquema:
  `migrations/035_perfil_repartidor_down.sql` (elimina las 4 columnas) ya
  existe y está listo.
- **Ningún dato de negocio real fue modificado** durante el desarrollo,
  las pruebas (todas contra bases Docker desechables) ni la verificación
  post-deploy (estrictamente de solo lectura).

## 12. Estado final

**Desarrollada, probada, desplegada, verificada y pendiente únicamente de
sincronización administrativa con `main`** (fast-forward simple, sección 9,
pendiente de autorización explícita del dueño del repositorio).
