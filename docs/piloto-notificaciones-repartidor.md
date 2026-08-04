# Plan de piloto — Notificaciones a repartidores por plantilla (Nonna Maye)

> Plan de piloto. No se ha hecho deploy. Las plantillas `xabor_nuevo_servicio_reparto`
> y `xabor_detalle_servicio_reparto` todavía no se han sometido a revisión
> de Meta — ver sección 5. No se toca PWA, imágenes, CRM ni el Asistente
> Comercial en esta rama.

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

## 2. Diseño final: dos plantillas, datos sensibles solo tras aceptar

Ajuste explícito del usuario sobre la primera versión de este plan: el
mensaje de OFERTA nunca debe llevar nombre, teléfono ni dirección del
cliente. Los datos completos se entregan en un SEGUNDO mensaje, y solo
después de que el repartidor acepta por un enlace de un solo uso.

**Plantilla 1 — `xabor_nuevo_servicio_reparto`** (oferta, sin datos sensibles):
```
🛵 Hay un nuevo servicio de reparto disponible.

🏪 Negocio: {{1}}
💰 Pago estimado: {{2}}

Si deseas tomar este servicio, entra al siguiente enlace:

{{3}}
```
`{{1}}` = nombre del negocio · `{{2}}` = pago estimado (hoy es `pedido.total`
— no existe todavía un cálculo de comisión propio del repartidor, separado
del total del cliente; fuera de alcance de este cambio) · `{{3}}` = enlace
de aceptación de un solo uso (`https://xabor.mx/repartidor/aceptar/<token>`).

**Plantilla 2 — `xabor_detalle_servicio_reparto`** (datos completos,
enviada SOLO tras aceptar):
```
✅ Confirmaste el servicio de reparto — aquí están los datos completos.

📦 Folio: {{1}}
👤 Cliente: {{2}}
📞 Teléfono: {{3}}
📍 Dirección: {{4}}
📝 Observaciones: {{5}}
💰 Monto a cobrar: {{6}}

Cualquier duda, contáctanos.
```
Es una plantilla (no texto libre) por la misma razón que la primera: el
repartidor pudo haber aceptado desde el navegador sin haberle escrito nada
al bot, así que su ventana de 24h puede seguir cerrada.

Ambas: categoría `UTILITY`, idioma `es_MX`, prefijo `xabor_` (convención
pedida por el usuario para toda plantilla propia de Xabor).

## 3. El enlace de aceptación — token de un solo uso (migración 033)

`notificaciones_repartidor` gana tres columnas: `token_aceptacion`,
`token_expira_at`, `token_usado_at`. El token:

- **Identifica el pedido y al repartidor destinatario** — es la propia
  fila de `notificaciones_repartidor` (1:1 con el intento de envío de la
  plantilla 1).
- **Expira automáticamente** — 30 minutos desde que se genera
  (`TOKEN_EXPIRACION_MINUTOS` en `whatsapp-meta.js`).
- **No se puede reutilizar** — `consumirTokenAceptacionRepartidor` es un
  `UPDATE ... WHERE token_usado_at IS NULL AND token_expira_at > NOW()`
  atómico: la primera petición que llega gana, cualquier repetición
  (doble clic, o el mensaje reenviado y abierto por alguien más) se
  rechaza con 409.
- **No requiere sesión previa del repartidor** — `GET /repartidor/aceptar/:token`
  es pública a propósito (el token en sí es la credencial de un solo uso;
  exigir login además habría significado que un repartidor sin sesión
  guardada en el navegador no pudiera aceptar nunca desde el enlace).
  Decisión explícita: esto es equivalente en robustez a cualquier enlace
  mágico de un solo uso (p. ej. reseteo de contraseña) — no impide que el
  repartidor comparta el enlace con alguien más ANTES de usarlo, pero sí
  impide que se acepte el mismo pedido dos veces.

Flujo completo: `notificarRepartidoresPorWA` genera el token y envía la
plantilla 1 → repartidor abre el enlace → `procesarAceptacionTokenRepartidor`
consume el token, llama a la asignación atómica ya existente
(`asignarRepartidor` — si otro repartidor ya se adelantó, falla aunque el
token propio fuera válido) y, solo si la asignación tiene éxito, envía la
plantilla 2 con los datos completos.

## 4. Qué cambia (rama `feat/repartidores-notificacion-whatsapp`)

- Migración 032: tabla `notificaciones_repartidor`.
- Migración 033: columnas de token de aceptación.
- `enviarPlantillaXaborNuevoServicioReparto` / `enviarPlantillaXaborDetalleServicioReparto`.
- El webhook de WhatsApp procesa `value.statuses` (antes se descartaba en
  silencio) y actualiza el estado real de cada intento de la plantilla 1,
  incluyendo `failed` con código/detalle del error de Meta.
- `GET /repartidor/aceptar/:token` (server.js) — página pública simple de
  confirmación/error.
- Feature flag por negocio: `configuracion.repartidor_notif_plantilla_activo`.
  **Apagado por defecto** — sin el flag, el comportamiento es EXACTAMENTE
  el anterior (texto libre, sin registro, sin token). Confirmado con
  regresión de suite completa (ver sección 6).
- **No se tocó**: la asignación atómica de pedido a repartidor
  (`asignarRepartidor` en `database.js`, ya era atómica antes de este
  cambio) ni la visibilidad del repartidor en la comanda (`panel/index.html`
  ya mostraba el badge 🛵, ya existía). Ambas se cubren con pruebas de
  regresión, no con código nuevo.

## 5. Activación — SOLO Nonna Maye, y solo 1-2 números autorizados primero

