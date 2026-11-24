# Xabor Básico — preparación de lanzamiento
No listo para comercializar: faltan el primer débito y la renovación del proveedor, validar la entrega automática de eventos, decisiones comerciales y autorización productiva.

## Lo implementado y probado localmente
- Alta por correo verificado, creación transaccional de negocio, sucursal y administrador, siete días de prueba.
- Solo POS y menú. Los campos enviados de rol, negocio y módulos no conceden privilegios.
- Contraseñas con scrypt, token de un solo uso, recuperación y revocación de sesiones.
- Límites de registro por IP y correo en PostgreSQL y trampa de formulario; no dependen solo de la memoria de un proceso. Confirmar correo sigue siendo obligatorio.
- Evidencia de fecha y hash del aviso de privacidad aceptado.
- Panel simplificado en `/basico`, sin reconstruir los motores existentes de menú, pedidos ni reportes.
- Productos, categorías, precio, datos del negocio, venta sin exigir teléfono de cliente y doble clic controlado.
- Ticket digital en `/ticket-venta/:folio`, con aislamiento por sesión/negocio, escape HTML y opción de impresión/PDF desde navegador. No es factura fiscal. No se promete compatibilidad universal de impresoras.
- Aislamiento de dos negocios en API, catálogo, reportes, tickets y replay de WebSocket.
- Vencimiento bloquea operaciones en servidor y permite la gestión de suscripción; datos conservados.
- Cobro SaaS, renovaciones, cancelación, recontratación, devoluciones y contracargos probados con proveedores simulados y PostgreSQL real.
- Conciliación periódica optativa, alertas persistidas y gracia configurable (0 días por omisión).
- Un rechazo definitivo de creación de contrato conserva el intento y permite reintentar; un resultado incierto permanece reservado para evitar cobros duplicados.
- La gracia configurable cubre también la espera del primer débito de una suscripción autorizada. No acredita mensualidades y sigue deshabilitada por omisión.
- Las altas públicas necesitan contratar Impresión para usar `/api/impresion` y Repartidores para administrar la red o crear un pedido POS a domicilio. Se corrigieron rutas heredadas que solo exigían sesión o POS; los negocios anteriores conservan su acceso y un módulo contratado después permite utilizar esas funciones.

## Validación
65 pruebas locales pasan con Node 22 y PostgreSQL 18. Los proveedores externos son falsos y la red saliente está bloqueada.
El borrador incorpora producción `f802288`, incluidos segundo factor de superadmin, revocación persistida, límites de acceso, consentimiento y Rewards. Las pruebas del Básico usan segundo factor de prueba; no desactivan esa protección.
Las tareas de reporte global y enriquecimiento de todos los perfiles se reservan a superadmin. El simulador de IA, su interruptor y el reenvío a cocina exigen el módulo correspondiente para las altas públicas. La sesión global y el segundo factor se revalidan antes de cada evento, con cierre de conexiones revocadas; las variantes de un token no evaden el logout.
El actualizador de staging aplica solo las cuatro migraciones nuevas de producción, en una transacción y con huellas persistidas. Se probó rollback ante un fallo intermedio, repetición sin reaplicar y rechazo de un SQL distinto del registrado.
La ampliación de pruebas reprodujo cuatro respuestas 200 indebidas en impresión y repartidores para una cuenta Básico; tras corregirlas devuelven 403. Crear/emparejar equipos, probar impresión y crear un envío a domicilio también se bloquean antes de escribir. La misma prueba verifica el acceso de negocios anteriores y módulos contratados posteriormente.
El WebSocket del panel revalida sesión, membresía, rol y acceso comercial antes de cada envío. Las conexiones inactivas se revisan cada 30 segundos. Se comprobó el cierre de un socket abierto al vencer la prueba y que una sesión revocada por cambio de contraseña no reciba una venta posterior.
Revisión visual en escritorio de 1280 × 900 y móvil de 390 × 844: alta de productos, venta de 80 MXN, reporte con una venta y comprobante correcto.
CI del borrador ahora crea su propia base PostgreSQL y ejecuta el flujo HTTP/WebSocket.
Las seis suites existentes del agente, pedido canónico, conversión de formulario y selector pasan tras migrar a Zod 4. La conversión a JSON Schema usa la API pública de Zod.
La actualización de dependencias de ejecución elimina los 10 avisos del lockfile anterior: `npm audit --omit=dev --audit-level=moderate` informa 0 vulnerabilidades el 23 de noviembre de 2026. Esto no sustituye la auditoría del código.
La imagen Docker se construye con `npm ci` y comprueba el arranque de Chrome con Puppeteer actualizado.

