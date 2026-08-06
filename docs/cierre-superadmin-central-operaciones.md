# Cierre — Central de Operaciones (Superadmin), Frente A

## Objetivo
Dar al equipo Xabor una Central de Operaciones para implementar, configurar y
acompañar 100+ negocios: pipeline de onboarding, ficha agregada por negocio,
checklist operativo con responsables, listado escalable y sesiones temporales
de soporte para operar el panel de cualquier negocio sin conocer ni cambiar la
contraseña del cliente.

## Rama y commits
- Rama de integración: `integration/superadmin-central-operaciones`
- Commit base: `db3d105` (commit real desplegado en producción al integrar,
  deployment `a9880ce7`).
- Commits integrados por fast-forward desde
  `feat/superadmin-central-operaciones-mvp`: `03c47c9`, `0cb694b`, `0c733c6`,
  `3dc1d3e`, más los commits de endurecimiento/predeploy de la revisión de
  integración (ver `git log db3d105..HEAD`).
- No incluye nada de los frentes B (migración 038 / red por negocio) ni C
  (migración 039 / restaurante).

## Arquitectura
- `migrations/037_central_operaciones_onboarding.sql` (+ `_down`, `_check`):
  - `negocios.onboarding_estado` (TEXT + CHECK de 11 estados) con backfill
    derivado SOLO de datos existentes (activo / admin con password /
    invitación vigente), idempotente, sin tocar negocios que ya salieron del
    default.
  - `negocios.implementacion` (JSONB): responsables, fecha objetivo,
    siguiente acción, bloqueantes, notas, mensualidad.
  - `sesiones_soporte`: una fila por sesión emitida; guarda SHA-256 del token
    (nunca el token), expiración, cierre manual y motivo. Es la fuente de la
    revocación server-side.
- `src/services/centralOperaciones.js`: ficha agregada (una consulta, sin
  N+1), checklist operativo, pipeline, listado escalable, sesiones de soporte.
- `src/services/session.js`: `crearTokenSesion` acepta flag `sop` y duración
  corta; las sesiones normales no cambian.
- `src/server.js`: 8 endpoints nuevos + integración del flag `sop` en
  `requireSesionNegocio` y `resolverNegocioSeguro`; `requireSuperadmin`
  RECHAZA cookies de soporte (sin encadenamiento ni acceso a consola desde
  soporte).
- `panel/superadmin.html`: pestaña Central + ficha. `panel/index.html`:
  barra de soporte + botón de salida.

## Migración 037 y predeploy
- Predeploy: `scripts/predeploy-037-central-operaciones.mjs`, agregado a la
  lista del runner existente `scripts/predeploy-run-032-033.mjs` (el que ya
  referencia `railway.toml` — no se tocó `railway.toml`).
- Idempotencia en dos capas (script detecta aplicada; SQL reejecutable).
- Validada en 2 PostgreSQL 16 Docker independientes: aplicación por el runner
  completo (032–036 no-op, 037 aplica), `_check`, re-ejecución del SQL sin
  error, `_down` en base desechable y re-aplicación posterior.
- **Pérdida de datos si se ejecuta `_down`**: se pierden las filas de
  `sesiones_soporte` (revocación/expiración de sesiones activas — efecto:
  cualquier sesión de soporte viva muere, que es el lado seguro) y los valores
  de `onboarding_estado`/`implementacion` (acompañamiento operativo; el
  backfill recompone una parte al reaplicar). La AUDITORÍA de inicio/cierre de
  soporte vive en `auditoria_plataforma` y SOBREVIVE al `_down`.
- El `_down` nunca se ejecuta automáticamente.

## Endpoints
| Método | Ruta | Guardia |
|---|---|---|
| GET | `/api/superadmin/central/negocios` | requireSuperadmin |
| GET | `/api/superadmin/negocios/:id/ficha` | requireSuperadmin |
| PATCH | `/api/superadmin/negocios/:id/onboarding` | requireSuperadmin |
| PATCH | `/api/superadmin/negocios/:id/checklist-operativo/:paso` | requireSuperadmin |
| PATCH | `/api/superadmin/negocios/:id/implementacion` | requireSuperadmin |
| POST | `/api/superadmin/negocios/:id/sesion-soporte` | requireSuperadmin + rate limit |
| GET | `/api/superadmin/sesiones-soporte` | requireSuperadmin |
| POST | `/api/auth/soporte/salir` | requireSesionNegocio (solo sesiones sop) |

## Sesión de soporte — modelo de seguridad
- Solo un superadmin activo puede crearla; queda auditada (inicio y cierre)
  en `auditoria_plataforma`.
- Token HMAC con claims `{usuarioId, negocioId, rol:'admin', sop:true}`,
  vida 2 h; viaja SOLO como cookie httpOnly (nunca en el cuerpo/logs).
- En CADA request: firma + fila viva en `sesiones_soporte` (no cerrada, no
  expirada, mismo negocio) + privilegio superadmin vivo. Perder el privilegio
  o cerrar la sesión la mata de inmediato, sin esperar la expiración del HMAC.
- `negocio_id` fijado dentro del token firmado: URL/query/body/headers/cookies
  secundarias no lo alteran (probado).
- Una cookie de soporte NO sirve en `/api/superadmin/*`: no se puede encadenar
  soporte→soporte ni usar la consola desde dentro de un negocio.
- No existe renovación: una sesión de soporte no puede volverse permanente.
- El panel del negocio muestra la barra "Estás administrando [NEGOCIO] como
  Superadmin" con botón "Salir y volver a Superadmin" (revoca + limpia cookie).

