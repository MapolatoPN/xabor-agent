# Propuesta de plantilla Meta: `xabor_nuevo_servicio_reparto_v2`

**Estado: NO sometida a Meta todavía.** Este documento es la propuesta lista
para que el negocio (con acceso a su Meta Business Manager / WhatsApp
Manager) la someta a revisión. El código ya está listo para usarla en
cuanto Meta la apruebe — ver "Plan de activación controlada" al final.

## Por qué existe

La plantilla ya aprobada `xabor_nuevo_servicio_reparto` tiene exactamente 3
variables (negocio, pago estimado, enlace) y su texto fijo ya fue revisado
y aprobado por Meta. Fase C (Red de Repartidores, tiempo real) requiere que
el repartidor conozca folio, calle/colonia de entrega y tarifa **desde el
primer mensaje** — variables que la plantilla actual no tiene. Meta no
permite editar el cuerpo de una plantilla ya aprobada con nuevas variables;
hay que someter una plantilla nueva (o una nueva versión) a revisión.

## Ficha técnica para someter a Meta

| Campo | Valor |
|---|---|
| **Nombre** | `xabor_nuevo_servicio_reparto_v2` |
| **Categoría recomendada** | **UTILITY** — es una notificación operativa a un repartidor sobre un pedido concreto ya existente, no contenido promocional. Meta suele rechazar como MARKETING cualquier plantilla con este perfil si se somete en esa categoría; UTILITY es la misma categoría ya usada (y aprobada) en la v1 y en `xabor_detalle_servicio_reparto`. |
| **Idioma** | `es_MX` |
| **Botón / enlace** | **Sin botón de plantilla (`call_to_action`/URL button) en esta propuesta.** El enlace `{{5}}` viaja como texto plano dentro del cuerpo, igual que en la v1 ya aprobada — mismo patrón que ya funciona en producción, sin depender de que Meta apruebe un botón dinámico aparte. Si más adelante se quiere un botón "Ver pedido" con URL dinámica, requeriría someter una plantilla adicional distinta; no se incluye aquí para no ampliar el alcance de esta aprobación. |

## Cuerpo exacto

```
🛵 Nuevo pedido disponible

Negocio: {{1}}
Pedido: #{{2}}
Entrega: {{3}}
Tarifa: {{4}}

¿Deseas cubrir este pedido? Da clic en el siguiente enlace:

{{5}}
```

## Variables — origen, formato y ejemplos

| Variable | Origen | Función que la produce | Ejemplo para Meta |
|---|---|---|---|
| `{{1}}` negocio | `obtenerNombreNegocio(pedido.negocioId)` | sin cambios, ya existía en v1 | `Nonna Maye` |
| `{{2}}` folio | `pedido.id` | directo, sin transformación | `XAB-0123` |
| `{{3}}` ubicación | `pedido.cliente.calle` / `pedido.cliente.colonia` | `formatearUbicacionRepartidor()` — `src/utils/direccionRepartidor.js` | `Av. Tecnológico 123, Col. Centro` |
| `{{4}}` tarifa | `pedido.total` | `formatearTarifaRepartidor()` | `$544.00 MXN` |
| `{{5}}` enlace | token de aceptación de un solo uso | sin cambios respecto a v1 | `https://xabor.mx/repartidor/aceptar/AbC123XyZ` |

## Ejemplo completo renderizado (con los valores de ejemplo de arriba)

```
🛵 Nuevo pedido disponible

Negocio: Nonna Maye
Pedido: #XAB-0123
Entrega: Av. Tecnológico 123, Col. Centro
Tarifa: $544.00 MXN

¿Deseas cubrir este pedido? Da clic en el siguiente enlace:

https://xabor.mx/repartidor/aceptar/AbC123XyZ
```

Otros tres renderizados reales, para cubrir los casos de fallback de `{{3}}`
(verificados directamente contra el código de `formatearUbicacionRepartidor`,
`src/utils/direccionRepartidor.js`):

- **Solo calle** (colonia vacía/null): `Entrega: Av. Tecnológico 123`
- **Solo colonia** (calle vacía/null): `Entrega: Col. Centro`
- **Ninguna de las dos**: `Entrega: Ubicación pendiente de confirmar`
  (y se registra un `console.warn` para el caso, sin bloquear el envío)

**Nunca se incluye:** nombre del cliente, teléfono del cliente, referencias
completas ni notas privadas — eso sigue reservado para la plantilla de
detalle (`xabor_detalle_servicio_reparto`), enviada solo después de que el
repartidor acepta.

## Verificación de formato de `{{3}}` (código ya revisado, Fase C — cierre)

Confirmado leyendo `src/utils/direccionRepartidor.js` línea por línea:

- **Nunca `null`/`undefined` literales**: la función siempre retorna un
  `string` — si no hay calle ni colonia, retorna el literal
  `'Ubicación pendiente de confirmar'`, nunca el valor `null` sin envolver.
- **Nunca comas duplicadas**: la coma solo se agrega en la rama
  `calle + ', Col. ' + colonia`; las ramas de un solo campo no llevan coma.
- **Nunca "Col. Col."**: la colonia se limpia con
  `.replace(/^col\.?\s*/i, '')` antes de re-anteponer `"Col. "` — si el
  dato ya venía como `"Col. Centro"`, el resultado es `"Col. Centro"`, no
  `"Col. Col. Centro"`.
- **Nunca calle/colonia repetidas**: si `calle` y `colonia` son el mismo
  texto (comparación case-insensitive), la colonia se descarta antes de
  construir el texto — evita `"Centro, Col. Centro"` cuando ambos campos
  traen el mismo valor por error de captura.
- **Sin saltos de línea defectuosos**: la función retorna una sola línea de
  texto (trim aplicado a ambas entradas); es el cuerpo de la plantilla el
  que decide el salto de línea antes de `Tarifa:`, no la función.
- Truncado a 300 caracteres con `…` para direcciones excesivamente largas.

Esto ya está cubierto por pruebas automatizadas (casos 1-6 de la suite
`test/fase-red-repartidores-tiempo-real.mjs`: calle+colonia, solo calle,
solo colonia, sin ninguna, dirección larga, caracteres especiales).

## Mapeo de variables (ya implementado en el código, sin cambios pendientes)

| Variable | Origen | Función |
|---|---|---|
| `{{1}}` negocio | `obtenerNombreNegocio(pedido.negocioId)` | (sin cambios, ya existía) |
| `{{2}}` folio | `pedido.id` | directo |
| `{{3}}` ubicación | `pedido.cliente.calle` / `pedido.cliente.colonia` | `formatearUbicacionRepartidor()` |
| `{{4}}` tarifa | `pedido.total` | `formatearTarifaRepartidor()` — mismo valor que hoy usa "Pago estimado" en la v1, solo reformateado; sigue sin existir un cálculo de comisión propia del repartidor separado del total del cliente (fuera de alcance, ya documentado en el piloto original) |
| `{{5}}` enlace | token de aceptación de un solo uso | sin cambios respecto a la v1 |

## Pasos manuales para someter la plantilla a Meta (fuera de esta sesión)

1. Entrar a Meta Business Manager → WhatsApp Manager → Plantillas de mensajes.
2. Crear plantilla nueva con nombre exacto `xabor_nuevo_servicio_reparto_v2`
   (el nombre debe coincidir carácter por carácter con el que usa el código).
3. Categoría: **Utilidad** (UTILITY). Idioma: **Español (México)**.
4. Pegar el cuerpo exacto de la sección "Cuerpo exacto" de este documento,
   sin modificar espacios, saltos de línea ni emoji.
5. Completar los 5 valores de ejemplo de la tabla de variables (Meta los
   exige para aprobar).
6. **No agregar botones** — esta propuesta no los incluye (ver ficha técnica).
7. Enviar a revisión y esperar la resolución de Meta (usualmente minutos a
   horas, puede tardar más).

## Plan de activación controlada (después de que Meta apruebe)

Procedimiento exacto, paso a paso, para activar la v2 sin arriesgar el
piloto v1 ya funcionando en producción:

1. **Confirmar aprobación**: verificar en Meta Business Manager que el
   estado de `xabor_nuevo_servicio_reparto_v2` es **APPROVED** (no
   "En revisión" ni "Rechazada").
2. **Elegir un único negocio piloto** para la activación inicial (mismo
   criterio que se usó para v1 con Nonna Maye) — nunca activar en todos
   los negocios de golpe.
3. **Mantener el resto de los negocios en v1**: no tocar la configuración
   de ningún otro negocio; por diseño, el flag se resuelve por
   `negocio_id` (`obtenerConfiguracion(pedido.negocioId)`), así que esto
   ya está garantizado por el código, no requiere un paso adicional de
   verificación por negocio.
4. **Activar el flag solo para el piloto**:
   ```js
   await actualizarConfiguracion(
     { repartidor_notif_plantilla_v2_activo: 'true' },
     negocioIdDelPiloto
   );
   ```
   (mismo mecanismo ya usado para `repartidor_notif_modo`/
   `repartidor_notif_plantilla_activo` — sin cambios de código, sin deploy).
5. **Crear un pedido controlado** en ese negocio (pedido de prueba real
   pero de bajo riesgo, con dirección de prueba conocida) con modalidad
   "entrega a domicilio", con calle y colonia capturadas.
