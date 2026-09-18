# Restaurante · Cobro: ticket pagado, cambio, descuentos y división por consumo

Rama `feat/restaurante-cobro-caja`, base de producción `90b9cc5`. Migración
nueva: **082** (columnas con default; el predeploy aborta si cambia el
número o el importe de cuentas, pagos o ventas de mesa). No se tocan
cocina, comandas, WhatsApp ni el trabajo certificado de Mesero.

## 1. Ticket de cuenta pagada

**Diagnóstico.** Al cerrar, el servidor creaba el trabajo Edge `documento:
'cuenta'` (solo rutas Caja/Ticket) y, si Edge no lo tomaba, emitía el ticket
por el camino legado `emitirTrabajoImpresion` con `tipo_comanda:
'cuenta_final'`: un aviso WebSocket que **solo imprime si el panel de
comandas (`/app`) está abierto en ese navegador**. La caja cierra desde
Restaurante (`/restaurante`), que no escuchaba nada, y Mapolato no tiene
impresora de Caja en Edge (solo Bebidas, Chilaquil y COCINA). Resultado: la
precuenta salía (tiene fallback de navegador desde el 18-sep) y el ticket
pagado no salía nunca.

**Recorrido nuevo.** `POST /cuentas/:id/cerrar` cierra y contabiliza en su
transacción (sin cambios) y después `imprimirTicketPagado`:

1. arma el snapshot con `construirTicketCuenta` (PAGADO, folio `RM-…`,
   productos con modificadores y notas, subtotal, descuento con motivo,
   propina, total, pagos por método, efectivo recibido y cambio);
2. crea el trabajo Edge `documento: 'cuenta'` (`origen_tipo:
   'restaurante_cuenta'`, `origen_id: folio`), que **solo** puede caer en
   impresoras con destino Caja/Ticket (`destinosDeDocumento` no hereda las
   reglas de categoría: nunca cocina);
3. si hubo trabajo → `impresion: { destino: 'edge' }` y el navegador no
   imprime; si no hubo (sin ruta, impresora apagada) → `impresion: {
   destino: 'navegador', ticket }` y Restaurante imprime el mismo snapshot
   con `imprimirTicketEnNavegador` (iframe térmico de 80 mm con largo al
   contenido, el mismo de la precuenta). Nunca los dos.

El camino legado `cuenta_final` ya no se emite desde el cierre. La plantilla
de `/app` sigue existiendo para su botón de reimpresión manual.

**Fallos y reintentos.** La impresión corre después del COMMIT y nunca
lanza: un error de impresora deja la venta hecha y responde `destino:
'ninguno'`. Repetir el cierre responde `yaCerrada` **sin** reimprimir.
Reimprimir es `POST /cuentas/:id/ticket`: incrementa
`ticket_impresiones`, crea un trabajo nuevo (`restaurante_cuenta_reimpresion`,
`origen_id: folio#n`, marcado `*** REIMPRESION ***`) o vuelve a mandar el
snapshot al navegador. No cierra, no cobra, no toca pagos ni venta. Una
cuenta abierta responde 409 `TICKET_NO_DISPONIBLE`; un mesero, 403.

El diálogo «Cuenta cerrada · PAGADO» de Restaurante muestra folio, total y
cambio, y tiene **Reimprimir ticket**.

**Edge.** `renderCuenta` imprime `PAGADO` en grande cuando `ticketPagado`,
el motivo junto al descuento, y las líneas «Efectivo recibido» y «Cambio».
Un Edge instalado antes de este cambio imprime el mismo snapshot sin la
palabra PAGADO (sí folio, importes, pagos y `Descuento (motivo)`, porque el
motivo viaja también como `promocion`); se actualiza reinstalando el Edge.

## 2. Efectivo recibido y cambio

Tres cantidades, una sola venta:

| Campo | Qué es | Dónde queda |
|---|---|---|
| Monto a abonar (`monto`) | lo que se registra contra la cuenta; **nunca** rebasa el saldo (`PAGO_EXCEDE_SALDO` sigue) | `restaurante_cuenta_pagos.monto`, `datos.pagos[].monto`, `datos.total` |
| Efectivo recibido (`recibido`) | el billete; solo con `efectivo`; debe cubrir abono **más propina** (`EFECTIVO_INSUFICIENTE`) | `pagos.recibido`, `datos.pagos[].recibido`, `datos.efectivo_recibido` |
| Cambio | `recibido − abono − propina`, calculado en servidor | `pagos.cambio`, `datos.pagos[].cambio`, `datos.cambio`, ticket |

Ejemplo: saldo $180, recibe $200 → abono $180, cambio $20, venta $180. La
pantalla muestra el cambio **antes** de confirmar (y bloquea «Registrar» si
falta dinero) y después de registrar, y lo imprime en el ticket.

**Propina.** Es aparte: no reduce el saldo ni entra a la venta
(`datos.propinas` y `pagos[].propina`, como antes). Con efectivo sale del
billete: $200 recibidos, $180 de abono y $10 de propina dan $10 de cambio; un
billete que no cubre abono más propina se rechaza.

**Pagos parciales.** Un abono menor al saldo; cada uno con su método, su
recibido y su cambio. La cuenta se cierra cuando el saldo llega a cero.

## 4. Descuentos

