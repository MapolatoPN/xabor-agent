# Fase 2 — Normalizar descuentos en todos los canales de Xabor

**Rama:** `fase2-normalizar-descuentos` (worktree dedicado, partiendo del HEAD
real de producción `4032111` — ver §1 del handoff)
**Fecha:** 22 de septiembre de 2026
**Estado:** implementado y probado, **sin commitear**.

## Objetivo

Hoy cada canal guarda el descuento de un pedido con su propia forma dentro
de `pedidos_activos.datos`. Esta fase introduce un bloque común
`datos.descuentos` — **aditivo, dual-write**: los campos legacy no se tocan,
se sigue escribiendo todo lo de siempre y además se escribe el bloque nuevo.

## 1. Mapa completo — quién escribe descuentos hoy

| Canal | Archivo/función | Dónde calcula | Qué guarda hoy (legacy) | Cuándo | Quién lo lee |
|---|---|---|---|---|---|
| **POS** (mostrador, inmediato) | `server.js:6822` `POST /api/pos/pedidos` → `posEnvios.js:94 construirOrdenPOS` | Manual (`body.descuento`) + promocional (`tiendaPromociones.calcularPromociones`, canal `pos`), sumados y topados a subtotal | `datos.descuento` (número combinado), `datos.promociones[]` (**solo** la parte del motor: `{id,nombre,tipo,descuento,unidades,codigo}`) | Al crear (síncrono) | Panel, comanda, ticket, `cortesCaja.js` |
| **POS clásico** (crear=cobrar) | `server.js:3516` `POST /api/pedido-presencial`, rama `!esPorCobrar` | 100% manual, **sin** `autorizarDescuento` (no valida motivo/límite — hallazgo preexistente, no se toca) | `datos.descuento`, `datos.motivo_descuento` | Al crear | Igual que POS |
| **POS abierto** (por_cobrar) | mismo endpoint, rama `esPorCobrar` | Nada — nace en 0 | `datos.descuento = 0` | Al crear | — |
| **POS cobro** | `server.js:3670` `PATCH /pedidos/:folio/cobro` | Manual con `autorizarDescuento` real (única autorización de verdad entre los 4 canales con manual) + Rewards (`registrarCanje`) | `datos.descuento`, `datos.motivo_descuento`, `datos.rewards_canje{puntos,monto}` | Al cobrar | Igual que POS |
| **Restaurante/mesas** | `restauranteService.js:1041 cerrarCuenta` | 100% manual vía `aplicarDescuentoCuenta` (línea 470) — único canal con `tipo` (porcentaje/importe) **y** `autorizadoPor` reales | `datos.descuento`, `datos.motivo_descuento`, `datos.descuento_tipo/valor/por` | Al cerrar cuenta | Igual, + historial de mesas |
| **WhatsApp legacy** | `channels/whatsapp-meta.js:1361` → `orderManager.js registrarPedido(orden,'whatsapp')` → `orders/validadorOrden.js validarOrdenPropuesta` | 100% promocional (`calcularPromociones`), el modelo **nunca** aplica descuento — se ignora si lo intenta (`descuento_ignorado`) | `datos.descuento`, `datos.promociones[]` | Al confirmar | Igual |
| **Mesero/agente nuevo** | `mesero-agente/canalDelAgente.js confirmarYEmitir` → `registrar(orden,'whatsapp')` → **el mismo** `validadorOrden.js` | Idéntico al legacy — comparten el mismo gate (`CANALES_ORDEN_LLM` incluye `whatsapp`); `ordenDesdeElCarrito` nunca pone `descuento` | Idéntico al legacy | Al confirmar | Igual |
| **Tienda en línea** | `services/tiendaCheckout.js` (creación ~L795) | 100% promocional (`calcularPromociones`, canal `tienda_online`) + Rewards (`consumirCanjeDeTienda` → `registrarCanje`, **después** de crear) | `datos.tienda.promociones[]` (incluye envío gratis, con `descuento`/`envio_gratis`), `datos.rewards_canje{puntos,monto}` (parche post-hoc) | Promo al crear; Rewards después | Igual, + `tienda_pedidos` |
| Rappi | `channels/rappi.js:281-303` | El propio proveedor manda `total_discounts` | `datos.descuento` (externo, no pasa por el motor) | Al recibir webhook | Igual |
| Rewards (transversal) | `services/rewardsService.js registrarCanje` | Llamado desde 3 sitios: POS clásico, POS cobro, tienda (`consumirCanjeDeTienda`) | `rewards_movements` (fuente única, channel-agnostic — la que ya usa el corte de Fase 1) | Variable por canal | `cortesCaja.js`, panel Rewards |

**Nota sobre Rappi:** existe, se documenta, **no se toca** — fuera de
alcance explícito (§8 del handoff: "NO Rappi").

