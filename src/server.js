import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHmac } from 'crypto';

import { procesarMensaje } from './agent/brain.js';
import {
  registrarPedido,
  emitirPedido,
  actualizarEstadoPedido,
  eliminarPedido,
  obtenerPedidos,
  setWsBroadcast,
  cargarPedidosDesdeDB
} from './orders/orderManager.js';
import { deleteSession } from './agent/session.js';
import { initDB, obtenerConversacion, obtenerConversacionesRecientes, guardarMensaje, obtenerVentas, obtenerResumenVentas, obtenerPedidosEntregados, setBotPausado, getBotPausado, confirmarPagoPedido, guardarPedidoProgramado, obtenerPedidosPorActivar, marcarPedidoProgramadoActivado, obtenerPedidosProgramadosPendientes, obtenerLlamadasRecientes, obtenerTranscripcionPorLlamada, obtenerPagosPendientesConLink, guardarFondoCaja, obtenerFondoCaja, seedMenuDesdeJSON, obtenerMenuCompleto, crearCategoria, actualizarCategoria, eliminarCategoria, crearProducto, actualizarProducto, eliminarProducto, guardarSuscripcionPush, obtenerSuscripcionesPush, eliminarSuscripcionPush, actualizarFormaPago, obtenerConfiguracion, actualizarConfiguracion, cancelarPedidoActivo, registrarDevolucion } from './services/database.js';
import { generarFactura, enviarFacturaPorEmail, descargarFacturaPDF } from './services/facturapi.js';
import webpush from 'web-push';
import whatsappRouter, { enviarMensaje, setWsBroadcastWA } from './channels/whatsapp-meta.js'; // Meta Cloud API
// import whatsappRouter from './channels/whatsapp.js'; // Twilio (respaldo)
import voiceRouter, { setupVoiceWebSocket } from './channels/voice.js';
import rappiRouter, { setWsBroadcastRappi, manejarStockout } from './channels/rappi.js';
import { configurarWebhooks, subirCatalogo, construirCatalogoRappi, actualizarSchedule, actualizarEstadoTienda } from './services/rappi-api.js';
import { consultarEstadoPago } from './services/clip-api.js';
import { analizarSemana } from './services/learner.js';
import { registrarRepartidor, obtenerRepartidorPorToken, obtenerRepartidorPorTelefono, obtenerRepartidores, guardarPushRepartidor, obtenerPushRepartidores, asignarRepartidor, obtenerPedidosParaRepartidor } from './services/database.js';

import { readFileSync } from 'fs';
const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// Config del negocio — se carga desde DB al iniciar y se cachea en memoria
let negocioConfig = {
  nombre: 'Restaurante', nombre_corto: 'NEGOCIO',
  direccion: '', ciudad: '', rfc: '', telefono: '', whatsapp: '', horario: ''
};
async function cargarConfig() {
  const cfg = await obtenerConfiguracion().catch(() => ({}));
  negocioConfig = { ...negocioConfig, ...cfg };
  console.log('[Config] Negocio cargado:', negocioConfig.nombre);
}
export function getConfig() { return negocioConfig; }

// ─── Integraciones en memoria (DB > env var) ─────────────────────────────────
let integracionesCache = {};
async function cargarIntegraciones() {
  const cfg = await obtenerConfiguracion().catch(() => ({}));
  integracionesCache = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (k.startsWith('int_')) integracionesCache[k.slice(4)] = v;
  }
  console.log('[Config] Integraciones cargadas:', Object.keys(integracionesCache).join(', ') || 'ninguna (usando env vars)');
}

// Mapa: clave interna → variable de entorno de respaldo
const ENV_MAP = {
  wa_token:          'WHATSAPP_TOKEN',
  wa_phone_id:       'WHATSAPP_PHONE_ID',
  wa_verify_token:   'WHATSAPP_VERIFY_TOKEN',
  wa_admin_numero:   'WHATSAPP_ADMIN_NUMERO',
  clip_api_key:      'CLIP_API_KEY',
  clip_api_secret:   'CLIP_API_SECRET',
  facturapi_key:     'FACTURAPI_KEY',
  anthropic_api_key: 'ANTHROPIC_API_KEY',
  vapid_public_key:  'VAPID_PUBLIC_KEY',
  vapid_private_key: 'VAPID_PRIVATE_KEY',
  vapid_email:       'VAPID_EMAIL',
};
export function getIntegracion(clave) {
  return integracionesCache[clave] || process.env[ENV_MAP[clave]] || '';
}
const menuJSON = JSON.parse(readFileSync(join(__dirname, 'data/menu.json'), 'utf-8'));

// ─── Autenticación del panel ──────────────────────────────────────────────────
const PANEL_PASSWORD = process.env.PANEL_PASSWORD || 'xabor2024';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'xabor-admin';
const PANEL_SECRET   = process.env.PANEL_SECRET   || 'xabor-secret-key';

function generarToken(password) {
  return createHmac('sha256', PANEL_SECRET).update(password).digest('hex');
}

const TOKEN_STAFF = generarToken(PANEL_PASSWORD);
const TOKEN_ADMIN = generarToken(ADMIN_PASSWORD);
// Compatibilidad con nombre antiguo
const TOKEN_VALIDO = TOKEN_STAFF;

function getRole(token) {
  if (token === TOKEN_ADMIN)  return 'admin';
  if (token === TOKEN_STAFF)  return 'staff';
  return null;
}

function requireAuth(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  const token = auth.slice(7);
  const role  = getRole(token);
  if (!role) return res.status(401).json({ error: 'Token inválido' });
  req.role = role;
  next();
}

function requireAdmin(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'No autorizado' });
  const token = auth.slice(7);
  if (token !== TOKEN_ADMIN) return res.status(403).json({ error: 'Solo administradores' });
  req.role = 'admin';
  next();
}