`POST /cuentas/:id/descuento` `{ tipo: 'porcentaje' | 'importe', valor,
motivo }` (caja o admin; el mesero no) y `DELETE` para quitarlo. Un solo
descuento por cuenta, sobre el subtotal completo.

Autorización: `services/descuentos.js`, la **misma** función que ahora usa
el cobro del POS (`PATCH /pedidos/:folio/cobro`): motivo obligatorio, nunca
mayor que el subtotal, staff hasta el **10 %** del subtotal (límite real
verificado en el POS), admin sin límite. Queda en la cuenta `descuento_tipo`,
`descuento_valor`, `descuento_monto`, `descuento_motivo`, `descuento_por`,
`descuento_at`.

`total = subtotal − descuento` en todos lados: `SQL_TOTALES` (saldo y
pagos), precuenta (Subtotal / Descuento (motivo) / TOTAL), ticket pagado,
venta (`datos.subtotal`, `datos.descuento`, `datos.motivo_descuento`,
`datos.descuento_por`, `datos.total` neto: los mismos nombres del POS, así
que historial, ventas y corte lo leen igual) y resumen de ventas (neto).

Guardas: se aplica bajo `FOR UPDATE`; con pagos registrados, un descuento que
dejara el total por debajo de lo cobrado responde 409
`DESCUENTO_INCOMPATIBLE`; el total nunca es negativo. Descuento y cobro
simultáneos: gana exactamente uno.

## 3. División por consumo (diseño, pendiente de tu visto bueno)

Hoy la división por consumo es texto libre en `cubre`. Lo que se propone:

**Modelo.** Cada cobro puede cubrir productos reales de la cuenta:

- `restaurante_cuenta_pagos.cobro_id` agrupa los pagos de una misma persona
  (un cobro mixto = un `cobro_id` con dos filas, efectivo y terminal).
- `restaurante_cuenta_cobro_items (cobro_id, item_id, porcion_num,
  porcion_den, importe)`: qué parte de cada renglón cubre ese cobro. Una
  porción es una fracción exacta (2 de 3 tacos = 2/3 del renglón; media
  pizza compartida = 1/2), y `importe` es su valor en centavos ya
  redondeado.

**Productos compartidos.** Un renglón se puede repartir entre varias
personas por fracción; cada persona paga `importe_neto_renglón ×
fracción`. Los centavos sobrantes del reparto los absorbe la **última**
porción que completa el renglón (misma regla que `dividirEnPartesIguales`),
así la suma cierra exacta. Un renglón queda «pagado» cuando sus porciones
suman 1; «pendiente» muestra la fracción que falta.

**Pagos parciales.** Un cobro por consumo es un pago parcial normal: el
saldo de la cuenta baja por el abono, y además queda registrado **qué**
consumo cubrió. Se puede mezclar: dos personas pagan por consumo y el
resto se divide en partes iguales sobre el saldo (lo que queda sin
asignar). El cierre exige saldo cero, como hoy.

**Doble cobro con dos cajeros.** Dentro de la transacción del pago, bajo el
`FOR UPDATE` de la cuenta, se recalcula la porción pendiente de cada renglón
elegido y se rechaza el cobro si alguna porción ya no está disponible
(`CONSUMO_YA_PAGADO`). Dos cajas que eligen el mismo taco se serializan y la
segunda recibe el rechazo con el detalle.

**Descuento y consumo.** El descuento de cuenta se reparte **a prorrata**
entre los renglones por su importe bruto, con el redondeo exacto asignado
al renglón de mayor importe, de modo que la suma de los netos es
exactamente `subtotal − descuento`. Quien paga un renglón paga su neto. Un
descuento aplicado después de cobros por consumo solo se admite si el neto
de cada renglón ya cobrado no cae por debajo de lo pagado por él; si no,
409 `DESCUENTO_INCOMPATIBLE`.

**Pantalla.** En «Dividir cuenta»: pestañas «Partes iguales» (como hoy) y
«Por consumo»: lista de renglones con lo pendiente de cada uno, tocar para
elegir cantidad o fracción, total de la selección, y el mismo diálogo de
pago (método, abono fijo = selección, efectivo recibido, cambio).

## Pruebas

`test/fase-restaurante-cobro-caja.mjs` (12 casos): 082; ticket sin Caja
(navegador, PAGADO, folio, pagos, cambio, cero trabajos Edge); reintento
sin reimprimir y reimpresión numerada sin tocar la venta (409 en cuenta
abierta, 403 mesero); con Caja: trabajo Edge en CAJA, cero en COCINA, papel
con PAGADO y REIMPRESION; impresora apagada no deshace el cobro; cambio
$180/$200; efectivo insuficiente 400 y sobrepago 409; propina y parciales
mixtos; descuento (staff 10 % sí, 15 % no, admin sí, motivo, auditoría,
quitar); descuento con pagos (409), reflejado en precuenta, ticket, venta y
resumen; carrera descuento/cobro; snapshot fiel; y la pantalla en Chrome
(cambio antes de confirmar, descuento en totales, cierre imprime PAGADO una
vez, reimprimir imprime REIMPRESIÓN).

Regresión verde: `fase-restaurante-mesas`, `fase-restaurante-e2e-piloto`,
`fase-restaurante-operacion-v2`, `fase-restaurante-precuenta`,
`fase-precuenta-papel`, `fase-cobro-diferido`, `fase-cortes-caja`,
`fase-ticket-final-contrato`, `fase-print-jobs`.
