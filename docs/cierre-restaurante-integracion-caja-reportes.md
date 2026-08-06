# Cierre — Integración restaurante → caja y reportes

Fase: `feat/restaurante-integracion-caja-reportes` (base `6edd51e`).
Principio rector: **las comandas sirven para cocina; el cierre de una cuenta
genera una sola venta consolidada para caja y reportes.**

## 1. Diagnóstico del modelo contable actual

- **Fuente de verdad de ventas**: `pedidos_activos`. `obtenerVentas` y
  `obtenerResumenVentas` (src/services/database.js) leen folio/estado y el
  JSONB `datos` (total, canal, modalidad, forma_pago, items, devolución,
  cancelación) filtrando `estado != 'cancelado'` y `negocio_id`. La tabla
  `pedidos` es historial por cliente; NO alimenta los reportes.
- **Fuente de verdad de caja**: no existe apertura/corte formal. Lo único
  que hay es el **fondo de caja** diario (`/api/caja/fondo`, migración 009):
  un monto por fecha y negocio. "Sin caja abierta" no es un estado que el
  sistema pueda detectar — el corte operativo se hace hoy con el resumen de
  ventas del día + el fondo.
- **Métodos de pago**: catálogo `metodos_pago` por negocio (migración 025);
  en ventas queda `datos.forma_pago` (texto). El resumen NO agrega por
  método.
- **Folios**: contador en memoria `XAB-####` (orderManager), re-sembrado al
  arrancar con `obtenerMaxFolioNum()` + los activos cargados.
- **Impresión**: solo se dispara vía `emitirPedido`/`emitirTrabajoImpresion`;
  insertar una fila en `pedidos_activos` JAMÁS imprime.
- **Tablero**: `obtenerPedidosActivos` filtra `estado != 'entregado'`; una
  fila que nace `entregado` nunca entra al tablero ni al arranque.
- **Riesgo de insertar una cuenta en `pedidos_activos`**: (1) romper el
  contador XAB si el folio no se excluye del CAST de `obtenerMaxFolioNum`
  (corregido en esta fase), (2) aparecer en tablero/central de reparto/D.1
  (evitado con estado `entregado`, modalidad `mesa`, canal
  `restaurante_mesa`), (3) duplicarse en reintentos (evitado con folio
  determinista + ON CONFLICT).

## 2. Arquitectura seleccionada: Opción B (adaptador a la fuente actual)

Al cerrar la cuenta, en la **misma transacción** se inserta **una** fila
consolidada en `pedidos_activos`:

- `folio = RM-<8 hex del id de cuenta>-<reversos>` (determinista).
- `estado = 'entregado'`, `entregado_at = NOW()` → invisible para tablero,
  cocina, OrderManager, central de reparto y métricas D.1.
- `datos`: `origen:'restaurante'`, `canal:'restaurante_mesa'`,
  `modalidad:'mesa'`, mesa, personas, mesero, `cuenta_id`, items activos,
  `total` (recalculado en SQL sobre NUMERIC), `propinas` (separadas),
  `forma_pago` (método único o `'mixto'`), `pagos[]` por método con monto y
  propina.
- `negocio_id` de la sesión/cuenta — nunca del payload.

**Por qué no la Opción A (entidad de venta propia)**: obligaría a que caja y
reportes consuman dos fuentes; cada reporte existente (periodo, resumen,
método, producto) tendría que reescribirse y mantener dos verdades — máximo
riesgo de descuadre entre caja y reportes.

**Por qué no la Opción C (evento contable)**: no existe una capa contable
común en el sistema; inventarla para esta fase agrega una pieza nueva de
infraestructura sin reducir ninguno de los riesgos (la venta igualmente
tendría que materializarse donde los reportes leen).

## 3. Exactly-once (reglas 1, 11, 12, 13)

- **Atómico**: cierre de cuenta + inserción de venta en una sola
  transacción con `FOR UPDATE`. Si falla la venta, la cuenta no cierra; si
  falla el cierre, la venta no queda.
- **Sin duplicados**: folio determinista + índice único
  `idx_restaurante_venta_folio` + `ON CONFLICT (folio) DO NOTHING`. Un
  reintento (doble clic, timeout, respuesta perdida) re-produce el mismo
  folio y aterriza en la misma fila.
