# Cierre — Primer mensaje de WhatsApp a repartidores con colonia y calle

Fase: `hotfix/primer-mensaje-repartidores-ubicacion` (base: 98c2758, el
commit desplegado en producción). Sin deploy, sin cambios en Meta.

## Plantilla real vs. plantilla secundaria (identificación en código, config y logs)

| | Plantilla 1 (PRIMER mensaje) | Plantilla 2 (posterior) |
|---|---|---|
| Nombre | `xabor_nuevo_servicio_reparto` (v1) | `xabor_detalle_servicio_reparto` |
| Propósito | Oferta del pedido a la red | Datos completos SOLO al ganador |
| Se envía cuándo | Al ofertar (emitirPedido → `notificarRepartidoresPorWA`, o re-solicitud manual del panel) | ~~Solo tras aceptar~~ → **YA NO se envía automáticamente** (ver "Decisión de arquitectura"); respaldo por flag |
| ¿Primera? | **SÍ** (en modo plantilla: `repartidor_notif_modo` piloto/completo) | NO — siempre posterior a la aceptación |
| Variables | 3: negocio, pago, enlace — **SIN ubicación** | 6: folio, nombre cliente, tel cliente, dirección completa, observaciones, monto |
| Idioma / botón | es_MX / sin botón (enlace como texto) | es_MX / sin botón |
| Estado Meta | Aprobada de facto: entregas reales HOY con wamid + `entregado/leido` | Aprobada de facto (flujo post-aceptar del piloto v1) |

Existe además una TERCERA pieza: `xabor_nuevo_servicio_reparto_v2` — la
única con ubicación — que **nunca se sometió a Meta** y estaba apagada
(`repartidor_notif_plantilla_v2_activo` ausente en toda la configuración).

## Hipótesis del propietario: CONFIRMADA (con matiz)

- Plantilla 1 (v1) ES el primer mensaje real: verificado en código
  (despachador), en configuración real (Nonna Maye:
  `repartidor_notif_modo=completo`) y en logs/BD sanitizados (~15
  notificaciones reales de XAB-0114 hoy, canal `plantilla`, estados
  `aceptado_meta/entregado/leido`).
- Los cambios de ubicación (`formatearEntregaOferta`, sin número) se habían
  aplicado a otros caminos: (a) el mensaje de TEXTO LIBRE — que solo sale
  en modo `apagado` y está sujeto a la ventana de 24 h, y (b) la propuesta
  v2 — no aprobada, apagada, y además mapeada a
  `formatearUbicacionRepartidor` (CON número exterior: habría violado la
  política de privacidad de la oferta).
- **Causa exacta**: la v1 no tiene variable de ubicación (clasificación C:
  "no tiene espacio para ubicación"), y la v2 tenía el mapeo equivocado
  (clasificación B) y nunca se sometió a Meta — por eso el primer mensaje
  seguía sin calle/colonia.

## Consulta a Meta (solo lectura)

`scripts/consulta-plantillas-meta.solo-lectura.mjs` (GET, nunca imprime
tokens). Resultado: el token real es un system user con scopes globales
sin `target_ids`, `me/businesses` devuelve 0 y la fila de Nonna Maye en
`integraciones_canal` no tiene `waba_id` → **el estado por API es
"desconocido/no consultable" con el token actual**. Evidencia operativa:
la v1 entrega mensajes reales hoy (APPROVED de facto); la v2 no existe en
el WABA (jamás sometida). Verificar el estado exacto requiere WhatsApp
Manager (paso manual del propietario).

## Decisión de arquitectura: el portal reemplaza a la plantilla de detalle

Decisión del propietario (2026-08-07): `xabor_detalle_servicio_reparto`
queda **obsoleta como mensaje automático al ganador**. Tras aceptar, el
ganador ya dispone de TODOS los datos por vías autenticadas y recuperables:

1. **Pantalla del enlace** ("Pedido asignado a ti" + botón "Ver mi
   entrega"): `consultarOfertaRepartidor` devuelve `asignado_a_mi` con la
   dirección completa AUNQUE el token esté consumido o vencido — reabrir el
   mismo enlace de WhatsApp desde cualquier dispositivo recupera la
   pantalla.
2. **Portal Operativo** (`/repartidor.html`): login por teléfono desde
   cualquier dispositivo → "Mi entrega" con cliente, teléfono, dirección
   con número, entre calles, referencia, notas, pago, ruta, estados e
   historial (validado además en el piloto real de producción).

Por privacidad, los datos del cliente **ya no se persisten en el historial
de WhatsApp** del repartidor. El envío automático queda APAGADO por
defecto; se conserva como respaldo re-activable POR NEGOCIO sin deploy con
`configuracion.repartidor_notif_detalle_wa_activo === 'true'`. La
plantilla en Meta queda **intacta** (no se toca ni se borra).

Flujo definitivo: pedido → oferta v2 (negocio/colonia+calle/pago/enlace) →
pantalla de revisión (GET sin consumir) → POST aceptar → carrera atómica →
perdedor ve solo el nombre del ganador → ganador: "Ver mi entrega" →
portal con datos completos → recogido → en camino → entregado → historial.

## Cambio de código (esta rama)

1. `enviarPlantillaXaborNuevoServicioRepartoV2` → **4 variables** alineadas
   al texto objetivo del propietario: negocio, ubicación resumida, pago,
   enlace (el folio ya no viaja: se ve en la pantalla del enlace/portal).
2. El despachador alimenta `{{2}}` con **`formatearEntregaOferta`** (la
   misma función del mensaje libre: Col. + calle SIN número exterior,
   fallback `Zona por confirmar`) — nunca más
   `formatearUbicacionRepartidor` en la oferta.
3. **Fallback auditable v2→v1**: si Meta rechaza la v2 (no aprobada,
   inexistente, pendiente, rechazada, pausada, deshabilitada, variables
   que no coinciden), la oferta sale por la v1 y el intento queda
   registrado (log + `error_detalle`) como JSON sin datos sensibles con
   `razonFallback` clasificada (`clasificarErrorPlantillaMeta`,
   `src/utils/metaPlantillaErrores.js`).
4. Log de plantilla usada en cada envío exitoso
   (`plantillaUtilizada`/`ubicacionIncluida`/`fallback`) — sin dirección ni
   teléfonos.
5. Configuración por negocio intacta: flag
   `repartidor_notif_plantilla_v2_activo` POR NEGOCIO; rollback sin deploy
   apagándolo. Sin hardcode global.
6. Test-only: `/test/pedido` acepta overrides de `cliente` (ruta ya
   protegida con admin) para probar direcciones por el flujo real; mock de
   Meta con fallos por nombre de plantilla.

### Payload anterior vs. nuevo (componente body de la v2)

Anterior (5 parámetros, ubicación CON número):
`[negocio, folio, "Av. Tecnológico 123, Col. Centro", tarifa, enlace]`

Nuevo (4 parámetros, ubicación SIN número):
`[negocio, "Col. Centro, calle Av. Tecnológico", "$544.00 MXN", enlace]`

La v1 no cambia: `[negocio, pago, enlace]`.

## Privacidad (política desplegada, respetada)

Antes de aceptar: negocio, colonia, calle (sin número ext/int), pago,
enlace. Nunca: número exterior/interior, referencias, cliente, teléfono,
coordenadas. Después de aceptar: dirección completa solo para el ganador
(plantilla de detalle + portal "Ver mi entrega").

## Rollout / rollback

1. Propietario somete la plantilla v2 (cuerpo exacto en
   `docs/plantilla-nueva-servicio-reparto-v2-propuesta.md`) en WhatsApp
   Manager y espera APPROVED.
2. Deploy de esta rama (requiere autorización aparte).
3. Activar `repartidor_notif_plantilla_v2_activo='true'` SOLO en el negocio
   piloto; el resto sigue en v1 automáticamente.
4. Si algo falla: el fallback ya protege cada envío (v1 + auditoría);
   rollback total = apagar el flag (sin deploy). Rollback de código: la v1
   sigue siendo la rama `else`, nada que revertir.
5. Si se activa el flag ANTES de la aprobación de Meta, no se pierde
   ninguna oferta: cada envío cae a v1 con `razonFallback`
   `template_not_approved_or_missing` visible en logs y en
   `notificaciones_repartidor.error_detalle`.

## Pruebas

- Suite nueva `test/fase-primer-mensaje-repartidores.mjs` (19 casos):
  plantilla real y orden de envío; payload v2 4 variables en orden y sin
  datos sensibles; ubicación en todos los formatos (número oculto,
  "Calle 5 de Mayo"/"Avenida 20 de Noviembre" preservadas, nulls,
  espacios, "Zona por confirmar" por el flujo real); estados Meta 132001/
  132000/132015/132016 → fallback auditable exacto; negocio piloto vs.
  negocio en v1; rollback sin deploy; aislamiento; GET sin consumir; POST
  acepta; carrera con nombre del ganador.
- Regresión completa (batería estándar, fase-chat-manual primero) + build
  Docker: resultados en el reporte de cierre de la fase.
