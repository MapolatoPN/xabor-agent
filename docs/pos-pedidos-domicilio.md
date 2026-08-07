# POS — Envíos / Pedidos a domicilio

Rama `feat/pos-pedidos-domicilio` (base 109f816, el commit desplegado).
**Sin migración** (041 sigue libre): reutiliza `pedidos_activos`/`datos`
JSONB, `pagos`, `menu_productos`, `configuracion` y el mismo motor de
pedidos que WhatsApp/Rappi/presencial.

## Regla de oro: no hay motor paralelo

El POS solo **prepara y valida** la orden; el pedido lo crea el motor
existente. Reutiliza tal cual:

| Necesidad | Se reutiliza |
|---|---|
| Crear pedido, folio, comanda, impresión, tablero | `registrarPedido` + `emitirPedido` (orderManager) |
| Enlace de pago (con guard de duplicado) | `pagosService.crearEnlacePago` |
| Red de repartidores (plantilla v2, aceptación, portal) | `notificarRepartidoresPorWA` + flujo de solicitar-repartidor |
| Cancelación reversible | `cancelarPedidoActivo` |
| Historial | `upsertCliente` + `guardarPedido` |

El único diferencial es **`canal='pos'` / `origen='manual'`**. El archivo
`src/services/posEnvios.js` NO inserta pedidos ni calcula pagos: solo
recalcula precios desde el menú, normaliza el teléfono y arma la dirección
estructurada.

## Diagnóstico del motor (reutilizado)

Ya existía `/api/pedido-presencial` que reutiliza el motor para "recoger".
El POS de envíos extiende ese patrón a domicilio (dirección + costo de
envío) y añade las acciones de gestión (enlace, repartidor, cancelar,
listado) sobre los servicios existentes.

## API

| Ruta | Rol | Qué hace |
|---|---|---|
| `POST /api/pos/pedidos` | auth + `pos` | Crea recoger/domicilio. Recalcula total en backend. Idempotency-Key. |
| `GET /api/pos/envios` | auth + `pos` | Envíos activos del negocio (canal pos o modalidad domicilio). |
| `GET /api/pos/envios/:folio` | auth + `pos` | Detalle (folio ajeno → 404). |
| `POST /api/pos/envios/:folio/enlace-pago` | auth + `pos` | Reutiliza crearEnlacePago; `reutilizado:true` si ya había vigente. |
| `POST /api/pos/envios/:folio/solicitar-repartidor` | admin + `repartidores` | Mismo flujo validado de la red (no toca Meta). |
| `POST /api/pos/envios/:folio/cancelar` | admin + `pos` | Cancela (no borra); requiere motivo; no cancela pagado/entregado. |

## Recálculo de precios (crítico)

`recalcularItemsDesdeMenu(negocioId, items)` consulta `menu_productos WHERE
negocio_id = <sesión> AND id = ANY(ids)`. Un producto de otro negocio
simplemente no aparece → se **rechaza con 400 `PRODUCTO_AJENO`** (no se
filtra en silencio). El precio del frontend se **ignora**: siempre se usa
el `precio` configurado. Total = subtotal recalculado + envío − descuento,
calculado en backend.

## Multi-tenant (tras el hallazgo de Carnitas Moreno)

- `negocioId` SIEMPRE de `req.negocioId` (sesión autenticada); jamás de
  body/query.
- Productos: revalidados contra el menú del negocio (rechazo, no filtrado).
- Listado/detalle/enlace: `obtenerPedidos/obtenerPedidoPorId(negocioId)` →
  un folio ajeno da 404.
- Fixtures de prueba propios ("Producto de prueba A/B"), NUNCA el fixture
  hardcodeado de `/test/pedido` (el que usaba el menú de Nonna y confundió
  a Carnitas Moreno).

## Enlace de pago sin duplicados

`crearEnlacePago` ya reutiliza el pago vigente (`reutilizado:true`) — el POS
solo lo surface: "Este pedido ya tenía un enlace de pago vigente". Nunca se
crea un segundo checkout (responde al hallazgo de enlaces manuales
duplicados). El estado de pago solo lo cambia el webhook/confirmación
existente; abrir el enlace nunca marca pagado.

## Idempotencia

`Idempotency-Key` por intento (header). Dedupe en memoria (TTL 60 s): doble
clic / reintento devuelve el MISMO folio. Barrera previa al motor.

## Estados de entrega

Derivados del modelo real (`datos.entrega_estado` del portal + estado del
pedido): `sin_repartidor → asignado → recogido → en_camino → entregado`,
más `cancelado`. No se crean estados nuevos.

## Auditoría

Eventos en log estructurado `[POS Audit]` con usuario/negocio/pedido:
`pedido_pos_creado`, `pago_link_generado`/`pago_link_reutilizado`,
`repartidor_solicitado`, `pedido_pos_cancelado`. Nunca URLs con token ni
secretos. (La tabla `auditoria_plataforma` es superadmin-scoped; una
bitácora por-negocio persistente queda como mejora futura.)

## Permisos

Crear/listar/enlace: auth + módulo `pos` (operador incluido). Solicitar
repartidor y cancelar: `requireAdminSeguro` (staff bloqueado). Superadmin en
sesión de soporte usa el sistema existente y queda auditado.

## UI

Sección **Envíos** en el panel: Nuevo pedido (recoger/domicilio, cliente,
dirección estructurada, buscador de productos del menú real, carrito con
recálculo, costo de envío, método de pago), Envíos activos (estados +
acciones: copiar tel, solicitar repartidor, enlace de pago con aviso de
duplicado) e Historial (apunta a la sección Historial existente).
Desktop + tablet; responsive a 1 columna < 900px.

## Limitaciones (documentadas, mejora futura)

- Autocompletado de cliente por teléfono y reutilización de direcciones
  previas: no hay endpoint operador seguro por-tenant hoy → degrada en
  silencio.
- Métodos de pago habilitados por negocio en el selector: hoy lista fija
  (efectivo/tarjeta/transferencia/enlace); no oculta deshabilitados.
- Edición de productos de un pedido ya creado: fuera de alcance (recalcular
  comanda/pago de un pedido impreso/pagado es complejo). Se puede cancelar y
  recrear.
- Extras con precio fijo por id de catálogo: el MVP suma el precio_extra
  enviado validado a número; no hay tabla de extras con precio por id.

## Pruebas

`test/fase-pos-envios.mjs` (18 casos): crear recoger/domicilio con el mismo
motor y folio XAB-; validaciones (nombre/teléfono normalizado/calle/colonia);
producto ajeno rechazado; precio recalculado en backend; totales; enlace de
pago no duplicado (1 vigente en BD); canal=pos en pedidos_activos;
multi-tenant en listado/detalle/enlace (404 ajeno); sesión 401; idempotencia
por doble clic; cancelación reversible; permisos de staff. + Regresión
completa y build Docker.

## Deploy / rollback

Deploy estándar (`railway up --ci`, sin migraciones — predeploy 032-040
no-op). Rollback = redeploy del commit anterior; sin cambios de esquema ni
de datos que revertir.