- **Reintento idempotente**: si la cuenta ya está cerrada y contabilizada,
  `cerrarCuenta` responde `{ok, yaCerrada:true, ventaFolio}` (200, no
  error) — la UI muestra el folio existente.
- **Saldo cero obligatorio** antes de cerrar (tolerancia medio centavo);
  totales SIEMPRE recalculados en servidor; el dinero se agrega con SUM
  sobre NUMERIC en SQL — nunca aritmética flotante de totales del cliente.

## 4. Migración 040 (`040_restaurante_integracion_ventas`)

Aditiva, reejecutable, reversible, sin backfill:

- `restaurante_cuentas.venta_folio TEXT NULL`
- `restaurante_cuentas.contabilizada_at TIMESTAMPTZ NULL`
- `restaurante_cuentas.reversos INT NOT NULL DEFAULT 0`
- Índice único parcial sobre `venta_folio`.

`_check` y `_down` incluidos; `predeploy-040-…` integrado al runner después
de 039 (detecta-aplicada → no-op; al aplicar verifica cero cuentas
contabilizadas — sin backfill). El `_down` NO toca las ventas ya insertadas
en `pedidos_activos` (son ventas reales).

## 5. Política de folios

- La cuenta no tiene folio propio de cara al cliente; su identidad es la
  mesa + id interno.
- La venta consolidada usa el folio `RM-…` en caja, reportes, ticket final
  y auditoría — un solo folio visible para la misma venta.
- El prefijo `RM-` no toca el contador `XAB-`: `obtenerMaxFolioNum` ahora
  solo cuenta folios `^XAB-[0-9]+$` (antes, cualquier folio no-XAB rompía el
  CAST y el catch reseteaba el contador a 0 → colisiones tras reinicio;
  corregido en esta fase).
- Tras un reverso, el re-cierre genera folio NUEVO (`…-1`) y el anterior
  queda cancelado con historial — relación visible por `cuenta_id`.

## 6. Caja

No existe apertura/corte formal en el sistema (solo fondo diario). Por lo
tanto:

- La venta consolidada afecta caja exactamente como las demás ventas: entra
  al resumen del día por `created_at`, con `forma_pago` y detalle por método
  en `datos.pagos` para el corte por método cuando exista.
- "No hay caja abierta" no es un estado representable hoy; el cierre de
  cuenta NUNCA se bloquea por caja. Cuando exista un módulo de
  apertura/corte formal, `datos.pagos[]` ya trae el detalle por método
  necesario para asociarla.
- Quién cobra/cierra: staff y admin (mismo criterio del MVP C; la
  separación fina de roles caja/mesero llegará con la arquitectura de roles
  futura).

## 7. Reportes

- La venta aparece UNA vez en `/api/ventas` y el resumen, con
  `canal='restaurante_mesa'`, `modalidad='mesa'` y `datos.origen='restaurante'`
  como filtro de origen (mostrador/WhatsApp/Rappi usan sus canales de
  siempre).
- No cuenta como domicilio ni recoger en el resumen (modalidad `mesa`).
- Las comandas NUNCA aparecen en reportes: viven en
  `restaurante_cuenta_items`, no en `pedidos_activos`.

## 8. Pagos mixtos y propinas

- Cada pago conserva su método; al cierre se agrupan por método
  (`SUM(monto)`, `SUM(propina)` en NUMERIC). `forma_pago` = método único,
  `'mixto'` si hay varios, `'sin pago'` si el total fue $0.
- La propina va SEPARADA (`datos.propinas` y `datos.pagos[].propina`) y no
  se suma al total de la venta. **Decisión pendiente del propietario**: si
  la propina entra al corte, cómo se reparte a meseros y su tratamiento
  fiscal — el sistema solo la registra como dato informativo; no se
  inventó ninguna política laboral o fiscal.

## 9. Impresión

- El cierre NO reimprime comandas (inicial, adicional ni cancelación).
- Se emite UN ticket final `tipo_comanda:'cuenta_final'` (contrato C8 sobre
  printRouter: nunca lanza; sin impresora → `omitido`), solo cuando el
  request fue el que realmente cerró (un reintento `yaCerrada` no
  reimprime). Lleva folio de venta, mesa, mesero, items, total, propina y
  pagos. **Pendiente documentado**: plantilla física específica para
  `cuenta_final` (hoy sale con la plantilla genérica del router).

