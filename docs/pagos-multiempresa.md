# Arquitectura de pagos multiempresa

Este documento describe la arquitectura de pagos genérica por proveedor
introducida para corregir el incidente del 2 de agosto de 2026 (el agente de
WhatsApp de Alora ofreció "enlace de pago" sin que Alora tuviera ningún
proveedor de pago configurado; el backend lo bloqueó correctamente, pero el
agente nunca debió haberlo ofrecido) y para dejar de asumir que Clip es el
único proveedor posible.

## Objetivo

- Cada negocio configura **sus propios** proveedores de pago, con
  credenciales cifradas por negocio (nunca una variable de entorno global).
- El agente (WhatsApp/voz) y el panel solo ofrecen los métodos de pago que
  **realmente** están disponibles para ese negocio — nunca una lista fija ni
  editable libremente sin verificación técnica.
- Ningún proveedor se "finge" implementado: el registro distingue
  explícitamente entre proveedores con lógica real (`implementado: true`) y
  proveedores que solo declaran su forma para uso futuro
  (`implementado: false`, mostrados como "Próximamente").

## Piezas del sistema

### 1. Registro de proveedores — `src/services/paymentProviders.js`

Interfaz común que cualquier adaptador implementa:

```js
createPaymentLink({ negocioId, pedidoId, total, descripcion, cliente, referencia, credenciales })
getPaymentStatus(referenciaExterna, negocioId)
cancelPayment(...)
verifyWebhook(...)
testConnection(credenciales)
getCapabilities()   // { createLink, getStatus, cancelLink, webhookSignature, ... }
```

Proveedores registrados: `clip` y `manual_transfer` (**implementados de
verdad**); `mercado_pago`, `stripe`, `openpay`, `conekta` (solo declaran
`camposConfiguracion`, `implementado: false` — `validarPuedeActivarse()`
rechaza cualquier intento de guardarles credenciales activas).

`getCapabilities().createLink` decide el **tipo** de pago que un proveedor
produce: `true` → `enlace_pago` (checkout real, como Clip); `false` →
`transferencia` (sin checkout, requiere conciliación manual, como
`manual_transfer`). Este campo es lo que usa `pagosService.js` para no
asumir que "principal" siempre implica un enlace de pago real.

### 2. Credenciales por negocio — `src/services/integracionesService.js`

Reutiliza `integraciones_canal` / `integraciones_canal_credenciales` (el
mismo mecanismo ya usado para WhatsApp/Meta desde la Fase B), con
`canal = 'pagos'`. Cifrado AES-256-GCM (`cifradoIntegraciones.js`), nunca en
claro fuera del adaptador que las consume.

Columnas nuevas en `integraciones_canal` (migración 025):
- `principal BOOLEAN` — el proveedor que el negocio usa para generar
  enlaces automáticos. Único por negocio+canal (índice parcial). Solo un
  proveedor puede ser principal a la vez; marcar uno nuevo desmarca el
  anterior en la misma transacción.
- `ambiente TEXT` — `sandbox` (default) o `produccion`.
- `ultima_prueba_at` / `ultima_prueba_ok` — resultado de la última
  `probarIntegracionPago` (nunca un cargo real, ver más abajo).

Funciones clave: `guardarIntegracionPago`, `obtenerIntegracionPago`,
`listarIntegracionesPago`, `obtenerProveedorPrincipal`,
`marcarProveedorPrincipal`, `suspenderIntegracionPago` (desmarca principal
automáticamente), `reactivarIntegracionPago`, `eliminarCredencialesPago`
(soft-delete: `estado = 'eliminado'`, nunca se borra la fila), y
`probarIntegracionPago` (delega en `testConnection` del adaptador — nunca
crea un cargo real; Clip solo valida la forma de las credenciales porque su
API no ofrece un endpoint de "ping").

**Efecto secundario importante**: `marcarProveedorPrincipal` también
habilita automáticamente (`habilitarMetodoPagoPorProveedorPrincipal`,
`database.js`) el método de pago correspondiente en `metodos_pago` (según
`getCapabilities().createLink`). Sin esto, marcar un proveedor como
principal no bastaría para que el agente pudiera ofrecerlo — quedaría un
segundo paso manual invisible, la misma clase de brecha que causó el
incidente original.

