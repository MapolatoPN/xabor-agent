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
import { initDB, obtenerConversacion, obtenerConversacionesRecientes, guardarMensaje, obtenerVentas, obtenerResumenVentas, obtenerPedidosEntregados, setBotPausado, getBotPausado, confirmarPagoPedido } from './services/database.js';
import whatsappRouter, { enviarMensaje, setWsBroadcastWA } from './channels/whatsapp-meta.js'; // Meta Cloud API
// import whatsappRouter from './channels/whatsapp.js'; // Twilio (respaldo)
import voiceRouter, { setupVoiceWebSocket } from './channels/voice.js';
import rappiRouter, { setWsBroadcastRappi, manejarStockout } from './channels/rappi.js';
import { configurarWebhooks, subirCatalogo, construirCatalogoRappi } from './services/rappi-api.js';
import { analizarSemana } from './services/learner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

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
    const status = evento?.payment_status || evento?.status;
    const ref    = evento?.metadata?.external_reference || evento?.external_reference;
    console.log(`[Clip] Webhook recibido — pedido: ${ref}, status: ${status}`);

    // Pago completado — persistir en BD y notificar al panel
    if (status === 'CHECKOUT_COMPLETED' || status === 'APPROVED') {
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
  res.json({
    status: 'ok',
    restaurante: 'Xabor',
    pedidos_activos: obtenerPedidos().filter(p => p.estado !== 'entregado').length,
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
  const { items, nombre, forma_pago, total, descuento } = req.body;
  if (!items || !items.length) return res.status(400).json({ error: 'Sin items' });
  const subtotal = items.reduce((s, i) => s + (i.precio_unitario || 0) * (i.cantidad || 1), 0);
  const desc     = parseFloat(descuento) || 0;
  const orden = {
    items,
    subtotal,
    descuento: desc,
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
app.get('/api/ventas', requireAdmin, async (req, res) => {
  const { desde, hasta } = req.query;
  const d = desde || new Date(new Date().setHours(0,0,0,0)).toISOString();
  const h = hasta || new Date().toISOString();
  const ventas = await obtenerVentas(d, h);
  res.json(ventas);
});

app.get('/api/ventas/resumen', requireAdmin, async (req, res) => {
  const { desde, hasta } = req.query;
  const d = desde || new Date(new Date().setHours(0,0,0,0)).toISOString();
  const h = hasta || new Date().toISOString();
  const resumen = await obtenerResumenVentas(d, h);
  res.json(resumen);
});

// Corte de caja — disponible para staff (resumen del día por forma de pago)
app.get('/api/corte-caja', requireAuth, async (req, res) => {
  const d = new Date(new Date().setHours(0,0,0,0)).toISOString();
  const h = new Date().toISOString();
  const [ventas, resumen] = await Promise.all([
    obtenerVentas(d, h),
    obtenerResumenVentas(d, h)
  ]);
  // Agrupar por forma de pago
  const porPago = {};
  (ventas || []).forEach(v => {
    const pago = v.forma_pago || 'no especificado';
    if (!porPago[pago]) porPago[pago] = { count: 0, total: 0 };
    porPago[pago].count++;
    porPago[pago].total += parseFloat(v.total || 0);
  });
  res.json({
    fecha: new Date().toLocaleDateString('es-MX', { timeZone: 'America/Matamoros', dateStyle: 'full' }),
    total_dia: resumen.total_ventas || 0,
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

// ─── Inicio ──────────────────────────────────────────────────────────────────
initDB()
  .then(() => cargarPedidosDesdeDB())
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