Antes de abrir el piloto a los repartidores reales de Nonna Maye, se agregó
una segunda clave obligatoria: `configuracion.repartidor_notif_piloto_telefonos`
(texto plano, teléfonos separados por comas — mismo formato que el resto de
la tabla `configuracion`, sin precedente de JSON en ella). Con el flag
`repartidor_notif_plantilla_activo=true`, **nunca** se notifica a todos los
repartidores del negocio por ausencia de esta lista: si la lista está
ausente, vacía, o no puede interpretarse como teléfonos, el envío falla
cerrado a **0 destinatarios** (con una alerta clara en logs) — jamás cae de
vuelta a "notificar a todos". El envío a todos los repartidores en
producción requerirá, más adelante, una configuración de rollout completo
aparte y explícita, todavía no implementada.

El filtro, además de la lista blanca, exige `activo = true` en la fila del
repartidor y deduplica por teléfono (dos filas con el mismo teléfono en
formatos distintos — con o sin prefijo de país — solo generan un envío).
Ver `src/channels/whatsapp-meta.js` (`normalizarTelefonoMX`,
`parsearListaPilotoTelefonos`) y la suite `PILOTO-WHITELIST` en
`test/fase-repartidores-notificaciones.mjs`.

```sql
-- 1. Configurar primero la lista blanca (1-2 números autorizados,
--    formato E.164, p. ej. +528781234567) -- SIN esto, el paso 2 no
--    notificará a nadie (fail closed), lo cual es intencional.
INSERT INTO configuracion (negocio_id, clave, valor)
VALUES ('<negocio_id_nonna_maye>', 'repartidor_notif_piloto_telefonos', '+52XXXXXXXXXX,+52YYYYYYYYYY')
ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = EXCLUDED.valor;

-- 2. Solo después, activar el flag.
INSERT INTO configuracion (negocio_id, clave, valor)
VALUES ('<negocio_id_nonna_maye>', 'repartidor_notif_plantilla_activo', 'true')
ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = 'true';
```

Ningún otro negocio con repartidores configurados ve ningún cambio de
comportamiento mientras su flag no esté activado explícitamente.

## 6. Verificación (completada)

- Suite `test/fase-repartidores-notificaciones.mjs`: 13/13 — plantilla de
  oferta enviada y registrada con token; **la plantilla de oferta nunca
  incluye nombre/teléfono/dirección del cliente** (verificado inspeccionando
  el cuerpo real recibido por el mock de Meta, no solo el código); aceptar
  por el enlace asigna el pedido y envía la plantilla de detalle con los
  datos completos; un token reutilizado (mensaje reenviado o doble clic)
  se rechaza; un token vencido se rechaza aunque nunca se haya usado; un
  token inexistente se rechaza sin lanzar; fallo de Meta al enviar se
  registra como `error_envio`; webhook de status actualiza
  delivered→leído con guard contra reordenamiento; webhook `failed`
  registra código/detalle sin retroceder después; negocioB (flag apagado)
  no genera ninguna fila nueva; aislamiento multiempresa; asignación
  atómica (regresión); visibilidad en comandas (regresión).
- Regresión completa: 28 suites existentes + la nueva, en DOS bases
  Postgres Docker frescas independientes — 0 fallidas en ambas.

## 7. Bloqueante antes de activar en producción: dos plantillas pendientes de aprobación

Ambas plantillas deben existir y estar **APPROVED** en el WABA de Nonna
Maye antes de activar el flag — sin eso, el envío falla en el 100% de los
casos (Meta rechaza plantillas no aprobadas). Contenido confirmado con el
usuario (sección 2); pendiente la sumisión real vía Graph API. Tiempo
típico de revisión de Meta: minutos a ~24h, por plantilla.

## 8. Ventana de observación del piloto

- Activar el flag solo para Nonna Maye, fuera de hora pico si es posible.
- Observar 24-48h: comparar en `notificaciones_repartidor` la proporción
  `entregado`/`leido` vs `fallido` de la plantilla de oferta, y cuántas
  ofertas terminan en una aceptación real (fila con `token_usado_at`).
- Criterio de éxito: proporción de `fallido` sensiblemente menor que la
  situación anterior (que no se podía ni medir), y que las aceptaciones
  reales enlacen correctamente con el envío de la plantilla de detalle.

## 9. Rollback del piloto

Apagar el flag es instantáneo y no requiere deploy ni migración:

```sql
UPDATE configuracion SET valor = 'false'
WHERE negocio_id = '<negocio_id_nonna_maye>' AND clave = 'repartidor_notif_plantilla_activo';
```

Esto revierte a texto libre inmediatamente (comportamiento previo, ya
probado como no-regresivo). Las migraciones 032/033 no requieren down en
un rollback de piloto — las tablas/columnas simplemente dejan de recibir
datos nuevos; sus down solo se usarían en un rollback completo del código,
no del piloto.

## 10. Fuera de alcance de este cambio (decisión explícita)

- No se implementa reintento automático de notificaciones fallidas (el
  registro de intentos permite construirlo después, con datos reales, en
  vez de adivinar).
- No se agrega un candado adicional de identidad en `/repartidor/aceptar/:token`
  (ver sección 3) más allá de un solo uso + expiración.
- No se toca el flujo de auto-registro de repartidores por WhatsApp
  (`repartidor Nombre Apellido`) ni la limpieza de repartidores inactivos
  en la base (28 registros activos, algunos con nombres claramente
  obsoletos/mal capturados -- es un problema de higiene de datos aparte,
  no de este hotfix).
- No se agrega UI nueva en el panel para ver el estado de entrega por
  repartidor -- la tabla `notificaciones_repartidor` queda lista para eso,
  pero no se pidió en este encargo.
- No se calcula un "pago estimado" propio del repartidor (comisión,
  distancia, etc.) -- se usa `pedido.total` como valor de referencia.
