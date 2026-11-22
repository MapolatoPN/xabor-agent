# Xabor Básico — Mercado Pago (suscripción SaaS)

**Estado: código en PR borrador, NO listo para producción, NO activar credenciales productivas sin pruebas.**

## Producto
Un solo negocio de alimentos, plan Básico de **$150 MXN/mes**. La API crea un
contrato de pago recurrente de Mercado Pago con estado inicial `pending`;
el cliente autoriza el medio de pago en el checkout alojado por Mercado Pago.
El inicio programado del primer cobro es el fin de la prueba de siete días
desde la verificación de correo, o dos minutos a futuro si ya venció.
**Verificar el comportamiento exacto del primer cobro con cuentas de prueba**
antes de mostrar promesas sobre fecha de débito: los productos `preapproval`
y `pending` dependen de la aceptación del pagador.

**No** son pagos procesados por los clientes de los restaurantes. La cuenta,
aplicación, access token y webhook corresponden exclusivamente a Xabor.
Los restaurantes conservan Clip / sus pasarelas independientes.

## Archivos
- `migrations/143_registro_basico_autoservicio.sql`: registro verificado.
- `migrations/144_suscripciones_basico_mercadopago.sql`: contrato por negocio
  e historial de pagos con claves únicas de factura y transacción.
- `src/services/mercadoPagoSaasCliente.js`: API fija, contrato `/preapproval`,
  consulta de facturas/pagos y validación HMAC de webhook.
- `src/services/suscripcionBasicoMp.js`: reserva única, checkout seguro,
  conciliación con DOS consultas remotas, acreditación en una transacción,
  cancelación con validación del contrato.
- `src/services/suscripcionBasicoMpRutas.js`: endpoints autenticados, webhook
  firmado separado; cabecera de intención para acciones de cobro.
- `panel/suscripcion-basico.html`: estado, contratación, cancelación.
- `scripts/conciliar-billing-basico-mp.mjs`: recuperación controlada de
  facturas cuando se pierde un webhook; NO corre en segundo plano.
- `test/fase-suscripciones-basico-mp.mjs`: pruebas sin datos externos.

## Configuración en Mercado Pago, cuando staging esté listo
1. Crear una **aplicación exclusiva para las mensualidades de Xabor**.
2. Obtener acceso de prueba y clave secreta de webhooks de esa aplicación.
3. Configurar webhook del entorno de pruebas en
   `https://<HOST-STAGING>/webhook/xabor-saas-mp`; habilitar los eventos
   `subscription_preapproval`, `subscription_authorized_payment`, `payment`.
4. Configurar credenciales **solo en el gestor de variables del ambiente de pruebas**,
   no en GitHub, capturas de pantalla, chats o logs.
5. Variables, por ambiente:
   - `MP_SAAS_ACCESS_TOKEN`: token propio de la app de suscripciones de Xabor
   - `MP_SAAS_WEBHOOK_SECRET`: secreto firmado de su webhook
   - `PUBLIC_URL`: URL HTTPS del ambiente (la URL real de la instalación)
   - `XABOR_SUSCRIPCIONES_MP=true`: interruptor de cobros (por defecto apagado)
   - `XABOR_ALTA_PUBLICA_BASICO=true`: interruptor separado de altas (por defecto apagado)
6. Aplicar migraciones 143 y 144 **únicamente en base de datos de staging**.
7. Confirmar la prueba de vida completa: alta, correo, menú, primera venta,
   vencimiento de prueba, autorización de tarjeta, pago aprobado, segunda
   factura, duplicados, cancelación y no acceso cruzado.

**Producción actual:** inspección de variables (22-nov-2026) detectó
`RESEND_API_KEY` pero no las variables `MP_SAAS_*` ni el interruptor de
suscripciones. No se escribió ninguna variable.

## Endpoints
- `GET /api/suscripciones-basico/estado`: sesión administrativa y negocio
  derivado de la cookie; disponible aunque la prueba haya expirado.