### 3. Métodos de pago reales por negocio — tabla `metodos_pago`

Tipos: `efectivo`, `terminal`, `enlace_pago`, `transferencia`,
`pago_en_sucursal`, `otro_autorizado`. Reemplaza a la lista libre
`reglas_atencion.pedidos.pago_aceptado` (que sigue existiendo en el panel
solo como referencia/notas — ya no decide qué ofrece el bot).

- `efectivo`/`terminal`: habilitados por defecto para todo negocio (nuevo o
  existente vía backfill de la migración 025) — funcionan sin proveedor.
- `enlace_pago`: **nunca editable a mano** desde el panel del negocio
  (`PUT /api/admin/metodos-pago/enlace_pago` responde 400) — se habilita
  únicamente como efecto de `marcarProveedorPrincipal` con un proveedor
  `createLink: true`.
- `transferencia`: el admin del negocio la habilita y captura sus propias
  instrucciones (titular/banco/CLABE) directamente en `metodos_pago.instrucciones`
  — no requiere ninguna integración ni proveedor.

`obtenerMetodosPagoDisponibles(negocioId, { paraBot })` (`database.js`) es
la única fuente de verdad que el agente consulta: hace `LEFT JOIN` con
`integraciones_canal` exigiendo `principal = TRUE` y `estado = 'activo'`
para incluir `enlace_pago` — un proveedor suspendido deja de ofrecerse
automáticamente, sin ningún paso manual adicional.

### 4. Modelo de pagos — tabla `pagos`

Cada intento de cobro (enlace o transferencia) es una fila:
`negocio_id`, `pedido_folio`, `proveedor`, `tipo`
(`enlace_pago`/`transferencia`), `monto`, `estado`
(`creando → pendiente/requiere_revision → pagado`, o
`fallido`/`vencido`/`cancelado`/`invalidado`/`reembolsado`),
`version_pedido_hash`, `referencia_interna` (única por negocio:
`"<negocioId>:<folio>:<hash>"`), `referencia_externa`, `url` (el enlace de
checkout — no es secreto, es justo lo que se comparte con el cliente).

IDs: `UUID` (`gen_random_uuid()`), nunca `COUNT(*)+1` — evita colisiones de
referencia financiera si se borran filas de prueba entre corridas.

### 5. Generación segura e idempotente — `src/services/pagosService.js`

`crearEnlacePago({ negocioId, pedidoId, actor, descripcion })`:

1. Relee el pedido desde `pedidos_activos` — **nunca** confía en un total
   que traiga el llamador.
2. Resuelve el proveedor principal y su tipo (`enlace_pago` o
   `transferencia`, según capacidades).
3. Si ya hay un pago vigente (`creando`/`pendiente`/`requiere_revision`)
   para ese pedido+tipo con el mismo hash de versión (total+modalidad), lo
   **reutiliza** — un doble clic o un reintento del agente nunca duplica el
   cobro.
4. Si el pedido cambió de total/modalidad desde el intento anterior, ese
   pago se invalida explícitamente (`invalidarPagosVigentesDePedido`) y se
   crea uno nuevo — nunca se reenvía un enlace por un monto que ya no es el
   correcto.
5. Un índice único parcial (`idx_pagos_vigente_unico`) refuerza la
   idempotencia también a nivel de base de datos, no solo de lógica de
   aplicación (defensa en profundidad ante condiciones de carrera).

`pedidos_activos` no tiene una columna de versión real (protegida, ver
`CLAUDE.md`) — se deriva un hash de `(total, modalidad)` en vez de agregar
una columna a esa tabla.

### 6. Webhook de Clip — `POST /webhook/clip` en `src/server.js`

Clip no firma sus webhooks en su API pública. Mitigación: el webhook
**nunca confía en el payload por sí solo**.

