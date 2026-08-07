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
| **Botón / enlace** | **Sin botón de plantilla (`call_to_action`/URL button) en esta propuesta.** El enlace `{{4}}` viaja como texto plano dentro del cuerpo, igual que en la v1 ya aprobada — mismo patrón que ya funciona en producción, sin depender de que Meta apruebe un botón dinámico aparte. Si más adelante se quiere un botón "Ver pedido" con URL dinámica, requeriría someter una plantilla adicional distinta; no se incluye aquí para no ampliar el alcance de esta aprobación. |

## Cuerpo exacto (cierre primer-mensaje-repartidores: 4 variables, sin folio)

```
🛵 NUEVO PEDIDO DISPONIBLE

Recoge en:
{{1}}

Entrega en:
{{2}}

Pago por entrega:
{{3}}

Revisa y acepta aquí:
{{4}}

La asignación se confirma al primer repartidor que lo acepte.
```

El folio NO viaja en la oferta: el repartidor lo ve en la pantalla del
enlace y en el portal después de aceptar. Menos variables = menos
superficie de rechazo en la revisión de Meta y ningún dato que no
necesite antes de aceptar.

## Variables — origen, formato y ejemplos

| Variable | Origen | Función que la produce | Ejemplo para Meta |
|---|---|---|---|
| `{{1}}` negocio | `obtenerNombreNegocio(pedido.negocioId)` | sin cambios, ya existía en v1 | `Nonna Maye` |
| `{{2}}` ubicación resumida | `pedido.cliente.calle` / `pedido.cliente.colonia` | `formatearEntregaOferta()` — `src/utils/direccionRepartidor.js` (**sin número exterior**, misma función que el mensaje libre desplegado) | `Col. Centro, calle Av. Tecnológico` |
| `{{3}}` pago | `pedido.total` | `formatearTarifaRepartidor()` (incluye `$` y `MXN`, por eso el cuerpo no antepone `$`) | `$544.00 MXN` |
| `{{4}}` enlace | token de oferta (la pantalla del enlace NO consume el token; aceptar es un POST explícito) | igual que v1 | `https://xabor.mx/repartidor/aceptar/AbC123XyZ` |

## Ejemplo completo renderizado (con los valores de ejemplo de arriba)

```
🛵 NUEVO PEDIDO DISPONIBLE

Recoge en:
Nonna Maye

Entrega en:
Col. Centro, calle Av. Tecnológico

Pago por entrega:
$544.00 MXN

Revisa y acepta aquí:
https://xabor.mx/repartidor/aceptar/AbC123XyZ

La asignación se confirma al primer repartidor que lo acepte.
```

Otros tres renderizados reales, para cubrir los casos de fallback de `{{2}}`
(verificados contra el código de `formatearEntregaOferta` y cubiertos por la
suite `test/fase-primer-mensaje-repartidores.mjs`):

- **Solo calle** (colonia vacía/null): `Entrega en: Calle Av. Tecnológico`
- **Solo colonia** (calle vacía/null): `Entrega en: Col. Centro`
- **Ninguna de las dos**: `Entrega en: Zona por confirmar`
  (y se registra un `console.warn` para el caso, sin bloquear el envío)
- **Calles con número en el nombre**: `Calle 5 de Mayo` y
  `Avenida 20 de Noviembre` se preservan tal cual (solo se recorta el
  número exterior FINAL: `Av. Tecnológico 123` → `Av. Tecnológico`,
  `Carranza #245 int 2` → `Carranza`).

**Nunca se incluye:** nombre del cliente, teléfono del cliente, referencias
completas ni notas privadas — eso vive en el Portal Operativo autenticado
("Ver mi entrega" en `/repartidor.html`), solo para el ganador. La antigua
plantilla de detalle (`xabor_detalle_servicio_reparto`) ya NO se envía
automáticamente (decisión del propietario, 2026-08-07): queda en Meta como
respaldo, re-activable por negocio con
`repartidor_notif_detalle_wa_activo='true'` sin deploy.

## Verificación de formato de `{{2}}` (cierre primer-mensaje-repartidores)

