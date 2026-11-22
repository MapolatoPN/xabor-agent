# Xabor Básico — contrato de lanzamiento ($150 MXN/mes)

Estado: **preparación; NO IMPLEMENTADO NI APROBADO PARA PRODUCCIÓN**.
Base exacta: `prod/mesero-shadow-v3` @ `41ce618af3d3a70f51633547abbf329332ce0018` (21-nov-2026).
No modificar despliegue, clientes, cobros ni base productiva durante el desarrollo.

## Producto y alcance
Negocios de alimentos (fondas, puestos, cafeterías, reposterías y restaurantes pequeños).
Un negocio, una sucursal, un administrador. Menú/categorías/productos/precios; ventas y medios de pago registrados; ticket comercial digital o impreso en dispositivo compatible; historial y reportes día/semana/mes. Ticket **no es CFDI**.
Excluir del plan base: WhatsApp IA, mesas/cuentas abiertas, comandas automáticas, inventario avanzado, tienda online, repartidores, facturación, usuarios y sucursales adicionales. Definir compatibilidad de impresión antes de anunciarla.

## Bloqueadores P0 antes de publicidad
- [ ] Registro público seguro, creación de tenant + usuario administrador + módulos mínimos, **transacción atómica**, idempotencia y protección contra spam. Ninguna aprobación de Superadmin.
- [ ] Email único verificado, contraseñas seguras, recuperación y política de intentos; no filtrar existencia de cuentas.
- [ ] Primer inicio guiado: alta de 5 productos, venta de prueba y ticket digital.
- [ ] Derechos del plan aplicados **en backend**, no solo ocultando menús. Bloquear endpoints y WebSocket de módulos no contratados. Mantener dependencias de módulos.
- [ ] Definir pasarela para **suscripción SaaS** distinta de Clip para **cobros de pedidos**. Crear alta de suscripción, pago inicial, renovación, webhook firmado, reintentos idempotentes, periodo de gracia, cancelación y reactivación. No almacenar tarjetas.
- [ ] Estado de prueba y vencimiento validados en servidor; los webhooks duplicados o fuera de orden no deben activar ni suspender incorrectamente.
- [ ] Seguridad multiempresa: dos negocios de prueba no comparten productos, ventas, tickets, reportes, usuarios, sesiones, credenciales ni impresoras.
- [ ] Ticket físico probado en Windows e impresora real compatible; fallback digital. El test de spooler simulado NO acredita hardware.
- [ ] Reportes conciliados contra ventas, cancelaciones, devoluciones y medios de pago. Fechas según zona horaria de negocio.
- [ ] Alta de negocios existentes pendientes: identificar registros, estado y canal de contacto; migrar **sin duplicar** ni enviar mensajes automáticos sin consentimiento.

## Pruebas de aceptación mínimas
1. Usuario nuevo se registra y recibe su negocio sin intervención humana.
2. Configura 5 productos y hace una venta; el reporte del día coincide con la venta.
3. Genera ticket digital; imprime con un dispositivo compatible documentado.
4. Cuenta A no puede consultar ni modificar datos de B usando ID ajeno.
5. Básico no puede activar funciones premium manipulando peticiones.
6. Un mismo webhook de cobro recibido 3 veces genera **una** renovación.
7. Suscripción vencida conserva datos y aplica la política de acceso definida; al pagar, recupera acceso.
8. Cuenta nueva puede operar desde celular; errores se explican sin exponer detalles internos.
9. Fallo parcial de registro no deja negocio huérfano ni usuario sin negocio.
10. Un piloto de 10 negocios completa registro, primera venta y ticket sin soporte individual.

## Orden de implementación recomendado
1. Pruebas de aislamiento + mapa de módulos y endpoints.
2. Backend y UI de registro público con protección e idempotencia.
3. Interfaz Básico y primer uso.
4. Proveedor de suscripciones + webhook y máquina de estados.
5. Impresión y conciliación.
6. Piloto controlado y correcciones.
7. Publicidad estatal.

## Criterios de lanzamiento
No publicar «registro inmediato», «$150/mes», «imprime tickets» o «sin instalación» hasta comprobar el flujo completo en entorno de staging, hardware aplicable y suscripción real de prueba. Publicidad solo después del piloto.

## Evidencia inicial
- Railway: rama de producción `prod/mesero-shadow-v3`, commit arriba, despliegue SUCCESS.
- `migrations/022_plan_comercial_negocio.sql`: seguimiento manual comercial; explícitamente no integra pasarela.
- Railway: variables relacionadas con cobros muestran `CLIP_API_KEY`/`CLIP_API_SECRET`, sin variable identificable de proveedor de suscripciones. **No demuestra ausencia absoluta de integración**.
- `src/services/modulosDependencias.js`: dependencias y grupos de módulos ya implementados.
- `docs/whatsapp-self-service.md`: autoservicio **de conexión WhatsApp**, no registro público de un nuevo negocio.
- `test/fase-cambio-sucursal.mjs`: exige base de pruebas y prohíbe Railway. **No se ejecutó**.

Este documento es el contrato de trabajo para implementación. No representa un arreglo funcional.