## Pipeline de onboarding
Orden principal: `prospecto → alta_iniciada → invitacion_enviada →
cuenta_creada → configuracion_en_proceso → integraciones → pruebas →
listo_para_operar → activo`; laterales: `pausado`, `cancelado`.
- **Automáticos (derivados al leer, nunca escritos por la derivación)**:
  `invitacion_enviada`, `cuenta_creada`, `configuracion_en_proceso`. El
  derivado SOLO avanza: jamás retrocede un estado manual posterior.
- **Manuales (PATCH, solo superadmin, auditados)**: `prospecto`,
  `alta_iniciada`, `integraciones`, `pruebas`, `listo_para_operar`, `activo`,
  `pausado`, `cancelado`. Intentar fijar un estado automático a mano → 400.
- Datos incompletos: la derivación cae al estado más temprano demostrable;
  negocios antiguos quedan cubiertos por el backfill de la 037.

## Checklist operativo (16 pasos)
- 11 automáticos (estado calculado de datos reales; el estado NO es editable
  a mano — intentar cambiarlo → 400; los metadatos responsable/fecha/notas/
  bloqueante/evidencia SÍ se anotan): negocio_creado, invitacion_enviada,
  administrador_registrado, datos_completos, horarios, menu, whatsapp, bot,
  metodos_pago, red_repartidores, modulo_restaurante.
- 5 manuales (estado pendiente/en_proceso/bloqueado/completado/no_aplica +
  metadatos, auditados): impresion, delivery, pedido_prueba, capacitacion,
  listo_para_operar.
- Un paso manual nunca puede contradecir un automático crítico: los
  automáticos se recalculan en cada lectura y mandan sobre su propio estado.

## Carnitas Moreno (verificación de solo lectura, 2026-08-06)
Sin cambios respecto al reporte anterior: `pendiente`, admin Xiomar Moreno
SIN contraseña (invitación no aceptada), invitación vigente que EXPIRA
2026-08-06 21:27 UTC, 0 productos, 0 pedidos, 0 repartidores,
0 integraciones; módulos pos/caja/menu/usuarios/whatsapp/repartidores/
chat_* en `pendiente`. **Plan para desbloquear**: (1) hoy, antes de las
21:27 UTC: contactar al cliente para que acepte la invitación, o reenviarla
(acción humana explícita — no se hizo aquí); (2) tras el acceso: menú y
horarios (cliente) + WhatsApp e impresión (Xabor); (3) pedido de prueba y
capacitación; (4) marcar `listo_para_operar`. Con esta Central desplegada,
todo eso se sigue desde la ficha del negocio.

## Pruebas
- Suite específica: `test/fase-central-operaciones.mjs` — **25/25** en 2
  PostgreSQL 16 independientes (incluye: encadenamiento bloqueado, superadmin
  degradado, expiración server-side, manipulación por query/body/header/
  cookie secundaria, orden hostil por lista blanca, ficha sin secretos,
  límites de paginación, checklist auto/manual, onboarding auditado,
  reenvío de invitación protegido por rate limit, cierre de soporte,
  sesiones simultáneas vía listado).
- Regresión (base 1): aislamiento P0 29/29, pagos multiempresa 48/48,
  tiempo-real repartidores 26/26, superadmin red 26/26, universos D.1 15/15,
  carrera inserción 2/2.
- Build Docker de producción: exitoso.
- UI validada en navegador (escritorio y 375px móvil) contra el server real.

## Riesgos
- La sesión de soporte es poder real de admin sobre el negocio: mitigada con
  2 h de vida, revocación server-side, no-encadenamiento, auditoría y barra
  visible. Revisar `/api/superadmin/sesiones-soporte?vigentes=true`
  periódicamente.
- `sesiones_soporte` revalida contra la base en cada request del panel en
  sesiones de soporte (1 SELECT por pk parcial) — costo despreciable y solo
  en sesiones de soporte.
- La edición de implementación/checklist usa `prompt()` — funcional y solo
  visible para Superadmin; se acepta para este deploy, modal pendiente.

## Procedimiento de deploy
1. Backup lógico de Postgres de producción (patrón de fases anteriores).
2. Desde un worktree LINKEADO a honest-tenderness/production/xabor-agent en
   la rama de integración: `railway up --service xabor-agent --ci`.
3. El predeploy corre solo (runner 032→037; 032–036 no-op, 037 aplica).

## Smoke test post-deploy
1. `/health` → 200; logs de deploy: `[predeploy-037] ... Verificación OK` y
   distribución de onboarding coherente (Nonna Maye/Alora/Mapolato = activo,
   Carnitas = invitacion_enviada o cuenta_creada).
2. Login superadmin → pestaña Central → los 4 negocios listados con etapa.
3. Ficha de Carnitas Moreno → invitación y checklist coherentes.
4. Entrar como soporte a un negocio de prueba (Alora) → barra visible →
   panel opera → Salir → la consola vuelve a pedir sesión.
5. Panel de Nonna Maye (sesión normal de cliente) intacto: comandas, chat.
6. Auditoría: filas `sesion_soporte_iniciada`/`cerrada` del paso 4.

## Rollback
- Código: redeploy del deployment anterior (`a9880ce7`). La 037 es aditiva:
  el código de `db3d105` convive con el esquema nuevo sin tocarlo — el
  `_down` NO es necesario para el rollback de código.
- Esquema (solo si se decide revertir del todo):
  `migrations/037_central_operaciones_onboarding_down.sql` a mano, con la
  pérdida de datos documentada arriba.

## Pendientes (no bloquean el deploy)
- Modal en lugar de `prompt()` para implementación/checklist.
- Deep-links de las acciones de ficha hacia secciones específicas del detalle.
- Roles de plataforma (Implementación/Soporte/Comercial/Finanzas/Solo
  lectura) — la sesión de soporte ya deja el terreno preparado.
