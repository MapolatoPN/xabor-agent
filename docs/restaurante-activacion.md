# Activación del módulo Restaurante desde Superadmin

Rama `fix/readiness-restaurante-ui` (base 98601ec, el commit desplegado).
**Sin migración, sin SQL como flujo normal, sin tocar el core del módulo**
(cuentas/mesas/pagos intactos).

## El problema que corrige

El módulo Restaurante estaba completo y desplegado (migraciones 039/040
aplicadas, 13 rutas, servicio, suite 28/28), pero era **invisible en
Superadmin**: la lista `MODULOS` del frontend estaba hardcodeada con 17
módulos y no incluía `'restaurante'`, aunque el backend
(`MODULOS_VALIDOS`) sí lo aceptaba. Activarlo requería llamar la API a
mano.

## Lo que cambia

1. **Fuente única de módulos**: `GET /api/superadmin/modulos-disponibles`
   (requireSuperadmin) devuelve `{clave, nombre}` derivado de
   `MODULOS_VALIDOS` + etiquetas server-side
   (`listarModulosDisponibles()`, database.js). La UI la consume al
   iniciar; la lista local queda solo como fallback (y ya incluye
   restaurante). Agregar un módulo futuro = un solo cambio en un solo
   archivo → el desfase no puede repetirse. **FUENTE ÚNICA: implementada.**
2. **Restaurante visible**: aparece automáticamente en la tarjeta Módulos
   de la ficha (selector de estado, reutiliza `cambiarModulo` y el PATCH
   existente — sin lógica especial) y en los checkboxes del alta de
   negocio.
3. **Número de mesas**: `PUT /api/superadmin/negocios/:id/restaurante-config`
   `{numMesas}` — entero estricto 1-500 (0, >500 y decimales → 400),
   guarda `configuracion.restaurante_num_mesas` (la clave que
   `listarMesas` ya lee), auditado en `auditoria_plataforma`. Sin tabla de
   mesas, sin migración. Input en la tarjeta nueva; deshabilitado si el
   módulo no está activo (con nota de que el default 12 nunca bloquea la
   activación) y advertencia "usando valor predeterminado: 12 mesas".
4. **Readiness mínimo**: `GET .../restaurante-readiness` → módulo,
   mesas (+usandoDefault), usuarios activos, productos activos y estado
   `LISTO` / `CONFIGURACION_PENDIENTE`. Criterio: módulo activo + ≥1
   usuario activo + ≥1 producto disponible + mesas válidas. Tarjeta
   "Restaurante — preparación" en el detalle técnico del negocio.

## Flujo de activación (sin SQL)

Superadmin → Negocio → Detalle técnico → **Módulos** →
**Restaurante (mesas y meseros)** → `activo` → tarjeta
**Restaurante — preparación**: fijar **Número de mesas** → verificar
**Usuarios activos ≥ 1** → verificar **Productos activos ≥ 1** → estado
**LISTO**. (Impresión y política de propinas quedan fuera de este
readiness mínimo, como definió la microfase.)

## Seguridad

Todas las rutas nuevas `requireSuperadmin`; admin normal y sin sesión →
401/403; negocio inexistente → 404; módulo inexistente → 400; activar/
desactivar idempotente (una sola fila por UPSERT existente). El tenant lo
fija el `:negocioId` bajo sesión superadmin (global por diseño, igual que
el resto de Superadmin).

## Pruebas

`test/fase-restaurante-activacion-ui.mjs` (12 casos): fuente única con
restaurante y etiqueta; HTML servido con fallback + tarjeta; activar/
desactivar/idempotencia; `requireModulo` 403↔200; mesas 1/12/500 ok y
0/501/decimal/no-numérico 400 sin pisar el valor; readiness pendiente→
LISTO y default 12 reportado sin bloquear; seguridad (admin/sin sesión/
404). + Regresión completa y build Docker.

## Deploy / rollback

Deploy estándar (sin migraciones; predeploy no-op). Rollback = redeploy
del commit anterior; los valores escritos (`negocio_modulos`,
`restaurante_num_mesas`) son configuración reversible por la misma UI.
