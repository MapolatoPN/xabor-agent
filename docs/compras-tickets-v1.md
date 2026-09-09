# Compras, fondos y pagos a proveedores

## Alcance y ejemplo

Una compra confirma el gasto. Un pago registra dinero que ya salió. Una entrega de fondo registra dinero recibido por un responsable. Ninguna de estas acciones hace transferencias bancarias.

Ejemplo: entregar $35,000 a Papá, pagar $8,000 de compras desde su fondo y confirmar $5,000 a crédito deja **$27,000 de fondo y $5,000 por pagar**. Un abono posterior de $2,000 desde otra cuenta deja $3,000 de deuda y conserva los $27,000 del fondo. El gasto sigue siendo $13,000.

Todos los importes se registran en MXN. Una foto con moneda explícita distinta se rechaza; convertir y registrar manualmente documentando tipo de cambio y referencia. La captura no calcula impuestos ni determina deducibilidad.

## Uso

Entrar por Administración → Compras y fondos, o `/compras.html`, con sesión de administrador o personal (`staff`). El administrador crea responsables y registra entregas/devoluciones en Fondos. Los saldos arrastran movimientos anteriores al periodo seleccionado.

Capturar manualmente o subir JPG/PNG/WEBP. La extracción propone un borrador; revisar proveedor, fecha, total, conceptos y factura. Se conservan unidad, precio unitario, categoría sugerida y confianza al editar o reordenar conceptos. La imagen privada se normaliza para quitar EXIF/GPS. Una imagen normalizada idéntica se detecta antes de volver a consultar IA; esto no detecta dos fotografías diferentes del mismo ticket.

Confirmar a crédito registra deuda sin tocar dinero. Confirmar al contado exige el origen del pago: fondo con responsable o cuenta/recurso externo con nombre. Compra y pago inicial se guardan juntos o ninguno se guarda. No se permite usar dinero entregado en una fecha posterior ni sobregirar un fondo.

El administrador registra abonos en Por pagar; estos reducen deuda sin crear otra compra. Puede corregir pagos y fondos con motivo obligatorio: el movimiento original queda registrado como revertido. Para cancelar una compra con pagos, primero corregir esos pagos. La cancelación no borra el documento. Puede actualizar el estado y UUID de factura después de confirmar, con auditoría y sin cambiar montos.

El personal puede capturar, editar borradores y confirmar con el pago inicial; solo administradores gestionan responsables, fondos, abonos posteriores, correcciones, cancelaciones y actualización posterior de factura. La sesión y la membresía del servidor determinan el negocio y rol; los valores enviados por el navegador no los reemplazan.

## Saldos y límites

- Compras y pagos muestran movimientos del periodo; fondo y deuda incluyen arrastre hasta la fecha final.
- Las correcciones recalculan el pasado. El reporte no es un cierre contable inmutable.
- El historial de fondos muestra los últimos 100 movimientos del periodo. La suma incluye todos.
- Registros anteriores a la migración 070 se marcan sin responsable o sin revisión de pagos. Se muestran como pendientes de revisión y se excluyen de saldos conocidos; no se inventa que una compra antigua está pagada o adeudada. No hay asistente de regularización histórica en esta entrega.
- No sincroniza bancos, caja, nómina, inventario ni CFDI. No resuelve todavía la conciliación global de cuánto dinero debería existir en todas las cuentas del negocio.
- Proveedor es texto de la compra; no se incorpora un catálogo fiscal de proveedores.

## Integración

Rama `codex/compras-fondos-pagos-v1`, basada en `feature/compras-tickets` e integrada con `main` @ `290ceda`. Claude mantiene el asistente de WhatsApp; estos cambios no alteran su lógica. El wrapper `tiendaRutas.js` monta Compras y delega Tienda a `tiendaRutasCore.js`, copia idéntica del archivo original de main. Si Claude cambia ese punto de montaje, reconciliarlo al integrar para conservar ambos módulos.

Las migraciones aditivas 069 y 070 se aplican juntas con `scripts/predeploy-070-compras-pagos-fondos.mjs`, conectado al runner de Railway existente. Son repetibles y transaccionales. No usan `compras_reales`, que pertenece a pedidos de clientes/promociones. Antes de integrar, comprobar que otro trabajo no haya ocupado esos números.

Las operaciones financieras se serializan por negocio dentro de transacciones. Pagos y fondos llevan clave de idempotencia; reutilizarla con otro contenido se rechaza. Los borradores y facturas usan versión para rechazar sobrescrituras simultáneas. Las consultas de resumen usan una sola instantánea de base de datos.

## Validación local y despliegue manual

Pruebas de Compras: `fase-compras-tickets` 10/10, `fase-compras-ia-contrato` 8/8, `fase-compras-integracion` 20/20 y `fase-compras-servidor` 7/7. Incluyen PostgreSQL real aislado, dos negocios, concurrencia, sesión real y navegador móvil/escritorio. La IA es simulada en las pruebas: **no prueba lectura real de tickets ni credenciales Anthropic**.

Regresiones: Tienda 75/75 en repetición (un primer intento falló en elegibilidad de primera compra), render de panel 21/21, navegación móvil 9/9, UX 19/19 y predeploy 31/31. Sidebar 11/16: las mismas cinco fallas también se reproducen en main; expectativas de conteos, selectores y agrupaciones anteriores. No se cambiaron pruebas ajenas para ocultarlas.

Para repetir integración usar PostgreSQL desechable local con SSL, `COMPRAS_TEST_DATABASE_URL`; la prueba crea un esquema aleatorio y lo elimina. Para servidor real usar base sintética completa con seed, `DATABASE_URL`, `SESSION_SECRET`, `PANEL_SECRET` e `INTEGRATIONS_ENCRYPTION_KEY` (32 bytes base64). Nunca apuntar estas pruebas a producción.

Antes del despliegue:

1. Integrar y revisar los cambios de Claude y Compras en una rama candidata; volver a probar los puntos compartidos y reservar migraciones 069/070. No se ha hecho push ni deploy desde esta entrega.
2. Comprobar respaldo recuperable de base y almacenamiento. Usar primero un entorno de ensayo con datos sintéticos.
3. Ejecutar `node scripts/compras-verificar-config.mjs` en el entorno candidato. Solo inspecciona configuración y no revela secretos. Requiere `ANTHROPIC_API_KEY`. Para fotos persistentes usar `STORAGE_DRIVER=s3` y las variables S3 documentadas en `almacenamiento.js`, o un volumen que cubra realmente `storage/documentos`. La configuración no demuestra permisos ni persistencia.
4. Aplicar el paso 070 en ensayo y verificar que se puede repetir. El predeploy de Railway ya lo ejecuta en el despliegue manual.
5. Subir una foto de ticket de prueba con IA real, revisar/corregir/confirmar, volver a abrirla y comprobar que sigue accesible tras reiniciar el servicio. Verificar aislamiento entre negocios. Anthropic y almacenamiento de Railway **siguen pendientes de esta prueba**, porque no estaban disponibles en el entorno local.
6. Verificar el ejemplo de $35,000 y el abono desde otra cuenta. Revisar advertencias históricas antes de confiar en los saldos si ya había registros de la versión anterior.
7. Con esas comprobaciones satisfechas, el usuario realiza el deploy manual y verifica acceso, captura y lectura del ticket.

Si hace falta volver al código anterior, conservar las tablas y columnas nuevas; no ejecutar borrados de Compras ni restaurar una base antigua sobre movimientos nuevos. La interfaz anterior no conoce el libro de pagos y no debe usarse para continuar capturando con los nuevos registros. Preparar un rollback operativo antes de activar el módulo.
