# Clientes: el CRM del negocio sobre `clientes_negocio`

El tab **Clientes** del panel es el CRM canónico del negocio. Desde esta
entrega deja de leer `clientes` (PK global por teléfono, primero que llega
gana entre negocios) y `perfiles_clientes` (métricas calculadas sin filtrar
negocio) y lee **`clientes_negocio`**: una persona por (negocio, teléfono a 10
dígitos), la misma entidad que usa la cuenta del cliente en la tienda.

Rama `feat/crm-clientes-v2`. Migración nueva: **081** (índice + backfill).
`clientes` y `perfiles_clientes` se conservan como histórico de WhatsApp; el
endpoint viejo `/api/admin/clientes` sigue vivo, pero el panel ya no lo usa.

## Quién es cliente de un negocio

Alguien es cliente del negocio X si:

1. **se registró** en la tienda de X (OTP), aunque no haya comprado
   (`origen = tienda`);
2. **tenía puntos** en el Rewards de X (backfill de la 080, `origen = rewards`);
3. **pidió** en X por cualquier canal (`origen` = canal del **primer** pedido
   en X: `whatsapp`, `checkout` (tienda como invitado), `voz`, `mostrador`).

La relación negocio↔teléfono nunca sale de `clientes.negocio_id` (que solo
recuerda al primer negocio que vio el teléfono): sale de evidencia que ya es
por negocio, `pedidos_activos.negocio_id`. La 081 hace el backfill y un
**reconciliador** cada 5 minutos (`reconciliarClientesDesdePedidos`) crea las
fichas que falten a partir de los pedidos recientes, en segundo plano, sin
tocar `orderManager` ni el camino síncrono de un pedido. Idempotente por la
`UNIQUE (negocio_id, telefono)`.

Una persona es **una fila por negocio**: el mismo teléfono en Nonna Maye y en
Mapolato son dos clientes con dos historias. Quien solo conversó por WhatsApp
sin pedir sigue en Chats; no entra al CRM como cliente.

Teléfonos sintéticos (`pos-…` de mostrador sin teléfono, `rappi-…`, `—`,
cortos) nunca se vuelven clientes.

## Métricas por negocio, no perfiles globales

Pedidos, total gastado, ticket promedio, primera y última compra se calculan
**en cada consulta** desde `pedidos_activos WHERE negocio_id = X` (cancelados
fuera), casando el teléfono del pedido normalizado a 10 dígitos con el
cliente (WhatsApp guarda `521…`, POS y tienda 10 dígitos). La 081 pone un
índice de expresión `(negocio_id, right(regexp_replace(tel,'\D',''),10))`
para que sea instantáneo.

No se creó `perfiles_clientes_negocio`: producción entera tiene unos cientos
de pedidos activos y el agregado cabe en la consulta paginada. Si un negocio
llega a decenas de miles, se materializa después sin cambiar la API.

**Segmento**: las mismas reglas que `memory.js` aplica al perfil de WhatsApp
(VIP ≥ 10 pedidos o ≥ $3 000; frecuente ≥ 3; dormido > 45 / > 30 días sin
comprar; en riesgo por score de abandono), pero sobre las cifras del negocio.
Sin compras: «nuevo».

## Endpoints (solo admin, negocio de la sesión)

| Ruta | Qué devuelve |
|---|---|
| `GET /api/admin/clientes/v2` | `{ clientes, total, page, limit, paginas }`. Parámetros: `q` (nombre, teléfono en cualquier formato, correo), `origen`, `segmento`, `registrado=si|no`, `rewards=si|no`, `consent_wa`, `consent_email`, `compro=si|no`, `ultima_desde`, `ultima_hasta` (YYYY-MM-DD), `orden` (total \| ultima \| alta \| pedidos \| puntos \| nombre), `page`, `limit` (≤ 100) |
| `GET /api/admin/clientes/v2/resumen` | total, registrados, con_rewards, consent_whatsapp, consent_email, compraron_30d, nuevos_30d, sin_compras, puntos_vivos |
| `GET /api/admin/clientes/v2/:id` | ficha: cliente + métricas, Rewards (saldo, nivel, movimientos, ganados, canjeados — leído con `rewardsDelCliente`), direcciones, pedidos del negocio (folio, fecha, canal, modalidad, estado, total, seguimiento), consentimientos (canal, otorgado, fecha, fuente), sesiones (activas, último uso, registrado desde) |
| `POST /api/admin/clientes/v2/:id/cerrar-sesiones` | revoca todas las sesiones de la tienda del cliente |

Un `:id` se busca **siempre** junto con `negocio_id`: el id de un cliente de
otro negocio responde 404, igual que uno inventado. La búsqueda y los filtros
viven en SQL sobre el conjunto del negocio; la paginación es real (nada de
500 filas en el navegador).

