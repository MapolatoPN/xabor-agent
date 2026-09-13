# Rewards en la Tienda en Línea

Cómo funciona Xabor Rewards cuando la venta entra por `/t/<slug>`, qué se
arregló y qué queda pendiente. Escrito para el dueño y para el siguiente que
toque esto.

## 1. Qué estaba roto

**La tienda en línea no daba un solo punto. Nunca. En ningún negocio.**

No era configuración. `rewardsService.acumularPuntos` decidía si una venta
acumulaba mirando un mapa de canales escrito a mano:

```js
const mapaCanal = {
  presencial: config.canal_mostrador,
  whatsapp:   config.canal_whatsapp,
  voz:        config.canal_telefono,
  rappi:      config.canal_rappi,
};
if (!mapaCanal[canal]) return null;   // ← aquí moría
```

La tienda registra sus pedidos con `canal = 'tienda_online'` (migración 051).
Ese canal no estaba en el mapa, `mapaCanal['tienda_online']` es `undefined`,
`undefined` es falsy — y toda venta de la tienda salía por la rama "canal no
habilitado". En silencio, con un log (`[Rewards] Canal 'tienda_online' no
habilitado`) que se lee como una decisión del negocio y no como un olvido.

Del lado del **canje** no había nada que olvidar: la tienda pública no tenía
una sola línea de Rewards. Ni saldo, ni opción de usar puntos, ni UI. El
módulo existía y funcionaba bien en POS/WhatsApp/voz; simplemente nadie lo
había conectado a este canal.

## 2. Cómo se enciende

Rewards en la tienda tiene **tres candados independientes**. Los tres tienen
que abrir, y si falta cualquiera el comportamiento es "apagado" (fallo
cerrado), nunca "encendido por omisión":

| Candado | Dónde vive | Quién lo mueve |
|---|---|---|
| Módulo contratado | `negocio_modulos.rewards` ∈ (`activo`, `configurado`) | Superadmin |
| Programa activo | `rewards_config.activo` | Panel → Rewards → Config |
| Canal encendido | `rewards_config.canal_tienda` | Panel → Rewards → Config → **Tienda en línea** |

`canal_tienda` es nuevo (migración **079**) y nace en **FALSE**.

**Por qué FALSE y no TRUE como mostrador/WhatsApp**: `ADD COLUMN … DEFAULT`
rellena *todas* las filas existentes. Con TRUE, la migración habría encendido
Rewards en la tienda de cada negocio que ya tiene el programa activo — un
cambio comercial que nadie pidió, aplicado por un despliegue. Con FALSE el
comportamiento de hoy se conserva exacto y encenderlo es un acto explícito del
negocio.

Un solo interruptor gobierna las **dos** mitades (acumular y canjear). Media
función encendida es más difícil de explicarle a un cliente ("gané puntos pero
no puedo usarlos") que la función completa o apagada.

## 3. Identidad del cliente

La tienda no tiene sesión. La identidad es el **teléfono** que el propio
cliente escribe en el checkout, normalizado por `normalizarTelefonoMX` (los
últimos 10 dígitos) — el mismo que usa el POS.

La cuenta de Rewards vive en `rewards_accounts (telefono, tenant_id)`. Eso
significa:

- **Cliente conocido** que vuelve a comprar: suma sobre su saldo anterior.
- **Cliente nuevo**: la cuenta se crea en la primera acreditación.
- **Checkout invitado**: no existe. La tienda **exige** nombre y teléfono
  (`construirOrdenPOS` rechaza un teléfono inválido), así que toda compra es
  atribuible. No hay compra anónima que se quede sin puntos.
- **Mismo teléfono en dos negocios**: dos cuentas independientes, dos saldos.
  Ni se suman, ni se ven entre sí, ni se heredan reglas.
- **Sucursales**: Rewards no distingue sucursal. El saldo es del negocio
  (`tenant_id` = `negocio_id`), no de la sucursal.

## 4. Acumulación: cuándo y cuánto

**Cuándo**: al pasar el pedido a `entregado`, igual que en todos los canales.
Nunca al abrir el checkout, ni al crear el pedido, ni al generar el enlace de
pago.

Para un pedido de la tienda pagado en línea eso implica, por construcción, que
el dinero ya entró: un pedido `tienda_online` en `pendiente_pago` sólo sale de
ahí por el flujo de pagos verificado o por cancelación
(`actualizarEstadoPedido` lo impide explícitamente). Un pago fallido o
abandonado no puede generar puntos porque nunca llega a `entregado`.

**Cuánto**: `floor(totalElegible / monto_por_punto)`.

`totalElegible` = total del pedido − propina − (lo pagado con puntos).

Con la configuración de fábrica (`monto_por_punto = 10`): un pedido de $200 da
20 puntos.

Qué entra y qué no en ese total, con los números exactos que prueba la suite:

| Concepto | ¿Cuenta para acumular? |
|---|---|
| Productos | Sí |
| Modificadores (precio extra) | Sí |
| Envío | **Sí** — el total del pedido lo incluye |
| Promociones / cupones | Restan (se acumula sobre el total ya rebajado) |
| Propina | No |
| Monto pagado con puntos | No |
| Impuestos | No aplica: la tienda no maneja línea de impuesto |

> **Decisión pendiente del dueño**: que el envío acumule puntos es el
> comportamiento heredado de todos los canales (el POS a domicilio siempre lo
> ha hecho así). No se cambió aquí porque hacerlo alteraría la acumulación del
> POS, que está fuera del alcance de este trabajo. Si el negocio prefiere que
> el envío no genere puntos, es un cambio de una línea y una decisión
> comercial, no un defecto.

### Bug de acumulación corregido de paso

`totalElegible` restaba el monto canjeado **siempre**. Pero `pedido.total` no
significa lo mismo según el flujo:

- POS clásico (crear = cobrar): el total se fija **antes** de registrar el
  canje → es bruto → restar está bien.
- POS `por_cobrar` y tienda en línea: el total se fija **ya rebajado** por el
  canje → restarlo otra vez lo descuenta dos veces.

Resultado: una venta de $200 pagada con $100 de puntos daba **0** puntos en
vez de los 10 que corresponden a los $100 en efectivo. Ahora la señal es
`datos.rewards_canje`, que escribe exactamente el mismo acto que rebaja el
total, así que nunca aparece sin que el total ya esté neto. **Esto también
arregla el POS diferido**, no sólo la tienda.

## 5. Canje: el orden importa

```
cliente escribe su teléfono
  → GET /api/tienda/:slug/rewards        (saldo y tope para este carrito)
  → POST /api/tienda/:slug/cotizar       (con rewardsPuntos: intención)
  → POST /api/tienda/:slug/checkout      (con rewardsPuntos: intención)
      1. el servidor recalcula el plan (planDeCanje)
      2. se crea el pedido SIN el descuento
      3. se gastan los puntos (registrarCanje: lock de fila + idempotente)
      4. SOLO entonces baja el total del pedido
      5. comanda, tablero, enlace de pago — todos ven el total final
