# Cierre — Portal Operativo del Repartidor

Rama `feat/portal-operativo-repartidor`, base `3333996` (commit real
desplegado, incluye los hotfixes de oferta, enlace de pago y búsqueda por
folio).

## 1. Diagnóstico del portal anterior

El portal EXISTÍA completo (`panel/repartidor.html`): login/registro por
teléfono, "mis pedidos" con Ver ruta (Google Maps) y botón Entregado,
pedidos disponibles con aceptación, WebSocket y push. Sus endpoints
(`/api/repartidor/login|registro|pedidos|pedido/:folio/aceptar|entregado|push/subscribe`)
siguen vivos en server.js.

**Causas exactas de la regresión** (no fue borrado, fue estrangulado por
los refactors de seguridad):

1. **Registro sin negocio**: `/api/repartidor/registro` daba de alta sin
   `negocio_id`; el refactor P0 hizo fail-closed todos los endpoints
   (`403 "Repartidor sin negocio resuelto"`) → cualquier repartidor dado
   de alta desde el portal quedaba permanentemente bloqueado. (El alta por
   WhatsApp sí liga negocio.)
2. **WebSocket raíz eliminado**: el portal se conectaba a `wss://host/`;
   el aislamiento multi-tenant movió los WS a rutas autenticadas
   (`/ws/panel`, `/ws/superadmin`) → el portal quedaba en "Reconectando…"
   para siempre y sin eventos.
3. **Sin puerta de entrada**: el flujo actual de ofertas (plantilla +
   enlace + pantalla pública) nunca enlazaba al portal del ganador.
4. Además, `Marcar entregado` usaba `actualizarEstadoPedido` (memoria) sin
   validar la ASIGNACIÓN (cualquier repartidor del negocio podía entregar
   el pedido de otro) y fallaba si el proceso se había reiniciado (pedido
   fuera de memoria).

## 2. Arquitectura

- **Oferta (pública, pre-aceptación)**: la pantalla del enlace ya
  desplegada — negocio, colonia/calle, pago, botón Aceptar. Sin número
  exterior, teléfono, referencias ni historial. (Sin cambios.)
- **Portal operativo (post-asignación)**: `panel/repartidor.html`
  reconstruido móvil-primero (375 px): tabs Mi entrega / Disponibles / Mis
  entregas.
- **Autenticación — Opción A (existente)**: token individual persistente
  de `repartidores.token` vía `x-rep-token` (login por teléfono). Se
  agregó **rate limit** a login (10/10 min por IP) y registro (5/10 min).
  El token de una oferta perdida jamás da acceso (vive en
  `notificaciones_repartidor`, otro dominio). `repartidor_id` nunca se
  acepta del navegador. **Pendiente documentado**: código de verificación
  por WhatsApp para endurecer el login por teléfono.
- **Registro**: ahora exige el negocio por slug
  (`/repartidor.html?negocio=<slug>`, enlace que comparte el negocio);
  sin slug válido → 400 con mensaje claro.
- **Ganador → portal**: la pantalla `asignado_a_mi` incluye el botón
  "Ver mi entrega" → `/repartidor.html`. WhatsApp sigue siendo el aviso;
  las plantillas Meta no se tocaron. Los demás repartidores siguen viendo
  "cubierto por Nombre".

## 3. Estados operativos

El estado PRINCIPAL del pedido (nuevo/en_preparacion/listo/entregado/
cancelado) no se amplía — gobierna cocina/corte/ventas. El avance del
repartidor vive en `datos.entrega_estado`
(`asignado → recogido → en_camino → entregado`) con timestamps
`recogido_at`/`en_camino_at` (JSONB, sin migración):

- `asignarRepartidor` sella `entrega_estado='asignado'` (mismo UPDATE
  atómico de siempre; carrera intacta).
- `recogido`/`en_camino`: UPDATE atómico con dueño (`repartidor_id`) + no
  terminal; idempotente (COALESCE conserva el primer timestamp);
  broadcast `entrega_estado` al panel del negocio.
- `entregado`: `marcarEntregadoRepartidor` — transición terminal atómica
  en DB (dueño + no terminal en el mismo UPDATE), `entregado_at` solo la
  primera vez (mismo guard de la migración 036 → métricas D.1 intactas),
  sincroniza memoria del OrderManager si está viva y emite
  `actualizar_estado` aislado por negocio. Doble clic → `{ok, ya:true}`.
  Cancelado → 409 con mensaje; ajeno → 403; inexistente → 404. El aviso
  de WhatsApp al cliente se conserva.

