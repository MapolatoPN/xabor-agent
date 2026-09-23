# Diagnóstico y plan del corte financiero

## Alcance inspeccionado

- Rama de integración inspeccionada: `integracion/corte-facturacion-20260923`
- Commit de integración previo: `10f0032` (`feat: integrar corte financiero, promociones y facturacion`)
- La verificación se hizo sobre un PostgreSQL local desechable (`xabor-ci-db`); no se desplegó, no se hizo push y no se escribieron datos de producción.

## Evidencia del modelo actual

### POS

`src/server.js` tiene dos caminos: `/api/pos/pedidos` y `/api/pedido-presencial`/`/pedidos/:folio/cobro`.

- El POS recalcula los productos desde `menu_productos`; ahora conserva `precio_lista`, `precio_base`, `precio_canal` y, cuando corresponde, `precio_especial` en `src/services/posEnvios.js`.
- `/api/pos/pedidos` guarda el total combinado de promociones automáticas y descuento manual, además de `motivo_descuento`, tipo, valor y usuario autorizador.
- El cobro presencial exige motivo y pasa por la misma autorización de descuentos que Restaurante. El descuento manual se guarda separado de Rewards.

### Restaurante

`src/services/restauranteService.js` construye una venta en `pedidos_activos` al cerrar la cuenta, con `subtotal`, `descuento`, `motivo_descuento`, tipo, valor, usuario, `total`, propinas y pagos. La autorización vive en `src/services/descuentos.js`; no se reconstruye el descuento desde el catálogo.

### Tienda en línea y promociones

`src/services/tiendaCheckout.js` guarda en `datos.tienda` el envío base, envío gratis, promociones aplicadas, nombre, código, tipo, valor, base de cálculo, acumulabilidad, prioridad y unidades beneficiadas. `src/services/tiendaPromociones.js` calcula el importe en servidor; el navegador no decide el descuento. La tienda usa el precio de canal (`tienda_productos.precio_tienda`) y guarda el precio histórico.

### Rewards

`rewards_movements` es la evidencia durable del canje. El corte lo lee por folio, excluye movimientos revertidos y lo presenta como categoría independiente. El canje presencial también estampa `rewards_canje` y el total neto en `pedidos_activos` para que ledger, venta y corte concilien.

### Corte y periodo

`src/services/cortesCaja.js` calcula el día operativo usando la zona horaria del negocio, excluye pedidos con pago explícitamente pendiente, reconoce cobros tardíos en el día del pago y congela toda la respuesta en `snapshot_json` al cerrar. `panel/index.html` muestra la zona del negocio al renderizar fechas y consulta el desglose desde ese snapshot.

## Qué muestra hoy

El nuevo `reporte_financiero` incluye:

- venta bruta antes de descuentos (productos + envío base), con indicador si el bruto histórico no es determinable;
- promociones automáticas, promociones por código, descuentos manuales, no clasificados y total combinado sin sumar Rewards dos veces;
- Rewards separado;
- venta neta cobrada, propinas, envío base/cobrado, devoluciones y ajustes posteriores;
- agrupación por concepto con ventas distintas e importe;
- detalle por folio, fecha/hora en la zona del negocio, canal, regla/porcentaje, importe y usuario cuando existe;
- calidad histórica (`completa`, `parcial`, `no_determinable`) y avisos de brechas.

Los cortes nuevos incluyen el resumen en el panel y en el ticket. Un corte cerrado anterior a este cambio conserva su venta neta firmada, pero se marca sin desglose: no se reconstruyen conceptos con precios actuales.

## Límites históricos explícitos

- Pedidos antiguos que sólo conservan `total` no permiten inferir venta bruta ni motivo; aparecen como no determinables/parciales.
- Un descuento agregado de un canal externo (por ejemplo, Rappi) se muestra como concepto externo no informado, nunca como descuento manual de Xabor.
- Promociones eliminadas o editadas sólo son explicables cuando el pedido guardó su snapshot; no se consulta la promoción vigente para reinterpretar el pasado.
- El JSON legado sólo conservaba una devolución. `migrations/091_devoluciones_venta.sql` crea `venta_devoluciones` append-only y hace backfill de la única evidencia todavía disponible; no puede recuperar aplicaciones que ya fueron sobrescritas antes de la migración.
- Cancelaciones y pagos pendientes no entran en venta cobrada. Devoluciones con pago en efectivo afectan el efectivo esperado; las de tarjeta/enlace no se restan del cajón.

## Ejemplo ficticio

| Concepto | Ventas | Importe |
| --- | ---: | ---: |
| Promoción desayuno | 12 | $480.00 |
| Descuento por cortesía | 3 | $150.00 |
| Descuento por inconveniente | 2 | $80.00 |

Resumen del mismo corte: venta bruta $6,200.00; promociones automáticas $480.00; descuentos manuales $230.00; Rewards $75.00 (separado); venta neta cobrada $5,415.00; propinas $410.00; envío cobrado $180.00; devoluciones $65.00.

Los importes y nombres anteriores son ficticios.

## Cambios preparados y despliegue

1. `src/services/ventaFinanciera.js` normaliza snapshots sin consultar precios actuales y reconcilia componentes.
2. `src/services/cortesCaja.js`, `src/services/ajustesCierre.js` y el panel consumen el mismo periodo, negocio, permisos y zona horaria.
3. `migrations/091_devoluciones_venta.sql` y `scripts/predeploy-091-devoluciones-venta.mjs` crean el ledger append-only y verifican que no cambien conteos de pedidos/ventas.
4. `scripts/predeploy-run-032-033.mjs` ejecuta la 091 antes de atender tráfico del binario nuevo.

## Verificación

Ejecutado sin base de datos:

```text
node --check src/services/database.js
node --check src/services/cortesCaja.js
node --check src/services/ventaFinanciera.js
node --check src/services/rewardsService.js
node --check src/server.js
node test/fase-corte-descuentos.mjs  # 9 pruebas pasaron
git diff --check
```

En la base local aislada también pasaron:

- `test/fase-descuentos-normalizados.mjs`: 26/26;
- `test/fase3a-registro-usos-promociones.mjs`: 31/31;
- `test/fase-cobro-diferido.mjs`: 28/28;
- `test/fase-cortes-caja.mjs`: 39/39;
- `test/fase-facturacion-por-negocio.mjs`: 39/39, usando una clave Base64 efímera sólo para la prueba.
- predeploy 087/088/090/091: aplicados/verificados en la base desechable sin cambiar conteos del camino crítico.

La revisión de producción fue únicamente de lectura. Confirmó que el binario actualmente desplegado aún no tiene todas las tablas/columnas de las migraciones 087, 088, 090 y 091; por eso no se activa este cambio hasta ejecutar el predeploy en una base dedicada, revisar el backfill y validar canario.