## Evidencia externa de staging
- Cuenta sintética: ingreso, producto de 80 MXN y venta `XAB-0001` guardados desde el navegador; reporte con una venta y 80 MXN.
- Registro con correo real completado por el propietario: correo verificado, token consumido, privacidad registrada, una sucursal, una cuenta administradora y solo POS y menú. La prueba vence el 30 de noviembre de 2026.
- Nueva cuenta: reporte inicial vacío incluyendo las fechas de la cuenta técnica; producto de 35 MXN, venta de dos unidades por 70 MXN, reporte de una venta y ticket `XAB-0002`. El ticket `XAB-0001` de la otra cuenta devuelve «Ticket no encontrado».
- Recuperación real de contraseña por correo completada por el propietario. La base registra el enlace consumido y la revocación de sesiones. La sesión anterior devolvió `SESION_REVOCADA`; el propietario confirmó el ingreso posterior con su nueva contraseña en su navegador.
- Resend tiene una clave exclusiva de staging, limitada al envío desde `xabor.mx`, guardada únicamente como variable segura del servicio. No se copió la clave productiva.
- El token de Mercado Pago se verificó contra `/users/me`: vendedor de prueba esperado, país México.
- Checkout con vendedor y comprador de prueba mexicanos: contrato pendiente creado por el servicio de Xabor y autorizado desde el checkout alojado, usando una tarjeta de prueba oficial. MP mostró siete días gratis, 150 MXN mensuales, primer cobro el 30 de noviembre y cobros posteriores cada día 30.
- La API confirmó `authorized` para ese contrato. La autorización no produjo mensualidades en el ledger: Xabor conserva el estado `prueba`. El ensayo de MP se vinculó a la cuenta técnica sintética y utilizó su correo de comprador de prueba al crear el contrato; no modifica el correo de acceso del propietario.
- Webhooks configurado en modo de prueba. El simulador oficial de pagos devolvió 200 OK. El servidor rechazó firmas ausentes y falsas con 401. No llegó el aviso automático de autorización durante el ensayo: se verificó aparte una notificación firmada simulada del contrato real de prueba, que consultó la API y actualizó el estado local a `authorized` sin acreditar mensualidades.
- Conciliación consultada contra MP: la API rechazó la página de 20 facturas con HTTP 400 y aceptó páginas de 12. Antes del despliegue se ejecutó el código corregido en un proceso aislado de staging: consultó el contrato de prueba sin errores, resolvió la alerta y mantuvo cero mensualidades.
- Actualización posterior aplicada por el propietario: `a824719`, despliegue `902efa19-0e94-4218-bafd-51d9fbe35c0d`. Dos ejecuciones automáticas observadas, separadas por quince minutos: un contrato, cero errores y cero acreditaciones en cada una.
- Comprobación HTTP del código desplegado con la cuenta sintética: menú, configuración y facturación responden 200; usuarios adicionales, Restaurante, Personal, impresión y administración de repartidores responden 403; crear un envío POS a domicilio responde 403. El ticket de la otra cuenta responde 404. Se conservan dos cuentas verificadas, dos ventas y cero mensualidades.
- Hubo dos rechazos HTTP 400 previos por correos que no correspondían al comprador mexicano; no crearon contratos remotos. Las reservas locales fallidas de la cuenta técnica se conservaron como canceladas.
- Diferencia de horario observada en ese ensayo: fin de prueba de Xabor `2026-11-30T05:26:15Z`, `next_payment_date` de MP `2026-11-30T15:14:56Z`. La fecha solicitada a MP no garantiza la hora de ejecución. Revisar y aprobar la gracia comercial para cubrir esa espera; el valor configurado sigue siendo 0.
- Diagnóstico de producción solo de lectura: 12 prospectos, 7 con estado `nuevo`, 4 `contactado` y 1 `descartado`; ninguno tiene correo registrado. Los contactos se entregan por archivo privado, fuera del repositorio. El estado no demuestra si hubo conversaciones por otros canales. No se enviaron campañas ni se alteraron registros.

## Preparado sin validación integral
- Staging independiente en Railway con servicios y secretos nuevos, fuentes del borrador y volumen separado.
- Desplegado `a824719`, despliegue `902efa19-0e94-4218-bafd-51d9fbe35c0d`: aplicación y PostgreSQL en línea; `/health` responde 200 y listo. Reintentos, gracia inicial, bloqueo de impresión/reparto y paginación corregida están desplegados. El esquema del Básico se aplicó con su numeración anterior. Las correcciones posteriores de permisos, sesiones y compatibilidad con producción requieren otra actualización de staging.
- Registro, correo y suscripciones habilitados solo en staging para el ensayo autorizado. Conciliación automática activada y primera ejecución comprobada, sin acreditaciones. La gracia permanece en 0 días. Producción no fue modificada.
- Inicializador que solo admite una base vacía con nombre/host/entorno de staging verificados.
- Aplicación exclusiva Mercado Pago **Xabor Suscripciones SaaS**, creada con consentimiento del propietario.
- Migraciones del Básico renumeradas a 150–154: producción ya utiliza 144–146 y 149. El cambio de nombres no borra ni recrea los datos del Básico que ya existen en staging.
- Diagnóstico productivo de solo lectura: `f802288` desplegado, segundo factor y sesiones persistidas presentes. Las tablas y credenciales SaaS siguen ausentes y sus dos banderas están apagadas. El ensayo con dinero real necesita completar y autorizar esa preparación; el ensayo de prueba no la sustituye.

## Sigue pendiente
- Observar el primer débito programado y una renovación del proveedor. Autorización y fecha programada no demuestran ejecución ni acreditación.
- Validar la entrega automática de eventos; el simulador y la notificación firmada reproducida no la sustituyen. Observar más ciclos de la conciliación automática y su recuperación de un pago real de prueba cuando exista.
- Cambio de tarjeta, política definitiva de reembolsos parciales y alertas externas.
- Auditoría ampliada de rutas heredadas, terminales y conexiones ya abiertas; las pruebas incluidas no prueban todos los endpoints del producto.
- Precio final con impuestos, condiciones comerciales, piloto y aprobación de producción.

## Lanzamiento
1. Completar las validaciones anteriores y documentar resultados, incluidos fallos y repeticiones.
2. Revisar compatibilidad de migraciones 150–154 y respaldo/recuperación.
3. Revisar diff, CI, alertas y consentimiento comercial.
4. Solicitar autorización expresa para el despliegue y migraciones de producción.
5. Lanzar un piloto controlado, comprobar ventas, facturación y negocios anteriores.
6. Abrir autoservicio y cobro únicamente con evidencias completas.

Detalles de suscripciones y variables: [xabor-basico-mercadopago.md](xabor-basico-mercadopago.md).
