# Alta autónoma de Xabor

El mismo registro crea negocios Básico o Pro. `/registro?plan=basico` y
`/registro?plan=pro` comparten `/api/publico/registro-basico/*`; se conservan
las direcciones anteriores y los enlaces de verificación ya emitidos.

El servidor fija la oferta al solicitar el correo: Básico, 150 MXN con siete
días de prueba; Pro, 900 MXN sin prueba, instalación incluida. Verificar el
correo crea el negocio y al administrador, pero no autoriza ningún cobro.
La cuenta inicia sesión y continúa en `/empezar`.

Pro requiere `XABOR_ALTA_PUBLICA_PRO=true`. Básico conserva su bandera y
política de invitaciones. Cerrar el registro no cancela los contratos existentes.
El CTA de Pro de la web abre el registro cuando su bandera está activa;
conserva la solicitud acompañada cuando está cerrada o no responde el servicio.
El formulario acompañado sigue disponible para quien necesita ayuda y para
clientes existentes que quieran cambiar de plan. No se crean cuentas duplicadas
ni se convierten contratos Básico en Pro automáticamente.

## Contratación y acceso

Se reutilizan la aplicación, webhook, conciliación y cancelación SaaS de
Mercado Pago. La referencia nueva es `xabor-pro:<uuid>`; las anteriores
`xabor-basico:<uuid>` se conservan. La mensualidad del contrato guardado es
la autoridad al comprobar las facturas y pagos, también para reembolsos,
renovaciones y cancelaciones. Nunca se toma el precio ni el negocio del body.

El cliente revisa la renovación y autoriza el checkout personalmente. Un
contrato autorizado no acredita una mensualidad: Pro obtiene acceso después
de un pago aprobado y verificado. La cancelación conserva lo ya pagado.
Sin acceso comercial, solo están disponibles la gestión de la suscripción y
la lectura de la guía, ambas para el administrador autenticado. Las ventas,
el menú, WebSocket, tienda pública y canales siguen sujetos a la vigencia.

Documentación del flujo de pago pendiente:
https://www.mercadopago.com.mx/developers/es/docs/subscriptions/integration-configuration/subscription-no-associated-plan/pending-payments

## Configuración guiada

La guía lee los datos reales del negocio de la sesión. No permite declarar
pagados los contratos ni marcar conectada una integración. Enlaza a las
pantallas habituales de Configuración, Menú, Mesas, Tienda y entrenamiento.
Los pasos opcionales se muestran aparte para que la instalación de una
impresora no impida empezar en mostrador. La asignación de impresoras no
acredita la salida física del papel: la guía pide revisarla en el negocio.

Pro incluye los módulos de la oferta vigente. Voz y el asistente de IA no se
habilitan. Repartidores queda contratado pero pendiente de configuración:
no se abre su portal público ni se implementa la futura red regional. La
automatización de WhatsApp nace apagada, y conectar Meta exige sus cuentas
y su autorización. Las tarifas de mensajería de Meta, el equipo y las tarifas
de otros proveedores no se incluyen en los 900 MXN.

El aviso de alta verificada al correo comercial configurado incluye el plan
y distingue una prueba Básico de un Pro pendiente de pago. Es un aviso
secundario: un fallo del correo al dueño no elimina el negocio ni revierte
el registro; la lista de Superadmin conserva la nueva alta.

## Migración y publicación

La migración 163 añade tres columnas a las solicitudes y amplía la regla de
referencias de suscripción. Las filas anteriores quedan como Básico con
siete días; no se cambia su precio, sus módulos, sus datos ni sus contratos.
El predeploy requiere `XABOR_MIGRAR_BASICO=SI` si faltan esas columnas,
rechaza una preparación parcial y comprueba la referencia Pro antes de arrancar.
No se debe abrir Pro sin publicar el binario compatible y aplicar la migración.

La publicación productiva y la apertura de Pro requieren la aprobación
expresa de su propietario. Las pruebas locales usan cuentas sintéticas,
proveedores en localhost y bloqueo de red externa; no acreditan un cobro real.
