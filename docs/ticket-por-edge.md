# El ticket del cliente, uno solo, por Xabor Edge

Rama `feat/ticket-por-edge`, sobre lo que está en producción (0dee5ca).

## Por qué

El 21-oct-2026, al instalar el Edge 1.2.0 en Acuña:
- la prueba de impresora ya salía con el diseño nuevo;
- el ticket del cliente seguía saliendo con el diseño de antes.

Ese ticket lo imprimía el navegador del panel (`ticketHTML`), lo mismo al
cobrar, con ✏️ Pago y con 🧾. Lo que diseña el dueño en «Diseño de ticket y
comanda» solo le llegaba a lo que imprime el Edge.

Mario: «no podemos tener un ticket automático de una forma y un ticket
manual de otra, deben ser el mismo».

## Cómo queda

Los tres caminos del ticket pasan por `imprimirTicketCliente()` de
`index.html`: al cobrar, al corregir la forma de pago con ✏️ Pago y el botón
🧾. Desde ahí:

- **Si el negocio imprime el ticket por el Edge**, el ticket sale por la
  impresora de Caja con el diseño del negocio. Tiene que cumplir dos cosas:
  - tener una impresora con «Caja / Ticket» marcada (ruta «cuenta»);
  - que el equipo de esa impresora esté conectado ahora con Xabor Edge 1.2
    o más.
- **Si no**, el navegador lo imprime como siempre, en el mismo clic.

**El panel lo pregunta cada minuto** (`GET /api/impresion/ticket-por-edge`).
No lo pregunta al momento de imprimir porque un negocio sin Edge tiene que
abrir la ventana en el mismo clic: si esperara a la red, el navegador podría
bloquearla. Cuando el negocio sí imprime por el Edge, el panel pide el ticket
con `POST /api/pedidos/:folio/ticket`. Si justo en ese momento ya no se puede
(el equipo se apagó, no hay red), sale con el navegador. **Un ticket nunca se
queda sin salir.**

**Por qué Edge 1.2 o más:** un Edge 1.1.0 imprimiría el trabajo con su
ticket viejo de cuentas, sin número de orden, cliente ni forma de pago, peor
que el del navegador. Igual se le mandan los campos de siempre, por si acaso.

**Un toque, un ticket:** el panel manda un identificador por toque
(`intento`). Si la red reintenta, no salen dos; un segundo toque sí saca
otro.

## El papel

`src/printing/formato/ticketPedido.js`: lleva lo mismo que el del navegador.
- Encabezado: nombre del negocio, «TICKET DE CLIENTE · canal», dirección,
  RFC y teléfono.
- **ORDEN #2093** en letra grande, hora de entrada y de impresión, y la
  modalidad resaltada («EN TIENDA · PRESENCIAL», «RECOGER EN TIENDA» o
  «ENTREGA A DOMICILIO»).
- Cliente y forma de pago.
- Platillos con su importe. El nombre largo se envuelve, no se recorta. Debajo
  van las opciones y la nota sin repetirlas.
- Costo de envío, descuento con su motivo y artículos.
- **GRAN TOTAL** y el monto en letra, ahora con los centavos de verdad (el del
  navegador siempre decía «00/100»).
- Billete y cambio, o el desglose del pago mixto.
- Datos de entrega a domicilio: nombre, dirección, referencias y teléfono.
- QR de autofactura, si el negocio lo tiene activado y el pedido está cobrado.
- Pie («Gracias por su visita») y WhatsApp.

Respeta las opciones del ticket en «Diseño de ticket y comanda»:
- nombre, dirección, RFC, teléfono y WhatsApp;
- desglose de opciones;
- total en letra grande;
- texto del pie.

**La vista previa** de «Ticket del cliente» en esa pantalla ahora muestra
este mismo ticket con un pedido de ejemplo. Antes mostraba una cuenta de
Mesas. Las cuentas de Mesas no cambian.

Los datos salen de `pedidos_activos`, lo que quedó al cobrar, billete y mixto
incluidos. Nunca salen del navegador.

## Panel

`index.html` es componente protegido y cambia lo mínimo:
- carga `panel/ticketPedido.js` con `?v=<huella>`;
- en `imprimirTicketCliente`, si `XaborTicket.porEdge`, el ticket va por el
  módulo con el navegador de respaldo. Si no, la línea de siempre.

