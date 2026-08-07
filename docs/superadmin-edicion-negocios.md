# Superadmin — Edición de negocios (caso Carnitas Moreno)

Rama `feat/superadmin-editar-negocios` (base 109f816, el commit desplegado).
Sin migración: reutiliza `negocios`, `usuarios`, `invitaciones_usuario`
(012), `auditoria_plataforma` (011), `sesiones_soporte` (037) y
`configuracion`.

## Diagnóstico

- `negocios` solo tiene `nombre/slug/estado/plan/activo` — el modelo NO
  tiene columnas de correo, teléfono ni dirección. El correo de invitación
  vive en `usuarios.email` (UNIQUE global desde la migración 006) y el
  contacto operativo en `configuracion` (claves `ciudad`, `telefono`,
  `direccion`, `nombre_corto`). Campos del pliego SIN soporte en el modelo
  (documentados, no se crearon columnas): razón social, colonia, código
  postal, tipo de negocio, logo.
- **Causa de que Carnitas Moreno no pudiera corregirse**: no existía
  ningún PATCH de datos del negocio ni del admin invitado; "Reenviar
  invitación" creaba una invitación nueva… **al mismo correo equivocado**.
  El caso real: 4 invitaciones (3 revocadas por reenvíos + 1 pendiente),
  ninguna aceptada, `password_creada=false`.
- Ya existía (se reutiliza, no se duplica): alta con invitación, reenviar,
  `PATCH /estado` (pendiente/activo/suspendido con invariante
  `activo=(estado='activo')` y auditoría), plan/módulos/checklist, sesión
  de soporte con barra visible en el panel y auditoría de entrada/salida.

## Lo nuevo

| Ruta | Qué hace |
|---|---|
| `PATCH /api/superadmin/negocios/:id` | Edición PARCIAL: `nombre`, `slug` (regex + unicidad + reservados + advertencia de URLs; jamás se recalcula al cambiar el nombre), `contacto{ciudad,telefono,direccion,nombre_corto}` → `configuracion`. Solo toca lo enviado; `updated_at`; auditoría `editar_negocio` campo a campo (antes/después). |
| `PATCH /api/superadmin/negocios/:id/admin` | Corrige `email`/`nombre` del admin invitado (primer admin por antigüedad, mismo criterio que reenviar). Valida formato y UNIQUE (`EMAIL_EN_USO` 409). Nunca crea un segundo admin: edita el usuario existente por UUID. Auditoría `editar_admin_negocio`. |
| `GET /api/superadmin/negocios/:id/invitaciones` | Historial con estado derivado (pendiente/aceptada/expirada/cancelada), correo destino, fechas, quién la generó. **Jamás tokens ni hashes.** |
| `POST /api/superadmin/negocios/:id/invitaciones/nueva` | Igual núcleo que reenviar (revoca pendientes, crea una nueva) — para usarse tras corregir el correo. |
| (endurecido) `POST …/reenviar-invitacion` | Ahora responde 409 `INVITACION_ACEPTADA` si el admin ya tiene contraseña — jamás se pisa una cuenta activa. |

Desactivar/Reactivar = `PATCH /estado` existente (suspendido bloquea el
acceso operativo vía `requireAuthSeguro`/`negocioEstaActivo`; NO borra
nada). Administrar = sesión de soporte existente (2 h, cookie temporal,
barra visible, auditoría iniciada/cerrada). **No existe DELETE de
negocios y no se implementó** (borrado físico fuera de alcance salvo
autorización expresa).

## UI (panel/superadmin.html, ficha del negocio)

- Tarjeta **"Editar negocio"**: nombre, slug (con advertencia), ciudad,
  teléfono, dirección, nombre corto + sección **"Administrador invitado"**
  (nombre, correo, texto de estado según aceptación, botones Guardar /
  Generar nueva invitación).
- Tarjeta **"Invitaciones"**: historial con badges de estado, correo
  destino, fechas y creador; nota explícita de que los tokens nunca se
  muestran.
- Acciones: Detalle técnico · Reenviar invitación · Entrar como soporte ·
  **Desactivar/Reactivar** (según estado, con confirmación que aclara que
  nada se borra).

## Flujo Carnitas Moreno (después del deploy)

1. Central → Ficha de Carnitas Moreno → "Editar negocio".
2. Corregir el correo del administrador → Guardar.
3. "Generar nueva invitación" → llega al correo corregido (la pendiente
   anterior queda cancelada; el historial lo muestra).
4. Si necesitas configurarlo antes de que acepte: "Entrar como soporte"
   (menú, horarios, métodos de pago, repartidores — auditado).
5. El negocio está `suspendido` hoy: "Reactivar negocio" cuando toque.

## Seguridad

`requireSuperadmin` en todas las rutas; admin normal y cross-tenant → 401/
403 (probado); sin sesión → 401; slug reservado bloqueado; auditoría sin
tokens/secretos; el id UUID es la única clave (cambiar nombre/correo/slug
no rompe ninguna FK).

## Pruebas

`test/fase-superadmin-editar-negocios.mjs` (16 casos): fixture réplica del
caso real por el flujo de alta verdadero, correo mock (sin proveedor el
backend devuelve el enlace una sola vez — cero correos reales), edición
parcial + auditoría, validaciones slug/email, historial y estados de
invitación, correo corregido → nueva invitación, aceptada → 409,
desactivar/reactivar con sonda de acceso y conteos intactos, sesión de
soporte punta a punta, seguridad multi-tenant. + Regresión completa y
build Docker (resultados en el reporte de cierre).

## Deploy / rollback

Deploy estándar (`railway up --ci`, sin migraciones nuevas — el predeploy
032-040 sigue no-op). Rollback = redeploy del commit anterior; no hay
cambios de esquema ni de datos que revertir. Los cambios que el
superadmin haga con estas rutas quedan auditados en
`auditoria_plataforma` y son reversibles editando de vuelta.
