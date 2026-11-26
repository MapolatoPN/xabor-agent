# Avisos al dueño por solicitudes y altas

`LEADS_NOTIFICATION_EMAIL` determina el destinatario de los avisos. Si no está
configurada, se mantiene el destinatario histórico de Xabor. Requiere el Resend
existente y `NODE_ENV=production`; las pruebas capturan el correo localmente.

- Una solicitud de Pro en la web se guarda en `prospectos_comerciales` y después
  se notifica al dueño. El registro permanece en Superadmin aunque falle el correo.
  Los reenvíos reconocidos por la deduplicación no generan otra notificación.
- Un alta de Básico o Pro se notifica al confirmar el correo y completar la transacción
  del negocio. No se notifican tokens inválidos o intentos sin verificar. El aviso
  contiene nombre, correo verificado y datos de contacto disponibles; no incluye
  contraseñas, tokens ni enlaces de activación.
- El aviso de alta no confirma un pago. El Básico conserva su prueba y la
  contratación existente. Pro distingue el alta pendiente de pago; la solicitud
  acompañada también se conserva. Véase `selfonboarding-planes.md` para la
  apertura del registro autónomo de Pro.

Los avisos usan una clave de idempotencia por solicitud y se exige un ID de
aceptación del proveedor antes de informar `enviado=true`. La aceptación de
Resend no certifica entrega o lectura. Su ventana de deduplicación es de
[24 horas](https://resend.com/docs/dashboard/emails/idempotency-keys).

La notificación es secundaria y asíncrona. No retrasa el registro ni revierte
un negocio creado si el proveedor falla. No es una cola persistente de reintentos:
Superadmin conserva las solicitudes y negocios para revisarlos si falla el correo.

Verificación: `fase-avisos-altas.mjs` cubre destinatario, escape, privacidad,
confirmación del proveedor y ausencia de envíos fuera de producción. La suite
`fase-avisos-altas-db.mjs` comprueba el commit visible, la confirmación concurrente
y que un fallo de correo no perjudique el alta. La integración HTTP prueba el
registro completo, un solo aviso al dueño y solicitudes Pro deduplicadas.
