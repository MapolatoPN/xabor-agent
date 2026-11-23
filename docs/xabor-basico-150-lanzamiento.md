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
52 pruebas locales pasan con Node 22 y PostgreSQL 18. Los proveedores externos son falsos y la red saliente está bloqueada.
El WebSocket del panel revalida sesión, membresía, rol y acceso comercial antes de cada envío. Las conexiones inactivas se revisan cada 30 segundos. Se comprobó el cierre de un socket abierto al vencer la prueba y que una sesión revocada por cambio de contraseña no reciba una venta posterior.
Revisión visual en escritorio de 1280 × 900 y móvil de 390 × 844: alta de productos, venta de 80 MXN, reporte con una venta y comprobante correcto.
CI del borrador ahora crea su propia base PostgreSQL y ejecuta el flujo HTTP/WebSocket.
Las seis suites existentes del agente, pedido canónico, conversión de formulario y selector pasan tras migrar a Zod 4. La conversión a JSON Schema usa la API pública de Zod.
La actualización de dependencias de ejecución elimina los 10 avisos del lockfile anterior: `npm audit --omit=dev --audit-level=moderate` informa 0 vulnerabilidades el 23 de noviembre de 2026. Esto no sustituye la auditoría del código.
La imagen Docker se construye con `npm ci` y comprueba el arranque de Chrome con Puppeteer actualizado.

## Evidencia externa de staging
- Cuenta sintética: ingreso, producto de 80 MXN y venta `XAB-0001` guardados desde el navegador; reporte con una venta y 80 MXN.
- El token de Mercado Pago se verificó contra `/users/me`: vendedor de prueba esperado, país México.
- El primer checkout con correo ficticio fue rechazado por MP (HTTP 400: comprador y vendedor deben ser ambos reales o de prueba); no creó un contrato remoto. Falta repetir con el comprador de prueba.
- El correo de ejemplo de la documentación fue rechazado por corresponder a otro país (HTTP 400). El comprador mexicano creado en el panel tiene ID `3865492517`; su correo no aparece en el panel ni en la consulta pública de usuarios. Se debe obtener desde su sesión para completar la prueba. Ninguno de estos rechazos creó un contrato remoto.
- Diagnóstico de producción solo de lectura: 12 prospectos, 7 con estado `nuevo`, 4 `contactado` y 1 `descartado`; ninguno tiene correo registrado. Los contactos se entregan por archivo privado, fuera del repositorio. El estado no demuestra si hubo conversaciones por otros canales. No se enviaron campañas ni se alteraron registros.

## Preparado sin validación integral
- Staging independiente en Railway con servicios y secretos nuevos, fuentes del borrador y volumen separado.
- Despliegue `0ac1197` aplicado por el propietario: aplicación y PostgreSQL en línea, sin cambios pendientes; `/health` responde 200. Las migraciones 144–148 se aplicaron en la base nueva.
- Inicializador que solo admite una base vacía con nombre/host/entorno de staging verificados.
- Aplicación exclusiva Mercado Pago **Xabor Suscripciones SaaS**, creada con consentimiento del propietario.
- Migraciones del Básico renumeradas a 144–148 para respetar la 143 que ya usa producción.

## Sigue pendiente
- Firmar webhooks y completar checkout/autorización con el comprador de prueba.
- Observar cobros y renovación reales del proveedor, especialmente el primer débito tras la prueba.
- Entrega real de correo, confirmación y recuperación en staging.
- Cambio de tarjeta, política definitiva de reembolsos parciales y alertas externas.
- Auditoría ampliada de rutas heredadas, terminales y conexiones ya abiertas; las pruebas incluidas no prueban todos los endpoints del producto.
- Precio final con impuestos, condiciones comerciales, piloto y aprobación de producción.

## Lanzamiento
1. Completar las validaciones anteriores y documentar resultados, incluidos fallos y repeticiones.
2. Revisar compatibilidad de migraciones 144–148 y respaldo/recuperación.
3. Revisar diff, CI, alertas y consentimiento comercial.
4. Solicitar autorización expresa para el despliegue y migraciones de producción.
5. Lanzar un piloto controlado, comprobar ventas, facturación y negocios anteriores.
6. Abrir autoservicio y cobro únicamente con evidencias completas.

Detalles de suscripciones y variables: [xabor-basico-mercadopago.md](xabor-basico-mercadopago.md).
