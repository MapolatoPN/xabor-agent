# Plan de piloto — Notificaciones a repartidores por plantilla (Nonna Maye)

> Plan de piloto. No se ha hecho deploy. La plantilla `nuevo_servicio_reparto`
> todavía no se ha sometido a revisión de Meta — ver sección 5. No se toca
> PWA, imágenes, CRM ni el Asistente Comercial en esta rama.

## 1. Contexto (por qué existe este cambio)

Diagnóstico de producción (Nonna Maye, `2026-08-03`): de 28 repartidores
marcados `activo`, solo 1 le había escrito al bot de WhatsApp en las
últimas 24 horas. Xabor enviaba la notificación de "nuevo pedido de
domicilio" como texto libre — WhatsApp exige que un mensaje de negocio
fuera de esa ventana de 24h use una plantilla aprobada, o queda sujeto a
rechazo. Xabor, además, descartaba por completo los webhooks de estado
(`sent`/`delivered`/`read`/`failed`) que Meta manda después, así que un
envío aceptado-pero-no-entregado se registraba en los logs como
"Notificación enviada" sin ninguna forma de detectar la falla real.

## 2. Qué cambia (rama `feat/repartidores-notificacion-whatsapp`)

- Migración 032: tabla `notificaciones_repartidor` — un registro por
  intento (pedido, repartidor, canal, wamid, estado, error).
- `enviarPlantillaNuevoServicioReparto` — envía la plantilla `nuevo_servicio_reparto`
  (`es_MX`) en vez de texto libre.
- El webhook de WhatsApp ahora procesa `value.statuses` (antes se
  descartaba en silencio) y actualiza el estado real de cada intento,
  incluyendo el caso `failed` con código/detalle del error de Meta.
- Feature flag por negocio: `configuracion.repartidor_notif_plantilla_activo`.
  **Apagado por defecto** — sin el flag, el comportamiento es EXACTAMENTE
  el anterior (texto libre, sin registro). Confirmado con regresión de
  suite completa (ver sección 4).
- **No se tocó**: la asignación atómica de pedido a repartidor
  (`asignarRepartidor` en `database.js`, ya era atómica antes de este
  cambio) ni la visibilidad del repartidor en la comanda (`panel/index.html`
  ya mostraba el badge 🛵, ya existía). Ambas se cubren con pruebas de
  regresión, no con código nuevo.

## 3. Activación — SOLO Nonna Maye

```sql
-- Vía Superadmin API (PATCH /api/superadmin/negocios/:id/modulos no aplica aquí,
-- es una clave de configuracion, no un módulo -- se activa con actualizarConfiguracion,
-- o directamente:
INSERT INTO configuracion (negocio_id, clave, valor)
VALUES ('<negocio_id_nonna_maye>', 'repartidor_notif_plantilla_activo', 'true')
ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = 'true';
```

Ningún otro negocio con repartidores configurados ve ningún cambio de
comportamiento mientras su flag no esté activado explícitamente.

## 4. Verificación (completada, ver Reporte de Preflight para el detalle)

- Suite nueva `test/fase-repartidores-notificaciones.mjs`: 8/8 -- plantilla
  aceptada y registrada, fallo de Meta registrado (nunca se pierde el
  intento), webhook de status actualiza delivered→leido con guard contra
  reordenamiento, webhook `failed` registra código/detalle sin retroceder
  después, negocioB (flag apagado) no genera ninguna fila nueva,
  aislamiento multiempresa, asignación atómica (regresión), visibilidad en
  comandas (regresión).
- Regresión completa: 28 suites existentes + la nueva, en DOS bases
  Postgres Docker frescas independientes — 0 fallidas en ambas.

## 5. Bloqueante antes de activar en producción: plantilla `nuevo_servicio_reparto`

La plantilla debe existir y estar **APPROVED** en el WABA de Nonna Maye
antes de activar el flag — sin eso, `enviarPlantillaNuevoServicioReparto`
falla en el 100% de los envíos (Meta rechaza plantillas no aprobadas).
Contenido propuesto pendiente de confirmación del usuario (ver mensaje
separado) antes de someterla vía Graph API. Tiempo típico de revisión de
Meta: minutos a ~24h.

## 6. Ventana de observación del piloto

- Activar el flag solo para Nonna Maye, fuera de hora pico si es posible.
- Observar 24-48h: comparar en `notificaciones_repartidor` la proporción
  `entregado`/`leido` vs `fallido` — el diagnóstico original mostró que la
  vasta mayoría de los envíos de texto libre probablemente nunca llegaban;
  esta es la primera vez que Xabor puede medirlo en vez de asumirlo.
- Criterio de éxito: proporción de `fallido` sensiblemente menor que la
  situación anterior (que no se podía ni medir), y al menos los
  repartidores que sí reciben el mensaje hoy lo siguen recibiendo.

## 7. Rollback del piloto

Apagar el flag es instantáneo y no requiere deploy ni migración:

```sql
UPDATE configuracion SET valor = 'false'
WHERE negocio_id = '<negocio_id_nonna_maye>' AND clave = 'repartidor_notif_plantilla_activo';
```

Esto revierte a texto libre inmediatamente (comportamiento previo, ya
probado como no-regresivo). La migración 032 no requiere down en un
rollback de piloto — la tabla `notificaciones_repartidor` simplemente deja
de recibir filas nuevas; su down (`032_notificaciones_repartidor_down.sql`)
solo se usaría en un rollback completo del código, no del piloto.

## 8. Fuera de alcance de este cambio (decisión explícita)

- No se implementa reintento automático de notificaciones fallidas (el
  registro de intentos permite construirlo después, con datos reales, en
  vez de adivinar).
- No se toca el flujo de auto-registro de repartidores por WhatsApp
  (`repartidor Nombre Apellido`) ni la limpieza de repartidores inactivos
  en la base (28 registros activos, algunos con nombres claramente
  obsoletos/mal capturados -- es un problema de higiene de datos aparte,
  no de este hotfix).
- No se agrega UI nueva en el panel para ver el estado de entrega por
  repartidor -- la tabla `notificaciones_repartidor` queda lista para eso,
  pero no se pidió en este encargo.
