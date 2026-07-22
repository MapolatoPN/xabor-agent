# Xabor — Agente de Pedidos y Panel de Comandas

## Descripción
Sistema de gestión de pedidos para restaurante. Recibe órdenes por WhatsApp, llamada y presencial (POS). Las muestra en un panel web en tiempo real con WebSocket, imprime comandas de cocina y tickets de cliente, y envía reportes diarios por WhatsApp.

## Stack
- **Backend**: Node.js 20 + Express, ESModules (`"type": "module"`)
- **Base de datos**: PostgreSQL (Railway) vía `pg` pool
- **WebSocket**: `ws` nativo
- **Push notifications**: Web Push API + VAPID (`web-push`)
- **WhatsApp**: Meta Cloud API (whatsapp-meta.js)
- **Deploy**: Railway (auto-deploy desde GitHub `main`)
- **Timezone**: `America/Matamoros` (CST, UTC-6)

## Estructura de archivos
```
src/
  server.js              # Servidor Express principal, rutas API, WebSocket, jobs
  orders/orderManager.js # Gestión en memoria + emisión WS de pedidos activos
  services/database.js   # Pool PostgreSQL, todas las funciones de DB
  channels/
    whatsapp-meta.js     # Webhook y envío Meta Cloud API
    voice.js             # Pipeline de voz (Deepgram + ElevenLabs)
    rappi.js             # Webhook Rappi
  agent/
    brain.js             # Lógica del agente conversacional (OpenAI)
    session.js           # Sesiones de conversación en memoria
    prompts.js           # System prompts
  services/
    clip-api.js          # Generación de enlaces de pago Clip
    rappi-api.js         # OAuth + endpoints Rappi
    learner.js           # Análisis semanal de conversaciones
panel/
  index.html             # Panel de comandas (SPA, sin framework)
  sw.js                  # Service Worker para push notifications
  login.html             # Login simple
public/
  menu.png               # Imagen del menú
```

## Variables de entorno (Railway)
```
DATABASE_URL             # PostgreSQL connection string (Railway provee)
ADMIN_TOKEN              # Contraseña del administrador del panel
PANEL_PASSWORD           # Contraseña del operador (staff)
OPENAI_API_KEY           # GPT-4o para el agente conversacional
WHATSAPP_TOKEN           # Meta Cloud API token
WHATSAPP_PHONE_ID        # ID del número de WhatsApp Business
WHATSAPP_VERIFY_TOKEN    # Token de verificación del webhook
VAPID_PUBLIC_KEY         # Para Web Push (generar con web-push)
VAPID_PRIVATE_KEY        # Para Web Push
VAPID_EMAIL              # mailto:admin@xabor.mx
WHATSAPP_ADMIN_NUMERO    # Número admin para reporte diario (ej: 528781234567)
ELEVENLABS_API_KEY       # Voz sintética para llamadas
DEEPGRAM_API_KEY         # Speech-to-text para llamadas
RAPPI_CLIENT_ID          # OAuth Rappi
RAPPI_CLIENT_SECRET      # OAuth Rappi
CLIP_API_KEY             # Pasarela de pago Clip
```

## Tablas principales en PostgreSQL
```sql
clientes           -- telefono (PK), nombre, ultima_visita, bot_pausado
pedidos            -- historial (WhatsApp/llamada, con FK a clientes)
pedidos_activos    -- todos los pedidos en curso (folio PK, datos JSONB, estado)
pedidos_programados-- pedidos agendados para fecha futura
mensajes           -- historial de chat WhatsApp
llamadas           -- registro de llamadas de voz
transcripciones    -- mensajes de cada llamada
push_subscriptions -- suscripciones Web Push
menu_categorias    -- categorías del menú
menu_productos     -- productos con precio
caja_fondo         -- fondo inicial de caja por día
```

> **Nota**: `pedidos_activos` es la fuente de verdad para corte de caja y ventas. Los presenciales solo se guardan aquí (la tabla `pedidos` tiene FK de teléfono que bloquea presenciales).

