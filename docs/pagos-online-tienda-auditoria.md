# Auditoría previa: pagos online para Tienda Online

Hecha sobre `f3be362`, antes de escribir una línea. La conclusión corta: **casi
toda la arquitectura multiproveedor ya existe y funciona**. Lo que falta no es un
sistema de pagos — es conectar la Tienda Online al que ya hay, y cerrar el ciclo
donde hoy se corta.

## 1. Qué existe ya (y se reutiliza tal cual)

| Pieza | Dónde | Qué resuelve |
|---|---|---|
| Registro de proveedores | `paymentProviders.js` | Interfaz común (`createPaymentLink`, `getPaymentStatus`, `cancelPayment`, `verifyWebhook`, `testConnection`, `getCapabilities`), bandera `implementado` y `validarPuedeActivarse` que impide activar un proveedor sin adaptador real |
| Credenciales por negocio | `integracionesService.js` + `cifradoIntegraciones.js` | `negocio_id + proveedor`, cifradas, `TenantContextRequiredError`, `obtenerProveedorPrincipal` |
| Servicio de pagos agnóstico | `pagosService.crearEnlacePago` | Recalcula el total desde la base (nunca del llamador), idempotente por `(negocio, pedido, versión, tipo)`, invalida el enlace anterior si cambia el monto, reutiliza filas fallidas |
| Modelo de pagos | migración `025` | Estados `creando · pendiente · pagado · fallido · vencido · cancelado · invalidado · reembolsado · requiere_revision`, `referencia_interna` única, `version_pedido_hash` |
| Confirmación idempotente | `confirmarPagoIdempotente`, `confirmarPagoPedido` | Un pago se confirma una sola vez |
| Gate de comanda | `orderManager.emitirPedido` | Un pedido `pendiente_pago` **no** imprime, no ofrece a repartidores, no entra a cocina |
| Única transición autorizada | `confirmarPedidoPendientePago` | `pendiente_pago → nuevo` + emisión, idempotente, solo desde el flujo de pagos |
| Adaptador Clip | `providers/clipProvider.js` | Enlace real por negocio; normaliza el vocabulario crudo del proveedor |
| Webhook Clip | `POST /webhook/clip` | Resuelve el negocio desde `referencia_interna` (nunca del body), **re-consulta el estado real** antes de marcar pagado, idempotente ante repetición |
| Reconciliación | job cada 5 min | Recupera pagos cuyo webhook nunca llegó |

**No hay que construir un segundo sistema de pagos.** El vocabulario de estados
existente ya es el que pide el encargo; se reutiliza sin renombrar nada.

## 2. Lo que falta — los huecos reales

**GAP 1 (P0, el central).** La Tienda Online ofrece el método `enlace_pago`
—"Recibirás una liga de pago segura"— y **nunca crea el enlace**. Peor:
`crearPedidoTienda` sólo marca `pago_confirmado = false` cuando el método
`pagaDespues`; para pago en línea no marca nada, el pedido nace `nuevo`, y
`emitirPedido` **imprime la comanda antes de que exista un solo peso**. El gate
`pendiente_pago` existe pero la tienda no lo usa.

**GAP 2.** No hay adaptador de Mercado Pago (`implementado: false`).

**GAP 3.** PayPal no está ni registrado en `paymentProviders`.

**GAP 4.** El webhook es específico de Clip (`/webhook/clip`). Falta una entrada
por proveedor que comparta la misma disciplina.

**GAP 5.** No hay seguimiento de pago para el cliente de la tienda ("Estamos
confirmando tu pago"), ni reintento sobre el **mismo** pedido.

**GAP 6.** No hay política de expiración de un pedido pendiente de pago, ni
liberación de la reserva de promoción asociada.

**GAP 7.** El panel no tiene la vista de tarjetas por proveedor
(Conectado / No conectado / Próximamente) para el negocio; hoy sólo Superadmin
lista proveedores.

## 3. Qué cambia del flujo actual de Tienda Online

Sólo el tramo de pago, y sólo para métodos en línea:

```
hoy:    checkout → pedido 'nuevo' → comanda  (aunque no se haya pagado)

nuevo:  checkout → pedido 'pendiente_pago' → enlace del proveedor
                 → cliente paga → webhook verificado
                 → confirmarPedidoPendientePago → comanda
```

Efectivo, terminal y transferencia manual **no cambian**: siguen naciendo con
`pago_confirmado = false` y emitiendo comanda de inmediato, porque el dinero se
cobra en persona.

## 4. Principio que ya se cumple y hay que preservar

El dinero nunca pasa por Xabor: las credenciales son del negocio, el enlace se
crea contra la cuenta del negocio, y el cobro va directo del cliente al
proveedor. Xabor configura, genera, verifica, registra y confirma. Esto ya es
así en Clip y es lo que hace posible el marketplace futuro sin volverse
receptor del dinero.
