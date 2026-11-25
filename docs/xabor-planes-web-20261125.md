# Oferta web: Básico150 y Pro900

La página pública de Xabor presenta dos planes mensuales en MXN:

- Básico150: productos, categorías, ventas de mostrador, mesas y cuentas,
  historial, reportes y tickets digitales. Siete días de prueba, registro sin
  tarjeta y suscripción posterior en Mercado Pago.
- Pro900: Básico más página del negocio con catálogo y pedidos, respuestas y
  formularios de WhatsApp, cotizaciones y los módulos del listado público.
  Instalación, configuración y puesta en marcha incluidas.
- Voz y el asistente de IA quedan fuera de la oferta pública. Se conserva el
  código y los permisos de los clientes anteriores.

Las tarifas de Meta por mensajería no están incluidas. El aviso aparece antes
del CTA de Pro, en su tarjeta, comparativa, FAQ y formulario. Las tarifas de
otros proveedores y el equipo físico también se pagan aparte. No se promete
mensajería gratuita ilimitada. Fuente de precios de Meta:
https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing

## Contratación

Básico conserva `/registro-basico` y su circuito existente de suscripción.
Pro utiliza el formulario de instalación acompañada y el endpoint existente
`/api/public/prospectos`. Se guarda la solicitud con precio, instalación y
aviso de Meta. El envío del formulario no cobra ni activa una suscripción
automática de900. No se modifican los precios de clientes existentes.

## Mesas en Básico

Las altas nuevas reciben `pos`, `menu` y `restaurante`. El panel habitual
habilita Mesas sin mostrar funciones premium. La estación por PIN también
comprueba el estado comercial para no eludir un vencimiento.

La migración161 incorpora `restaurante` a las altas públicas verificadas con
plan comercial `basico` y mensualidad150. Solo agrega permisos ausentes o
no configurados; conserva estados suspendidos, pendientes y configurados.
No modifica negocios, usuarios, precios, ventas ni consentimientos.

El predeploy la ejecuta con autorización `XABOR_MIGRAR_BASICO=SI`; el modo
`--comprobar` informa pendientes sin escribir. La actualización es atómica
e idempotente. No requiere variables nuevas si ya existe esa autorización.

El consumo y las cuentas se guardan aunque no haya impresión contratada.
Sin ese módulo, Básico no crea trabajos Edge ni envía impresión automática
al cerrar; las precuentas mantienen su representación en navegador. Los
negocios anteriores conservan la integración de impresión existente.

## Evidencia local

PostgreSQL18 y Node22 locales, con proveedores simulados y red externa
bloqueada: ciclo de mesa completo, precios del servidor, aislamiento entre
negocios, reportes, vencimiento de admin y estación, conservación de ventas,
actualización autorizada y rollback de161, predeploy sobre esquema anterior.

La oferta y su formulario pasan20 comprobaciones HTTP. Se revisaron móvil
390px y escritorio1366px: sin desbordamiento, menú móvil, pestañas con teclado,
aviso de Meta legible, formulario y privacidad. El formulario de la vista
previa usa una captura local; la prueba HTTP verifica la persistencia real
en PostgreSQL local. No se enviaron correos ni se realizaron cobros reales.

## Publicación pendiente

La propuesta parte de5436186, en una rama independiente de la fuente viva
de Railway. No se debe mover la fuente de producción hasta la autorización
expresa del titular. El primer cobro real, su webhook y su renovación siguen
sin una prueba productiva completa; estas pruebas locales no los acreditan.