## Roles del panel
- **admin** — acceso completo: Comandas, POS, Corte, Historial, Ventas, Chats, Llamadas, Menú
- **staff** — acceso limitado: Comandas, POS, Chats

El token se genera como `hash(contraseña)`. El middleware `requireAdmin` compara contra `TOKEN_ADMIN`.

## Flujo de un pedido WhatsApp
1. Cliente escribe → webhook `/webhook/whatsapp` → `brain.js` genera respuesta con GPT-4o
2. Al confirmar → `registrarPedido()` → `guardarPedidoActivo()` + broadcast WS `nuevo_pedido`
3. Panel recibe WS → `agregarPedido()` → muestra comanda + auto-imprime comanda de cocina (800ms delay)
4. Staff cambia estado (en_preparacion → listo → entregado)
5. Al entregar → `archivarPedidoActivo()` (estado = 'entregado' en pedidos_activos)

## Impresión térmica (EC Line 80mm)
- **Comanda cocina** (`imprimirComanda`): número de orden grande, cliente, modalidad, items sin precios — auto-print al llegar pedido
- **Ticket cliente** (`imprimirTicketCliente`): receipt completo con RFC, Gran Total, monto en letras — botón manual al cobrar
- Ambos usan popup aislado (`window.open`) para evitar que el UI del panel interfiera con la impresión

## Jobs automáticos en server.js
- Cada 5 min: activar pedidos programados, sincronizar estado Rappi, reconciliar pagos Clip pendientes
- Cada minuto a las 22:01 CST: enviar reporte de corte de caja por WhatsApp al número admin

## Convenciones importantes
- **No avanzar** integraciones de pago ni cambios en producción sin aprobación del dueño
- IDs de pedido: `XAB-NNNN` (folio secuencial, nunca se reutiliza)
- `panelListo` flag: evita auto-print de pedidos existentes al reconectar WS (3s de gracia)
- `actualizarContador()` es null-safe — el elemento `#contador` puede no existir
- Git: hacer commits siempre desde PowerShell en Windows, NUNCA desde el sandbox de Claude (corrompe archivos)

## Estado actual (julio 2026)
- Push notifications: funcionando en desktop y computadora del negocio ✅
- Corte de caja: solo visible para admin ✅
- Reporte diario WhatsApp: activo a las 22:01 CST ✅
- Editar forma de pago: disponible para admin en comandas activas e historial ✅
- Comanda cocina vs Ticket de cliente: separados, auto-print es comanda sin precios ✅
- CLAUDE.md en repo para contexto entre sesiones y máquinas ✅
- Configuración del negocio desde panel (Config tab, tabla configuracion) ✅
- Seguimiento de pedido por WhatsApp: cliente pregunta estado → respuesta directa de DB ✅
- Notificación automática "listo" al cliente por WA al cambiar estado en panel ✅
- Escalación de quejas: WhatsApp al admin (WHATSAPP_ADMIN_NUMERO) + SMS Twilio fallback ✅
- Monitoreo de errores: alerta WA al admin si bot falla 3+ veces en 5 min ✅
- Inventario rápido: checkbox disponible/agotado en tab Menú del panel (ya existía) ✅
- Cancelaciones: botón 🚫 en comandas activas (admin), estado=cancelado, excluido del corte ✅
- Devoluciones: botón ↩ en historial (admin), monto+motivo, se refleja en corte ✅
- Control de descuentos: staff ≤ 10%, motivo obligatorio, admin sin límite ✅
- CFDI con Facturapi: servicio facturapi.js, modal en panel, genera factura timbrada ✅

## Historial de decisiones importantes

### Impresión
- Se usa popup aislado (`window.open`) para imprimir — evita que el UI del panel aparezca en la impresión
- **Comanda** (🍽️): formato cocina, número de orden grande, sin precios, auto-print al llegar pedido
- **Ticket de cliente** (🧾): receipt completo, botón manual al cobrar, título "TICKET DE CLIENTE"
- Impresora: EC Line 80mm