// ─── Web Push — VAPID ────────────────────────────────────────────────────────
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY  || '';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_EMAIL   = process.env.VAPID_EMAIL       || 'mailto:admin@xabor.mx';

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);
  console.log('[Push] VAPID configurado');
} else {
  console.warn('[Push] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY no configurados — push desactivado');
}

async function enviarPushATodos(titulo, cuerpo, data = {}) {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) { console.log('[Push] VAPID no configurado — omitiendo'); return; }
  let subs;
  try { subs = await obtenerSuscripcionesPush(); } catch (e) { console.error('[Push] Error leyendo suscripciones:', e.message); return; }
  console.log(`[Push] Enviando "${titulo}" a ${subs.length} suscripción(es)`);
  const payload = JSON.stringify({ titulo, cuerpo, data });
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { auth: sub.auth, p256dh: sub.p256dh } },
        payload
      );
    } catch (e) {
      if (e.statusCode === 410 || e.statusCode === 404) {
        // Suscripción expirada — limpiar
        await eliminarSuscripcionPush(sub.endpoint).catch(() => {});
      } else {
        console.error('[Push] Error enviando notificación:', e.message);
      }
    }
  }
}

async function enviarPushARepartidores(titulo, cuerpo, data = {}) {
  const vapidPub = getIntegracion('vapid_public_key') || VAPID_PUBLIC;
  const vapidPri = getIntegracion('vapid_private_key') || VAPID_PRIVATE;
  const vapidEmail = getIntegracion('vapid_email') || VAPID_EMAIL;
  if (!vapidPub || !vapidPri) return;
  try { webpush.setVapidDetails(vapidEmail, vapidPub, vapidPri); } catch {}
  const subs = await obtenerPushRepartidores();
  if (!subs.length) return;
  const payload = JSON.stringify({ titulo, cuerpo, data });
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { auth: sub.keys.auth, p256dh: sub.keys.p256dh } },
        payload
      );
    } catch (e) { console.error('[Push Repartidor] Error:', e.message); }
  }
}
export { enviarPushARepartidores };

const app = express();
const server = createServer(app);

// ─── WebSocket: panel de comandas + Conversation Relay de voz ───────────────
const wss      = new WebSocketServer({ noServer: true }); // panel
const wssVoice = new WebSocketServer({ noServer: true }); // voz

// Enrutar conexiones WebSocket por path
server.on('upgrade', (req, socket, head) => {
  if (req.url === '/ws/voice') {
    wssVoice.handleUpgrade(req, socket, head, (ws) => {
      wssVoice.emit('connection', ws, req);
    });
  } else {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  }
});

function broadcast(data) {
  const mensaje = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === 1) { // 1 = OPEN
      client.send(mensaje);
    }
  });
  // Push notification para nuevo pedido
  if (data.tipo === 'nuevo_pedido') {
    const p = data.pedido;
    const canal = p?.canal === 'presencial' ? 'Presencial' : (p?.canal === 'rappi' ? 'Rappi' : 'WhatsApp');
    const cliente = p?.cliente?.nombre || 'Cliente';
    const total   = p?.total ? `$${Number(p.total).toFixed(0)}` : '';
    enviarPushATodos(
      `🛎 Nuevo pedido — ${canal}`,
      `${cliente}${total ? ' · ' + total : ''}`,
      { pedidoId: p?.id || p?.folio }
    ).catch(() => {});
  }
  // Push notification para mensaje nuevo de WhatsApp
  if (data.tipo === 'nuevo_mensaje' && data.mensaje?.direccion === 'entrante') {
    const tel = data.mensaje?.telefono || '';
    const txt = data.mensaje?.texto?.slice(0, 60) || 'Nuevo mensaje';
    enviarPushATodos('💬 Nuevo mensaje WhatsApp', txt, { telefono: tel }).catch(() => {});
  }
}

// Inyectar broadcast en el orderManager, whatsapp y rappi
setWsBroadcast(broadcast);
setWsBroadcastWA(broadcast);
setWsBroadcastRappi(broadcast);

// Activar WebSocket de voz (Conversation Relay)
setupVoiceWebSocket(wssVoice);

wss.on('connection', (ws) => {
  console.log('[WS] Panel conectado');

  // Enviar pedidos existentes al panel cuando se conecta
  const pedidosActivos = obtenerPedidos().filter(p => p.estado !== 'entregado');
  pedidosActivos.forEach(pedido => {
    ws.send(JSON.stringify({ tipo: 'nuevo_pedido', pedido }));
  });

  ws.on('close', () => console.log('[WS] Panel desconectado'));
});

// ─── Middlewares ─────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Twilio envía form-urlencoded

// Archivos estáticos: panel y audios generados por ElevenLabs
app.use(express.static(join(__dirname, '../panel')));
app.use('/audio', express.static(join(__dirname, '../public/audio')));
app.use('/public', express.static(join(__dirname, '../public')));

// ─── Rutas de webhooks (canales) ────────────────────────────────────────────
app.use('/webhook/whatsapp', whatsappRouter);
app.use('/webhook/voice', voiceRouter);
app.use('/webhook/rappi', rappiRouter);

// Clip — notificación de pago completado
app.post('/webhook/clip', async (req, res) => {
  // Responder 200 inmediatamente (Clip espera respuesta rápida)
  res.sendStatus(200);

  try {
    const evento = req.body;
    // Clip Checkout Webhook: resource_status + me_reference_id
    const status = evento?.resource_status;
    const ref    = evento?.me_reference_id;
    console.log(`[Clip] Webhook recibido — pedido: ${ref}, status: ${status}, resource: ${evento?.resource}`);

    // Pago completado — persistir en BD y notificar al panel
    if (status === 'COMPLETED' && evento?.resource === 'CHECKOUT') {
      await confirmarPagoPedido(ref);
      broadcast({ tipo: 'pago_confirmado', pedidoId: ref, proveedor: 'clip' });
      console.log(`[Clip] ✅ Pago confirmado y guardado para pedido ${ref}`);
    }
  } catch (e) {
    console.error('[Clip] Error al procesar webhook:', e.message);
  }
});

