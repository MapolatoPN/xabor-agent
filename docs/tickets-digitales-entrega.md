# Entrega de tickets digitales

Disponible para las cuentas con Punto de venta, tanto Básico como Pro:

1. En el pedido, abre **Más → Compartir ticket**; también está en **Historial → Ver y compartir ticket**. Básico conserva su entrada **Imprimir ticket**.
2. **Enviar por correo:** escribe el destinatario y envía. Xabor manda un correo transaccional mediante el Resend ya configurado, con el enlace al comprobante. La confirmación indica aceptación por el proveedor; no confirma recepción, lectura ni ausencia de spam.
3. **Compartir por WhatsApp:** abre WhatsApp con el texto y el enlace. El operador elige el contacto y pulsa enviar. No usa la API de Meta, el bot ni las automatizaciones del Pro.
4. El cliente abre el comprobante sin cuenta y puede imprimir o guardar PDF. Se comparte un enlace, no un PDF adjunto. No es un CFDI.

El enlace vence en 30 días. Es un permiso de lectura para ese negocio y folio; quien lo reciba puede reenviarlo. No permite navegar a otras ventas ni al panel. No expone teléfono, dirección, datos del comprador o controles de envío. Archivar la venta conserva el comprobante; eliminarla retira su acceso. Al cancelar una venta, el comprobante muestra CANCELADO. El acceso público no depende de que el negocio conserve su suscripción después de compartirlo.

## Operación

No requiere migraciones, dependencias ni variables nuevas. Usa `SESSION_SECRET`, `PUBLIC_URL` y `RESEND_API_KEY` existentes. La clave de sesión debe tener al menos 24 caracteres. Rotarla invalida los enlaces anteriores. `PUBLIC_URL` debe ser HTTPS y del dominio público de Xabor; no se confía en Host ni en URLs proporcionadas por el cliente. Fuera de producción o sin Resend el envío se cierra y la pantalla ofrece WhatsApp.

Los topes de correo persisten en `limites_acceso` y son compartidos por las réplicas: 30 intentos/hora por usuario, 300/día por negocio y 3/15 minutos por ticket y destinatario. Se guardan huellas, sin el correo ni el enlace. Los intentos fallidos también consumen límite. El destinatario sí se transmite a Resend al solicitar el envío.

Los reintentos de la misma solicitud conservan contenido y `Idempotency-Key`. [Resend conserva estas claves durante 24 horas](https://resend.com/docs/dashboard/emails/idempotency-keys). Una nueva solicitud explícita, recargar el ticket o repetir después de esa ventana puede mandar un nuevo correo.

## Verificación

`node --test test/fase-tickets-entrega.mjs` valida firma, vencimiento, privacidad, contenido y reintentos de interfaz. `test/fase-tickets-entrega-db.mjs` exige una base local desechable y el preload `test/red-solo-local.mjs`: levanta la aplicación real con PostgreSQL y un Resend local. Cubre permisos y revocación, origen y tamaño de petición, separación de negocios, enlaces públicos, respuesta perdida, rechazo del proveedor, idempotencia y límites concurrentes. CI ejecuta ambos conjuntos y conserva las regresiones de Básico y cancelaciones.

Antes de publicar: conservar el commit que realmente esté en producción, revisar la diferencia y obtener aprobación del dueño. Después: comprobar salud y huellas de archivos. Una prueba de entrega en una bandeja real requiere un destinatario autorizado; las pruebas automatizadas no envían a clientes reales.
