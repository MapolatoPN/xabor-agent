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
import { initDB, obtenerConversacion, obtenerConversacionesRecientes, guardarMensaje, obtenerVentas, obtenerResumenVentas, obtenerPedidosEntregados, setBotPausado, getBotPausado, confirmarPagoPedido, guardarPedidoProgramado, obtenerPedidosPorActivar, marcarPedidoProgramadoActivado, obtenerPedidosProgramadosPendientes, obtenerLlamadasRecientes, obtenerTranscripcionPorLlamada, obtenerPagosPendientesConLink, guardarFondoCaja, obtenerFondoCaja, seedMenuDesdeJSON, obtenerMenuCompleto, crearCategoria, actualizarCategoria, eliminarCategoria, crearProducto, actualizarProducto, eliminarProducto, guardarSuscripcionPush, obtenerSuscripcionesPush, eliminarSuscripcionPush } from './services/database.js';
import webpush from 'web-push';
import whatsappRouter, { enviarMensaje, setWsBroadcastWA } from './channels/whatsapp-meta.js'; // Meta Cloud API
// import whatsappRouter from './channels/whatsapp.js'; // Twilio (respaldo)
import voiceRouter, { setupVoiceWebSocket } from './channels/voice.js';
import rappiRouter, { setWsBroadcastRappi, manejarStockout } from './channels/rappi.js';
import { configurarWebhooks, subirCatalogo, construirCatalogoRappi, actualizarSchedule, actualizarEstadoTienda } from './services/rappi-api.js';
import { consultarEstadoPago } from './services/clip-api.js';
import { analizarSemana } from './services/learner.js';

import { readFileSync } from 'fs';
const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
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
app.get('/health', (req, res) => {
  const activos = obtenerPedidos().filter(p => p.estado !== 'entregado');
  res.json({
    status: 'ok',
    restaurante: 'Xabor',
    pedidos_activos: activos.length,
    pedidos: activos.map(p => ({ id: p.id, canal: p.canal, estado: p.estado, cliente: p.cliente?.nombre })),
    ws_clientes: wss.clients.size,
    timestamp: new Date().toISOString()
  });
});

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
app.patch('/pedidos/:id/estado', (req, res) => {
  const { estado } = req.body;
  const estadosValidos = ['nuevo', 'en_preparacion', 'listo', 'entregado'];
  if (!estadosValidos.includes(estado)) {
    return res.status(400).json({ error: 'Estado inválido' });
  }
  const pedido = actualizarEstadoPedido(req.params.id, estado);
  if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
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

// Conversaciones WhatsApp
app.get('/api/conversaciones', async (req, res) => {
  const lista = await obtenerConversacionesRecientes(20);
  res.json(lista);
});

app.get('/api/conversacion/:telefono', async (req, res) => {
  const msgs = await obtenerConversacion(req.params.telefono, 100);
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
