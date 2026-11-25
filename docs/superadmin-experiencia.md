# Experiencia de Superadmin y revisión de datos

La consola tenía dos listados y dos fichas para administrar un mismo negocio.
La entrada «Negocios» ahora usa el listado paginado de la Central y su ficha.
La configuración técnica continúa disponible desde «Administración y soporte».
No cambian las rutas de escritura ni sus controles de autorización o auditoría.

## Procedencia y plan comercial

`negocios.plan = prueba` es un valor comercial heredado. No identifica datos
ficticios, no acredita el pago de una suscripción y no permite retirar cuentas.

`revisionDatosNegocios.js` compara nombre y slug exactos contra las semillas
documentadas. La coincidencia se calcula al consultar; no se guarda una
clasificación, ni se cambia estado, plan, módulos, usuarios o contratos.
Incluye la procedencia del código de prueba y el piloto comercial conocido.
No clasifica por ausencia de pedidos, correo, nombre «Demo» o plan comercial.

El listado inicial muestra todas las cuentas. Los filtros se aplican en SQL
antes de paginar; el total permanece disponible incluso para páginas vacías.
El resumen distingue las coincidencias y deja fuera de las alertas de cartera
los pilotos y pruebas conocidas. «Sin señales» no confirma un cliente real.
El aviso de administradores de plataforma vinculados a pruebas es informativo;
no revoca derechos ni reemplaza la verificación en dos pasos.

## Interacción

- Resumen con contadores que abren la cartera filtrada.
- Búsqueda con espera breve e invalidación de respuestas antiguas.
- Errores visibles con reintento; no se muestran resultados viejos como válidos.
- Un listado con cuenta, plan, pedidos, catálogo y siguiente acción.
- Ficha con acceso y siguiente paso visibles, formularios y soporte desplegables.
- Seguimiento, etapa y checklist manual con formularios; se conserva la escritura
  auditada y los pasos automáticos no se editan manualmente.
- Invitaciones nuevas ocultas cuando el administrador ya tiene contraseña.
- Administradores desactivados no aparecen como usuarios con acceso.
- La falta de terminal física deja de presentarse como un requisito universal.

Las configuraciones avanzadas, prospectos y reparto conservan sus operaciones.
Esta entrega no añade archivo, borrado masivo, nuevas migraciones ni cambios
en facturación. Retirar datos de prueba exige una revisión separada de usuarios,
permisos de plataforma, pedidos y contratos, y una autorización específica.

## Evitar nuevas semillas en producción

Las semillas identificadas importan `solo-db-pruebas.mjs`: antes de conectar,
exige una URL PostgreSQL en loopback y una base `test_*`. El ayudante de segundo
factor sintético aplica la misma verificación en cada llamada. Los rechazos
no muestran la URL ni sus credenciales. Esto protege las entradas identificadas;
no sustituye la revisión de otros scripts antiguos que escriban en la base.

## Validación

- `fase-superadmin-revision-datos.mjs`: coincidencias estrictas, falsos positivos,
  piloto y bloqueo de semillas/segundo factor contra bases reales.
- `fase-superadmin-experiencia-db.mjs`: filtros, totales, paginación, acceso de
  administradores activos, autorización HTTP con 2FA y conservación de negocios,
  usuarios, membresías y módulos tras las consultas.
- `fase-superadmin-experiencia-ui.mjs`: respuestas fuera de orden, errores,
  escape de nombres y ocultación de acciones cuando falla una ficha.
- Regresión de Central, soporte y segundo factor; módulos de Superadmin;
  registro Básico por HTTP/WebSocket y reportes de productos de la versión base.
- Revisión visual sobre la aplicación HTTP local con datos sintéticos, a 390px
  y en escritorio. El proxy de QA y sus sesiones locales no forman parte del
  producto ni se publican.

Las suites con base requieren PostgreSQL desechable y
`NODE_OPTIONS=--import=./test/red-solo-local.mjs`. El informe de inventario real,
sus evidencias y las capturas se mantienen fuera del repositorio.