## El tab

`panel/index.html`, bloque `#vista-clientes` y JS `// ─── Tab Clientes`.
Orden de lectura: persona → actividad → valor → Rewards → contacto.

- Tarjetas: clientes, con cuenta en la tienda, compraron 30 días, nuevos 30
  días, con Rewards, aceptan promos por WhatsApp.
- Buscador (servidor, con debounce), filtros de origen / situación /
  segmento, orden, paginación.
- Columnas: Cliente (segmento, «● cuenta»), Contacto (teléfono, correo),
  Origen (chip: Tienda · Rewards · WhatsApp · Checkout · Mostrador), Alta,
  Última compra, Pedidos, Ticket, Total, Puntos, Promos (WA / correo).
- Ficha: resumen (cliente desde, primera y última compra, pedidos, total,
  ticket), Rewards (con enlace al ajuste administrativo que ya existe en el
  tab Rewards), Direcciones, Pedidos, Marketing, Cuenta en la tienda (cerrar
  sesiones), WhatsApp.
- La actividad de WhatsApp (conversión, conversaciones sin cerrar) se
  conserva, plegada: es actividad de chats, no la definición de cliente. Las
  campañas siguen exactamente donde estaban.

## Campañas y consentimiento (auditoría, sin cambios en esta entrega)

`obtenerDestinatariosCampana` (`database.js:7320`) elige por segmento de
`clientes` / `perfiles_clientes` y **no consulta `cliente_consentimientos`**:
el concepto no existía cuando se escribió. Filtra `negocio_id`, así que no es
una fuga entre negocios; es un hueco de consentimiento. No se tocó.

Propuesta para la siguiente fase:

1. Destinatarios desde `clientes_negocio` ⋈ último consentimiento por canal
   (`whatsapp` para campañas de WhatsApp; `email` cuando existan por correo),
   con los mismos filtros de segmento/origen del CRM.
2. Modo de transición **explícito**, porque es una decisión de negocio:
   *opt-in estricto* (hoy daría casi cero destinatarios) o *interés
   legítimo* para quienes ya compraron por WhatsApp en el negocio, con baja
   automática al recibir «STOP»/«BAJA» (fila `otorgado = false`, fuente
   `whatsapp_stop`).
3. Registrar por campaña cuántos quedaron fuera por consentimiento, para que
   el dueño vea el efecto.

## Migración 081

Corre sola en el deploy (`predeploy-run` → `predeploy-081-crm-clientes-negocio.mjs`).
Aditiva e idempotente: el índice con `IF NOT EXISTS`, el backfill con
`ON CONFLICT DO NOTHING`. El predeploy fotografía pedidos y Rewards antes y
después y **aborta si algo cambió**; reporta clientes por origen.

A mano: `DATABASE_URL=… node scripts/predeploy-081-crm-clientes-negocio.mjs`
(dos veces: la segunda dice «Ya aplicada»).

**Rollback**: `git revert` de los commits; con el código viejo el índice y
las filas nuevas son inertes. `081_crm_clientes_negocio_down.sql` quita solo
el índice: las personas creadas por el backfill son clientes reales, pueden
tener direcciones/sesiones ya, y la 080 las borraría en cascada — retirarlas
sería una decisión con datos, no un rollback ciego.

## Pruebas

| Suite | Casos | Qué responde |
|---|---|---|
| `test/fase-crm-clientes.mjs` | 14 | Backfill idempotente; A no ve a B; misma persona en dos negocios con métricas separadas; búsqueda por teléfono (cualquier formato) y correo que no cruza; filtros; paginación real; resumen; ficha (Rewards, 2 direcciones, pedidos solo del negocio, cancelado listado pero no contado, consentimiento, sesiones); ficha ajena 404; cerrar sesiones; staff fuera; reconciliador una sola vez; endpoint viejo vivo |
| `test/fase-crm-clientes-ui.mjs` | 10 | Puppeteer en escritorio y tablet: sidebar, tarjetas, columnas, búsqueda, filtro en servidor, ficha completa, campañas en su lugar, cero errores JS |

Mordidas (4/4): quitar `negocio_id` en la base del CRM, en las métricas, en
la ficha o en los pedidos de la ficha pone en rojo exactamente sus pruebas.

## Pendiente (fuera de esta entrega)

- Editar nombre/correo y marcar «interno» desde la ficha v2 (el endpoint
  viejo `PATCH /api/admin/clientes/:telefono/interno` sigue vivo sobre
  `clientes`).
- Exportar CSV.
- Campañas con consentimiento (arriba).
- Retirar `perfiles_clientes` cuando WhatsApp deje de escribirla.
