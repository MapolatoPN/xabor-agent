# Cierre operativo post-deploy — Central de Operaciones (Frente A)

## Deploy
- **Deployment ID**: `7aaa64ef-757c-4df2-9377-88328daee980`
- **Commit**: `c949cdd` (rama `integration/superadmin-central-operaciones`)
- **Fecha**: 2026-08-06 12:21 UTC
- **Backup previo**: `backup-pre-frente-a-20260806-072014.sql` (934 KB, 53
  tablas, pg_dump 18 vía Docker, exit 0)
- **Deployment anterior (rollback)**: `a9880ce7` / commit `db3d105`

## Migración 037
Aplicada por el predeploy (032–036 no-op → 037 aplicada → `_check` OK).
Verificado por lectura directa en producción: columnas
`onboarding_estado`/`implementacion` con CHECK, tabla `sesiones_soporte`
(0 filas), backfill exacto — Nonna Maye/Alora/Mapolato = `activo`,
Carnitas Moreno = `invitacion_enviada`. Migraciones 038/039 NO aplicadas.

## Validaciones técnicas post-deploy
- `/health` 200 · deployment SUCCESS · servicio Online.
- `superadmin.html` 200 · `login.html` 200.
- Endpoints de la Central sin sesión → 401.
- Logs de arranque sin error/exception/crash/OOM; DB, OrderManager
  (contador de folios intacto), Rappi, Push y WS iniciando normal.
- Re-verificado Online al cierre de esta fase.

## Humo interactivo — PENDIENTE (propietario)
No existe una sesión segura de Superadmin al alcance de la automatización y
está prohibido crear/restablecer credenciales. Checklist para el humo
manual (una sola pasada, ~10 min):
1. Login Superadmin → pestaña **Central de Operaciones**.
2. Ver 4 negocios: Nonna Maye/Alora/Mapolato "Activo", Carnitas "Invitación
   enviada".
3. Abrir la **ficha** de Carnitas: cuenta (invitación vigente/expirada),
   checklist, implementación, progreso.
4. Marcar un paso manual del checklist con responsable/notas (dato de
   acompañamiento real, no de prueba).
5. **Entrar como soporte a Alora** (nunca Carnitas): barra visible
   "Estás administrando Alora… como Superadmin".
6. Con la sesión de soporte, intentar abrir `superadmin.html` → la consola
   debe responder 403 en sus APIs.
7. Salir de soporte → volver a iniciar sesión → verificar en Auditoría las
   filas `sesion_soporte_iniciada` y `sesion_soporte_cerrada`.
8. Repetir la pestaña Central en un teléfono (vista móvil).

## Rollback
Redeploy del deployment anterior `a9880ce7` (commit `db3d105`).
La 037 es aditiva: el código anterior convive con el esquema sin `_down`;
`_down` solo con causa técnica confirmada (pierde filas de
`sesiones_soporte` y valores de onboarding/implementación; la auditoría
sobrevive).

## Estado
Producción **Online** en `7aaa64ef`. Frente A operativamente cerrado del
lado técnico; queda el humo interactivo del propietario y la activación de
Carnitas Moreno (ver plan en `cierre-red-repartidores-por-negocio.md`).
