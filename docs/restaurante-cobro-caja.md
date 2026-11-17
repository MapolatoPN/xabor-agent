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

**Precuentas de la cuenta dividida (15-oct-2026).** Pedido de los meseros:
una mesa de 8 que pide la cuenta dividida necesita un papel por persona con
lo que consumió, para enseñárselo antes de cobrar. En «Por consumo» hay dos
botones, que también ve el mesero:

- «Imprimir selección»: una PRECUENTA solo con lo elegido (la selección no
  se borra: se puede cobrar tal cual después).
- «Imprimir una por persona»: aparece si los renglones se capturaron por
  «Orden N» (`ordenes_por_persona`, 115). Una precuenta por orden con algo
  pendiente, en orden, y al final una «Sin asignar» con lo que no es de
  nadie. Lo ya pagado no sale; los papeles suman el saldo de la mesa.

`POST /api/restaurante/cuentas/:id/precuenta-division` `{modo:
'seleccion'|'personas', seleccion?, etiqueta?, solicitudId}` (operación de
restaurante, como la precuenta). Lo arma `src/services/precuentaDivision.js`:

- El total de cada papel es `importeDePorcion` de la selección: exactamente
  lo que el cobro por consumo acepta (si difiriera un centavo, el cobro
  daría `MONTO_NO_COINCIDE`). El bruto es neto + su parte del descuento, así
  que en el papel subtotal - descuento = total al centavo. Unidades enteras
  salen como «cantidad × precio de lista»; una fracción de unidad, como un
  renglón con su importe y «Compartido: 1/2» de modificador.
- Solo imprime: no cobra, no reserva ni toma el lock. Con el remanente en
  partes iguales o un abono suelto responde 409 `REMANENTE_DIVIDIDO` (los
  renglones ya no dicen lo que falta); sin personas, 409 `SIN_PERSONAS`.
- Documento `cuenta`, `origen_tipo = 'restaurante_precuenta_division'`,
  `origen_id = cuenta:solicitud:k`: va solo a Caja/Ticket y un reintento
  HTTP no duplica papel. Sin Caja vuelve al navegador, que imprime TODAS en
  un solo diálogo, una por hoja, con la página del alto de la más larga.
- Usa solo campos que el renderer del Edge YA instalado imprime: la persona
  va en la `leyenda` («ORDEN 3 - LUIS - NO ES COMPROBANTE DE PAGO») y la
  fracción como modificador. No hace falta actualizar la PC del negocio. Los
  textos para la térmica pasan por `textoTermico`: el Edge escribe latin1 y
  una raya «—» llegaría como el byte de control 0x14.

## 5. Candado de precuenta y cobro identificado (migración 140)

Pedido de Mario (17-nov-2026) para Obispado: la precuenta que se lleva a la
mesa se liga con la cuenta que se cierra, lo que se le baje a la cuenta
después de imprimirla lo autoriza un supervisor con SU clave, y el cobro queda
a nombre de quien recibe el dinero, aunque la sesión de la caja sea de otra
persona. Reglas en `src/services/candadoPrecuenta.js`; tablas nuevas en la
**140** (aditiva, `_down.sql` a mano; el predeploy aborta si cambia el número
o el importe de cuentas, platillos, pagos o ventas de mesa).

**Registro de precuentas (siempre, sin bandera).**
- Cada precuenta impresa —completa o un papel de la cuenta dividida— queda en
  `restaurante_precuentas` con su número dentro de la cuenta, subtotal,
  descuento, total, pagado, quién la pidió y la **firma** del consumo
  (renglones vivos con cantidad y precio, más el descuento; los pagos no
  cuentan). Se registra ANTES del papel, salga por Edge o por el navegador.
- El papel lleva `Folio: PC-XXXXXXXX-N` y la hora. Las 8 letras son las de la
  venta `RM-XXXXXXXX-n` del cierre: el papel se casa con la venta del
  historial. Edge ya imprimía `folio` y `emitidoAt`; no hay que actualizar la PC.
- Idempotente por `solicitudId` (un reintento devuelve el mismo número) y con
  la cuenta bloqueada (dos cajas a la vez sacan números distintos). Si la
  cuenta cambió entre leerla y registrarla, 409 `CUENTA_CAMBIO`.
- `GET /api/restaurante/cuentas/:id` agrega `candado`: banderas, última
  precuenta (sin la firma) y `vigente` (¿la cuenta sigue igual que en ella?).
  El tablero cuenta las precuentas de cada mesa (🔒).

