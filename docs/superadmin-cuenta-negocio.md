El menú de sucursales incluye «Superadmin» cuando `/api/auth/sucursales`
confirma que la cuenta tiene un registro de plataforma activo. También aparece
para un superadmin con una sola sucursal. La entrada navega a `/superadmin`;
no crea una sesión de soporte, no modifica la sucursal ni sustituye el 2FA.
El pedido sin guardar requiere confirmar la salida.

La migración 162 añade `administradores_plataforma.personal_en_negocios_propios`,
booleano no nulo y apagado por omisión. No concede permisos a cuentas existentes.
Una autorización administrativa explícita y auditada permite conservar Empleados
al combinar superadmin con la administración de un negocio. Se exige además
usuario y negocio activos y una membresía admin activa de ese negocio. El permiso
no habilita el módulo contratado ni amplía la lista de sucursales. Soporte siempre
queda excluido. Las rutas y la visibilidad de Empleados comparten esta regla;
un fallo de la base oculta la entrada y rechaza la operación.

Para trasladar el acceso de plataforma entre cuentas existentes: conservar el
origen, conceder el destino con una operación auditada, comprobar su acceso real
y su propio segundo factor, y solo entonces retirar el origen e invalidar sus
sesiones. No copiar contraseñas, secretos TOTP ni cookies. Conservar las filas
históricas de usuario y auditoría.

Validación: `fase-superadmin-selector.mjs` (interacción del menú sin navegador)
y `fase-superadmin-cuenta-db.mjs` (HTTP real, PostgreSQL local y proveedores
bloqueados). La regresión HTTP de Empleados se ejecuta con `CASOS=B` en
`fase-xecador-empleados.mjs`. La comprobación visual se hace con la aplicación
HTTP y datos sintéticos, antes de cualquier cambio de producción.