**`{{2}}` usa `formatearEntregaOferta()`** — la misma función que produce la
línea "Entrega en:" del mensaje libre desplegado en producción
(`whatsapp-meta.js`). Reglas exactas, confirmadas en código:

- **Sin número exterior antes de aceptar**: el número FINAL de la calle se
  recorta (la regex también cubre `#`, `no.`, `núm.`, `int`, `depto`,
  `local`) — "Av. Tecnológico 123" se ofrece como "calle Av. Tecnológico".
  Excepción segura: si al recortar no quedan letras ("Calle 21"), se
  conserva tal cual para no vaciar el dato.
- Formatos: ambas → `Col. <colonia>, calle <calle>`; solo colonia →
  `Col. <colonia>`; solo calle → `Calle <calle>`; ninguna →
  `Zona por confirmar`.
- **Nunca `null`/`undefined` literales, comas duplicadas ni "Col. Col."**
  (la colonia se limpia de su prefijo antes de re-anteponerlo); si calle y
  colonia traen el mismo texto, la colonia se descarta.
- Cubierto por `test/fase-primer-mensaje-repartidores.mjs` (formatos,
  número oculto, "Calle 5 de Mayo"/"Avenida 20 de Noviembre" preservadas,
  nulls/espacios, y el payload real capturado del flujo completo).

## Mapeo de variables (ya implementado en el código de la rama)

| Variable | Origen | Función |
|---|---|---|
| `{{1}}` negocio | `obtenerNombreNegocio(pedido.negocioId)` | (sin cambios, ya existía) |
| `{{2}}` ubicación resumida | `pedido.cliente.calle` / `pedido.cliente.colonia` | `formatearEntregaOferta()` |
| `{{3}}` pago | `pedido.total` | `formatearTarifaRepartidor()` — mismo valor que hoy usa "Pago estimado" en la v1, solo reformateado; sigue sin existir un cálculo de comisión propia del repartidor separado del total del cliente (fuera de alcance, ya documentado en el piloto original) |
| `{{4}}` enlace | token de oferta de un solo uso | sin cambios respecto a la v1 |

### Fallback auditable v2→v1 (nuevo en esta rama)

Si Meta rechaza el envío v2 (no aprobada, inexistente, pendiente,
rechazada, pausada, deshabilitada o variables que no coinciden), la oferta
NO se pierde: sale por la v1 aprobada y el intento queda auditado en el
log y en `notificaciones_repartidor.error_detalle` con un JSON sin datos
sensibles:

```json
{
  "plantillaSolicitada": "xabor_nuevo_servicio_reparto_v2",
  "plantillaUtilizada": "xabor_nuevo_servicio_reparto",
  "ubicacionIncluida": false,
  "fallback": true,
  "razonFallback": "template_not_approved_or_missing"
}
```

Razones posibles: `template_not_approved_or_missing` (132001),
`template_param_mismatch` (132000), `template_paused` (132015),
`template_disabled` (132016), `error_meta_<código>` / `error_desconocido`.
Cada envío exitoso también registra en el log qué plantilla se usó
(`plantillaUtilizada`, `ubicacionIncluida`, `fallback`) — nunca dirección
ni teléfonos.

## Pasos manuales para someter la plantilla a Meta (fuera de esta sesión)

1. Entrar a Meta Business Manager → WhatsApp Manager → Plantillas de mensajes.
2. Crear plantilla nueva con nombre exacto `xabor_nuevo_servicio_reparto_v2`
   (el nombre debe coincidir carácter por carácter con el que usa el código).
3. Categoría: **Utilidad** (UTILITY). Idioma: **Español (México)**.
4. Pegar el cuerpo exacto de la sección "Cuerpo exacto" de este documento,
   sin modificar espacios, saltos de línea ni emoji.
5. Completar los 4 valores de ejemplo de la tabla de variables (Meta los
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
   el flujo de aceptación vigente: `GET /repartidor/aceptar/:token`
   muestra la pantalla de revisión SIN consumir el token; la aceptación es
   el botón que hace `POST /api/repartidor/oferta/:token/aceptar`. Tras
   aceptar, la pantalla ganadora ofrece "Ver mi entrega" → Portal
   Operativo (`/repartidor.html`) con la dirección completa.
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
