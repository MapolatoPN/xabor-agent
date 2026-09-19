# Restaurante · Cobro: ticket pagado, cambio, descuentos y división por consumo

Dos entregas sobre el mismo flujo de cobro:

- Ticket pagado, efectivo recibido/cambio y descuentos: rama
  `feat/restaurante-cobro-caja`, base `90b9cc5`, migración **082**. En
  producción desde `c0b9128`.
- División por consumo real: rama `feat/restaurante-division-consumo`,
  base de producción `c0b9128`, migración **083** (aditiva, con `_down.sql`;
  el predeploy aborta si cambia el número o el importe de cuentas, pagos o
  ventas de mesa).

No se tocan cocina, comandas, WhatsApp, Rappi, promociones, tienda en
línea ni el trabajo certificado de Mesero.

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

Guardas: se aplica bajo `FOR UPDATE`; el total nunca es negativo. Desde la
083 el descuento queda **congelado** con cualquier pago vigente: aplicar,
cambiar o quitar responde 409 `DESCUENTO_CONGELADO` y primero se revierte
el cobro (sustituye al antiguo `DESCUENTO_INCOMPATIBLE`, que solo cubría
el caso de un total por debajo de lo cobrado). Descuento y cobro
simultáneos: gana exactamente uno.

## 3. División por consumo real (migración 083)

Cada persona paga lo que consumió: renglones completos, unidades de un
renglón o fracciones de un renglón compartido. Implementa el diseño con los
cuatro ajustes aprobados: descuento congelado tras el primer pago; consumo y
después «dividir el resto» sin vuelta atrás; renglón con porción cobrada
inmutable; prorrateo del descuento por mayores residuos.

**Modelo (083).**

- `restaurante_cuenta_pagos`: `cobro_id UUID` agrupa los pagos de una misma
  persona (un cobro mixto = un `cobro_id` con dos filas, efectivo y
  terminal); `tipo_cobro` `abono` | `consumo` | `parte` (default `abono`,
  así lo histórico no cambia de significado); `revertido_at`,
  `revertido_por`, `motivo_reverso`.
- `restaurante_cuenta_porciones (id, cuenta_id, negocio_id, item_id,
  cobro_id, numerador, denominador ≤ 1000, importe_centavos, registrado_por,
  created_at, revertido_at, revertido_por, motivo_reverso)`: qué fracción de
  cada renglón cubrió cada cobro y cuántos centavos valió. El texto `cubre`
  sigue siendo informativo; la fuente de verdad son las porciones.
- `restaurante_cuentas.division_remanente JSONB`: `{partes, iniciado_at,
  iniciado_por, saldo_centavos}` desde que se cobra la primera parte igual.
- Predeploy `scripts/predeploy-083-restaurante-division-consumo.mjs`
  (advisory lock, idempotente, snapshot antes/después) y entrada
  `083-restaurante-division-consumo` en `predeploy-run-032-033.mjs`.

**Aritmética (`src/services/divisionConsumo.js`, pura, todo en centavos).**

- Fracciones exactas `num/den` reducidas (2 de 3 tacos = 2/3; media pizza
  = 1/2). Nunca decimales.
- `prorratearDescuento`: el descuento de la cuenta se reparte entre los
  renglones vivos por su bruto con mayores residuos: base =
  floor(D·bruto/total) y los centavos sobrantes van, uno por uno, a los
  mayores residuos (empate: orden del renglón). `Σ netos = subtotal −
  descuento` exacto siempre, y nadie recibe más de un centavo sobre su parte.
- `importeDePorcion`: floor(neto × fracción); la porción que completa el
  renglón se lleva exactamente lo que falta (½ + ½ de $255.01 = $127.50 +
  $127.51).
- `partesIgualesCentavos`: base para todas y un centavo extra a las
  primeras ($433.00 entre 3 = 144.34, 144.33, 144.33).

**Servicio (`restauranteService.js`).**