El riesgo está acotado: un negocio sin Caja en el Edge, o con el Edge viejo
o apagado, imprime exactamente como antes. Lo comprueba
`fase-ticket-al-cobrar` 25/25 sin cambios.

## Pruebas

`node test/fase-ticket-por-edge.mjs`: 21 de 21.
- **A (1–11), sin base:**
  - monto en letra;
  - los mismos datos que calculaba el navegador;
  - todo lo del papel;
  - cabe en 32, 42 y 48 sin perder palabras;
  - las opciones;
  - entrega, billete, mixto y QR;
  - Mesas no cambia;
  - el Edge 1.2 lo imprime y uno viejo también lo entiende;
  - el panel: huella, la consulta cada minuto, por el Edge sin navegador, y el
    navegador cuando no se puede.
- **B (12–17), con Postgres:**
  - cuándo va por el Edge y cuándo no (sin Caja, Caja apagada, equipo
    desconectado, Edge viejo);
  - un toque, un ticket;
  - si no va por el Edge, no crea trabajos;
  - QR solo cobrado;
  - ni cancelados ni de otro negocio.
- **C (18–20), servidor real con un Edge de prueba:**
  - con 1.1.0, el navegador;
  - con 1.2.0, el trabajo le llega por el WebSocket;
  - la vista previa es este ticket.
- **D (21), Chrome real:**
  - 🧾 con Edge: no abre el navegador y el ticket llega al Edge;
  - sin Edge: el navegador en el mismo clic.

Siguen verdes:
- `fase-ticket-al-cobrar` (25/25) y `fase-ticket-final-contrato`;
- `fase-diseno-papel-panel`, `fase-formato-impresion`, `fase-panel-escapa-cliente`
  y `fase-panel-vistas-hermanas`;
- las de impresión y Edge, y el predeploy.

**Mordidas:** las 44, desactivadas una por una, tumban al menos un caso. Si la mordida
toca `panel/ticketPedido.js`, el corredor pone su huella al día en `index.html`
(como un despliegue correcto); «huella vieja» es la mordida aparte.

| Se desactiva | Casos que caen |
|---|---|
| la orden no va grande | 3 |
| la modalidad no va resaltada | 3 |
| el total ignora la opción | 5 |
| sin el monto en letra | 3 |
| la nota repite las opciones | 3 |
| opciones aunque no se quieran | 5 |
| el nombre del platillo se recorta | 4 |
| etiqueta de teléfono sin teléfono | 3 |
| el nombre del negocio ignora la opción | 5 |
| el pie ignora la opción | 5 |
| el WhatsApp ignora la opción | 5 |
| sin QR de autofactura | 6, 16 |
| sin pago mixto | 6 |
| sin datos de entrega | 6 |
| centavos como antes (00/100) | 1 |
| «por cobrar» como forma de pago | 2 |
| «—» como teléfono | 2, 3 |
| teléfono técnico de Rappi | 2 |
| el canal crudo | 2, 3 |
| un Edge viejo recibe un trabajo vacío | 8 |
| la cuenta ignora el ticket del pedido | 7, 8, 14, 16, 19, 20 |
| la vista previa es una cuenta de Mesas | 20 |
| sin Caja también «se puede» | 12, 13, 14, 15, 16, 18, 19, 21 |
| no exige la Caja conectada | 13, 14 |
| no exige Edge 1.2 | 13, 15, 18 |
| impresora apagada cuenta como Caja | 13, 14, 16, 19, 21 |
| cada reintento, otro ticket | 14 |
| ticket de un pedido cancelado | 17 |
| ticket de otro negocio | 17 |
| autofactura sin cobrar | 16 |
| crea trabajos aunque no vaya por el Edge | 15, 18 |
| la ruta sin sesión | 18, 19, 21 |
| la ruta no mira el Edge real | 18 |
| el trabajo no se entrega al Edge | 19, 21 |
| la consulta del panel siempre dice que no | 18, 19, 21 |
| panel: siempre por el servidor | 9, 21 |
| panel: nunca por el Edge | 9, 21 |
| panel: por el Edge y además el navegador | 11, 21 |
| panel: sin Edge no usa el navegador | 11 |
| panel: el mismo intento siempre | 11 |
| panel: cree en el Edge sin preguntar | 10, 21 |
| panel: un corte de red lo apaga | 10 |
| panel: en espera sale también por el navegador | 11 |
| index: huella vieja | 9 |