```

**Por qué el pedido nace sin el descuento y se rebaja después.** Al revés —
descontar primero y cobrar los puntos después — dos checkouts simultáneos del
mismo cliente pasarían los dos la validación de saldo y el segundo se quedaría
con un pedido barato y ningún punto gastado: dinero regalado. Con este orden,
quien pierde la carrera simplemente paga precio completo, y la tienda se lo
dice (`rewardsNoAplicado` → aviso en la pantalla de éxito).

**El navegador nunca decide un descuento.** Manda una intención ("quiero usar
N puntos"). El servidor recalcula módulo, programa, canal, cuenta *de este
negocio*, múltiplos de `canje_minimo`, saldo y tope contra el total del
pedido, y **recorta hacia abajo**. Nunca hacia arriba. Un `rewardsPuntos:
999999` contra un pedido de $30 descuenta, como mucho, $30.

**Orden de aplicación en el total** (el mismo que el POS):

```
subtotal (productos + modificadores)
  − promociones / cupones
  + envío
  − canje Rewards
  = total
```

**Devoluciones de puntos**:

- Pedido cancelado desde el panel → `revertirMovimientosFolio` (ya existía).
- Checkout abandonado cuyo pago expira → el expirador cancela el pedido dentro
  de una transacción de dinero, donde un programa de lealtad no tiene nada que
  hacer. Lo recoge un **barrido en segundo plano**
  (`reconciliarCanjesDePedidosCancelados`, cada 5 min): busca pedidos
  cancelados con el canje vivo y los revierte. Idempotente: correrlo mil veces
  no mueve un punto de más.

## 6. Aislamiento multiempresa

- El negocio se resuelve **siempre desde el slug de la URL**. Nunca se acepta
  un `negocio_id` del navegador.
- La cuenta se busca por `(telefono, tenant_id)`. Un saldo del negocio B es
  invisible e inutilizable en la tienda del A — probado en las dos direcciones
  (no se muestra, no se gasta, y comprar en A no toca el saldo en B).
- **Doble validación** de negocio: `planDeCanje` la hace al leer, y
  `registrarCanje` la vuelve a hacer bajo el lock. Quitar una de las dos no
  rompe el aislamiento; hacen falta las dos (comprobado con una mordida).
- Cero slugs o IDs de negocio en el código.

## 7. Lo que ve el cliente

En el resumen del checkout, sólo si el negocio tiene Rewards encendido para la
tienda:

- Sin saldo utilizable: `⭐ Esta compra te da N puntos de <programa>`.
- Con saldo: `⭐ Tienes N pts · usa M y ahorra $X` con un botón `＋` para
  aplicarlo, y `Se canjean en bloques de N pts.`
- Aplicado: `⭐ Usando M pts de tus N` con `✕` para quitarlo, y una línea en
  los totales: `<programa> (M pts)  −$X`.
- Si el servidor recortó: `Se ajustó a M pts: es lo máximo que cabe en este pedido.`
- En la pantalla de éxito: `⭐ Usaste M puntos y ahorraste $X`, o el aviso de
  que no se pudieron aplicar.

Todos los números salen del servidor. El frontend no sabe cuánto vale un
punto, ni cuál es el mínimo, ni cuántos caben.

Si el negocio no tiene Rewards encendido para la tienda, `rewards` viene
`null` y **no se pinta absolutamente nada**: la tienda se ve exactamente igual
que antes.

## 8. Auditoría

Cada movimiento en `rewards_movements` responde: negocio (`tenant_id`),
cliente (`account_id` → teléfono), pedido (`folio_venta`), tipo
(`acumulacion` | `canje` | `reverso` | `ajuste_*` | `expiracion`), cantidad
(`puntos`, negativo si sale), saldo previo y posterior, motivo, quién
(`usuario`: `sistema` para la acumulación, `tienda` para el canje de la
tienda, el operador para el POS) y `created_at`. El `metadata` del canje trae
el monto en pesos; el de la acumulación, el canal y el total de la venta.

No se guarda nada personal más allá del teléfono, que es la identidad del
programa.

## 9. Riesgos y deuda conocida

**Oráculo de saldo (aceptado y acotado).** `GET /api/tienda/:slug/rewards` es
público — en la tienda no hay sesión. Mitigado: va bajo el limitador de
checkout (el más estrecho, 20/min por IP por omisión), devuelve sólo cifras de
puntos, y un teléfono sin cuenta responde con la misma forma en ceros. Riesgo
residual: un saldo > 0 revela que ese teléfono compró en ese negocio. Cerrarlo
del todo exige verificar el teléfono (OTP por WhatsApp) antes de mostrar
saldo; es un trabajo aparte y una decisión de producto.

**Sin expiración de puntos.** `rewards_config.vigencia_dias` existe en la
tabla pero nadie la lee. No hay job de expiración. Los puntos no caducan.

**El envío acumula puntos** (ver §4).

**`pendiente_configuracion` no se cura solo.** Un negocio cuyo módulo Rewards
quedó en ese estado (la migración 015 lo deja así cuando encuentra el programa
sin configurar) no puede salir de ahí desde el panel de Rewards: guardar la
configuración no toca `negocio_modulos`. Lo tiene que mover el superadmin.

## 10. Cómo probarlo

```bash
node test/fase-rewards-tienda.mjs
```

39 pruebas: configuración, identidad, acumulación (una sola vez, incluso con
tres acreditaciones simultáneas), canje, topes, aislamiento entre negocios y
entre clientes, concurrencia, convivencia con promociones/envío/modificadores,
cancelación, checkout abandonado y no-regresión de los otros canales.
