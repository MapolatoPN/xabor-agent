# Ajustes de Cierre Semanal (conciliación)

**Estado:** implementado y probado en local (commits `28a8c3b`, `42c3b3f`,
`12eb00a`), SIN desplegar. Incluye la migración **065** (no destructiva).

## Qué resuelve

Al cierre de semana el negocio necesita revisar las ventas **no facturadas**
y registrar descuentos, bonificaciones, cortesías, devoluciones o ajustes
administrativos — sin reescribir jamás la venta original ni los cortes.

Pestaña **Ajustes** del panel (admin + módulo `caja`): selector de semana
operativa, resumen (ventas / facturadas bloqueadas / no facturadas /
ajustado / neto), tabla con selección múltiple, vista previa con
confirmación explícita, lista de ajustes con reversión y CSV.

## Principios (invariantes)

1. **Venta original inmutable.** El módulo NUNCA escribe en
   `pedidos_activos`, `pagos`, `cortes_caja` ni `movimientos_caja` (hay un
   test de contrato de fuente que lo vigila). Un ajuste es un renglón en
   `ajustes_cierre` con `monto_original` (base al momento), `monto_ajuste` y
   `monto_neto`; la aritmética la garantiza un CHECK de la base
   (`neto = original − ajuste`, `neto ≥ 0`).
2. **Facturada = bloqueada.** Fuente: `facturas_pedido` (ver abajo). Se
   valida en la vista previa Y OTRA VEZ dentro de la transacción de
   confirmación: si alguien facturó entre una y otra, el **lote completo**
   se rechaza (409 `FACTURADA_TRAS_PREVIEW`, folio señalado) — lo que el
   operador confirmó fue la vista previa completa, no una versión recortada.
3. **Cortes cerrados intactos.** El ajuste es una capa administrativa
   posterior con su propio reporte; ningún snapshot se reescribe.
4. **Reversión, jamás borrado.** `estado='revertido'` con actor, motivo y
   fecha; el renglón queda como constancia (cero `DELETE` en el módulo).
5. **Semana operativa** = lunes–domingo en la zona horaria DEL negocio
   (mismo kit que los cortes: una venta del domingo 23:40 hora local
   pertenece a su semana aunque en UTC ya sea lunes). Fecha provista pero
   malformada → 400, jamás caer en silencio a "hoy".
6. **Fail-closed histórico.** Tres categorías de facturación, no dos:
   `FACTURADA` (en `facturas_pedido`), `NO_FACTURADA_VERIFICABLE` y
   `HISTORICA_NO_VERIFICABLE`. Solo la segunda (y cobrada) es elegible.

## Frontera de facturación confiable (fail-closed)

Antes de que `facturas_pedido` empezara a registrar emisiones no existe un
vínculo confiable pedido→CFDI (ver la auditoría del gate). Por eso una venta
anterior a esa frontera **no** se trata como "no facturada": es
`HISTORICA_NO_VERIFICABLE` — visible pero **no seleccionable ni ajustable**,
y contada aparte del "no facturadas".

- **Configuración:** clave `ajustes_facturacion_confiable_desde` en la tabla
  `configuracion`, **por negocio** (no hay tabla de settings nueva).
- **Formato e interpretación:** un instante ISO-8601 en **UTC** (p. ej.
  `2026-08-27T14:32:00Z`). Una fecha desnuda `YYYY-MM-DD` se interpreta como
  **medianoche UTC** de ese día. Se compara contra `pedidos_activos.created_at`,
  que también es un instante UTC — **comparación de instantes, sin
  ambigüedad de zona horaria**. Una venta es histórica si `created_at <`
  frontera.
- **Default fail-closed:** si la clave **no existe** (o su valor es corrupto),
  la frontera es +infinito: **todas** las ventas no facturadas son
  históricas no verificables y **nada** es elegible. El módulo queda inerte a
  propósito hasta que el rollout fije la clave. **Nunca** se hardcodea una
  fecha en el código.
