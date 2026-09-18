# Impresión de pedidos por Edge: fallback, rastro durable y «Reenviar a cocina»

Entrega pequeña sobre la tubería que ya existía y ya funcionaba en
producción (`pedido pagado → servidor → impresion_trabajos → Xabor Edge →
impresoras`). No cambia el motor de ruteo, la idempotencia de los trabajos
ni el flujo de pago. Rama `feat/impresion-edge-robustez`.

Diagnóstico previo (18-sep-2026, Mapolato Obispado): desde que Edge quedó
configurado (15-sep 13:48 UTC) los pedidos pagados de la tienda generan sus
trabajos en el mismo segundo del `paid_at`, se entregan al Edge de inmediato
y el Edge confirma en 2 a 5 s, sin duplicados. Los 29 pedidos pagados sin
comanda física son anteriores a esa configuración: en ese periodo la comanda
dependía de que el panel estuviera abierto en un navegador, y nadie se
enteraba cuando no lo estaba. Esta entrega cierra ese silencio.

## 1. El fallback de comanda es UNA impresora

La regla `documento:comanda` es el **default** del motor: un ítem sin regla
de categoría ni de producto sale en todas las impresoras que la tengan. El
panel (Config → Impresoras) la crea en cada impresora a la que se le asigna
el destino «Cocina», así que tres impresoras en «Cocina» son tres copias de
cualquier producto desconocido.

Principio: producto con regla específica → su estación; producto sin regla →
solo Cocina; nunca las tres estaciones.

`scripts/impresion-fallback-solo-cocina.mjs` lo deja así por negocio:

```
DATABASE_URL=… node scripts/impresion-fallback-solo-cocina.mjs --negocio <uuid> --cocina "COCINA"            # dry-run
DATABASE_URL=… node scripts/impresion-fallback-solo-cocina.mjs --negocio <uuid> --cocina "COCINA" --aplicar  # ejecuta
```

Audita las reglas, proyecta con el motor real a dónde iría un ítem sin regla
y, con `--aplicar`, borra en una transacción las `documento:comanda` que no
sean de la impresora indicada, verificando antes de confirmar. Nunca toca
reglas de categoría o producto, nunca crea reglas (si Cocina no tiene la
suya, aborta y pide asignarla desde el panel). Idempotente.

Mapolato hoy: `documento:comanda` en Bebidas, Chilaquil y COCINA; las
categorías EXTRAS, COMIDAS y ENVIO no tienen regla y salen en las tres.
Tras el script: solo COCINA. Ojo: volver a asignar «Cocina» a Bebidas o
Chilaquil desde el panel recrea el fallback en esa impresora.

## 2. Rastro durable: `datos.impresion_edge`

Cada vez que un pedido intenta salir por Edge (`src/printing/edgeComanda.js`)
queda en el pedido:

```json
{ "estado": "creado", "trabajos": 3, "duplicados": 0,
  "impresoras": ["Bebidas", "Chilaquil", "COCINA"], "sin_ruta": [], "avisos": [],
  "error": null, "alerta": false, "at": "2026-09-18T…" }
```

Estados: `creado` (al menos un trabajo nuevo), `ya_existia` (reemisión: los
trabajos ya estaban), `sin_trabajos` (nada tenía destino), `error` (no se
pudo intentar). `alerta` es `true` cuando el negocio **sí** tiene impresoras
activas y aun así salieron cero trabajos: entonces hay `console.error`
(`COMANDA SIN PAPEL: el pedido …`), evento WS `impresion_sin_trabajo` al
panel, aviso arriba del tablero y la tarjeta en rojo («⚠ Sin comanda en
Edge»). Con trabajos, la tarjeta muestra «🖨 Edge · Bebidas, COCINA». Un
negocio sin impresoras no recibe alertas: imprime desde el navegador como
siempre.

El rastro viaja en el mismo `nuevo_pedido` que recibe el panel y se fusiona
sobre lo que hubiera (los reenvíos no lo borran).

## 3. «Reenviar a cocina»

`POST /api/pedidos/:folio/reenviar-cocina` (solo admin; botón en la tarjeta
del tablero y en el historial). Rutea el pedido con las reglas **vigentes**
por la misma tubería que la comanda original y crea trabajos nuevos:

| Campo | Valor |
|---|---|
| `origen_tipo` | `pedido_reimpresion` |
| `origen_id` | `<folio>#<n>` (n = número de reenvío) |
| `idempotency_key` | `negocio:pedido_reimpresion:<folio>#<n>:<impresora>` |
| `trabajo_original_id` | el trabajo original de esa impresora, si existe |
| `reimpreso_por`, `motivo`, `created_at` | quién, por qué y cuándo |

Lo que **no** hace: registrar el pedido otra vez, tocar `pagos`,
`compras_reales`, Rewards ni el estado del pedido, ni pasar por
`emitirPedido`. Un pedido `pendiente_pago` responde 409 (`PAGO_PENDIENTE`),
uno cancelado 409, uno inexistente 404. Dos clics en menos de 15 s son un
solo reenvío (`repetido: true`, bajo advisory lock por pedido). El pedido
recuerda `impresion_edge.reenvios` y `ultimo_reenvio`.

## Pruebas

`test/fase-tienda-impresion-edge-e2e.mjs` (13 casos, servidor real, Edge
falso por WebSocket, panel en Chrome): checkout → `pendiente_pago` sin papel
→ confirmación → una comanda por estación (Café→Bebidas,
Chilaquiles→Chilaquil, Hotcakes→COCINA) → producto sin regla SOLO en COCINA →
rastro y `impresionEdge: true` en el panel → cinco confirmaciones repetidas
no duplican → reemitir el pedido (recuperación tras crash) da duplicados, no
trabajos → reenvío con quién y cuándo, sin pedido nuevo ni pagos tocados
→ ventana anti doble clic → 403/409/404 → comanda sin destino con alerta,
log y aviso → tarjeta con rastro, botón y aviso en el navegador → Edge
desconectado deja trabajos recuperables que llegan una sola vez → reconectar
no reentrega.

Mordidas (4/4 detectadas): quitar la resolución de categoría, quitar la
idempotencia del trabajo, mandar el fallback a todas las impresoras, y una
reimpresión que crea un pedido nuevo ponen en rojo exactamente sus casos.

Pre-existente y fuera de esta entrega: `fase-comanda-edge-exclusiva` tiene 5
casos [PANEL] que fallan igual con el panel de producción
(`upsertPedidoEnTablero is not defined`: extraen `agregarPedido` del HTML y
esa función hoy delega en `tableroEventos.js`).

## Pedidos viejos (Mapolato)

XAB-0288, 0308, 0309, 0311 y 0325: pagados por Clip entre el 9 y el 13 de
septiembre (ledger `pagado`, derivación saldada, compra real registrada),
sin trabajo Edge porque Edge no existía, y todavía en estado `nuevo`. Las
ventas y el corte no cambian al cerrarlos: se calculan por `created_at` y
`estado <> 'cancelado'`, así que ya cuentan. Cerrarlos desde el panel
dispararía `acumularPuntos` (Rewards tiene `canal_tienda` encendido en
Mapolato y esos cinco teléfonos no tienen cuenta: se crearían cuentas y
puntos hoy). La acción mínima sin efectos secundarios es un UPDATE directo
de `estado` a `entregado`, sin tocar `updated_at` ni `entregado_at`, tras
confirmar con el restaurante que sí se sirvieron.
