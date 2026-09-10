# Compras por WhatsApp

Un administrador autoriza un número mexicano y lo vincula a un responsable en
Compras → Compras por WhatsApp. La autorización pertenece exclusivamente al
negocio receptor; números no autorizados siguen el agente de pedidos habitual.

El comprador envía una imagen JPG/PNG/WEBP al número del negocio. Recibe un
borrador con proveedor, fecha, total y hasta 12 conceptos. El ticket completo y
sus advertencias están disponibles en el panel. Para registrar, copia una de las
opciones del resumen: `CONFIRMAR código-v1 FONDO`, `CONFIRMAR código-v1 CREDITO`,
o `CONFIRMAR código-v1 CUENTA nombre`. `CANCELAR código-v1` cancela el borrador.
El código real y su versión llegan en cada resumen. `COMPRAS` muestra ayuda.

## Consistencia

- Confirmar y registrar el pago inicial es una sola transacción financiera.
- Un crédito no descuenta del fondo; otra cuenta tampoco. Fondo insuficiente
  revierte la confirmación completa. No se inventan entregas de dinero.
- Cada código pertenece al remitente y al negocio. Editar en el panel cambia
  la versión: una confirmación vieja devuelve un resumen actualizado.
- El wamid recupera el mismo borrador tras reentregas/reinicios. Se detectan
  duplicados por imagen y, cuando hay folio legible, proveedor/fecha/total/folio.
  No se garantiza detectar fotos distintas de un ticket sin folio.
- Archivo privado, recodificado sin EXIF. La IA solo prepara datos; no confirma.
- Compras no procesa ecos ni importaciones históricas de la Business App.
- Los mensajes salientes guardan el wamid devuelto por Meta para evitar que
  el eco active una intervención humana ficticia.

## Operación y límites

Enviar una foto por vez y esperar el resumen. Si ya hay otra en proceso, el bot
pide reenviarla; no hay una cola durable de imágenes pendientes. Límite de 30
entradas guardadas por hora por negocio. Si la respuesta de Meta falla, reenviar
foto o confirmación recupera el estado; no hay reintento automático de salientes.
La confirmación no sustituye revisar errores de OCR. Fotos como documento PDF
o HEIC no entran en este flujo. Cambiar o desactivar la autorización es exclusivo
del administrador. La migración 071 no autoriza números ni carga fondos.

## Validación

`fase-compras-whatsapp.mjs`: PostgreSQL local, imagen real, IA simulada,
aislamiento, pagos, deuda, códigos versionados, duplicados y cancelación.
`fase-compras-whatsapp-webhook.mjs`: servidor real, webhook firmado y Meta local
simulado; foto recuperada, confirmación a crédito y wamid de respuesta.
`fase-compras-integracion.mjs`: incluye autorización/revocación con roles y
configuración desde navegador móvil. También ejecutar suites de firma Meta,
respuesta a imágenes, servidor de Compras, contrato IA, tickets y cámara.