## 2. Contrato: `datos.descuentos`

```js
{
  manual: {
    monto: number,            // siempre presente, 0 si no aplica
    tipo: 'porcentaje' | 'importe' | null,
    motivo: string | null,
    autorizadoPor: string(uuid) | null,
  },
  promociones: [
    { promocionId: number|null, nombre: string|null, monto: number, tipo: string|null, codigo: string|null },
  ],
  rewards: { monto: number, puntos: number },
  total: number,
}
```

**Invariante (verificada, `test/fase-descuentos-normalizados.mjs`):**
```
total === dinero(manual.monto + sum(promociones[].monto) + rewards.monto)
```
Sostenida por construcción: cada canal solo llena la fuente que
**efectivamente** aplicó (ver mapa) — nunca hay doble conteo real entre las
tres, salvo la combinación legítima manual+promo del POS, cubierta por el
"residuo" (ver §3).

**Campos obligatorios** (nunca `undefined`): `manual.monto`, `promociones`
(array, puede ser `[]`), `rewards.monto`, `rewards.puntos`, `total`.
**Campos opcionales** (`null` si el canal no lo tiene, nunca inventados):
`manual.tipo`, `manual.motivo`, `manual.autorizadoPor`, y por promoción
`promocionId`/`tipo`/`codigo`.

### Ejemplos reales por canal

- **POS con descuento manual sin promo:** `{manual:{monto:20,tipo:null,motivo:null,autorizadoPor:null}, promociones:[], rewards:{monto:0,puntos:0}, total:20}`
- **Restaurante con descuento autorizado:** `{manual:{monto:20,tipo:'porcentaje',motivo:'mesa fase2',autorizadoPor:'<uuid admin>'}, promociones:[], rewards:{monto:0,puntos:0}, total:20}`
- **WhatsApp/Mesero con promo:** `{manual:{monto:0,...null}, promociones:[{promocionId:7,nombre:'2x1',monto:100,tipo:'2x1',codigo:null}], rewards:{monto:0,puntos:0}, total:100}`
- **Tienda con promo + Rewards:** `{manual:{monto:0,...null}, promociones:[{...,monto:40}], rewards:{monto:25,puntos:50}, total:65}`

## 3. Doble conteo — cómo se evita en el POS (único canal con manual+promo)

`server.js`'s `/api/pos/pedidos` combina manual+promo y **topa** la suma al
subtotal (`descuentoTotal = Math.min(subtotal, descuentoManual + descuentoPromo)`,
comportamiento preexistente, no tocado). Para que `descuentos.total` **nunca
diverja** del `descuento` legacy incluso en ese caso extremo, el bloque
nuevo calcula `manual.monto` como el **residuo** contra el total ya topado:
`manual = descuentoTotal - promoTotal` (nunca negativo). Promociones se
queda con el monto exacto que el motor ya calculó (nunca se topa). Probado
explícitamente (`[POS] J. doble conteo`).

## 4. Dual-write: qué NO se tocó

Ningún campo legacy se eliminó ni se renombró. `datos.descuento`,
`datos.motivo_descuento`, `datos.promociones[]`, `datos.descuento_tipo/valor/por`,
`datos.tienda.promociones[]`, `datos.rewards_canje` — todos siguen
escribiéndose exactamente igual. Un pedido creado por esta rama es
consumible sin cambios por panel, comanda, ticket, historial y el corte de
Fase 1 (verificado: las 289 pruebas existentes de esos módulos pasan sin
modificación).

## 5. El normalizador — reutilizado, no duplicado

`construirDesgloseDescuentos()` vive en `src/services/descuentos.js`
(el mismo archivo que ya tenía `autorizarDescuento`/`calcularMontoDescuento`
— no se creó un archivo nuevo). Es una función **pura**: sin `await`, sin
`pool`, sin `req`. Acepta `p.descuento` como alias de `p.monto` en el
arreglo de promociones para no obligar a cada canal a remapear el campo que
ya trae el motor de promociones.

## 6. Gap preexistente descubierto durante las pruebas (no es de esta fase)

`POST /api/admin/pedido/:folio/cancelar` no solo marca `estado='cancelado'`:
llama a `eliminarPedido()` (`orderManager.js:925`), que hace un
`DELETE FROM pedidos_activos` real (vía `database.js eliminarPedido`, con
nombre idéntico a la función homónima de `orderManager.js` que solo actúa
en memoria — dos funciones distintas, mismo nombre, en módulos distintos).
Un pedido cancelado **no queda** en `pedidos_activos` como fila con
`estado='cancelado'`; se retira por completo. Esto es consistente con "un
cancelado no cuenta en el corte" (ya no hay fila que contar), pero es
distinto de lo que documentación anterior daba a entender. No se tocó —
documentado para que nadie más lo redescubra a la mala.