- `POST /api/suscripciones-basico/checkout`: sesión administrativa,
  `X-Xabor-Accion: contratar`, crea un contrato SOLO una vez; repite URL
  existente en solicitudes duplicadas; no crea cargos sin autorización.
- `POST /api/suscripciones-basico/cancelar`: sesión administrativa,
  `X-Xabor-Accion: cancelar`; el usuario debe confirmar en la UI; conserva
  periodo previamente pagado. Puede requerir intervención para reinscribirse
  tras cancelación definitiva: **pendiente habilitar recontratación**.
- `POST /webhook/xabor-saas-mp?data.id=<id>`: exige `x-signature`,
  `x-request-id`, HMAC SHA256 y timestamp reciente. Nunca usa ID de
  negocio ni monto declarados por el emisor: consulta recurso de Mercado Pago.

## Acreditación y fallos
1. Recibe evento firmado `subscription_authorized_payment` o `payment`.
2. Consulta factura `GET /authorized_payments/{id}` y pago
   `GET /v1/payments/{id}`.
3. Comprueba contrato `GET /preapproval/{id}` y `external_reference`
   vinculado a la cuenta exacta.
4. Exige ambos importes $150 MXN y pago `approved`.
5. Inserta en ledger con unicidad de ID de factura y de pago. Solo una
   inserción nueva extiende un mes; el mismo evento se puede repetir.
6. `subscription_preapproval` solo cambia estado remoto de contrato, NUNCA
   concede acceso pagado.
7. Si Mercado Pago responde pero se pierde la respuesta al crear el
   preapproval, queda `creando` sin reintento automático. Es más seguro
   revisar la operación antes que arriesgar doble contratación.
8. Los negocios anteriores a la migración 143 NO se filtran por la nueva
   suscripción ni se les cambia el plan.

## Conciliación de fallas de webhook
Después de validar en staging, el comando manual:
```bash
XABOR_CONCILIACION_CONFIRMADA=SI XABOR_SUSCRIPCIONES_MP=true \
  node scripts/conciliar-billing-basico-mp.mjs
```
Requiere las variables seguras de BD y Mercado Pago del entorno.
Procesa como máximo 10 contratos por defecto (máximo 30) y dos páginas
de facturas por contrato. Requiere programar y monitorear esta tarea
antes de confiar en renovaciones sin supervisión.

## Bloqueadores antes de vender
- [ ] Cuentas de prueba verificadas (incluida **primera fecha real de cargo**
  de una preapproval pendiente, prueba gratuita y rechazo de tarjeta)
- [ ] Registro en entorno aislado con PostgreSQL, email y pruebas reales
- [ ] Verificar que la migración de `negocio_plan_comercial` existe y
  correlaciona correctamente la suscripción
- [ ] Conciliación automatizada, alertas y control de fallas reales
- [ ] Implementar manejo de reembolsos, contracargos y pago anulado:
  el ledger actual acredita solo pagos approved y **todavía no revierte
  periodos pagados por devoluciones posteriores**
- [ ] Recontratación después de cancelar (hoy requiere revisión)
- [ ] Política clara de periodo de gracia, interrupciones de MP y datos
  retenidos al vencer
- [ ] Validar cuentas multiempresa / módulos premium al vencer
- [ ] Decidir si $150 es precio final con impuestos y preparar facturación CFDI
  de la suscripción si corresponde
- [ ] Probar ticket digital y hardware permitido del plan Básico
- [ ] Piloto de diez negocios y autorización explícita de deploy

## Referencias oficiales
- API de suscripciones y facturas:
  https://www.mercadopago.com.mx/developers/es/reference/online-payments/subscriptions/overview
- Suscripción con pago pendiente:
  https://www.mercadopago.com.mx/developers/es/docs/subscriptions/integration-configuration/subscription-no-associated-plan/pending-payments
- Webhook firmado:
  https://www.mercadopago.com.mx/developers/es/docs/subscriptions/additional-content/your-integrations/notifications/webhooks
- Cancelaciones:
  https://www.mercadopago.com.mx/developers/es/docs/subscriptions/subscription-management
