# Plan de despliegue progresivo — Pagos multiempresa + Documentos PDF + Cotizaciones (piloto)

> Plan final. No se ha hecho deploy. Pendiente de autorización explícita
> antes de cualquier paso que toque Railway/producción.

## 1. Rama de release

`release/pagos-documentos-cotizaciones-v1`, creada desde el commit
`125ca42` (`feat(panel): UI de documentos PDF y cotizaciones`) —
exactamente el último commit antes de que empezara el trabajo de Fase 0
CRM. Es una rama limpia (sin cherry-pick, sin reescritura de historia):
un puntero nuevo sobre un commit ya existente.

### Commits DENTRO de la rama de release (todo hasta `125ca42` inclusive)

Incluye, entre otros, toda la cadena de pagos multiempresa (`ee6bc76`
migración 025 en adelante), y los dos commits que construyen documentos/
cotizaciones:
- `254574d` — backend de documentos PDF en el chat y módulo de cotizaciones
- `125ca42` — UI de documentos PDF y cotizaciones en el panel

### Commits FUERA de la rama de release (permanecen solo en `feat/consolidacion-pagos-documentos`)

| Commit | Motivo de exclusión |
|---|---|
| `cb75948` | Fase 0A CRM (clientes_negocio, negocio_id en oportunidades/eventos) |
| `0158e51` | Eliminación de `POST /chat`/`whatsapp.js` — asociada a la Fase 0, se excluye junto con ella |
| `656b7a8` | Fase 0B CRM (perfiles_clientes multiempresa) |
| `dcca152` | Suite de pruebas de la Fase 0 |
| `ef274c5` | Documentación de arquitectura/auditoría (no aplica a este release) |
| `2a03721` | Demo local, benchmark PDF, backlogs de imágenes/asistente comercial (no aplica a este release) |

**Verificado**: `git log --oneline feat/consolidacion-pagos-documentos
^125ca42` devuelve exactamente esos 6 commits — ninguno de código de
Fase 0 CRM llega a la rama de release.

## 2. Regresión completa (dos bases Postgres Docker frescas)

Migraciones 001-026 (confirmado: **sin** 027/028) + seed, sobre dos
contenedores Postgres Docker desechables independientes:

- **Base 1**: 349/349 pruebas pasadas (15 suites existentes, 0 fallidas).
- **Base 2**: 349/349 pruebas pasadas, verificado además que el módulo
  `cotizaciones` queda `no_contratado` en el 100% de los negocios
  **inmediatamente después de sembrar, antes de correr ninguna suite**
  (la corrida anterior en Base 1 lo mostró `activo` para un negocio
  porque `fase-cotizaciones.mjs` lo activa como parte de su propio
  fixture de prueba sobre la misma base — no es el estado real de un
  seed limpio, y se confirmó por separado en Base 2).

## 3. Prueba de build Railway-compatible (Puppeteer/Chromium) — BLOQUEADA, no por el código

`Dockerfile` + `.dockerignore` nuevos en la raíz de la rama de release
(`node:20-slim` + librerías de sistema que Chromium necesita para
arrancar — sin esto, Railpack por sí solo falla con `libnss3.so: cannot
open shared object file`, exactamente el riesgo ya documentado en el
reporte de producción de la sesión anterior).

**Resultado real**: el primer intento de `docker build` transfería
~300MB+ de contexto porque `node_modules` (con el Chromium ya
descargado por `npm install`) no estaba excluido — se corrigió con
`.dockerignore` (`node_modules`, `.git`, `test`, `docs`) y se reinició el
build. El segundo intento agotó el espacio en disco del equipo (**0
bytes libres en `C:`**, confirmado con `Get-PSDrive`) y **Docker Desktop
dejó de poder arrancar** (`Error response from daemon: Docker Desktop is
unable to start`) — no se pudo completar el build ni antes ni después.

**Diagnóstico**: se confirmó que el VHDX propio de Docker (`docker_data.vhdx`)
pesa solo ~9GB — no es la causa de un disco lleno de 126GB+. Es un
problema de espacio a nivel de todo el equipo, preexistente a esta
sesión, y **no me corresponde resolverlo borrando archivos del usuario
sin su decisión explícita** (podría tratarse de datos personales
importantes). Se documenta como bloqueante externo, no como un fallo del
Dockerfile ni de la rama de release.