## 4. Historial "Mis entregas"

`GET /api/repartidor/entregas?rango=hoy|7d|30d&estado=todos|entregados|cancelados&pagina=N`
— solo terminales PROPIOS del negocio propio, 20 por página con conteo
total. **Política de privacidad post-entrega**: sin teléfono del cliente,
sin calle/número/referencias — solo colonia, folio, tiempos (aceptado/
entregado/duración), pago y estado (+ motivo de cancelación). La duración
se deriva de `notificaciones_repartidor.token_usado_at` (igual que las
métricas); aceptaciones hechas desde el propio portal no tienen token y
muestran "—" (documentado, no se inventa).

## 5. Datos personales

- Pedido ACTIVO asignado: nombre, teléfono (clicable), dirección completa,
  entre calles, referencias, notas, total y forma de pago.
- Pedido terminado: solo los campos del historial (arriba).
- Antes de aceptar (pestaña Disponibles y oferta pública): solo
  colonia/calle y monto — misma política del primer mensaje.

## 6. Ruta

Botón `Abrir ruta`: coordenadas si existen
(`google.com/maps/dir/?api=1&destination=lat,lng`), si no dirección
estructurada con `encodeURIComponent` (acentos/referencias seguras).
Funciona como URL universal (Google Maps app/web; en iPhone abre el
navegador o la app si está instalada). Abrir el mapa no cambia ningún
estado.

## 7. Incidencias

`POST /api/repartidor/pedido/:folio/incidencia` — tipos:
direccion_no_encontrada, cliente_no_responde, pedido_no_listo,
problema_cobro, vehiculo, otro (+texto ≤300). Se anexa a
`datos.incidencias[]` (auditoría en el propio pedido, sin migración) y se
avisa por WS a la Central del negocio (solo admin) y a Superadmin. Jamás
cambia estados ni reasigna.

## 8. Tiempo real

El WS raíz del portal viejo no existe; los WS actuales exigen sesión de
panel. El portal usa **polling moderado de 25 s + botón Actualizar** (y
recarga tras cada acción). Una cancelación del negocio aparece en el
siguiente ciclo: el pedido sale de "Mi entrega", el intento de entregar
responde "fue cancelado" y queda en el historial como cancelado.
**Pendiente documentado**: canal WS autenticado por token de repartidor.

## 9. API

`GET /me` · `GET /pedido-actual` · `GET /entregas` ·
`POST /pedido/:folio/recogido|en-camino|entregado|incidencia` (+ las
previas `login/registro/pedidos/aceptar/push`). Todo deriva repartidor y
negocio del token autenticado.

## 10. Migración

**No necesaria**: sub-estados, timestamps e incidencias viven en el JSONB
`datos` del pedido; el esquema de `repartidores` (035) ya trae estado.
041 sigue libre.

## 11. Pruebas

Suite `fase-portal-repartidor` 12/12 (registro/sesión/actual/aislamiento/
estados/incidencia/entregado/historial/frontend-XSS) + regresión completa
(ver reporte). Sin repartidores ni pedidos reales.

## 12. Rollout (NO ejecutado)

1 repartidor de prueba en un negocio propio → registro con el enlace con
slug → pedido ficticio → aceptar (portal o enlace) → portal muestra la
entrega → Abrir ruta → recogido → en camino → entregado → historial →
verificar Central/comanda/métricas. Criterio de salida: una entrega
completa sin divergencia entre portal, Central y comanda.

## 13. Deploy y rollback

Deploy normal (sin migraciones). Rollback: redeploy del commit anterior —
los campos JSONB nuevos son inofensivos para el código previo.

## 14. Riesgos y pendientes

- Login por teléfono sin segundo factor (rate-limited; código por
  WhatsApp pendiente).
- Tiempo real por polling (WS autenticado de repartidor pendiente).
- Sin coordenadas capturadas hoy: la ruta usa dirección textual.
- La comanda del panel muestra repartidor asignado; pintar también el
  sub-estado (`entrega_estado`, evento ya emitido) es mejora visual
  pendiente del panel.
