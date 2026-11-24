# Xabor Básico — suscripciones SaaS
Estado: borrador. Pruebas locales con proveedores simulados y ensayo externo de autorización con cuentas/tarjeta de prueba. No se ha observado el primer débito ni una renovación; no es certificación de Mercado Pago ni autorización productiva.

## Implementación
- Precio único configurable en `XABOR_BASICO_MENSUALIDAD_MXN` (150 por omisión). El alta y cada contrato conservan su precio; cambiar el parámetro no modifica contratos anteriores.
- Contrato pendiente mensual, checkout alojado y primer débito solicitado después de la prueba de siete días o del periodo ya pagado.
- Credenciales exclusivas de Xabor SaaS, separadas de los pagos de restaurantes.
- Firma HMAC, timestamp y consulta de factura, pago y contrato. Una redirección o autorización sin pago no acredita mensualidades.
- Reserva única en PostgreSQL para contratos simultáneos. Un rechazo definitivo HTTP 400/401/403/404/405/422 conserva el intento cancelado y permite reintentar. Un timeout, conflicto de idempotencia, límite o error de servidor mantiene la reserva y genera una alerta de resultado incierto: requiere conciliación/revisión antes de reintentar.
- Ledger único por factura y pago. Periodos vinculados a la fecha de débito de la factura, con mes calendario limitado al último día cuando corresponde. Un webhook repetido no añade meses.
- Reembolsos y contracargos confirmados retiran el acceso del periodo afectado y conservan el historial. Los reembolsos parciales dejan ese periodo sin acceso hasta revisión; falta aprobar la política comercial definitiva. Este servicio NO emite devoluciones de dinero automáticamente.
- Cancelación conserva lo pagado. Recontratar crea otro contrato e inicia cobros después del periodo conservado. Los avisos de un contrato antiguo no sobrescriben el nuevo.
- Gracia configurable mediante `XABOR_BASICO_GRACIA_DIAS`, de 0 a 30. Por omisión es 0: no se anuncia una concesión comercial no aprobada. Con contrato autorizado cubre una renovación reciente o la espera del primer débito tras la prueba. Se mide desde el fin del periodo pagado o, si no lo hay, desde el fin de la prueba; no añade pagos al ledger.
- Conciliación opcional cada 15 minutos mediante `XABOR_CONCILIACION_AUTOMATICA=true`, además del webhook. Exclusión entre réplicas con advisory lock, orden justo por última consulta y cursor persistido de facturas.
- Búsqueda de facturas en páginas de 12, con tamaño centralizado para el cliente, la tarea periódica y el comando manual. En el ensayo real `limit=20` devolvió HTTP 400 «Invalid value for limit»; `limit=12` con offsets 0 y 12 devolvió 200. El proveedor local reproduce esa restricción y la prueba recorre varias páginas sin acreditar facturas solo programadas.
- Alertas persistidas, sin secretos o payloads personales, disponibles para superadmin en `GET /api/superadmin/basico/alertas`. No se han conectado avisos por correo externos.

## Esquema
Producción `f802288` ya utiliza 144–146 y 149 para segundo factor, sesiones, consentimiento y Rewards. Las migraciones del Básico todavía no se han aplicado en producción y usan ahora estos nombres:
1. 150: solicitudes de alta pública verificable.
2. 151: contratos y ledger inicial.
3. 152: contratos históricos, precio fijado y periodos/estados por pago.
4. 153: conciliación, alertas y claves foráneas compuestas de tenant.
5. 154: límites persistidos de registro y evidencia de aceptación del aviso de privacidad.

Aplicarlas en orden y revisar la compatibilidad antes de cualquier producción. El inicializador de staging rechaza cualquier entorno distinto de `staging-basico`, host distinto de `basico-postgres.railway.internal` y base distinta de `xabor_basico_staging`. No inicializa una base de clientes ni reintenta sobre un esquema incompleto.

## Entornos
- Producción existente: `honest-tenderness / production / xabor-agent`, rama `prod/mesero-shadow-v3`.
- Staging nuevo: `honest-tenderness / staging-basico`.
- Servicios separados: `basico-postgres` y `basico-staging`; volumen nuevo. No se copiaron datos o secretos productivos.
- URL activa: https://basico-staging-staging-basico.up.railway.app (commit desplegado `a824719`, despliegue `902efa19-0e94-4218-bafd-51d9fbe35c0d`, con reintentos seguros, gracia inicial, bloqueo adicional de rutas premium y paginación corregida).
- Aplicación MP creada con autorización: **Xabor Suscripciones SaaS**, ID `701400261990154`.
- La cuenta sintética de staging no demuestra entrega real de correo: únicamente sirve para pruebas aisladas.
- Se verificó aparte un registro con correo real del propietario, creación de su cuenta y negocio, venta de 70 MXN, recuperación de contraseña y revocación de la sesión anterior. Los datos personales y contraseñas no se guardan en este documento.

## Configuración
- `MP_SAAS_ACCESS_TOKEN`: cuenta vendedora DE PRUEBA, verificar su identidad antes de operar.
- `MP_SAAS_WEBHOOK_SECRET`: secreto de la notificación del entorno correspondiente.
- `PUBLIC_URL`: URL HTTPS del entorno.
- `XABOR_SUSCRIPCIONES_MP=true`: solo después de comprobar cuenta y webhook.
- `XABOR_ALTA_PUBLICA_BASICO=true`: separado de cobros; requiere correo operativo.
- `RESEND_API_KEY`: acceso de correo del entorno, nunca copiar innecesariamente el de producción.