- `estadoDivision`: renglones vivos con bruto, descuento prorrateado, neto,
  cobrado y pendiente (centavos y fracción), estado `pendiente | parcial |
  pagado` y sus porciones; cobros vigentes agrupados por `cobro_id`;
  `consumoBloqueado` con motivo; partes iguales del remanente (fijas o
  propuestas para N personas).
- `cobrarConsumo`: `seleccion = 'resto' | [{itemId, cantidad} | {itemId,
  numerador, denominador}]` y `pagos[]`. Bajo `FOR UPDATE` de la cuenta
  relee las porciones vigentes: si otra caja ya cobró lo que se pide, 409
  `CONSUMO_YA_PAGADO` con `detalle {itemId, producto, solicitado,
  pendiente}`. El importe lo calcula el servidor y los pagos deben sumarlo
  exactamente (409 `MONTO_NO_COINCIDE` con `importeEsperado`): nunca se
  acepta un total del navegador. `cobroId` opcional del cliente: el mismo
  id responde `repetido: true` sin registrar nada (doble clic, reintento).
- `cobrarParteIgual`: la primera parte fija N en `division_remanente`; las
  siguientes se recalculan sobre el saldo pendiente y los pagos deben
  coincidir con una de ellas. `PARTES_YA_FIJADAS`, `PARTES_AGOTADAS`,
  `NADA_QUE_COBRAR`.
- Un abono suelto (`/pagos`) o una parte igual son asignaciones genéricas:
  desde que existe una, la selección por producto se cierra (409
  `REMANENTE_DIVIDIDO`). Al revés sí: consumo y luego partes iguales.
- `revertirCobro` (admin, motivo obligatorio): marca pagos y porciones con
  `revertido_at/por/motivo`, nunca borra; libera las porciones y, si no queda
  ninguna parte igual vigente, la división del remanente. Con venta
  contabilizada exige antes el reverso de la venta.
- Reglas transversales: `aplicarDescuentoCuenta` y `quitarDescuentoCuenta`
  responden 409 `DESCUENTO_CONGELADO` con cualquier pago vigente;
  `cambiarCantidadItem`, `quitarItemPendiente` y `cancelarItem` responden 409
  `ITEM_TIENE_COBRO` si el renglón tiene una porción vigente (la condición
  va en el propio UPDATE/DELETE, sin ventana). `SQL_TOTALES`, la precuenta,
  el ticket y el cierre ignoran los pagos revertidos.
- `registrarPago` no cambia de contrato: cada abono lleva ahora su propio
  `cobro_id` y `tipo_cobro = 'abono'`.

**Cierre.** Sin cambios contables: exige saldo cero y genera UNA venta
`RM-*` en `pedidos_activos` con los pagos agrupados por método
(`forma_pago` mixto si hay más de uno). Ningún cobro por consumo o parte
crea pedido ni venta; no se toca la impresión de cocina, Rewards ni la
tienda.

**Endpoints.**

- `GET /api/restaurante/cuentas/:id/division?partes=N` (operación de
  restaurante, solo lectura).
- `POST /api/restaurante/cuentas/:id/cobros-consumo` `{seleccion, pagos,
  cobroId?, nota?}` → 201 (200 si `repetido`). Caja o admin.
- `POST /api/restaurante/cuentas/:id/cobros-partes` `{partes?, pagos,
  cobroId?}` → 201. Caja o admin.
- `POST /api/restaurante/cuentas/:id/cobros/:cobroId/revertir` `{motivo}`
  (admin).
- `GET .../dividir` se conserva por compatibilidad; el panel ya no lo usa.

**Pantalla (`panel/mesas.html`).** «Dividir cuenta» abre un modal con dos
pestañas sobre el mismo estado del servidor. «Por consumo»: cada renglón
con cantidad, producto, modificadores/notas, bruto (y neto si hay
descuento) y estado (`✓ PAGADO`, `Pagado $x · Pendiente $y`); tocar el
renglón elige todo lo pendiente; stepper de unidades para cantidades > 1 y
chips ½ ⅓ ⅔ ¼ para compartidos; «Selección actual $x [Limpiar] [Cobrar
selección]» y «Cobrar resto $saldo». «Partes iguales»: stepper de personas
(bloqueado cuando N ya está fijo), Persona k $monto [Cobrar], pagadas con
✓. Cobrar abre el mismo diálogo de pago con el importe **no editable**
(lo fijó el servidor), efectivo recibido/cambio, propina y pago mixto (dos
métodos, un solo `cobro_id`). Un 409 cierra el diálogo y reconstruye la
pantalla desde el servidor. «Cobros registrados» lista cada cobro con sus
porciones y, para admin, «Revertir» con motivo. Sin `prompt()`.

