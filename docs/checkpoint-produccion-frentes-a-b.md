# Checkpoint de producción — Frentes A y B desplegados

Fecha: 2026-08-06 · Estado: **Online**, `/health` 200

## Deploy actual
- Proyecto Railway: `honest-tenderness` · entorno `production` · servicio `xabor-agent` · URL `https://xabor.mx`
- **Deployment**: `c925e2b1-05e4-4c7a-90db-d94e974415b7` (Frente B)
- **Commit**: `594c464` · rama `integration/red-repartidores-por-negocio`
- Historial inmediato: `7aaa64ef`/`c949cdd` (Frente A) ← `a9880ce7`/`db3d105` (fix concurrencia repartidores)
- Backups pre-deploy: `backup-pre-frente-a-20260806-072014.sql` (934 KB) y
  `backup-pre-frente-b-20260806-074957.sql` (945 KB, 54 tablas) en `C:\xabor-backups\`

## Migraciones aplicadas en producción
- **037** (Frente A): `negocios.onboarding_estado` (CHECK 11 estados, backfill
  derivado — verificado: 3 negocios `activo`, Carnitas `invitacion_enviada`),
  `negocios.implementacion` (JSONB), tabla `sesiones_soporte`.
- **038** (Frente B): tabla `red_repartidores_config` (19 columnas, 20
  constraints) — **verificada VACÍA: cero backfill, ningún negocio cambió de
  comportamiento**.
- **039: NO aplicada. Frente C NO desplegado** (verificado: sin tablas
  `restaurante_*`).

## Tablas nuevas
`sesiones_soporte` (037) · `red_repartidores_config` (038).

## Endpoints nuevos
Frente A: `GET /api/superadmin/central/negocios` · `GET .../negocios/:id/ficha`
· `PATCH .../onboarding` · `PATCH .../checklist-operativo/:paso` ·
`PATCH .../implementacion` · `POST .../sesion-soporte` ·
`GET /api/superadmin/sesiones-soporte` · `POST /api/auth/soporte/salir`.
Frente B: `GET|PUT /api/config/red-repartidores` ·
`POST /api/pedidos/:folio/solicitar-repartidor` ·
`GET /api/superadmin/red-repartidores/central`.
Todos verificados 401 sin sesión en producción.

## Pantallas nuevas
Superadmin: pestaña **Central de Operaciones** (listado con pipeline +
ficha) y subvista **Central de reparto** (en Red de Repartidores).
Panel del negocio: **barra de sesión de soporte** con botón de salida.

## Comportamiento retrocompatible (clave)
- `red_repartidores_config` sin fila ⇒ el negocio opera EXACTAMENTE como
  antes del Frente B (hoy: los 4 negocios, tabla vacía).
- Error real leyendo esa config ⇒ el gate NO oferta (fail-closed) y el
  pedido principal nunca se afecta.
- La derivación de onboarding solo avanza; nunca pisa estados manuales.

## Campos declarativos (no ejecutados por el motor)
`radio_km`, `fuentes.red_xabor`, `fuentes.externas`,
`politica_reasignacion='reofertar'`. Ninguna pantalla los renderiza (la
configuración de red es solo-API hoy) y `GET /api/config/red-repartidores`
los expone en `camposDeclarativos` — verificado por prueba automatizada.

## Riesgos vigentes
- Sesión de soporte = poder de admin del negocio (mitigado: 2 h, revocación
  server-side, anti-encadenamiento, auditoría, barra visible).
- Cobertura de red por texto de colonia (sin geocoding): captura incorrecta
  puede excluir pedidos; el motivo queda en log.
- Reoferta automática inexistente: si nadie acepta, la reoferta es manual
  (`solicitar-repartidor`).

## Rollback
- Frente B → redeploy `7aaa64ef`. Frente A → redeploy `a9880ce7`.
- 037 y 038 son aditivas: el código anterior convive con el esquema; los
  `_down` existen pero solo se ejecutan con causa técnica confirmada
  (pérdidas documentadas en los cierres respectivos).

## Validaciones pendientes del propietario
Checklist visual único en `docs/checklist-validacion-propietario.md`
(sin credenciales seguras disponibles para la automatización, el humo
autenticado es manual).

## Carnitas Moreno (última lectura 2026-08-06 12:53 UTC — solo lectura)
`pendiente` · onboarding `invitacion_enviada` · Xiomar Moreno sin
contraseña · invitación vigente hasta **2026-08-06 21:27 UTC** (no
aceptada) · 0 menú · 0 repartidores · 0 configuración de red · efectivo y
terminal habilitados. **Sin modificaciones — cualquier acción requiere
autorización expresa del propietario.** Si la invitación vence antes:
"Invitación vencida. Pendiente de autorización del propietario para
reenviarla."
