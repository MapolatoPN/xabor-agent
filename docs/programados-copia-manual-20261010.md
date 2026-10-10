# Consulta e impresión manual de reservas programadas

El panel mostraba las reservas sin un estado de pago ni un botón de impresión. Esto hacía parecer confirmado un pedido cuya fecha se había guardado antes de cobrar. La tarjeta ahora distingue Pendiente de pago, Pagado, Pago al recibir, Cancelado y Pago por verificar. Las reservas pendientes explican que se confirman al recibir el pago y todavía no pasan a cocina.

Imprimir copia abre una ventana con fecha y hora del negocio, cliente, teléfono, dirección, referencias, platillos, opciones, notas, importes y estado del pago. Una copia pendiente indica que no autoriza preparación ni entrega. El botón vuelve a consultar la lista antes de abrir el diálogo de impresión; valida el mismo negocio, folio e identidad de reserva. Si ya fue activada, desapareció o cambió de identidad, no imprime datos anteriores. Se conservan las notas libres junto con los modificadores.

La consulta usa el endpoint autenticado existente, con módulo POS y filtro obligatorio por negocio. La respuesta tiene una lista blanca de campos y no incluye enlaces ni tokens de checkout, seguimiento o pagos. Solo se hace GET, sin crear trabajos de cocina, registrar ventas o cambiar el estado de pago/activación. La impresión usa el diálogo del navegador y requiere permitir ventanas emergentes; la impresora física no se probó.

La fecha durable ISO del pedido tiene prioridad. Para reservas anteriores sin esa fecha, la consulta SQL interpreta el timestamp almacenado como UTC, evitando que la zona horaria del proceso desplace la hora. La visualización usa la zona configurada del negocio.

## Validación

Base aislada: `91fe56db32e4763fbc9ce029bcdc8cd6e1f89489`, despliegue activo al comenzar. Node 22.23.3, PostgreSQL desechable `test_botones_programados_20261010`, red externa bloqueada y transporte de impresión simulado.

- `fase-programados-consulta.mjs`: 8 casos pasados; estados de pago, fecha durable y fecha SQL en un proceso con otra zona, campos privados, texto malicioso, nota libre, datos frescos, doble clic, reserva activada, identidad distinta, ventanas bloqueadas, sesión, módulo POS y dos negocios separados. Los GET conservaron las reservas y no generaron trabajos de impresión.
- `fase-programados-panel.mjs`: navegador real correcto, tres estados visibles y copia manual con el pago actualizado; sin desbordes. Capturas revisadas visualmente.
- `fase-gate-programados-db.mjs`: 13 casos pasados.
- `fase-tienda-banner.mjs`, parte pura: 16 casos pasados.
- `predeploy-check-incidentes.mjs`: correcto, incluidas tienda, plomería y modo formulario.
- Gate de producción de solo lectura: 12 comprobaciones por negocio, cero fallos.
- Sintaxis y `git diff --check`: correctos.

## Pedido consultado

Nury Hernández, `XAB-1458`, Acuña: inicialmente reserva pendiente de pago por $450, con enlace Clip y `paid_at` vacío. La tienda guarda la fecha solicitada antes de crear el enlace; el pedido no se confirma ni se activa para cocina sin el pago. Durante la revisión, el enlace venció y la reserva pasó a cancelada mediante el proceso existente. No se alteró ese pedido ni su pago desde esta tarea.

## Alcance y riesgo

La solicitud del propietario autorizó el ajuste del panel. En `panel/index.html`, componente protegido, se incorpora el módulo con huella de contenido y se delega solamente el render de programados. El endpoint de consulta añade los campos permitidos; las rutas protegidas de pedidos y la lógica de creación, pago, activación y cocina permanecen sin cambios. El riesgo principal es confundir una copia con una comanda o imprimir una reserva antigua; las etiquetas y la consulta fresca con identidad lo previenen.