### Corte de caja
- `obtenerVentas` y `obtenerResumenVentas` leen de `pedidos_activos` (JSONB), NO de `pedidos`
- Razón: la tabla `pedidos` tiene FK de teléfono que bloquea pedidos presenciales (teléfono "—")
- `pedidos_activos` es la fuente de verdad — contiene todos los canales

### Reporte diario WhatsApp
- Se envía a `WHATSAPP_ADMIN_NUMERO` (env var en Railway, formato: 528781234567)
- Hora: 22:01 CST (America/Matamoros) — cron cada minuto que verifica la hora
- Incluye: fondo inicial, total ventas, efectivo esperado, desglose por modalidad y canal
- Endpoint manual para disparar en cualquier momento: `POST /api/admin/reporte-diario/enviar` (solo admin)

### Editar forma de pago
- Solo admin puede editar (middleware `requireAdmin`)
- Endpoint: `PATCH /api/admin/pedido/:folio/pago`
- Actualiza en `pedidos_activos` con `jsonb_set`
- Se refleja en tiempo real vía WebSocket (`actualizar_pago`)
- Botón morado ✏️ Pago visible en comandas activas y en historial

### Seguimiento de pedido por WhatsApp
- En `whatsapp-meta.js`, antes de llamar a Claude, se detecta si el mensaje es una consulta de estado
- Regex: `/en\s*qu[eé]\s*va|estado.*pedido|cu[aá]nto\s*falta|ya\s*est[aá]\s*list.../i`
- Si hay pedido activo con ese teléfono en `pedidos_activos`, se responde directamente
- DB function: `obtenerPedidosActivosPorTelefono(telefono)` — busca por `datos->'cliente'->>'telefono'`
- Si no hay pedido activo, Claude responde de forma natural

### Notificación "listo" al cliente
- En `PATCH /pedidos/:id/estado`, cuando estado = 'listo', envía WA automático al cliente
- No envía si es presencial (telefono = "—" o vacío)
- Mensaje diferente para "recoger en tienda" vs "entrega a domicilio"

### Escalación de quejas
- `notificarEscalacion(telefono)` en `whatsapp-meta.js`
- Primero envía WA al admin (`WHATSAPP_ADMIN_NUMERO`)
- Luego SMS Twilio como fallback si `TWILIO_SMS_NUMBER` está configurado

### Monitoreo de errores
- Contador en memoria en `whatsapp-meta.js`: array `errores[]` con timestamps
- Si 3+ errores en 5 minutos → envía WA de alerta al admin
- `alertaEnviada` flag evita spam; se resetea tras 15 minutos

### Git — regla crítica
- **NUNCA hacer commits desde el sandbox de Claude** — corrompe archivos (trunca el contenido)
- Siempre hacer `git add`, `git commit`, `git push` desde PowerShell en Windows
- Si hay `index.lock` o `HEAD.lock`: `Remove-Item C:\xabor-agent\.git\*.lock -Force`

### Computadora del negocio
- El repo fue copiado por USB — está desactualizado
- Para actualizar: `cd C:\xabor-agent && git pull origin main`
- Abrir carpeta `C:\xabor-agent` en Cowork para que lea este CLAUDE.md automáticamente

## Pendientes

### POS completo (COMPLETADO ✅)
- Cancelaciones con motivo — botón admin en comandas, excluidas del corte ✅
- Devoluciones con monto+motivo — botón admin en historial, resta del corte ✅
- Control de descuentos por rol — staff ≤ 10%, motivo obligatorio ✅
- CFDI vía Facturapi — requiere `FACTURAPI_KEY` en Railway ✅
- Inventario: toggle disponible/agotado en tab Menú ✅

### Agente WhatsApp
- Imagen del menú automática: el marcador `<ENVIAR_MENU>` ya existe y funciona;
  el prompt ya instruye al bot a usarlo. Verificar con cliente real si se envía bien.

### SaaS / Productización
- Guía de onboarding para nuevos restaurantes (Railway + WA + variables de entorno)
- Modelo de negocio: mensualidad, por pedido, setup fee

### Técnicos
- Push notifications en móvil: pendiente verificar (en desktop/computadora del negocio ya funciona)
- JWT con expiración (tokens estáticos actuales son menos seguros)