Webhook: `POST /webhook/xabor-saas-mp?data.id=<id>`.
Eventos: `subscription_preapproval`, `subscription_authorized_payment`, `payment`.

## Evidencia local
Node 22.23.5 y PostgreSQL 18, base desechable en Docker. Red saliente bloqueada; Resend y MP se sustituyen por proveedores HTTP locales.
65 pruebas pasan en las suites de alimentos, registro, acceso comercial, cliente MP, plan/ticket, sesiones, actualización de staging e integración DB. Incluyen confirmación simultánea, privilegios ignorados, aislamiento de catálogo/reportes/tickets/WebSocket, primera venta sin teléfono, recuperación de contraseña, cierre de sockets abiertos por vencimiento/revocación, pagos rechazados/aprobados, renovaciones, duplicados, recontratación, devoluciones, contracargos, gracia inicial/de renovación y conciliación. El caso de respuesta 500 simula que MP creó el contrato antes del error y demuestra que no se crea otro al reintentar. Las pruebas ampliadas comprueban el bloqueo de impresión y reparto para altas públicas sin esos módulos, la conservación de condiciones anteriores y el acceso tras contratar el módulo.
La prueba visual creó productos, registró una venta por 80 MXN y verificó reporte y ticket en escritorio y móvil.
GitHub Actions incorpora PostgreSQL independiente; esperar su resultado remoto antes de aprobar producción.

## Ensayo externo y límites
- Vendedor y comprador de prueba mexicanos verificados. La cuenta técnica de Xabor creó un contrato con el correo de ese comprador mediante el cliente normal de MP; no se cambió el correo de acceso del propietario.
- Checkout alojado autorizado con una Mastercard de prueba oficial: MP mostró siete días gratis, 150 MXN por mes, primer cobro el 30 de noviembre de 2026 y siguientes cada día 30. La API confirma `authorized` y el ledger de mensualidades sigue vacío, como corresponde durante la prueba.
- El primer `start_date` solicitado fue `2026-11-30T05:26:15Z`; MP devolvió `next_payment_date=2026-11-30T15:14:56Z`. Hay que cubrir operativamente diferencias de horario y procesamiento con la gracia que apruebe el propietario. No se cambió el valor configurado de 0 días.
- El simulador oficial de Webhooks devolvió 200 OK. La autorización no produjo un aviso automático observado durante el ensayo. Una notificación firmada simulada del contrato real consultó la API, actualizó el estado local a `authorized` y conservó el estado comercial `prueba`, con cero mensualidades.
- El conciliador desplegado inicialmente falló por el tamaño de página rechazado por MP y registró una alerta. Se ejecutó el código candidato corregido en un proceso aislado dentro de staging: vendedor de prueba verificado, un contrato consultado, cero errores, alerta resuelta y cero mensualidades. Después el propietario aplicó el código y `XABOR_CONCILIACION_AUTOMATICA=true` únicamente en staging. Los logs confirman dos ejecuciones automáticas separadas por quince minutos, ambas con un contrato, cero errores y cero acreditaciones.
- Comprobación HTTP tras desplegar: acceso a menú, configuración y estado de suscripción; bloqueo 403 de impresión, repartidores, pedidos a domicilio y otros módulos premium comprobados. Se conservan dos cuentas verificadas y dos ventas; ticket de otra cuenta inaccesible. Health 200 y servicio listo.
- Correo real de verificación y recuperación comprobado con participación del propietario; el enlace de recuperación quedó consumido y la sesión anterior devolvió `SESION_REVOCADA`.

## Pendiente externo / comercial
- Observar ejecución y acreditación del primer débito y una renovación. La pantalla y la API solo demuestran la programación, no un ciclo de cobro completo.
- Verificar entrega automática de eventos y observar más ciclos del respaldo de conciliación ya activo en staging. No confundir el simulador ni la reproducción firmada con entrega automática.
- Validar cambio de tarjeta mediante nueva autorización/recontratación. El panel no recibe números de tarjeta.
- Confirmar impuestos, condiciones comerciales, duración de gracia y tratamiento de reembolsos parciales.
- Revisar cuentas existentes y endpoints premium más allá de los casos incluidos, y realizar piloto.
- Autorizar explícitamente migraciones y despliegue productivo. El PR debe seguir en borrador.

## Referencias oficiales consultadas
- [API de suscripciones](https://www.mercadopago.com.mx/developers/es/reference/online-payments/subscriptions/overview)
- [Búsqueda de facturas por pago/contrato](https://www.mercadopago.com.mx/developers/es/reference/online-payments/subscriptions/authorized-payment-search/get)
- [Gestión y cancelación](https://www.mercadopago.com.mx/developers/es/docs/subscriptions/subscription-management)
- [Pruebas con vendedor y comprador sintéticos](https://www.mercadopago.com.mx/developers/en/news/2023/11/16/Questions-on-how-to-test-your-integration--)
- [Tarjetas oficiales de prueba para suscripciones](https://www.mercadopago.com.mx/developers/es/docs/subscriptions/additional-content/your-integrations/test/cards)
- [Webhooks de suscripciones](https://www.mercadopago.com.mx/developers/es/docs/subscriptions/additional-content/your-integrations/notifications/webhooks)
