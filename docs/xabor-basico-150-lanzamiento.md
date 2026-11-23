# Xabor Básico — preparación de lanzamiento
No listo para comercializar: faltan validaciones externas de Mercado Pago y correo, decisiones comerciales y autorización productiva.

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

## Validación
50 pruebas locales pasan con Node 22 y PostgreSQL 18. Los proveedores externos son falsos y la red saliente está bloqueada.
Revisión visual en escritorio de 1280 × 900 y móvil de 390 × 844: alta de productos, venta de 80 MXN, reporte con una venta y comprobante correcto.
CI del borrador ahora crea su propia base PostgreSQL y ejecuta el flujo HTTP/WebSocket.

## Preparado sin validación integral
- Staging independiente en Railway con servicios y secretos nuevos, fuentes del borrador y volumen separado.
- Inicializador que solo admite una base vacía con nombre/host/entorno de staging verificados.
- Aplicación exclusiva Mercado Pago **Xabor Suscripciones SaaS**, creada con consentimiento del propietario.
- Migraciones del Básico renumeradas a 144–148 para respetar la 143 que ya usa producción.

## Sigue pendiente
- Aplicar y comprobar el despliegue de staging.
- Verificar la cuenta/token de MP, firmar webhooks y ejecutar checkout/autorización con comprador y vendedor de prueba.
- Observar cobros y renovación reales del proveedor, especialmente el primer débito tras la prueba.
- Entrega real de correo, confirmación y recuperación en staging.
- Cambio de tarjeta, política definitiva de reembolsos parciales y alertas externas.
- Auditoría ampliada de rutas heredadas, terminales y conexiones ya abiertas; las pruebas incluidas no prueban todos los endpoints del producto.
- Diagnóstico de prospectos reales únicamente con consultas de lectura; no enviar campañas ni alterar registros.
- Precio final con impuestos, condiciones comerciales, piloto y aprobación de producción.

## Lanzamiento
1. Completar las validaciones anteriores y documentar resultados, incluidos fallos y repeticiones.
2. Revisar compatibilidad de migraciones 144–148 y respaldo/recuperación.
3. Revisar diff, CI, alertas y consentimiento comercial.
4. Solicitar autorización expresa para el despliegue y migraciones de producción.
5. Lanzar un piloto controlado, comprobar ventas, facturación y negocios anteriores.
6. Abrir autoservicio y cobro únicamente con evidencias completas.

Detalles de suscripciones y variables: [xabor-basico-mercadopago.md](xabor-basico-mercadopago.md).