## 10. Reapertura, cancelación y devoluciones

- **Reapertura**: una cuenta con venta contabilizada NUNCA se reabre en
  silencio — `reabrirCuenta` responde `VENTA_CONTABILIZADA` (409). Solo las
  cuentas cerradas SIN venta (estado previo a esta fase) pueden reabrirse.
- **Reverso (admin, motivo obligatorio)**:
  `POST /api/restaurante/cuentas/:id/revertir-venta` marca la venta
  `cancelado` con auditoría (`datos.cancelacion = {motivo, por, at}`),
  reabre la cuenta, conserva TODOS los pagos e items e incrementa
  `reversos`. La venta cancelada sale de reportes pero queda en historial.
  Si la mesa ya fue tomada por otra cuenta, el reverso falla completo
  (`MESA_OCUPADA`) — nada queda a medias.
- **Devoluciones parciales post-cierre**: BLOQUEADO documentado. No existe
  un sistema de devoluciones maduro para ventas de mesa; el camino hoy es
  reverso completo + re-cierre corregido. No se improvisó.

## 11. Seguridad

- Negocio siempre de la sesión (`req.negocioId`); cuenta/venta de otro
  negocio → 404 (probado, incluido el reverso).
- Reverso y reapertura: `requireAdminSeguro`. Cierre/pagos: staff o admin.
- Superadmin solo vía sesión de soporte (sin cambios; anti-encadenamiento
  intacto — esta fase no toca auth).
- Totales recalculados en servidor; sin secretos en respuestas.

## 12. Concurrencia e idempotencia (probado)

Doble cierre concurrente → una venta; reintento tras respuesta perdida →
`yaCerrada` con el mismo folio; ventana de fallo (venta insertada, cuenta
sin marcar) → el reintento aterriza en la misma fila; pago+cierre
simultáneos → jamás cerrada con saldo; reverso concurrente → uno gana;
reverso vs mesa ocupada → rollback completo. Todo con transacciones,
`FOR UPDATE`, índices únicos y `ON CONFLICT` — sin sleeps ni flags en
memoria.

## 13. UI (`panel/mesas.html`)

Folio de venta y estado "Venta registrada" al cerrar; mensaje idempotente
en reintentos; propinas mostradas por separado; la advertencia de piloto se
reemplazó por la nota informativa de venta consolidada + propinas (el
bloqueo contable que la motivaba queda resuelto por esta fase).

## 14. Compatibilidad con el módulo apagado

`restaurante` sigue inactivo para todos los negocios; sin datos nuevos; las
rutas siguen gateadas por `requireModulo('restaurante')`. Cero impacto en
pedidos existentes, caja, WhatsApp, Rappi y repartidores (regresión
completa en verde).

## 15. Plan de piloto (NO ejecutado)

Criterios de entrada: integración caja/reportes aprobada (esta fase),
reportes correctos con origen, una sola venta por cuenta, pagos mixtos
cuadrados, propina visible, impresión validada en el hardware del negocio,
personal capacitado (mesero + caja), respaldo manual (bloc de comandas),
propietario presente el primer día, módulo activado SOLO para ese negocio.

Criterio de salida (éxito): 1 semana de operación con cortes diarios
cuadrados contra el resumen de ventas y cero reversos no explicados.

Rollback operativo: apagar el módulo `restaurante` del negocio (los datos
quedan; las ventas ya contabilizadas se conservan), volver al flujo manual.

## 16. Deploy y rollback (para cuando se autorice)

- Deploy normal: el predeploy runner aplica 040 (no-op si ya está).
- Rollback de código: redeploy del commit anterior — 040 es aditiva y no
  estorba al código previo.
- Rollback de esquema (solo si fuera imprescindible):
  `040_restaurante_integracion_ventas_down.sql` (no borra ventas).

## 17. Riesgos y decisiones pendientes

- Política de propinas (reparto/fiscal) — propietario.
- Plantilla física del ticket `cuenta_final` — pendiente de hardware real.
- Caja formal (apertura/corte) no existe en el sistema — cuando se
  construya, `datos.pagos[]` ya provee el detalle por método.
- Impuestos/descuentos: el módulo de mesas no maneja impuestos ni
  descuentos por línea todavía; el total consolidado es la suma de items
  activos (misma semántica que el resto del sistema).