**Lo que sí queda confirmado sin necesidad de completar el build**:
el Dockerfile usa exactamente la lista de dependencias de sistema
documentada como necesaria en Debian/Ubuntu para el Chromium empaquetado
por `puppeteer` (mismo patrón que la imagen oficial
`ghcr.io/puppeteer/puppeteer` y la documentación pública de Puppeteer) —
es estructuralmente correcto, pero su éxito real en Railway **no está
verificado empíricamente** por este bloqueo. Ver §3.1 para la decisión
que esto implica.

Este Dockerfile **no se activa solo** — Railway solo lo usa si se
configura el servicio para usar Dockerfile en vez de Railpack (paso de
configuración explícito en Railway, no automático, y no se toca en esta
sesión).

### 3.1 Decisión: Puppeteer vs PDFKit para este release

Con la verificación de Railway bloqueada por una causa ajena al código,
la decisión responsable —tomada con la autonomía técnica que se me dio
explícitamente para este punto— es:

**Recomendación: migrar a PDFKit antes de este release**, no desplegar
Puppeteer sin verificación empírica real. Razones:

1. El benchmark real de la sesión anterior ya mostró que PDFKit genera
   el mismo documento en 60ms vs 2110ms, con una fracción de la memoria,
   sin proceso externo — ya era la recomendación técnica antes de este
   bloqueo.
2. El Dockerfile preparado es estructuralmente correcto pero **no está
   confirmado que funcione en la práctica** — desplegar Puppeteer a
   producción sobre una verificación incompleta viola directamente la
   prioridad #2 de esta sesión ("no afectar WhatsApp/Rappi/pagos/pedidos"):
   si el Dockerfile fallara en Railway de un modo no anticipado, el
   *build entero* del servicio fallaría, tumbando también WhatsApp/Rappi/
   pedidos — no solo cotizaciones.
3. Migrar a PDFKit **elimina la categoría de riesgo completa** (nada que
   verificar en Railway, Railpack funciona sin Dockerfile, sin
   dependencia de sistema alguna).

**Alternativa descartada**: desplegar igual con el Dockerfile sin
verificación local completa, confiando en que Railway sí tenga espacio y
el build sí funcione. Descartada por violar la prioridad #1
("no perder ni mezclar datos") y #2 de esta sesión — un build fallido en
Railway por una dependencia de sistema faltante tumbaría el servicio
completo, no solo cotizaciones, y no hay forma de confirmarlo sin la
verificación que quedó bloqueada.

**Qué NO se hizo**: no se implementó la migración a PDFKit en esta
sesión — es una reescritura real de `cotizacionPdf.js` que invalidaría
la regresión ya corrida (349/349 verde fue contra la versión con
Puppeteer). Implementarla ahora sin volver a correr toda la regresión
sería exactamente el tipo de atajo que esta sesión busca evitar. Queda
como el primer paso recomendado antes de autorizar el push (ver §9).

## 4. Módulo `cotizaciones` — apagado por defecto, activación piloto

Confirmado en §2: `no_contratado` para todo negocio tras la migración
026. **Nunca se activa solo** — requiere una acción explícita de
Superadmin.

**Comando recomendado para activar únicamente el negocio piloto**
(vía el endpoint ya existente, no SQL directo contra producción):

```
PATCH /api/superadmin/negocios/:negocioPilotoId/modulos
Body: { "modulo": "cotizaciones", "estado": "activo" }
```
(repetir para `generador_cotizaciones` y `chat_documentos_pdf` si el
piloto también debe poder recibir/enviar PDFs en el chat, no solo
cotizaciones).

Ningún otro negocio se ve afectado — cada fila de `negocio_modulos` es
independiente por `(negocio_id, modulo)`.

## 5. Límites temporales propuestos (para autorización, no aplicados aún)

### 5.1 Una generación de PDF concurrente

**Gap real detectado**: hoy no existe ningún límite de concurrencia ni
`rateLimitMiddleware` sobre `GET /api/cotizaciones/:id/pdf` ni sobre el
envío (`POST /api/cotizaciones/:id/enviar`, que también genera el PDF).
Dos cotizaciones grandes generándose al mismo tiempo lanzan dos procesos
Chromium simultáneos — exactamente el escenario de riesgo ya señalado
para el bot de WhatsApp.