**Candado** (`configuracion.restaurante_candado_precuenta = 'true'`). Con una
precuenta impresa, lo que salió en ella no se baja sin la clave de un
supervisor (`ROLES_SUPERVISOR`: administrador del negocio con clave de
autorización; la de staff NO basta y la SESIÓN de administrador tampoco):
- quitar o rebajar un platillo pendiente (`supervisor_pin` en el cuerpo);
- cancelar lo ya enviado (la clave del diálogo de siempre tiene que ser de
  un administrador: 409 `CANDADO_PRECUENTA` con la de staff);
- aplicar un descuento.
Lo que se agregó DESPUÉS de la precuenta se corrige libre (el cliente no lo
vio en el papel); subir una cantidad nunca pide clave. Al **cerrar**, si la
cuenta cambió desde su última precuenta: 409 `PRECUENTA_VENCIDA` con los dos
totales; se cierra imprimiendo otra precuenta (sin clave) o con la de un
supervisor. Cada autorización queda en `restaurante_cuenta_bitacora`
(`autorizacion_supervisor`: acción, folio, quién pidió y quién autorizó) y en
`restaurante_item_eventos.autorizado_por` cuando toca un platillo. Mientras el
negocio no tenga ningún administrador con clave, la sesión de administrador
autoriza (queda `sin_clave` en la bitácora) para que encender la bandera
nunca deje a la caja sin forma de corregir.

**Descuento de más del 10 % desde staff**, con o sin candado: con
`supervisor_pin` de un administrador se autoriza como de administrador y
queda a su nombre (`descuento_por`). Sin él, 403 `DESCUENTO_NO_AUTORIZADO`
con `detalle.requiereSupervisor`: la pantalla ofrece pedir la clave. Así la
caja puede trabajar con una sesión de staff.

**Cobro identificado** (`configuracion.restaurante_cobro_identificado =
'true'`). Registrar pago, cobrar consumo o parte y cerrar piden `cobra:
{ usuario_id, pin }`: cualquier persona activa del negocio con PIN de mesero
o clave de autorización. El pago (`registrado_por`), las porciones y el cierre
(`cerrada_por`) quedan a su nombre; la sesión de la caja va en la bitácora
(`cobro_identificado`). Sin `cobra`, 400 `COBRA_REQUERIDO`; PIN equivocado,
401 `COBRA_PIN_INCORRECTO`; cinco fallos seguidos bloquean unos minutos. La
pantalla recuerda a quien cobró 3 minutos, solo para esa cuenta y solo en
memoria (cobrar y cerrar van seguidos).

**Mover de mesa y tablero** (sin bandera). Solo a una mesa de 1 a
`restaurante_num_mesas` (400 `MESA_FUERA_DE_TABLERO`) y con bitácora
(`mesa_movida`: de, a, quién). `listarMesas` devuelve además
`fueraDeTablero`: las cuentas abiertas con un número mayor, que la pantalla
muestra aparte para cobrarlas o regresarlas al tablero.

**Autorización a distancia** (sin bandera propia: vale donde se pide una
clave de supervisor). Cuando no hay supervisor en la sucursal, la caja pulsa
«📱 Pedir a distancia» en el diálogo de la clave (o en el de quitar un
platillo enviado) y le llama a un administrador:
- La caja manda la MISMA acción con `pedir_autorizacion: true`. Si todavía
  hace falta la clave, el servidor guarda en `restaurante_autorizaciones_remotas`
  lo que iba a cambiar —acción, mesa, platillo, cantidad e importe, o descuento
  y motivo, o los dos totales al cerrar, más el folio de la precuenta— y
  responde 202 `AUTORIZACION_SOLICITADA` con su id. Nada cambia en la cuenta.
  Un doble toque devuelve la misma solicitud. Si ya no hacía falta, la acción
  simplemente se aplica.
- El administrador abre **`/autorizaciones`** en su celular, con su cuenta.
  Ve lo que espera respuesta (con lo que se cambia y quién lo pide) y lo
  autoriza con **su propia** clave (la de otro, aunque sea administrador, no
  sirve; cinco fallos bloquean unos minutos) o lo rechaza. La lista y la
  respuesta son solo de administrador del negocio (`requireAdminSeguro`).
- La pantalla de la caja pregunta cada 3 s (`GET /api/restaurante/autorizaciones/:id`)
  y, autorizada, manda la acción con `autorizacion_id`. El servidor la gasta
  dentro de la transacción de la acción, con la cuenta bloqueada, solo si
  coincide la **huella**: acción, cuenta, lo que vio el supervisor y el
  vínculo (el renglón exacto; para el descuento, la firma de la cuenta y el
  motivo; para cerrar, la firma de la cuenta). Si algo cambió, si ya se usó,
  si venció, si se rechazó o si la manda otra sesión: 409
  `AUTORIZACION_REMOTA_INVALIDA` y no se aplica nada (un intento fallido no
  la gasta).