- **Rollout:** al desplegar, se establece la clave por negocio al instante
  del despliegue del sistema confiable. Un negocio puede adelantar su propia
  frontera más tarde, solo tras una reconciliación manual de su histórico.
- **Bloqueo backend:** `aplicarAjuste` revalida la frontera dentro de la
  transacción; un intento sobre una histórica se rechaza con
  `FACTURACION_HISTORICA_NO_VERIFICADA` (HTTP 409). No se confía en el
  frontend: el checkbox deshabilitado es solo cortesía visual.

## Tipos y modos de ajuste

- Tipos: `descuento`, `bonificacion`, `cortesia`, `devolucion`, `ajuste`.
- **Fijo:** monto **por ticket** (multi-selección; p. ej. $5 a 12 tickets =
  12 renglones de $5 con el mismo `lote_id`).
- **Porcentual:** **individual** (una venta a la vez, sobre su neto
  disponible) — decisión de producto.
- Acumulables: el disponible descuenta ajustes previos; `EXCEDE_NETO`
  impide que el neto quede negativo (también bajo concurrencia: `FOR
  UPDATE` serializa commits simultáneos).

## Fuente de facturación (hallazgo de auditoría + brecha)

**Antes de este cambio Xabor no tenía ninguna fuente por ticket** del hecho
"esta venta ya tiene CFDI": la emisión (Facturapi, vía el modal del panel o
el agente de WhatsApp) devolvía el UUID al cliente y lo descartaba; la
tabla `invoices` solo contiene CFDIs DESCARGADOS del SAT, sin enlace a
pedidos.

- **`facturas_pedido` (065):** un renglón por emisión, registrado en los
  DOS caminos existentes en el momento de emitir (el único punto veraz).
  `registrarFacturaEmitida` nunca lanza: la factura ya existe en el
  proveedor; si el registro local falla queda log CRÍTICO.
- **Brecha 1 (histórico):** facturas emitidas ANTES de este cambio no
  tienen registro y NO se reconstruyen adivinando (cruzar `invoices` por
  monto/fecha sería inventar el enlace). Aparecerán como no facturadas.
- **Brecha 2 (facturación posterior al ajuste):** si una venta ajustada se
  factura después, el CFDI sale con los datos originales del pedido.
  Integrar el monto ajustado a la factura requeriría tocar la generación de
  CFDI — fuera de alcance a propósito (STOP documentado). El reporte marca
  esas ventas con `revisar_manual` (⚠️ en la UI, columna en el CSV) para el
  contador.

## Piezas

- `migrations/065_ajustes_cierre.sql` (+down): `facturas_pedido`,
  `ajustes_cierre`. Idempotente, no destructiva.
- `src/services/ajustesCierre.js`: semana operativa, `ventasDeSemana`,
  `previewAjuste`/`aplicarAjuste` (mismo evaluador en ambas fases),
  `revertirAjuste`, `csvSemana` (BOM para Excel, escape RFC de
  comas/comillas).
- `src/server.js`: `/api/admin/ajustes-cierre/{semana, preview, aplicar,
  revertir, semana.csv}` (`requireAdminSeguro` + módulo `caja`; 400 con
  código, 409 con rechazos estructurados).
- `panel/index.html`: pestaña "Ajustes" (admin). En error o conflicto la UI
  recarga el estado real.

## Pruebas

`test/fase-ajustes-cierre.mjs` — 31 casos (26 del gate + 5 adversariales)
sobre un fixture de 100 ventas de $100 (20 facturadas / 10 abiertas / 70
elegibles) más bordes de semana, tenant y zona horaria. Corrida doble con
código de salida verificado; regresión de cortes, vision, agrupamiento y
superadmin en verde. Flujo completo también ejercitado en vivo sobre la UI
(selección → preview → confirmar → lista con reversión).