## Pruebas

`test/fase-restaurante-cobro-caja.mjs` (15 casos): 082; ticket sin Caja
(navegador, PAGADO, folio, pagos, cambio, cero trabajos Edge); reintento
sin reimprimir y reimpresión numerada sin tocar la venta (409 en cuenta
abierta, 403 mesero); con Caja: trabajo Edge en CAJA, cero en COCINA, papel
con PAGADO y REIMPRESION; impresora apagada no deshace el cobro; Windows o
Edge, nunca ambos (Edge falso conectado y desconectado); cambio $180/$200;
efectivo insuficiente 400 y sobrepago 409; propina y parciales mixtos;
descuento (staff 10 % sí, 15 % no, admin sí, motivo, auditoría, quitar);
descuento congelado tras un pago (409 al aplicar y al quitar), reflejado en
precuenta, ticket, venta y resumen; carrera descuento/cobro; snapshot fiel;
y la pantalla en Chrome.

`test/fase-restaurante-division-consumo.mjs` (28 casos): 083; cuatro
productos → A paga dos, B otro, cobrar resto; 3 tacos 2/3 + 1/3; pizza ½ +
½ con precio impar (127.50 + 127.51); descuento con centavos difíciles
(netos suman exacto y se cobran uno a uno); mayores residuos para cientos
de descuentos y el sobrante a los mayores residuos; renglón parcialmente
pagado no cambia de cantidad, no se quita ni se cancela (409
`ITEM_TIENE_COBRO`) y sí tras revertir; descuento después del primer pago
409 `DESCUENTO_CONGELADO` y sí tras revertir; dos cajas cobran el mismo
renglón a la vez (una gana, la otra 409 con detalle, jamás doble cobro);
mixto $200 + $194 en un solo cobro con dos pagos; cambio; propina aparte;
consumo y después remanente entre 3 (144.34/144.33/144.33), sin volver a
consumo, N fijo, cierre exacto; cerrar exige saldo cero; una sola venta
`RM-*` y ningún pedido por cobro; aislamiento entre negocios (404); refresh
fiel a la base; doble clic con el mismo `cobroId`; precios y fracciones
difíciles con 33.33 % de descuento cierran al centavo; precuenta con pagado
y saldo; ticket final con pagos por método; reverso auditado sin borrar
(403 staff, 400 sin motivo, 404 repetido); abono suelto cierra la
selección; y la pantalla en Chrome (modal, selección táctil, cobrar
selección con importe fijo, partes iguales con stepper, capturas en
`test/.capturas-cuenta/division-*.png`). Con `SALTAR_UI=1` omite Chrome.

Mordidas (desactivar una garantía y ver fallar la suite): sin `FOR UPDATE`
en `cobrarConsumo`; sin comprobar la fracción pendiente (doble cobro);
descuento después de un pago; cambiar cantidad, quitar y cancelar un
renglón con porción cobrada; `Math.round` en la porción; la porción que
completa no se lleva el centavo; mayores residuos al revés; volver a
consumo tras formalizar partes; confiar en el total del navegador en
consumo y en partes. Las doce se detectan.

Regresión verde: `fase-restaurante-mesas`, `fase-restaurante-e2e-piloto`,
`fase-restaurante-operacion-v2`, `fase-restaurante-precuenta`,
`fase-precuenta-papel` (su marcador de fin cambió de `dividirIguales`, que
ya no existe, al encabezado «Dividir cuenta»), `fase-cobro-diferido`,
`fase-cortes-caja`, `fase-ticket-final-contrato`, `fase-print-jobs`.