- Pendiente vence a los 5 minutos; autorizada, 5 minutos después. Queda en
  la bitácora como cualquier autorización de supervisor, con `remota` = id.
- Sin ningún administrador con clave no se ofrece (no habría quién conteste).
  Por ahora el aviso es la llamada: la página no manda notificaciones.

**Para encenderlo en un negocio.** 1) Aplicar la 140 (va en el runner del
predeploy). 2) Cada supervisor registra su clave de autorización en
Configuración › Usuarios (rol administrador). 3) Quien cobre sin ser
administrador necesita su PIN o su clave. 4) Encender las banderas:
`restaurante_candado_precuenta` y `restaurante_cobro_identificado` en
`configuracion` del negocio. Apagarlas regresa todo a como estaba (el
registro de precuentas y la bitácora de mover siguen).

## Pruebas

`test/fase-precuenta-division-pura.mjs` (10 casos, sin Postgres): textos
para la térmica; selección completa, por unidades y media orden (las dos
mitades suman el platillo); 2 000 selecciones al azar con descuento y
porciones previas donde total = cobro y subtotal - descuento = total; la
porción que completa tras dos cuartos sin descuento negativo; una por
persona (orden, «Sin asignar» al final, lo pagado fuera, suma = saldo);
validación igual al cobro; el papel del renderer del Edge instalado; el
endpoint solo imprime documento `cuenta`; botones y nombres únicos en la
pantalla. `test/fase-precuenta-division.mjs` (8 casos, servidor y Postgres
reales, negocio propio): con 10 % y media orden el cobro acepta exactamente
el total impreso; una por persona y después de cobrarle a una; mesero de
tablet sí, otro negocio 404; errores (`MODO_INVALIDO`, `SELECCION_VACIA`,
`CONSUMO_YA_PAGADO`, `SIN_PERSONAS`, `REMANENTE_DIVIDIDO`,
`CUENTA_NO_ABIERTA`); Chrome (botones, una hoja por persona en un diálogo,
página del alto de la más larga; capturas `precuenta-division-*.png`); con
Caja por Edge solo a Caja, idempotente por solicitud. Mordidas (12, todas
detectadas): redondear la porción, permitir descuento negativo, imprimir más
de lo pendiente, ignorar el remanente dividido, dejar la raya, incluir lo
pagado, «Sin asignar» primero, no avisar sin personas, documento `comanda`,
`origen_id` sin la solicitud, medir el cuerpo en vez de la hoja y un diálogo
por persona.

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

`test/fase-restaurante-candado-precuenta.mjs` (39 casos, servidor y Postgres
reales, tres negocios propios: A con dos administradores con clave, una caja
de staff y un mesero; B con un administrador ajeno; C sin ningún
administrador con clave). REGISTRO: imprimir registra la N.º 1 con folio
`PC-XXXXXXXX-1` y lo pone en el papel; el reintento con la misma solicitud
devuelve la misma precuenta y otro toque saca la N.º 2; dos cajas a la vez
sacan números distintos; la división registra un papel por persona; el folio
sale por Edge y por el formato del servidor; la cuenta dice su última
precuenta y si sigue vigente, nunca la firma; el mesero de tablet queda como
quien la pidió. SIN BANDERA: todo sigue como antes. CANDADO: quitar o rebajar
lo que salió en la precuenta pide la clave de un administrador (la de staff
no basta); lo agregado después y subir cantidades, no; cancelar lo enviado
con la clave de staff se rechaza y con la de un administrador pasa; sin
precuenta, cancelar sigue como siempre; descontar pide clave y queda a nombre
de quien autorizó; una cuenta que cambió no se cierra sin precuenta nueva o
clave (y queda en la bitácora); con la precuenta vigente se cierra sin pedir
nada; la clave de un administrador de otro negocio no sirve; sin ningún
administrador con clave, la sesión de administrador autoriza y queda dicho
(la de staff no). DESCUENTO: staff al 20 % se rechaza ofreciendo la clave
del supervisor, y con ella pasa. COBRO: sin decir quién cobra el pago no
entra; con el PIN el pago queda a su nombre y la sesión de la caja en la
bitácora; cerrar también lo pide y la clave de autorización también vale; el
cobro por consumo queda a nombre de quien cobra. MESAS: mover fuera del
tablero se rechaza; mover dentro deja rastro (de, a, quién); una cuenta que
ya estaba fuera se lista aparte y el tablero marca las precuentas. A
DISTANCIA: pedirla no cambia nada en la cuenta y la lista de administradores
la enseña con su detalle, pero nunca la huella (staff no ve la lista); para
autorizar hace falta la clave propia del administrador con la sesión abierta
(la de otro administrador, la de staff o ninguna se rechazan, y una sesión de
staff no resuelve); resuelta no se vuelve a resolver; usarla aplica el cambio,
la deja como usada y la bitácora lo dice; no sirve para otro renglón, para un
renglón gemelo idéntico, desde otra sesión, en una cuenta que cambió, ya
vencida (pendiente o autorizada) ni dos veces (quitar el descuento y
reaplicarlo con la misma autorización se rechaza); un intento fallido no la
gasta; rechazada no sirve; el descuento queda atado a su porcentaje y su
motivo y a nombre de quien autorizó; cancelar la usa en lugar de la clave y
queda atada a la cantidad; cerrar una cuenta vencida queda atado a la firma
del momento; otro negocio no la ve ni la resuelve, y sin administradores con
clave no se ofrece. CONTRATO: la 140 está en el runner, la pantalla sabe
pedir clave, quién cobra y autorización a distancia, y `/autorizaciones` se
sirve sin WebSocket ni impresión.