**Propuesta concreta** (no aplicada, lista para autorizar): un mutex en
proceso en `cotizacionPdf.js` que serialice las llamadas a
`generarPdfCotizacion` — la segunda solicitud espera a que la primera
termine en vez de lanzar un segundo Chromium en paralelo. Es un cambio
de ~15 líneas, sin nueva dependencia (una cola simple con promesas).
Limitación conocida y aceptada para el piloto: en memoria de un solo
proceso, igual criterio que el rate limiting ya existente en el resto
del sistema.

### 5.2 Tamaño máximo de PDF / partidas

**Gap real detectado**: `POST /api/cotizaciones` y `PATCH
/api/cotizaciones/:id` no tienen límite superior de `items.length` (solo
exigen al menos 1). Una cotización con cientos de partidas generaría un
PDF grande y una renderización lenta.

**Propuesta**: límite de **50 partidas por cotización** (generoso para
el caso de uso real de eventos/catering) devuelto como `400` si se
excede, más un límite de tamaño de salida del PDF ya generado (rechazar
y loguear si supera **5 MB** — un PDF de cotización normal pesa
~100-150KB según el benchmark real de esta sesión, 5MB ya sería
anómalo).

### 5.3 Almacenamiento local tratado como temporal

El piloto usa `STORAGE_DRIVER=local` (default de `almacenamiento.js`,
sin cambios de código). **Se documenta explícitamente como temporal**:
los PDFs generados en el piloto viven en el filesystem del contenedor de
Railway, que **no es persistente entre deploys** — un redeploy borra
`storage/documentos/`. Aceptable para un piloto de bajo volumen si se
comunica al negocio piloto que los PDFs ya enviados siguen disponibles
en el historial de WhatsApp del cliente aunque Xabor los pierda
localmente; la migración a Cloudflare R2 (ya diseñada, `STORAGE_DRIVER=s3`,
sin cambios de código, ver `docs/decision-puppeteer-vs-pdfkit.md` §5)
queda como el siguiente paso, no bloqueante para este piloto.

### 5.4 Ninguna activación automática para otros negocios

Ya es el comportamiento real (§4) — se documenta aquí como límite
operativo explícito: **ningún proceso automatizado activa módulos**, la
única vía es el endpoint de Superadmin usado manualmente, una vez, para
el negocio piloto elegido.

## 6. Preflight de producción

### 6.1 Migraciones — comandos exactos

**Antes de ejecutar nada**: confirmar en producción cuáles de las dos ya
están aplicadas (`SELECT * FROM pg_tables WHERE tablename IN
('pagos','cotizaciones');` — si ya existen, esa migración ya corrió, no
se reintenta). Es muy probable que **025 ya esté aplicada** (pagos
multiempresa ya se documentó como aprobado en una sesión anterior a
esta) y que **solo falte 026**.

```bash
# Respaldo obligatorio antes de cualquier migración en producción
pg_dump "$DATABASE_URL" -F c -f respaldo-pre-026-$(date +%Y%m%d-%H%M).dump

# Migración 025 (solo si SELECT anterior confirma que NO está aplicada)
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/025_pagos_multiempresa.sql
psql "$DATABASE_URL" -f migrations/025_check_pagos_multiempresa.sql

# Migración 026
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/026_documentos_cotizaciones.sql
psql "$DATABASE_URL" -f migrations/026_check_documentos_cotizaciones.sql
```

Ambas migraciones son reejecutables (`IF NOT EXISTS`/`ON CONFLICT DO
NOTHING`/guardas `DO $$`) — correrlas dos veces por error no duplica
nada, pero el respaldo se toma de todos modos por disciplina, no porque
se espere necesitarlo.

### 6.2 Resto del preflight