6. **Confirmar en el WhatsApp del repartidor de prueba**: que el mensaje
   recibido muestre calle, colonia, tarifa y el enlace — exactamente el
   formato de la sección "Ejemplo completo renderizado".
7. **Confirmar ausencia de datos sensibles**: que el mensaje NO incluya
   teléfono del cliente, nombre del cliente, referencias completas ni
   notas privadas — solo lo que la plantilla ya define.
8. **Abrir el enlace con el repartidor de prueba correcto** y confirmar
   que el flujo de aceptación funciona (mismo endpoint `GET
   /repartidor/aceptar/:token` ya probado en Fase C).
9. **Verificar aceptación única**: confirmar que una vez aceptado, el
   pedido queda asignado y no puede volver a aceptarse.
10. **Probar intento de un segundo repartidor** sobre el mismo enlace (o
    un segundo repartidor de prueba notificado) y confirmar que recibe el
    mensaje de "ya fue tomado" — no una segunda asignación.
11. **Confirmar eventos en tiempo real**: verificar en el panel Superadmin
    (pestaña Red de Repartidores) que `red_repartidores_nuevo_servicio` y
    `red_repartidores_servicio_aceptado` llegan correctamente para ese
    pedido de prueba.
12. **Revisar logs** de la ventana de la prueba en busca de
    `error_envio`/excepciones no esperadas.
13. **Mantener observación controlada** durante un periodo corto (p. ej.
    24-48h) con tráfico real del negocio piloto antes de extender.
14. **Extender gradualmente** a los demás negocios que usan la red de
    repartidores, uno a la vez, repitiendo la observación breve en cada
    uno.
15. **Apagar inmediatamente el flag** ante cualquier error inesperado:
    ```js
    await actualizarConfiguracion(
      { repartidor_notif_plantilla_v2_activo: 'false' },
      negocioAfectado
    );
    ```
    esto revierte ese negocio a la plantilla v1 en el siguiente pedido,
    sin necesidad de deploy ni de reiniciar el servicio.

### Comandos/consultas seguras para comprobar el estado del flag (solo lectura)

```sql
-- Ver el estado del flag por negocio (solo lectura, segura de ejecutar en cualquier momento)
SELECT negocio_id, clave, valor
FROM configuracion
WHERE clave = 'repartidor_notif_plantilla_v2_activo';
```

```sql
-- Ver los últimos intentos de notificación y si usaron plantilla v1 o v2
-- (la tabla no distingue v1/v2 explícitamente por columna -- se infiere por
-- fecha relativa a cuándo se activó el flag para ese negocio; no requiere
-- cambio de esquema para esta verificación puntual)
SELECT pedido_folio, repartidor_id, estado, wamid, created_at
FROM notificaciones_repartidor
WHERE negocio_id = '<uuid-del-negocio-piloto>'
ORDER BY created_at DESC
LIMIT 20;
```

Estas consultas son de solo lectura (`SELECT`) — no se ejecutan aquí contra
producción porque este cierre no incluye ninguna prueba interactiva con
datos reales del piloto; quedan documentadas para cuando el propietario
active el flag.

## Estrategia de rollback a v1

- **Rollback inmediato (sin deploy)**: apagar el flag
  `repartidor_notif_plantilla_v2_activo` para el negocio afectado (paso 15
  arriba). El siguiente pedido de ese negocio vuelve a usar la plantilla
  v1 automáticamente — no requiere reiniciar el servicio ni tocar código.
- **Rollback de código**: no aplica en un sentido destructivo — la rama
  de la v2 nunca reemplazó el camino de la v1
  (`enviarPlantillaXaborNuevoServicioReparto` sigue intacta y es la rama
  `else` del código), así que no hay nada que revertir en el repositorio
  para que la v1 siga funcionando; basta con el flag en `'false'`/ausente.
- **Si Meta rechaza o suspende la plantilla v2 después de aprobada**: el
  siguiente intento de envío con `usarPlantillaV2=true` fallará con
  `error_envio` (capturado, registrado, visible en
  `notificaciones_repartidor` y en logs) — no bloquea el resto del pedido
  ni al resto de repartidores. Se recomienda apagar el flag en cuanto se
  detecte el primer `error_envio` relacionado, en vez de esperar a que se
  acumulen más intentos fallidos.

## Riesgo si se somete con el nombre/variables incorrectos

Si el texto sometido a Meta no coincide EXACTAMENTE con el de este
documento (número de variables, orden, texto fijo), el envío en producción
fallará con un error de Meta API (plantilla no encontrada o parámetros no
coinciden) — el código ya maneja ese caso como `error_envio` (mismo
manejo de errores que la v1), nunca bloquea el resto del flujo de pedidos.