- Formato nuevo (`me_reference_id = "negocioId:folio:hash"`, generado por
  `pagosService.js`): resuelve `negocioId` directo del string (nunca
  adivinado), busca el pago real en `pagos`, y si no está ya `pagado`,
  **re-consulta el estado real en la API de Clip** (`consultarEstadoPago`,
  con las credenciales de ESE negocio) antes de confirmar. Un webhook
  duplicado para un pago ya confirmado es idempotente (no vuelve a llamar a
  Clip, no reintenta).
- Formato legado (solo el folio, sin negocioId embebido): único caso real
  que sigue llegando por esta vía hoy son los pedidos **programados** que
  aún no se activaron (ver `whatsapp-meta.js` — no existen todavía en
  `pedidos_activos`, que `crearEnlacePago` exige). Se resuelve por el
  pedido en memoria; riesgo residual documentado: si el proceso se
  reinició, este pago no se reconcilia por esta vía y depende del job de
  reconciliación en background (`obtenerPagosPendientesConLink`).

### 7. Transferencia manual — conciliación humana

`manual_transfer` no tiene API: `createPaymentLink` solo devuelve las
instrucciones configuradas (banco/CLABE/titular) y registra el pago en
`requiere_revision`. Nunca se auto-confirma. Un admin del negocio (nunca
staff) confirma manualmente después de verificar el depósito:

- `POST /api/admin/pagos/:pagoId/confirmar-manual` → `pagado`
- `POST /api/admin/pagos/:pagoId/rechazar-manual` → `cancelado`

Ambas rutas exigen `negocio_id` en el `WHERE` (nunca solo `pagoId`) y
`tipo = 'transferencia' AND estado = 'requiere_revision'` — nunca se pueden
usar para "saltarse" la verificación real de un enlace Clip pendiente.

## Permisos

| Acción | Rol mínimo | Ruta |
|---|---|---|
| Configurar/probar/marcar principal/suspender/eliminar un proveedor | Superadmin | `/api/superadmin/negocios/:id/integraciones/pagos*` |
| Ver integraciones de pago (sin secretos) | Admin del negocio | `GET /api/admin/integraciones/pagos` |
| Ver métodos de pago disponibles (sin secretos) | Staff o Admin | `GET /api/config/pagos` |
| Editar métodos de pago (habilitar/instrucciones) | Admin del negocio | `PUT /api/admin/metodos-pago/:tipo` (rechaza `enlace_pago`) |
| Generar enlace de pago manualmente desde un pedido | Staff o Admin (módulo `pos`) | `POST /api/admin/pedido/:folio/enlace-pago` |
| Confirmar/rechazar transferencia manual | Admin del negocio | `POST /api/admin/pagos/:id/confirmar-manual` / `rechazar-manual` |

Ningún endpoint de negocio (admin o staff) puede leer ni escribir secretos
de otro negocio — las credenciales cifradas nunca se incluyen en las
respuestas HTTP, ni siquiera al propio dueño del negocio.

## Limitaciones conocidas / fuera de alcance

- La invalidación de un enlace pendiente por cambio de pedido
  (`invalidarPagosVigentesDePedido`) está implementada y probada a nivel de
  `pagosService.js`, pero hoy **ningún endpoint del código base modifica el
  total/modalidad de un pedido ya en `pedidos_activos`** — es defensa
  preparada para cuando exista una función de edición de pedido, no algo
  actualmente alcanzable desde el panel.
- `metodos_pago.habilitado` para `transferencia` no bloquea
  `crearEnlacePago` si `manual_transfer` es el proveedor principal (el
  gate real vive en `integraciones_canal.principal`/`estado`, no en
  `metodos_pago`) — un desajuste entre "principal" y "habilitado en el
  panel" es posible en teoría pero de bajo impacto (en el peor caso, se
  ofrecen instrucciones de transferencia que el admin creía deshabilitadas
  visualmente).
- Los canales `whatsapp-meta.js` migraron sus tres puntos de generación de
  enlace a `pagosService.crearEnlacePago`, **excepto** pedidos programados
  aún no activados (excepción documentada en el propio archivo: ese caso
  sigue usando `clip-api.js` directo porque el pedido todavía no existe en
  `pedidos_activos`).