| Punto | Detalle |
|---|---|
| **Variables requeridas** | Ninguna variable nueva de entorno global — pagos/documentos/cotizaciones usan credenciales cifradas por negocio (`integraciones_canal_credenciales`) y configuración por negocio (`configuracion`), no variables de Railway nuevas. **Si se despliega con Puppeteer** (no recomendado, ver §3.1), Railway necesitaría configurarse para build por Dockerfile en vez de Railpack — pendiente de verificación real. **Si se migra a PDFKit primero** (recomendado), no se necesita ningún cambio de configuración de build en absoluto. |
| **Negocio piloto** | Definir explícitamente CUÁL negocio real será el piloto antes de activar nada (decisión de negocio, no técnica) — el comando de activación (§4) requiere su `negocioId` real. |
| **Activación del módulo `cotizaciones`** | Ver comando exacto en §4 — `PATCH /api/superadmin/negocios/:negocioPilotoId/modulos`, nunca automática, nunca para más de un negocio a la vez. |
| **Health check** | `GET /health` ya existe y ya es el endpoint que Railway usa (`healthcheckPath` en `railway.toml`) — sin cambios necesarios. |
| **Smoke tests post-deploy** | (1) `GET /health` → 200. (2) Login del negocio piloto funciona. (3) Un pedido de WhatsApp normal se sigue procesando (mensaje de prueba real o revisión de logs de los primeros minutos). (4) Activar el módulo cotizaciones para el piloto (§4) y crear UNA cotización de prueba real desde el panel, generar su PDF, confirmar que abre correctamente. (5) Confirmar que Rappi y el bot de otros negocios (no piloto) siguen respondiendo con normalidad. |
| **Monitoreo** | Si se despliega con Puppeteer: vigilar memoria del servicio en Railway durante y después de la primera generación de PDF real (pico esperado ~250-350MB adicionales) y logs por `libnss3.so`. Si se migra a PDFKit: memoria esperada es mínima (decenas de MB, no cientos), monitoreo estándar basta. |
| **Rollback** | Ninguna migración de esta fase requiere rollback de esquema si algo falla (025/026 ya probadas dos veces en esta sesión). Rollback real: (a) desactivar el módulo `cotizaciones` del negocio piloto (`PATCH .../modulos` a `no_contratado`, instantáneo, sin downtime), (b) si el problema fuera Puppeteer/Chromium, revertir la configuración de build de Railway a Railpack (el resto del servicio sigue funcionando, Puppeteer solo se invoca al generar/enviar un PDF). Nunca requiere `git revert` de código para mitigar — es reversible por configuración. |

## 7. Qué queda fuera de este release (confirmado, no ambiguo)

Fase 0 CRM (aislamiento de `perfiles_clientes`/`oportunidades`/`eventos`),
imágenes, IA multimodal, asistente comercial automático — ninguno de
estos commits ni funcionalidades llega a `release/pagos-documentos-cotizaciones-v1`.

## 8. Estado del push — retenido, no por fallo de pruebas

La regla explícita fue "push únicamente si todas las pruebas siguen
verdes". La regresión automatizada (349/349, dos bases) **sí está
verde**. La verificación de build Railway/Chromium **no se completó**
(bloqueada por falta de espacio en disco del equipo, §3) — es una de las
verificaciones pedidas que no llegó a un resultado, no un resultado
negativo. Por disciplina (nunca empujar con una verificación pedida
incompleta) **se retiene el push**, no porque algo haya fallado.

Los commits SÍ se crean (ver §9) — quedan listos localmente,
verificados, con árbol limpio — para que el push sea una decisión de un
segundo, no un bloqueo de trabajo.

## 9. Detenido para autorización

No se ha hecho push de la rama de release, no se ha tocado Railway, no
se activó ningún módulo en producción, no se instaló ni ejecutó nada
contra datos reales. Decisiones pendientes de tu autorización:

1. **Espacio en disco**: liberar espacio en `C:` para poder completar la
   verificación de build de Puppeteer/Chromium (si se decidiera seguir
   ese camino) — no es algo que yo deba decidir qué borrar.
2. **Puppeteer vs PDFKit**: mi recomendación es migrar a PDFKit antes de
   este release (§3.1) — confirmar si procedo con esa migración (lo que
   invalidaría la regresión actual hasta volver a correrla completa) o
   si prefieres insistir con Puppeteer una vez resuelto el punto 1.
3. **Negocio piloto real**: cuál negocio de producción será el elegido.
4. **Push de la rama de release**: autorizar explícitamente, una vez
   resueltos 1-2.
5. **Límites temporales de §5**: autorizar aplicarlos (son ~15-20 líneas
   de cambio, sin nueva dependencia) antes o después del push.