// Página de agradecimiento post-pago (redirect desde Clip)
app.get('/pago/gracias', (req, res) => {
  res.send(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Xabor — Pago recibido</title><style>body{font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#fafaf8;color:#333}h1{font-size:2rem;margin-bottom:.5rem}p{color:#666;font-size:1.1rem}</style></head><body><h1>Pago recibido</h1><p>Tu pago fue procesado correctamente. Puedes cerrar esta ventana.</p></body></html>`);
});

// ─── API interna ─────────────────────────────────────────────────────────────

// Auth — rutas públicas (no requieren token)
app.post('/api/auth/login', (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(401).json({ error: 'Contraseña incorrecta' });
  if (password === ADMIN_PASSWORD) return res.json({ token: TOKEN_ADMIN, role: 'admin' });
  if (password === PANEL_PASSWORD) return res.json({ token: TOKEN_STAFF, role: 'staff' });
  return res.status(401).json({ error: 'Contraseña incorrecta' });
});

app.get('/api/auth/verify', requireAuth, (req, res) => {
  res.json({ ok: true, role: req.role });
});

// Proteger todas las rutas /api/* excepto las de auth
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth/')) return next();
  requireAuth(req, res, next);
});

// Servir panel principal solo con sesión válida
app.get('/', (req, res) => {
  res.sendFile(join(__dirname, '../panel/index.html'));
});