Mordidas (15, todas detectadas): `exigirSupervisor` que nunca exige; la
clave de staff cuenta como supervisor; cancelar acepta a cualquier
autorizador como supervisor; lo agregado después también pide clave; cerrar
no revisa la precuenta vencida; sin supervisores la sesión de administrador
no autoriza; la clave del supervisor no sube el tope del descuento; no se
pide quién cobra; el pago no queda a nombre de quien cobra; mover sin límite
de tablero; mover sin bitácora; el tablero no lista lo que está fuera; el
papel no lleva el folio; la precuenta se registra sin bloquear la cuenta; y
la precuenta no es idempotente (hay dos capas, el atajo de la consulta previa
y el de cada clave: la mordida quita las dos).

Mordidas de la autorización a distancia (13, todas detectadas): se gasta sin
comparar la huella; el vínculo (renglón, firma, motivo) no cuenta; se puede
usar dos veces; la autorizada no vence al usarse; se contesta lo pendiente
vencido; otra sesión la puede usar; se autoriza con cualquier clave; staff la
resuelve; staff ve la lista; se resuelve desde otro negocio; la lista enseña
lo de otro negocio; la huella sale del servidor; y pedirla no guarda nada.
Donde la garantía vive en dos capas (servidor y servicio, o la consulta y el
gasto), la mordida quita las dos.

Regresión con la 140 (una base nueva por suite, 46 suites): verdes las de
Mesas (`fase-restaurante-*`, `fase-precuenta-*`, `fase-liberar-mesa`,
`fase-mesas-dolares`, `fase-acuna-mesas-propinas`, `fase-carrito-mesa`,
`fase-estacion-meseros`, `fase-ordenes-por-persona`), cobro y caja
(`fase-cobro-diferido`, `fase-cortes-caja`, `fase-tarjeta-cobro-simple`,
`fase-formas-cobro`, `fase-caja-*`, `fase-corte-descuentos`,
`fase-pos-dolares`), impresión (`fase-ticket-final-contrato`,
`fase-print-jobs`, `fase-edge-texto-termico`, `fase-formato-impresion`),
cancelaciones y permisos (`fase-cancelaciones-*`, `fase-permisos-operador`,
`fase-panel-vistas-hermanas`, `fase-panel-html-render`) y las que revisan el
runner (`fase-pedidos-temporada`, `fase-descuento-tras-cierre`).
`fase-restaurante-mesas` ahora fija `restaurante_num_mesas` en su caso de
concurrencia, porque mover exige que la mesa destino esté en el tablero.
Fallan igual en el commit de producción y no por esto:
`fase-descuentos-normalizados` (la respuesta del cobro ganó claves de
autofactura), `fase-xecador-migracion` (pide una plantilla sin las tablas
`xecador_*`) y `fase-usuarios-mesero-pin`, que revienta en su limpieza por
restos que ella misma deja; sobre una copia sin esos restos da 23/23. Con
la autorización a distancia se repitió sobre 44 suites (las mismas menos esas
dos últimas): 43 verdes, `fase-permisos-operador` con la ruta nueva, y solo
`fase-descuentos-normalizados` falla, por la misma razón.
