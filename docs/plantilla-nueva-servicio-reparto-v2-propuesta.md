# Propuesta de plantilla Meta: `xabor_nuevo_servicio_reparto_v2`

**Estado: NO sometida a Meta todavía.** Este documento es la propuesta lista
para que el negocio (con acceso a su Meta Business Manager / WhatsApp
Manager) la someta a revisión. El código ya está listo para usarla en
cuanto Meta la apruebe — ver sección "Cómo activarla" al final.

## Por qué existe

La plantilla ya aprobada `xabor_nuevo_servicio_reparto` tiene exactamente 3
variables (negocio, pago estimado, enlace) y su texto fijo ya fue revisado
y aprobado por Meta. Fase C (Red de Repartidores, tiempo real) requiere que
el repartidor conozca folio, calle/colonia de entrega y tarifa **desde el
primer mensaje** — variables que la plantilla actual no tiene. Meta no
permite editar el cuerpo de una plantilla ya aprobada con nuevas variables;
hay que someter una plantilla nueva (o una nueva versión) a revisión.

## Texto exacto a someter

- **Nombre:** `xabor_nuevo_servicio_reparto_v2`
- **Categoría:** UTILITY (misma categoría que la plantilla v1 — es una
  notificación operativa a un repartidor, no marketing)
- **Idioma:** `es_MX`
- **Cuerpo:**

```
🛵 Nuevo pedido disponible

Negocio: {{1}}
Pedido: #{{2}}
Entrega: {{3}}
Tarifa: {{4}}

¿Deseas cubrir este pedido? Da clic en el siguiente enlace:

{{5}}
```

- **Valores de ejemplo para Meta** (obligatorios al someter):
  - `{{1}}` → `Nonna Maye`
  - `{{2}}` → `XAB-0123`
  - `{{3}}` → `Av. Tecnológico 123, Col. Centro`
  - `{{4}}` → `$544.00 MXN`
  - `{{5}}` → `https://xabor.mx/repartidor/aceptar/AbC123XyZ`

## Mapeo de variables (ya implementado en el código)

| Variable | Origen | Función |
|---|---|---|
| `{{1}}` negocio | `obtenerNombreNegocio(pedido.negocioId)` | (sin cambios, ya existía) |
| `{{2}}` folio | `pedido.id` | directo |
| `{{3}}` ubicación | `pedido.cliente.calle` / `pedido.cliente.colonia` | `formatearUbicacionRepartidor()` — `src/utils/direccionRepartidor.js` (reglas de fallback: solo calle, solo colonia, o "Ubicación pendiente de confirmar") |
| `{{4}}` tarifa | `pedido.total` | `formatearTarifaRepartidor()` — mismo valor que hoy usa "Pago estimado" en la v1, solo reformateado; sigue sin existir un cálculo de comisión propia del repartidor separado del total del cliente (fuera de alcance, ya documentado en el piloto original) |
| `{{5}}` enlace | token de aceptación de un solo uso | sin cambios respecto a la v1 |

**Nunca se incluye:** nombre del cliente, teléfono del cliente, referencias
completas ni notas privadas — eso sigue reservado para la plantilla de
detalle (`xabor_detalle_servicio_reparto`), enviada solo después de que el
repartidor acepta.

## Cómo activarla (una vez que Meta la apruebe)

1. Confirmar en Meta Business Manager que el estado de
   `xabor_nuevo_servicio_reparto_v2` es **APPROVED**.
2. Activar, por negocio, la clave de configuración:
   `configuracion.repartidor_notif_plantilla_v2_activo = 'true'`
   (mismo mecanismo que `repartidor_notif_modo`/`repartidor_notif_plantilla_activo`
   — vía `actualizarConfiguracion({ repartidor_notif_plantilla_v2_activo: 'true' }, negocioId)`).
3. Mientras esa clave no esté en `'true'`, el sistema sigue enviando la
   plantilla v1 exactamente como hoy — cero cambio de comportamiento en
   producción hasta ese paso manual explícito.

## Riesgo si se somete con el nombre/variables incorrectos

Si el texto sometido a Meta no coincide EXACTAMENTE con el de este
documento (número de variables, orden, texto fijo), el envío en producción
fallará con un error de Meta API (plantilla no encontrada o parámetros no
coinciden) — el código ya maneja ese caso como `error_envio` (mismo
manejo de errores que la v1), nunca bloquea el resto del flujo de pedidos.