// Salud del servidor
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// Chat de prueba (sin Twilio)
app.post('/chat', async (req, res) => {
  const { sessionId, mensaje } = req.body;
  if (!sessionId || !mensaje) {
    return res.status(400).json({ error: 'Se requiere sessionId y mensaje' });
  }

  try {
    const resultado = await procesarMensaje(sessionId, mensaje);

    if (resultado.orden) {
      const pedido = registrarPedido(resultado.orden, 'api');
      emitirPedido(pedido);
      return res.json({ ...resultado, pedido });
    }

    res.json(resultado);
  } catch (error) {
    console.error('[server] Error en /chat:', error.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Ver todos los pedidos
app.get('/pedidos', (req, res) => {
  res.json(obtenerPedidos());
});

// Cambiar estado de un pedido (desde el panel)
app.patch('/pedidos/:id/estado', async (req, res) => {
  const { estado } = req.body;
  const estadosValidos = ['nuevo', 'en_preparacion', 'listo', 'entregado'];
  if (!estadosValidos.includes(estado)) {
    return res.status(400).json({ error: 'Estado inválido' });
  }
  const pedido = actualizarEstadoPedido(req.params.id, estado);
  if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });

  // Notificar al cliente por WhatsApp cuando el pedido está listo
  if (estado === 'listo') {
    const tel = pedido.cliente?.telefono;
    const esPresencial = !tel || tel === '—' || tel.length < 7;
    if (!esPresencial) {
      try {
        const msg = pedido.modalidad === 'recoger en tienda'
          ? `Tu pedido ${pedido.id} está listo. Puedes pasar a recogerlo cuando gustes.`
          : `Tu pedido ${pedido.id} está listo y en camino. Llega en unos minutos.`;
        await enviarMensaje(tel, msg);
        console.log(`[Panel] Notificación "listo" enviada a ${tel} para ${pedido.id}`);
      } catch (e) {
        console.error('[Panel] Error notificando cliente listo:', e.message);
      }
    }
  }

  res.json(pedido);
});

// Pedido presencial — capturado desde el panel sin pasar por el bot
app.post('/api/pedido-presencial', requireAuth, (req, res) => {
  const { items, nombre, forma_pago, total, descuento, motivo_descuento, billete, cambio, mixto_efectivo, mixto_terminal } = req.body;
  if (!items || !items.length) return res.status(400).json({ error: 'Sin items' });
  const subtotal = items.reduce((s, i) => s + (i.precio_unitario || 0) * (i.cantidad || 1), 0);
  const desc     = parseFloat(descuento) || 0;
  const orden = {
    items,
    subtotal,
    descuento: desc,
    motivo_descuento: motivo_descuento || null,
    billete: parseFloat(billete) || 0,
    cambio: parseFloat(cambio) || 0,
    mixto_efectivo: parseFloat(mixto_efectivo) || null,
    mixto_terminal: parseFloat(mixto_terminal) || null,
    total: total ?? (subtotal - desc),
    modalidad: 'recoger en tienda',
    canal: 'presencial',
    forma_pago: forma_pago || 'efectivo',
    cliente: { nombre: nombre || 'Cliente presencial', telefono: '—' },
    costo_envio: 0
  };
  const pedido = registrarPedido(orden, 'presencial');
  emitirPedido(pedido);
  import('./services/database.js').then(({ guardarPedido }) => guardarPedido('presencial', orden)).catch(() => {});
  res.json({ ok: true, pedido });
});

// Eliminar pedido (pruebas / limpieza) — requiere contraseña de administrador
app.delete('/pedidos/:id', async (req, res) => {
  const pin = req.headers['x-admin-pin'];
  if (!pin || pin !== ADMIN_PASSWORD) {
    return res.status(403).json({ error: 'Contraseña de administrador incorrecta' });
  }
  const ok = await eliminarPedido(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Pedido no encontrado' });
  res.json({ ok: true });
});

// Actualizar forma de pago — solo admin
app.patch('/api/admin/pedido/:folio/pago', requireAdmin, async (req, res) => {
  const { folio } = req.params;
  const { forma_pago } = req.body;
  if (!forma_pago) return res.status(400).json({ error: 'forma_pago requerida' });
  const ok = await actualizarFormaPago(folio, forma_pago);
  if (!ok) return res.status(500).json({ error: 'No se pudo actualizar' });
  // Actualizar en memoria si el pedido sigue activo
  const { obtenerPedidoPorId } = await import('./orders/orderManager.js');
  const p = obtenerPedidoPorId(folio);
  if (p) p.forma_pago = forma_pago;
  broadcast({ tipo: 'actualizar_pago', id: folio, forma_pago });
  res.json({ ok: true });
});

// Cancelar pedido activo — solo admin
app.post('/api/admin/pedido/:folio/cancelar', requireAdmin, async (req, res) => {
  const { folio } = req.params;
  const { motivo } = req.body;
  if (!motivo?.trim()) return res.status(400).json({ error: 'Motivo requerido' });
  const ok = await cancelarPedidoActivo(folio, motivo.trim());
  if (!ok) return res.status(500).json({ error: 'No se pudo cancelar' });
  // Quitar del panel en tiempo real
  await eliminarPedido(folio).catch(() => {});
  broadcast({ tipo: 'cancelar_pedido', id: folio, motivo });
  console.log(`[Panel] Pedido ${folio} CANCELADO — ${motivo}`);
  res.json({ ok: true });
});

// Registrar devolución en pedido entregado — solo admin
app.post('/api/admin/pedido/:folio/devolucion', requireAdmin, async (req, res) => {
  const { folio } = req.params;
  const { monto, motivo } = req.body;
  if (!monto || parseFloat(monto) <= 0) return res.status(400).json({ error: 'Monto inválido' });
  if (!motivo?.trim()) return res.status(400).json({ error: 'Motivo requerido' });
  const ok = await registrarDevolucion(folio, parseFloat(monto), motivo.trim());
  if (!ok) return res.status(500).json({ error: 'No se pudo registrar la devolución' });
  broadcast({ tipo: 'devolucion_registrada', id: folio, monto: parseFloat(monto), motivo });
  console.log(`[Panel] Devolución ${folio}: $${monto} — ${motivo}`);
  res.json({ ok: true });
});

// Generar factura CFDI — solo admin
app.post('/api/admin/pedido/:folio/factura', requireAdmin, async (req, res) => {
  const { folio } = req.params;
  const { nombre_fiscal, rfc, regimen, email, uso_cfdi, cp } = req.body;
  if (!nombre_fiscal || !rfc) return res.status(400).json({ error: 'nombre_fiscal y rfc son requeridos' });
  if (!process.env.FACTURAPI_KEY) return res.status(503).json({ error: 'FACTURAPI_KEY no configurada en Railway' });

  // Obtener datos del pedido
  const { obtenerPedidoActivoPorFolio } = await import('./services/database.js');
  const { obtenerPedidosEntregados: _ent } = await import('./services/database.js');
  // Buscar en activos primero, luego en entregados
  let pedidoDatos = await obtenerPedidoActivoPorFolio(folio);
  if (!pedidoDatos) {
    const ents = await _ent(500);
    const found = ents.find(p => p.id === folio || p.folio === folio);
    pedidoDatos = found || null;
  }
  if (!pedidoDatos) return res.status(404).json({ error: 'Pedido no encontrado' });

  try {
    const factura = await generarFactura(pedidoDatos, { nombre_fiscal, rfc, regimen, email, uso_cfdi, cp });
    // Enviar por email si se proporcionó
    if (email && factura.id) await enviarFacturaPorEmail(factura.id, email).catch(() => {});
    res.json({
      ok: true,
      factura_id: factura.id,
      folio_fiscal: factura.uuid,
      pdf_url: `https://www.facturapi.io/v2/invoices/${factura.id}/pdf`,
      xml_url: `https://www.facturapi.io/v2/invoices/${factura.id}/xml`
    });
  } catch (e) {
    console.error('[Facturapi] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Descargar PDF de factura — proxy autenticado para el panel
app.get('/api/admin/factura/:facturaId/pdf', requireAdmin, async (req, res) => {
  try {
    const buf = await descargarFacturaPDF(req.params.facturaId);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=factura-${req.params.facturaId}.pdf`);
    res.send(Buffer.from(buf));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Conversaciones WhatsApp
app.get('/api/conversaciones', async (req, res) => {
  const lista = await obtenerConversacionesRecientes(20);
  res.json(lista);
});

app.get('/api/conversacion/:telefono', async (req, res) => {
  const msgs = await obtenerConversacion(req.params.telefono);
  res.json(msgs);
});

// Enviar mensaje manual desde el panel (link de pago, etc.)
app.post('/api/send-message', async (req, res) => {
  const { telefono, mensaje } = req.body;
  if (!telefono || !mensaje) {
    return res.status(400).json({ error: 'Se requiere telefono y mensaje' });
  }
  try {
    await enviarMensaje(telefono, mensaje);
    console.log(`[Panel] Mensaje manual enviado a ${telefono}: ${mensaje.slice(0, 60)}`);
    // Guardar y emitir al panel
    const msgGuardado = await guardarMensaje(telefono, null, 'saliente', mensaje);
    if (msgGuardado) broadcast({ tipo: 'nuevo_mensaje', mensaje: msgGuardado });
    res.json({ ok: true });
  } catch (error) {
    console.error('[Panel] Error al enviar mensaje:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Historial de entregados
app.get('/api/historial', requireAuth, async (req, res) => {
  const lista = await obtenerPedidosEntregados(100);
  res.json(lista);
});

// POS — Ventas (solo admin)
// Medianoche en hora de México (Matamoros) — el servidor corre en UTC
function inicioDelDiaMX() {
  const ahora = new Date();
  const mxDate = new Date(ahora.toLocaleString('en-US', { timeZone: 'America/Matamoros' }));
  const offsetMs = ahora - mxDate; // diferencia UTC vs hora MX
  mxDate.setHours(0, 0, 0, 0);    // medianoche en tiempo MX
  return new Date(mxDate.getTime() + offsetMs); // convertir a UTC real
}

app.get('/api/ventas', requireAdmin, async (req, res) => {
  const { desde, hasta } = req.query;
  const d = desde || inicioDelDiaMX().toISOString();
  const h = hasta || new Date().toISOString();
  const ventas = await obtenerVentas(d, h);
  res.json(ventas);
});

app.get('/api/ventas/resumen', requireAdmin, async (req, res) => {
  const { desde, hasta } = req.query;
  const d = desde || inicioDelDiaMX().toISOString();
  const h = hasta || new Date().toISOString();
  const resumen = await obtenerResumenVentas(d, h);
  res.json(resumen);
});

// ─── Fondo de caja ────────────────────────────────────────────────────────────
function fechaHoyMX() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Matamoros' }).format(new Date());
}

app.post('/api/caja/fondo', requireAuth, async (req, res) => {
  const { monto } = req.body;
  if (!monto || isNaN(monto) || Number(monto) < 0) {
    return res.status(400).json({ error: 'Monto inválido' });
  }
  const fecha = fechaHoyMX();
  await guardarFondoCaja(fecha, Number(monto));
  res.json({ ok: true, fecha, fondo: Number(monto) });
});

app.get('/api/caja/fondo', requireAuth, async (req, res) => {
  const fecha = fechaHoyMX();
  const registro = await obtenerFondoCaja(fecha);
  res.json({ fecha, fondo: registro ? parseFloat(registro.fondo) : null });
});

// ─── Menú — endpoints ────────────────────────────────────────────────────────
app.get('/api/menu', async (req, res) => {
  const menu = await obtenerMenuCompleto();
  res.json(menu);
});

app.post('/api/admin/menu/categorias', requireAdmin, async (req, res) => {
  const cat = await crearCategoria(req.body.nombre);
  res.json(cat);
});

app.patch('/api/admin/menu/categorias/:id', requireAdmin, async (req, res) => {
  await actualizarCategoria(req.params.id, req.body);
  res.json({ ok: true });
});

app.delete('/api/admin/menu/categorias/:id', requireAdmin, async (req, res) => {
  await eliminarCategoria(req.params.id);
  res.json({ ok: true });
});

app.post('/api/admin/menu/productos', requireAdmin, async (req, res) => {
  const prod = await crearProducto(req.body);
  res.json(prod);
});

app.patch('/api/admin/menu/productos/:id', requireAdmin, async (req, res) => {
  await actualizarProducto(req.params.id, req.body);
  res.json({ ok: true });
});

app.delete('/api/admin/menu/productos/:id', requireAdmin, async (req, res) => {
  await eliminarProducto(req.params.id);
  res.json({ ok: true });
});

// ─── Push Notifications — endpoints ─────────────────────────────────────────
app.get('/api/push/vapid-public-key', (req, res) => {
  if (!VAPID_PUBLIC) return res.status(503).json({ error: 'Push no configurado' });
  res.json({ key: VAPID_PUBLIC });
});

app.post('/api/push/subscribe', requireAuth, async (req, res) => {
  const { endpoint, keys } = req.body;
  if (!endpoint || !keys?.auth || !keys?.p256dh) {
    return res.status(400).json({ error: 'Suscripción inválida' });
  }
  try {
    await guardarSuscripcionPush({ endpoint, auth: keys.auth, p256dh: keys.p256dh });
    res.json({ ok: true });
  } catch (e) {
    console.error('[Push] Error guardando suscripción:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/push/subscribe', requireAuth, async (req, res) => {
  const { endpoint } = req.body;
  if (!endpoint) return res.status(400).json({ error: 'endpoint requerido' });
  await eliminarSuscripcionPush(endpoint).catch(() => {});
  res.json({ ok: true });
});

// Corte de caja — disponible para staff (resumen del día por forma de pago)
app.get('/api/corte-caja', requireAuth, async (req, res) => {
  const d = inicioDelDiaMX().toISOString();
  const h = new Date().toISOString();
  const [ventas, resumen, fondoReg] = await Promise.all([
    obtenerVentas(d, h),
    obtenerResumenVentas(d, h),
    obtenerFondoCaja(fechaHoyMX())
  ]);
  const fondo = fondoReg ? parseFloat(fondoReg.fondo) : 0;
  // Agrupar por forma de pago
  const porPago = {};
  (ventas || []).forEach(v => {
    const pago = v.forma_pago || 'no especificado';
    if (!porPago[pago]) porPago[pago] = { count: 0, total: 0 };
    porPago[pago].count++;
    porPago[pago].total += parseFloat(v.total || 0);
  });
  const totalVentas = resumen.total_ventas || 0;
  // Efectivo en caja = fondo inicial + ventas en efectivo
  const ventasEfectivo = (porPago['efectivo']?.total || 0) + (porPago['Efectivo']?.total || 0);
  res.json({
    fecha: new Date().toLocaleDateString('es-MX', { timeZone: 'America/Matamoros', dateStyle: 'full' }),
    fondo_inicial: fondo,
    total_dia: totalVentas,
    efectivo_esperado: fondo + ventasEfectivo,
    num_pedidos: resumen.num_pedidos || 0,
    por_pago: porPago,
    pedidos: (ventas || []).map(v => ({
      folio: v.folio || '#'+v.id,
      hora: new Date(v.created_at).toLocaleTimeString('es-MX', { timeZone: 'America/Matamoros', hour: '2-digit', minute: '2-digit', hour12: true }),
      cliente: v.nombre_cliente || '—',
      forma_pago: v.forma_pago || '—',
      total: parseFloat(v.total || 0)
    }))
  });
});

// Control manual del bot por conversación
app.post('/api/conversacion/:telefono/pausar', requireAuth, async (req, res) => {
  await setBotPausado(req.params.telefono, true);
  broadcast({ tipo: 'bot_pausado', telefono: req.params.telefono, pausado: true });
  res.json({ ok: true, pausado: true });
});

app.post('/api/conversacion/:telefono/reactivar', requireAuth, async (req, res) => {
  await setBotPausado(req.params.telefono, false);
  broadcast({ tipo: 'bot_pausado', telefono: req.params.telefono, pausado: false });
  res.json({ ok: true, pausado: false });
});

app.get('/api/conversacion/:telefono/estado-bot', requireAuth, async (req, res) => {
  const pausado = await getBotPausado(req.params.telefono);
  res.json({ pausado });
});

// Limpiar sesión
app.delete('/session/:sessionId', (req, res) => {
  deleteSession(req.params.sessionId);
  res.json({ ok: true });
});

// Endpoint para el análisis semanal (llamado por scheduled task)
app.post('/internal/analizar-semana', async (req, res) => {
  const secret = req.headers['x-internal-secret'];
  if (secret !== (process.env.INTERNAL_SECRET || 'xabor-internal')) {
    return res.status(403).json({ error: 'No autorizado' });
  }
  res.json({ ok: true, mensaje: 'Análisis iniciado' });
  analizarSemana().catch(e => console.error('[Learner] Error en análisis:', e.message));
});

// Rappi — marcar productos sin stock
app.put('/api/rappi/stockout', requireAuth, manejarStockout);

// Rappi — subir catálogo completo (Nonna Maye / store 900172582)
app.post('/api/rappi/subir-catalogo', requireAuth, async (req, res) => {
  try {
    const catalogo = construirCatalogoRappi();
    const resultado = await subirCatalogo(catalogo);
    console.log('[Rappi] Catálogo subido:', JSON.stringify(resultado));
    res.json({ ok: true, resultado });
  } catch (e) {
    console.error('[Rappi] Error subiendo catálogo:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Rappi — actualizar solo el schedule (sin re-subir todo el catálogo)
app.post('/api/rappi/actualizar-schedule', requireAuth, async (req, res) => {
  try {
    const resultado = await actualizarSchedule();
    console.log('[Rappi] Schedule actualizado:', JSON.stringify(resultado));
    res.json({ ok: true, resultado });
  } catch (e) {
    console.error('[Rappi] Error actualizando schedule:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Rappi — activar/desactivar tienda manualmente
app.put('/api/rappi/estado-tienda', requireAuth, async (req, res) => {
  const { activa } = req.body;
  if (activa === undefined) return res.status(400).json({ error: 'Se requiere { activa: true|false }' });
  try {
    const resultado = await actualizarEstadoTienda(activa);
    rappiAbierto = activa; // sincronizar estado interno
    console.log(`[Rappi] Tienda ${activa ? 'activada' : 'desactivada'} manualmente`);
    res.json({ ok: true, resultado });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Rappi — registrar webhooks en sandbox/producción (llamar una vez al configurar)
app.post('/api/rappi/setup-webhooks', requireAuth, async (req, res) => {
  const baseUrl = process.env.PUBLIC_URL || req.body.baseUrl;
  if (!baseUrl) return res.status(400).json({ error: 'Se requiere PUBLIC_URL o body.baseUrl' });
  try {
    const results = await configurarWebhooks(baseUrl);
    res.json({ ok: true, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Pedido de prueba (solo para desarrollo)
// Configuración del negocio
app.get('/api/vapid-public', (req, res) => {
  const key = getIntegracion('vapid_public_key') || VAPID_PUBLIC;
  res.json({ publicKey: key || null });
});

app.get('/api/config', requireAuth, async (req, res) => {
  res.json(negocioConfig);
});
app.put('/api/config', requireAdmin, async (req, res) => {
  const ok = await actualizarConfiguracion(req.body);
  if (!ok) return res.status(500).json({ error: 'Error al guardar' });
  negocioConfig = { ...negocioConfig, ...req.body };
  broadcast({ tipo: 'config_actualizada', config: negocioConfig });
  res.json({ ok: true, config: negocioConfig });
});

// ─── Integraciones (claves de API configurables desde panel) ──────────────────
const INT_CLAVES = [
  'wa_token','wa_phone_id','wa_verify_token','wa_admin_numero',
  'clip_api_key','clip_api_secret',
  'facturapi_key',
  'anthropic_api_key',
  'vapid_public_key','vapid_private_key','vapid_email',
];

app.get('/api/admin/integraciones', requireAdmin, async (req, res) => {
  const cfg = await obtenerConfiguracion();
  const result = {};
  INT_CLAVES.forEach(k => {
    const val = cfg['int_' + k] || '';
    // Enmascarar: mostrar solo últimos 4 caracteres
    result[k] = val.length > 8 ? '••••••••' + val.slice(-4) : (val ? '••••' : '');
  });
  res.json(result);
});

app.put('/api/admin/integraciones', requireAdmin, async (req, res) => {
  const cambios = {};
  for (const [k, v] of Object.entries(req.body)) {
    if (!INT_CLAVES.includes(k)) continue;
    if (!v || v.startsWith('••••')) continue; // no sobreescribir con máscara
    cambios['int_' + k] = v.trim();
  }
  const ok = await actualizarConfiguracion(cambios);
  if (!ok) return res.status(500).json({ error: 'Error al guardar' });
  // Recargar config en memoria para que los servicios usen los nuevos valores
  await cargarIntegraciones();
  res.json({ ok: true });
});

// ─── Repartidores ─────────────────────────────────────────────────────────────
// Registro público (el repartidor accede al link y llena nombre+teléfono)
app.post('/api/repartidor/registro', async (req, res) => {
  const { nombre, telefono } = req.body;
  if (!nombre || !telefono) return res.status(400).json({ error: 'nombre y telefono requeridos' });
  const rep = await registrarRepartidor(nombre.trim(), telefono.trim());
  if (!rep) return res.status(500).json({ error: 'Error al registrar' });
  res.json({ ok: true, token: rep.token, nombre: rep.nombre });
});

// Login por teléfono — devuelve token
app.post('/api/repartidor/login', async (req, res) => {
  const { telefono } = req.body;
  if (!telefono) return res.status(400).json({ error: 'telefono requerido' });
  const rep = await obtenerRepartidorPorTelefono(telefono.trim());
  if (!rep) return res.status(404).json({ error: 'No registrado' });
  res.json({ ok: true, token: rep.token, nombre: rep.nombre });
});

// Middleware para rutas de repartidor
async function requireRepartidor(req, res, next) {
  const token = req.headers['x-rep-token'] || req.query.token;
  if (!token) return res.status(401).json({ error: 'token requerido' });
  const rep = await obtenerRepartidorPorToken(token);
  if (!rep) return res.status(401).json({ error: 'token inválido' });
  req.repartidor = rep;
  next();
}

// Pedidos disponibles para tomar
app.get('/api/repartidor/pedidos', requireRepartidor, async (req, res) => {
  const pedidos = await obtenerPedidosParaRepartidor();
  res.json(pedidos.map(p => ({
    folio: p.folio,
    estado: p.estado,
    cliente: p.datos?.cliente?.nombre,
    direccion: `${p.datos?.cliente?.calle || ''} ${p.datos?.cliente?.colonia || ''}`.trim(),
    total: p.datos?.total,
    items: p.datos?.items?.length
  })));
});

// Aceptar pedido (atómico — solo uno lo puede tomar)
app.post('/api/repartidor/pedido/:folio/aceptar', requireRepartidor, async (req, res) => {
  const { folio } = req.params;
  const asignado = await asignarRepartidor(folio, req.repartidor.id, req.repartidor.nombre);
  if (!asignado) return res.status(409).json({ error: 'Este pedido ya fue tomado por otro repartidor' });
  broadcast({ tipo: 'repartidor_asignado', folio, repartidor: req.repartidor.nombre });
  console.log(`[Repartidor] ${req.repartidor.nombre} tomó el pedido ${folio}`);
  res.json({ ok: true, folio });
});

// Guardar push subscription del repartidor
app.post('/api/repartidor/push/subscribe', requireRepartidor, async (req, res) => {
  const { subscription } = req.body;
  if (!subscription) return res.status(400).json({ error: 'subscription requerida' });
  await guardarPushRepartidor(req.repartidor.id, subscription);
  res.json({ ok: true });
});

// Lista de repartidores (admin)
app.get('/api/admin/repartidores', requireAdmin, async (req, res) => {
  res.json(await obtenerRepartidores());
});

app.post('/api/admin/reporte-diario/enviar', requireAdmin, async (req, res) => {
  await enviarReporteDiario();
  res.json({ ok: true });
});

app.post('/test/pedido', (req, res) => {
  const ordenPrueba = {
    cliente: { nombre: 'Cliente Prueba', telefono: '8781234567', calle: 'Av. Tecnológico 123', colonia: 'Centro', entre_calles: 'Juárez y Morelos' },
    modalidad: 'entrega a domicilio',
    items: [
      { nombre: 'Chicken Louisiana', cantidad: 1, precio_unitario: 180, notas: '' },
      { nombre: 'Focaccia Bar', cantidad: 1, precio_unitario: 225, notas: 'Spread pesto, proteína salami, queso manchego, toppings lechuga y tomate, aderezo ranch' },
      { nombre: 'Poppi', cantidad: 1, precio_unitario: 79, notas: 'Uva' }
    ],
    subtotal: 484,
    costo_envio: 60,
    descuento: 0,
    total: 544,
    canal: 'test'
  };
  const pedido = registrarPedido(ordenPrueba, 'test');
  emitirPedido(pedido);
  res.json({ ok: true, pedido });
});

// ─── Job: activar pedidos programados ────────────────────────────────────────
// Corre cada 5 minutos — mueve al panel activo los pedidos cuyo horario ya llegó (≤ ahora + 1h)
async function activarPedidosProgramados() {
  try {
    const pendientes = await obtenerPedidosPorActivar();
    for (const row of pendientes) {
      const pedido = row.datos;
      pedido.estado = pedido.estado || 'nuevo';
      // Registrar en el panel y emitir por WebSocket
      const { guardarPedidoActivo } = await import('./services/database.js');
      await guardarPedidoActivo(pedido);
      broadcast({ tipo: 'nuevo_pedido', pedido });
      await marcarPedidoProgramadoActivado(row.folio);
      console.log(`[Scheduler] Pedido ${row.folio} activado (programado para ${row.programado_para})`);
    }
  } catch (e) {
    console.error('[Scheduler] Error activando pedidos programados:', e.message);
  }
}

// Endpoint para que el panel liste los pedidos programados pendientes
app.get('/api/pedidos-programados', requireAuth, async (req, res) => {
  const lista = await obtenerPedidosProgramadosPendientes();
  res.json(lista.map(r => ({
    folio: r.folio,
    programado_para: r.programado_para,
    cliente: r.datos?.cliente?.nombre || '—',
    total: r.datos?.total || 0,
    items: r.datos?.items || []
  })));
});

// ─── Transcripciones de llamadas ─────────────────────────────────────────────
app.get('/api/llamadas', requireAuth, async (req, res) => {
  const lista = await obtenerLlamadasRecientes(30);
  res.json(lista);
});

app.get('/api/llamadas/:callSid', requireAuth, async (req, res) => {
  const mensajes = await obtenerTranscripcionPorLlamada(req.params.callSid);
  res.json(mensajes);
});

// ─── Job: Reporte diario WhatsApp a las 22:01 (America/Matamoros) ────────────
const WHATSAPP_ADMIN_NUMERO = process.env.WHATSAPP_ADMIN_NUMERO || '';

function inicioDelDiaTexto(fechaISO) {
  // Devuelve medianoche CST del mismo día como ISO
  const d = new Date(fechaISO);
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Matamoros', year:'numeric', month:'2-digit', day:'2-digit'
  }).formatToParts(d);
  const y = partes.find(p=>p.type==='year').value;
  const m = partes.find(p=>p.type==='month').value;
  const day = partes.find(p=>p.type==='day').value;
  return new Date(`${y}-${m}-${day}T06:00:00.000Z`).toISOString(); // UTC-6 midnight ≈ 06:00Z
}

async function enviarReporteDiario() {
  if (!WHATSAPP_ADMIN_NUMERO) return;
  const ahora = new Date().toISOString();
  const inicio = inicioDelDiaTexto(ahora);
  const [ventas, resumen, fondoReg] = await Promise.all([
    obtenerVentas(inicio, ahora),
    obtenerResumenVentas(inicio, ahora),
    obtenerFondoCaja(fechaHoyMX())
  ]);
  const fondo         = fondoReg ? parseFloat(fondoReg.fondo) : 0;
  const totalVentas   = parseFloat(resumen?.total_ventas || 0);
  // Agrupar por canal y modalidad
  const porCanal  = {};
  const porModal  = {};
  let efectivoVentas = 0;
  (ventas || []).forEach(v => {
    const canal = v.canal || 'otro';
    const modal = v.modalidad || 'otro';
    const total = parseFloat(v.total || 0);
    porCanal[canal] = (porCanal[canal] || 0) + total;
    porModal[modal] = (porModal[modal] || 0) + total;
    if ((v.forma_pago || '').toLowerCase().includes('efectivo')) efectivoVentas += total;
  });
  const fmtMXN = n => `$${parseFloat(n).toFixed(2)}`;
  const bloqueCanal = Object.entries(porCanal).map(([k,v]) =>
    `  • ${k}: ${fmtMXN(v)}`).join('\n') || '  (ninguna)';
  const bloqueModal = Object.entries(porModal).map(([k,v]) =>
    `  • ${k}: ${fmtMXN(v)}`).join('\n') || '  (ninguna)';
  const msg =
`🧾 *CORTE DE CAJA — XABOR*
📅 ${new Date().toLocaleDateString('es-MX', { timeZone:'America/Matamoros', dateStyle:'full' })}

💰 Fondo inicial: ${fmtMXN(fondo)}
🛒 Total ventas: ${fmtMXN(totalVentas)} (${resumen?.num_pedidos || 0} pedidos)
💵 Efectivo esperado en caja: ${fmtMXN(fondo + efectivoVentas)}

📦 *Por tipo de entrega:*
${bloqueModal}

📡 *Por canal de venta:*
${bloqueCanal}`;
  try {
    await enviarMensaje(WHATSAPP_ADMIN_NUMERO, msg);
    console.log('[Reporte] Corte diario enviado por WhatsApp');
  } catch(e) {
    console.error('[Reporte] Error al enviar corte diario:', e.message);
  }
}

// Verificar cada minuto si es hora del reporte (22:01 CST)
setInterval(() => {
  const now = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Matamoros', hour:'2-digit', minute:'2-digit', hour12: false
  }).format(new Date());
  if (now === '22:01') enviarReporteDiario();
}, 60 * 1000);

// ─── Job: sincronizar horario de Rappi ───────────────────────────────────────
// Activa/desactiva la tienda en Rappi según el horario real de Xabor.
// Lunes–Sábado 11:00–22:00 (America/Matamoros). Corre al inicio y cada 5 min.
let rappiAbierto = null; // null = estado desconocido al arrancar

function estaAbiertoAhora() {
  const now = new Date();
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Matamoros',
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit'
  }).formatToParts(now);
  const p = Object.fromEntries(partes.map(x => [x.type, x.value]));
  const dow  = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
  const mins = parseInt(p.hour, 10) * 60 + parseInt(p.minute, 10);
  return dow >= 1 && dow <= 6 && mins >= 11 * 60 && mins < 22 * 60;
}

async function sincronizarRappi() {
  if (!process.env.RAPPI_CLIENT_ID || !process.env.RAPPI_CLIENT_SECRET) return; // no configurado
  const abierto = estaAbiertoAhora();
  if (rappiAbierto === abierto) return; // sin cambio — no llamar la API
  try {
    await actualizarEstadoTienda(abierto);
    rappiAbierto = abierto;
    console.log(`[Rappi] Tienda ${abierto ? 'abierta ✅' : 'cerrada 🔴'} (${new Date().toLocaleString('es-MX', { timeZone: 'America/Matamoros' })})`);
  } catch (e) {
    console.error('[Rappi] Error al sincronizar estado:', e.message);
  }
}

// ─── Reconciliación de pagos Clip ─────────────────────────────────────────────
// Revisa cada 5 min si algún pago con enlace ya fue completado (por si el webhook falló)
async function reconciliarPagosPendientes() {
  if (!process.env.CLIP_API_KEY || !process.env.CLIP_API_SECRET) return;
  try {
    const pendientes = await obtenerPagosPendientesConLink();
    for (const { folio, clip_link_id } of pendientes) {
      const data = await consultarEstadoPago(clip_link_id);
      if (data?.resource_status === 'COMPLETED' && data?.resource === 'CHECKOUT') {
        await confirmarPagoPedido(folio);
        broadcast({ tipo: 'pago_confirmado', pedidoId: folio, proveedor: 'clip' });
        console.log(`[Clip Reconciliación] ✅ Pago confirmado automáticamente: ${folio}`);
      }
    }
  } catch (e) {
    console.error('[Clip Reconciliación] Error:', e.message);
  }
}

// ─── Inicio ──────────────────────────────────────────────────────────────────
initDB()
  .then(() => seedMenuDesdeJSON(menuJSON))
  .then(() => cargarPedidosDesdeDB())
  .then(() => cargarConfig())
  .then(() => cargarIntegraciones())
  .then(() => {
    // Activar pedidos programados cada 5 minutos
    activarPedidosProgramados();
    setInterval(activarPedidosProgramados, 5 * 60 * 1000);
    // Sincronizar horario de Rappi al arrancar y cada 5 minutos
    sincronizarRappi();
    setInterval(sincronizarRappi, 5 * 60 * 1000);
    // Reconciliar pagos Clip pendientes al arrancar y cada 5 minutos
    reconciliarPagosPendientes();
    setInterval(reconciliarPagosPendientes, 5 * 60 * 1000);
  })
  .catch(e => console.error('[DB] Error al inicializar:', e.message));

server.listen(PORT, () => {
  console.log(`
🌮 =============================================
   Agente Xabor corriendo en puerto ${PORT}
   Panel: http://localhost:${PORT}
   API:   http://localhost:${PORT}/health
🌮 =============================================
  `);
});
