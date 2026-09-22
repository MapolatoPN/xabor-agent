# Corte de caja: descuentos, promociones y Rewards — Fase 1

**Rama:** `worktree-promos-descuentos-corte` (worktree separado, partiendo de `main`)
**Fecha:** 22 de septiembre de 2026
**Objetivo del dueño:** administrar promociones y descuentos, y saber al
cierre del día cuánto del ingreso se fue en ellos.

## Qué hace esta fase

El corte de caja (`cortesCaja.js`, `GET /api/corte-caja`, ticket térmico,
reporte diario de WhatsApp y panel) ahora muestra, además de las ventas por
forma de pago:

- **Descuento manual** — lo que un cajero/mesero tecleó a mano (motivo
  obligatorio, staff ≤10%, admin sin límite).
- **Descuento promocional** — lo que otorgó el motor de promociones
  (`tiendaPromociones.calcularPromociones`), sin intervención humana.
- **Rewards canjeados** — puntos aplicados como descuento en pedidos del día.

Los tres son **informativos**: ya están incluidos dentro de `total` /
`ventas_totales`. Sumarlos no cambia `efectivo_esperado` ni el arqueo — es
el mismo cuidado que exige la invariante 2 de `cortesCaja.js` (ventas del
periodo ≠ dinero físico).

## De dónde sale el dato

`pedidos_activos.datos.descuento` es un solo número por pedido que mezcla
manual y promocional según el canal:

| Canal | `descuento` es… | Cómo se separa |
|---|---|---|
| POS (`/api/pos/pedido`) | manual + promocional, sumados | `datos.promociones[]` trae SOLO la parte del motor; el resto es manual |
| Restaurante (`restauranteService.js`) | 100% manual | no hay `promociones[]`; todo es manual |
| WhatsApp / agente (`validadorOrden.js`) | 100% promocional | el modelo NUNCA aplica descuento; lo que hay siempre viene de `promociones[]` |
| Tienda en línea (`tiendaCheckout.js`) | 100% promocional | anidado en `datos.tienda.promociones[]`, no al nivel de `datos` |

`calcularCorteVivo` suma `promociones[].descuento` (o `tienda.promociones[]`
si no hay arreglo al nivel de `datos`) y llama a eso "promocional"; el
residuo contra `datos.descuento` es "manual". Clamp defensivo: la parte
promocional nunca excede el descuento total del pedido, así el manual nunca
sale negativo.

Rewards se lee de `rewards_movements` (no de `datos`), uniendo por folio con
`pedidos_activos` del rango del día — es la única fuente que no depende del
formato de cada canal, y excluye automáticamente canjes de pedidos
cancelados (el folio simplemente no está en el conjunto del día).

## Migración

`088_cortes_descuentos_promociones.sql` — agrega tres columnas nullable-por-
DEFAULT a `cortes_caja`: `descuento_manual`, `descuento_promocional`,
`rewards_canjeados`. No destructiva, no toca `pedidos_activos` ni cambia
`efectivo_esperado` de ningún corte existente.

**Numeración:** salta de la 078 (última en `main`) a la 088, por encima de
la más alta conocida en cualquier rama viva (087, sin commitear en
`rescue/mesero-tool-agent` al momento de escribir esto) — para no chocar
cuando esta rama y esa se junten.

**Cortes ya cerrados antes de esta migración** quedan con las tres columnas
en 0 — no se reconstruyen retroactivamente (invariante: un corte cerrado
nunca se recalcula).

## Qué NO cubre esta fase (documentado a propósito)

- **Envío regalado por promociones de envío gratis.** El POS descarta esa
  información al armar el pedido (filtra `envioGratis` del arreglo de
  promociones y nunca pone `costo_envio` en 0 cuando el motor lo autoriza);
  solo la tienda en línea conserva el dato completo. Falta unificar antes de
  poder contabilizarlo con confianza.
- **Separar manual/promocional/Rewards en la administración de promociones**
  (`/api/admin/tienda/metricas`, `tiendaPromociones.listarPromociones`) —
  hoy solo cuenta lo que pasó por la tienda en línea; POS y WhatsApp/agente
  no registran uso en `tienda_promocion_usos`, así que los límites de uso y
  las métricas por promoción no ven esos canales. Es una fase aparte porque
  toca el camino de creación de pedidos, no solo lectura.
- **Un formato único** para `datos.descuento` — sigue habiendo tres formas
  distintas de guardar el desglose según el canal; esta fase las lee todas,
  pero no las unifica.

## Verificación

Contra una base Postgres desechable (migraciones 001-078 de `main` + 088),
con datos sintéticos de los cuatro canales, un pedido abierto (`por_cobrar`)
y un pedido cancelado con descuento y canje: `descuento_manual`,
`descuento_promocional` y `rewards_canjeados` salieron correctos, excluyendo
correctamente el pedido abierto y el cancelado (incluido su canje asociado).
`cerrarCorte` los persiste; `ticketCorte` los imprime.

Las suites existentes `test/fase-cortes-caja.mjs` (38/38) y
`test/fase-cobro-diferido.mjs` (28/28) pasan sin cambios sobre el mismo
esquema — no hay regresión en el cálculo de ventas, arqueo ni cobro
diferido.

## Archivos tocados

- `migrations/088_cortes_descuentos_promociones.sql` (+ `_down`)
- `scripts/predeploy-088-cortes-descuentos-promociones.mjs`
- `src/services/cortesCaja.js` — cálculo, cierre y ticket
- `src/server.js` — `GET /api/corte-caja` (rama cerrado) y reporte diario WhatsApp
- `panel/index.html` — tarjeta en el corte del día + columna en el histórico

## Siguiente paso sugerido

Fase 2: registrar el uso de promociones desde POS y WhatsApp/agente (no solo
tienda en línea), para que límites de uso y métricas por promoción reflejen
todos los canales. Toca `orderManager.js` y las rutas `/pedidos` — requiere
tu aprobación explícita por ser camino crítico (CLAUDE.md).
