import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHmac, createHash, timingSafeEqual } from 'crypto';

import { procesarMensaje } from './agent/brain.js';
import {
  registrarPedido,
  emitirPedido,
  actualizarEstadoPedido,
  actualizarEstadoPedidoLegacySinNegocio,
  eliminarPedido,
  obtenerPedidos,
  obtenerTodosPedidosParaWebSocketLegacy,
  setWsBroadcast,
  cargarPedidosDesdeDB
} from './orders/orderManager.js';
import { deleteSession } from './agent/session.js';
import { pool, initDB, obtenerConversacion, obtenerConversacionesRecientes, guardarMensaje, obtenerVentas, obtenerResumenVentas, obtenerPedidosEntregados, setBotPausado, getBotPausado, confirmarPagoPedido, guardarPedidoProgramado, obtenerPedidosPorActivar, marcarPedidoProgramadoActivado, obtenerPedidosProgramadosPendientes, obtenerLlamadasRecientes, obtenerTranscripcionPorLlamada, obtenerPagosPendientesConLink, guardarFondoCaja, obtenerFondoCaja, seedMenuDesdeJSON, obtenerMenuCompleto, crearCategoria, actualizarCategoria, eliminarCategoria, crearProducto, actualizarProducto, eliminarProducto, obtenerModificadoresProducto, crearGrupoModificador, actualizarGrupoModificador, eliminarGrupoModificador, crearOpcionModificador, actualizarOpcionModificador, eliminarOpcionModificador, guardarSuscripcionPush, obtenerSuscripcionesPush, eliminarSuscripcionPush, actualizarFormaPago, obtenerConfiguracion, actualizarConfiguracion, obtenerNegocioIdPorSlug, obtenerMembresiaUsuarioNegocio, obtenerNegociosDeUsuario, obtenerUsuarioPorId, obtenerUsuarioPorEmail, crearUsuarioConPassword, cancelarPedidoActivo, registrarDevolucion, crearCampana, registrarEnvioCampana, completarCampana, obtenerCampanas, obtenerDestinatariosCampana, toggleClienteInterno } from './services/database.js';
import { crearTokenSesion, verificarTokenSesion, crearTokenPreAuth, verificarTokenPreAuth, revocarTokenSesion } from './services/session.js';
import { verifyPassword } from './services/password.js';
import { generarFactura, enviarFacturaPorEmail, descargarFacturaPDF } from './services/facturapi.js';
import webpush from 'web-push';
import whatsappRouter, { enviarMensaje, setWsBroadcastWA } from './channels/whatsapp-meta.js'; // Meta Cloud API
// import whatsappRouter from './channels/whatsapp.js'; // Twilio (respaldo)
import voiceRouter, { setupVoiceWebSocket } from './channels/voice.js';
import rappiRouter, { setWsBroadcastRappi, manejarStockout } from './channels/rappi.js';
import finanzasRouter from './routes/finanzas.js';
import { jobDiarioSAT } from './services/satSync.js';
import { guardarCredencialesSAT, obtenerInfoCertSAT, eliminarCredencialesSAT } from './services/satCredentials.js';
import { invalidarCacheCredenciales } from './services/satClient.js';
import { configurarWebhooks, obtenerWebhook, subirCatalogo, construirCatalogoRappi, actualizarSchedule, actualizarEstadoTienda, consultarAprobacionMenu } from './services/rappi-api.js';
import { consultarEstadoPago } from './services/clip-api.js';
import { analizarSemana } from './services/learner.js';
import { enriquecerTodosLosPerfiles, detectarConversacionesAbandonadas, obtenerOportunidadesPendientes } from './services/memory.js';
import { registrarRepartidor, obtenerRepartidorPorToken, obtenerRepartidorPorTelefono, obtenerRepartidores, guardarPushRepartidor, obtenerPushRepartidores, asignarRepartidor, obtenerPedidosParaRepartidor, obtenerPedidosAsignadosARepartidor, obtenerCandidatosRepartidor, eliminarRepartidor } from './services/database.js';

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

// ═══════════════════════════════════════════════════════════════════════════
// ⚠ LEGADO — resolver de negocio por header, SIN autenticación real ─────────
// Confía en un slug que envía el cliente (X-Negocio-Slug) para elegir el
// negocio, sin verificar que quien hace la request tenga permiso alguno
// sobre él. Se conserva únicamente para no romper el panel actual de Nonna
// Maye (que todavía no inicia sesión con el mecanismo nuevo de abajo).
// Aplicado únicamente a las rutas de configuración y menú (GET/PUT /api/config,
// GET /api/menu y /api/admin/menu/*) — no se extiende a WhatsApp, voz, Rappi,
// SAT, pedidos ni impresión.
// REEMPLAZO: requireSesionNegocio (ver abajo) es el mecanismo real — resuelve
// el negocio desde una sesión firmada server-side y verifica membresía en
// usuario_negocios. Migrar las rutas de config/menú a requireSesionNegocio
// es el siguiente paso pendiente (requiere que el panel inicie sesión real).
let negocioPorDefectoIdCache = null;
async function resolverNegocioActualPorDefecto() {
  if (!negocioPorDefectoIdCache) {
    negocioPorDefectoIdCache = await obtenerNegocioIdPorSlug('nonna-maye');
  }
  return negocioPorDefectoIdCache;
}

async function resolverNegocio(req, res, next) {
  const slug = req.headers['x-negocio-slug'];
  if (!slug) {
    req.negocioId = await resolverNegocioActualPorDefecto();
    req.esNegocioPorDefecto = true;
    return next();
  }
  const id = await obtenerNegocioIdPorSlug(slug);
  if (!id) {
    return res.status(404).json({ error: `Negocio no encontrado para slug: ${slug}` });
  }
  req.negocioId = id;
  req.esNegocioPorDefecto = false;
  next();
}

// ═══════════════════════════════════════════════════════════════════════════
// ✅ NUEVO (Fase 2) — autenticación multiempresa real por sesión ────────────
// El negocio autorizado NUNCA se acepta porque el cliente lo envía (ni
// header ni body ni query) — se determina exclusivamente a partir de un
// token de sesión firmado por el servidor (ver services/session.js), y se
// verifica contra la tabla usuario_negocios que el usuario de esa sesión
// realmente pertenece al negocio que la sesión indica.
//
// Uso: app.get('/ruta', requireSesionNegocio(), handler)
//      app.post('/ruta', requireSesionNegocio('admin'), handler)  // exige rol
//
// Jerarquía de roles simple: 'admin' satisface cualquier requerimiento;
// 'staff' solo satisface requerimientos de 'staff' o ninguno.
const JERARQUIA_ROLES = { admin: 2, staff: 1 };

function requireSesionNegocio(rolMinimo) {
  return async (req, res, next) => {
    const auth = req.headers['authorization'];
    const tokenBearer = (auth && auth.startsWith('Bearer ')) ? auth.slice(7) : null;
    const token = leerCookieSesion(req) || tokenBearer;
    if (!token) {
      return res.status(401).json({ error: 'No autenticado' });
    }
    const payload = verificarTokenSesion(token);
    if (!payload) {
      return res.status(401).json({ error: 'Sesión inválida o expirada' });
    }

    // Verificar que el usuario de la sesión SIGUE perteneciendo al negocio
    // que la sesión indica — no basta con confiar en el token: la membresía
    // pudo revocarse después de emitido.
    const membresia = await obtenerMembresiaUsuarioNegocio(payload.usuarioId, payload.negocioId);
    if (!membresia || !membresia.activo) {
      return res.status(403).json({ error: 'El usuario ya no pertenece a este negocio' });
    }

    if (rolMinimo) {
      const nivelUsuario  = JERARQUIA_ROLES[membresia.rol] || 0;
      const nivelRequerido = JERARQUIA_ROLES[rolMinimo] || 0;
      if (nivelUsuario < nivelRequerido) {
        return res.status(403).json({ error: 'Permiso insuficiente para esta operación' });
      }
    }

    req.usuarioId = payload.usuarioId;
    req.negocioId = payload.negocioId;
    req.rol = membresia.rol;
    next();
  };
}

// ─── Cookies de sesión (Fase 3) ─────────────────────────────────────────────
// Parseo manual — sin agregar cookie-parser como dependencia nueva. Solo se
// necesita leer/escribir una cookie propia (xabor_sesion), no un parser
// genérico de cookies de terceros.
const COOKIE_SESION = 'xabor_sesion';

function leerCookieSesion(req) {
  const header = req.headers['cookie'];
  if (!header) return null;
  for (const par of header.split(';')) {
    const idx = par.indexOf('=');
    if (idx === -1) continue;
    const nombre = par.slice(0, idx).trim();
    if (nombre === COOKIE_SESION) return decodeURIComponent(par.slice(idx + 1).trim());
  }
  return null;
}

function setCookieSesion(res, token) {
  const partes = [
    `${COOKIE_SESION}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${12 * 60 * 60}`, // 12 horas — igual a DURACION_MS en session.js
  ];
  if (process.env.NODE_ENV === 'production') partes.push('Secure');
  res.setHeader('Set-Cookie', partes.join('; '));
}

function limpiarCookieSesion(res) {
  const partes = [`${COOKIE_SESION}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (process.env.NODE_ENV === 'production') partes.push('Secure');
  res.setHeader('Set-Cookie', partes.join('; '));
}

// ═══════════════════════════════════════════════════════════════════════════
// ✅ NUEVO (Fase 3) — puente sesión-nueva / legado para rutas de config y menú
// Intenta primero la sesión nueva (cookie httpOnly, o un Authorization:
// Bearer que sea un token de sesión firmado — no el token admin/staff
// legado). Si se presentó una credencial de sesión nueva pero resulta
// inválida o expirada, se RECHAZA de inmediato — nunca cae al mecanismo
// legado en ese caso, porque eso dejaría colarse a alguien con un token
// viejo o manipulado por la puerta de atrás. Solo cuando no se presentó
// ninguna credencial de sesión nueva (ninguna cookie y, si hay Bearer, es el
// token admin/staff legado) se usa el mecanismo legado como respaldo
// temporal, exactamente como funcionaba antes de esta fase.
//
// PENDIENTE DE ELIMINAR (ver requisito de "compatibilidad temporal"): una
// vez que todos los usuarios del panel inicien sesión con el mecanismo
// nuevo, quitar la rama "⚠ LEGADO" de esta función y las rutas/middlewares
// marcados ⚠ LEGADO (resolverNegocio, requireAuth, requireAdmin, TOKEN_ADMIN,
// TOKEN_STAFF, POST /api/auth/login).
function resolverNegocioSeguro(rolMinimo) {
  return async (req, res, next) => {
    const tokenCookie = leerCookieSesion(req);
    const auth = req.headers['authorization'];
    const tokenBearer = (auth && auth.startsWith('Bearer ')) ? auth.slice(7) : null;
    const esBearerLegado = tokenBearer && (tokenBearer === TOKEN_ADMIN || tokenBearer === TOKEN_STAFF);
    const tokenSesionNueva = tokenCookie || (esBearerLegado ? null : tokenBearer);

    if (tokenSesionNueva) {
      const payload = verificarTokenSesion(tokenSesionNueva);
      if (!payload) {
        // Credencial de sesión nueva presente pero inválida/expirada — no
        // caer al legado silenciosamente.
        return res.status(401).json({ error: 'Sesión inválida o expirada' });
      }
      const membresia = await obtenerMembresiaUsuarioNegocio(payload.usuarioId, payload.negocioId);
      if (!membresia || !membresia.activo) {
        return res.status(403).json({ error: 'El usuario ya no pertenece a este negocio' });
      }
      if (rolMinimo) {
        const nivelUsuario   = JERARQUIA_ROLES[membresia.rol] || 0;
        const nivelRequerido = JERARQUIA_ROLES[rolMinimo] || 0;
        if (nivelUsuario < nivelRequerido) {
          return res.status(403).json({ error: 'Permiso insuficiente para esta operación' });
        }
      }
      const negocioDefaultId = await resolverNegocioActualPorDefecto();
      req.usuarioId = payload.usuarioId;
      req.negocioId = payload.negocioId;
      req.rol = membresia.rol;
      req.esNegocioPorDefecto = payload.negocioId === negocioDefaultId;
      req.sesionNueva = true;
      return next();
    }

    // ⚠ LEGADO — sin credencial de sesión nueva, usar token admin/staff + slug
    const role = tokenBearer ? getRole(tokenBearer) : null;
    if (!role) return res.status(401).json({ error: 'No autenticado' });
    if (rolMinimo === 'admin' && role !== 'admin') {
      return res.status(403).json({ error: 'Solo administradores' });
    }
    req.role = role;
    req.sesionNueva = false;
    return resolverNegocio(req, res, next);
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// ✅ NUEVO (Fase 4) — puente sesión-nueva/legado para rutas SIN filtrado por
// negocio_id todavía. Mismo criterio de seguridad que resolverNegocioSeguro
// (sesión nueva inválida se rechaza de inmediato, nunca cae al legado; el
// legado solo aplica cuando no se presentó ninguna credencial nueva), pero
// sin resolver ni exigir negocio — solo autentica, exactamente como hacían
// requireAuth/requireAdmin. Se usa en rutas cuyas tablas subyacentes
// (pedidos, clientes, mensajes, etc.) todavía no tienen negocio_id real
// filtrado — ver auditoría de Fase 4. Reutiliza resolverNegocioSeguro para
// no duplicar la lógica de aceptar/rechazar la credencial; simplemente
// ignora req.negocioId después.
//
// PENDIENTE DE ELIMINAR junto con resolverNegocioSeguro cuando se retire el
// mecanismo legado (ver documentación de compatibilidad temporal).
function requireAuthSeguro(req, res, next) {
  return resolverNegocioSeguro()(req, res, next);
}
function requireAdminSeguro(req, res, next) {
  return resolverNegocioSeguro('admin')(req, res, next);
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

// ═══════════════════════════════════════════════════════════════════════════
// ✅ NUEVO — autenticación de terminales de impresión (print-agent) ─────────
// Consulta central de solo lectura: terminales → sucursales → negocios.
// La única identidad que declara el cliente es terminalId + token (nunca
// negocioId ni sucursalId) -- ambos se derivan aquí, exclusivamente desde
// la base de datos, vía el JOIN. negocios.activo existe en el esquema
// (migración 003) -- se valida directamente, no se documenta como ausente.
// terminalId puede venir malformado (no-UUID) desde un cliente hostil: se
// captura el error de sintaxis de Postgres y se trata igual que "no
// encontrado" -- nunca se distingue de cara al cliente.
async function obtenerTerminalParaAutenticacion(terminalId) {
  try {
    const { rows } = await pool.query(`
      SELECT
        t.id      AS terminal_id,
        t.token_hash,
        t.activo  AS terminal_activo,
        t.tipo    AS terminal_tipo,
        s.id      AS sucursal_id,
        s.activo  AS sucursal_activo,
        n.id      AS negocio_id,
        n.activo  AS negocio_activo
      FROM terminales t
      JOIN sucursales s ON s.id = t.sucursal_id
      JOIN negocios n   ON n.id = s.negocio_id
      WHERE t.id = $1
    `, [terminalId]);
    return rows[0] || null;
  } catch (e) {
    // Incluye el caso de terminalId con formato inválido (no-UUID) --
    // Postgres lanza "invalid input syntax for type uuid", se trata igual
    // que "no encontrado". Log seguro: solo el terminalId (identificador
    // interno declarado por el cliente, nunca un secreto), nunca el token.
    console.error(`[PrintAgent] obtenerTerminalParaAutenticacion: error de consulta para terminalId=${terminalId} — ${e.message}`);
    return null;
  }
}

// Se actualiza EXCLUSIVAMENTE al autenticar con éxito -- nunca por un
// trigger genérico (ver migración 010). Un fallo aquí NUNCA invalida una
// autenticación ya correcta -- ver el único llamador, que no lo espera
// antes de responder éxito al agente.
async function marcarUltimaConexionTerminal(terminalId) {
  try {
    await pool.query(`UPDATE terminales SET ultima_conexion = NOW() WHERE id = $1`, [terminalId]);
  } catch (e) {
    console.error(`[PrintAgent] No se pudo actualizar ultima_conexion para terminal=${terminalId}: ${e.message}`);
  }
}

// ─── WebSocket: panel de comandas + Conversation Relay de voz ───────────────
const wss      = new WebSocketServer({ noServer: true }); // panel
const wssVoice = new WebSocketServer({ noServer: true }); // voz

// ═══════════════════════════════════════════════════════════════════════════
// ✅ NUEVO — autenticación del handshake WebSocket del panel (/ws/panel) ────
// Mismo criterio que requireSesionNegocio/resolverNegocioSeguro (HTTP): el
// negocio NUNCA se acepta porque el cliente lo envía (ni query, ni header,
// ni primer mensaje) — se deriva exclusivamente de la cookie de sesión
// httpOnly xabor_sesion, verificada con verificarTokenSesion (firma, expiración
// y revocación) y luego reconfirmada contra usuario_negocios (la membresía
// pudo revocarse después de emitido el token). Rechaza ANTES de completar el
// upgrade — nunca se abre el socket ni se envía un solo pedido a una
// conexión no autenticada.
//
// La conexión legado (print-agent, sin autenticar, en la raíz "/") sigue
// intacta en esta tarea — ver el comentario "PENDIENTE DE ELIMINAR" junto a
// wss.on('connection') más abajo. broadcast() tampoco cambia todavía.
async function autenticarUpgradePanel(req, socket, head) {
  function rechazar(status, motivo) {
    socket.write(`HTTP/1.1 ${status} ${motivo}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  }

  const token = leerCookieSesion(req);
  if (!token) return rechazar(401, 'Unauthorized');

  const payload = verificarTokenSesion(token); // firma, expiración y revocación
  if (!payload) return rechazar(401, 'Unauthorized');
  if (!payload.usuarioId || !payload.rol) return rechazar(401, 'Unauthorized');
  if (typeof payload.negocioId !== 'string' || !payload.negocioId.trim()) return rechazar(401, 'Unauthorized');

  // Reconfirmar membresía real — no basta con confiar en el token.
  const membresia = await obtenerMembresiaUsuarioNegocio(payload.usuarioId, payload.negocioId);
  if (!membresia || !membresia.activo) return rechazar(403, 'Forbidden');
  if (!JERARQUIA_ROLES[membresia.rol]) return rechazar(403, 'Forbidden'); // rol corrupto/desconocido

  const contextoWS = {
    tipo: 'panel',
    usuarioId: payload.usuarioId,
    negocioId: payload.negocioId,
    rol: membresia.rol, // rol fresco de DB, no el del token (pudo cambiar)
    sucursalId: null,
    terminalId: null,
  };

  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.contextoWS = contextoWS;
    wss.emit('connection', ws, req);
  });
}

// Enrutar conexiones WebSocket por path
server.on('upgrade', (req, socket, head) => {
  const pathname = req.url.split('?')[0];

  if (pathname === '/ws/voice') {
    wssVoice.handleUpgrade(req, socket, head, (ws) => {
      wssVoice.emit('connection', ws, req);
    });
    return;
  }

  if (pathname === '/ws/panel') {
    autenticarUpgradePanel(req, socket, head);
    return;
  }

  // ✅ NUEVO — ruta dedicada para print-agents autenticados por terminal.
  // A diferencia del panel (que ya trae su credencial en el handshake vía
  // cookie), el print-agent no tiene cookie -- su credencial llega en el
  // PRIMER MENSAJE post-conexión (ver wss.on('connection') más abajo), así
  // que el upgrade siempre se completa aquí sin autenticar todavía. La
  // conexión queda marcada 'print-agent-pendiente' -- nunca 'legacy', y no
  // recibe absolutamente nada (ni pedidos, ni snapshot, ni eventos) hasta
  // que el mensaje inicial autentique correctamente o expire el timeout.
  if (pathname === '/ws/print-agent') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.contextoWS = { tipo: 'print-agent-pendiente', usuarioId: null, negocioId: null, rol: null, sucursalId: null, terminalId: null, autenticado: false };
      wss.emit('connection', ws, req);
    });
    return;
  }

  // ⚠ LEGADO — MULTIEMPRESA INSEGURO: conexión sin autenticar (usada hoy por
  // print-agent.js en la raíz "/"). PENDIENTE DE ELIMINAR en cuanto
  // print-agent.js migre a su propia ruta autenticada — no ampliar esta ruta
  // para nuevos clientes mientras tanto.
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.contextoWS = { tipo: 'legacy', usuarioId: null, negocioId: null, rol: null, sucursalId: null, terminalId: null };
    wss.emit('connection', ws, req);
  });
});

// ✅ NUEVO (Fase 7) — push notifications, extraídas de broadcast() a su
// propia función para poder dispararlas tanto desde broadcast() (legado)
// como desde broadcastNegocio() (nuevo), sin duplicar la lógica ni
// mezclarla con el filtrado por negocio. Push SIGUE GLOBAL a propósito en
// esta fase (no se tocó el sistema de push) — ver reporte, sección "Estado
// del push global". broadcastPrintAgentLegacy NUNCA la llama (evitaría un
// doble push del mismo nuevo_pedido, que ya dispara push vía
// broadcastNegocio).
function dispararPushParaEvento(data) {
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
  if (data.tipo === 'nuevo_mensaje' && data.mensaje?.direccion === 'entrante') {
    const tel = data.mensaje?.telefono || '';
    const txt = data.mensaje?.texto?.slice(0, 60) || 'Nuevo mensaje';
    enviarPushATodos('💬 Nuevo mensaje WhatsApp', txt, { telefono: tel }).catch(() => {});
  }
}

// ⚠ PENDIENTE DE ELIMINAR: broadcast global legado — envía a TODOS los
// sockets de wss (panel de cualquier negocio + print-agent legado), sin
// aislar nada. NO USAR PARA NUEVOS EVENTOS OPERATIVOS. Se conserva
// únicamente para flujos que hoy todavía no tienen negocioId confiable:
// nuevo_mensaje de WhatsApp, bot_pausado, pago_confirmado (webhooks/jobs
// sin sesión), repartidor_asignado y el actualizar_estado del flujo de
// repartidor (sin sesión de negocio), rappi_menu_aprobado/rechazado (sin
// datos operativos que aislar) y rappi_cancelacion cuando su store_id no
// resuelve a ninguna integración registrada — ver reporte de esta fase
// para el detalle completo de cada caso. Usar broadcastNegocio(negocioId,
// data) para cualquier evento operativo nuevo.
function broadcast(data) {
  const mensaje = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === 1) { // 1 = OPEN
      client.send(mensaje);
    }
  });
  dispararPushParaEvento(data);
}

// ✅ NUEVO (Fase 7) — broadcast seguro por negocio. Envía EXCLUSIVAMENTE a
// conexiones ws.tipo==='panel' cuyo ws.negocioId coincida exactamente —
// nunca a 'legacy' (print-agent), nunca a wssVoice, nunca a otro negocio.
// Fail closed: sin negocioId válido, no envía a nadie y NUNCA cae a
// broadcast() global. Dispara el mismo push global que broadcast() (ver
// dispararPushParaEvento) — deliberado y documentado, no un efecto
// accidental del filtrado por negocio.
function broadcastNegocio(negocioId, data, opciones = {}) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    console.error(`[WS] broadcastNegocio: negocioId inválido u omitido — no se envía a nadie (fail closed) [tipo=${data?.tipo}]`);
    return 0;
  }
  const negocioIdNorm = negocioId.trim();
  const mensaje = JSON.stringify(data);
  let enviados = 0;
  wss.clients.forEach(client => {
    if (client.readyState !== 1) return; // 1 = OPEN
    if (client.tipo !== 'panel') return;
    if (client.negocioId !== negocioIdNorm) return;
    // opciones.sucursalId / opciones.terminalId: reservado para filtros
    // futuros más finos (no usado todavía — no se inventa comportamiento
    // no solicitado en esta fase).
    client.send(mensaje);
    enviados++;
  });
  dispararPushParaEvento(data);
  return enviados;
}

// ⚠ PENDIENTE DE ELIMINAR: envío adicional y temporal hacia print-agent
// (conexiones ws.tipo==='legacy' en la raíz "/"), EXCLUSIVAMENTE para
// nuevo_pedido — mantiene la impresión de Nonna Maye funcionando mientras
// print-agent.js no migra a su propia ruta autenticada (fase no autorizada
// todavía). Nunca debe usarse para mensajes, pagos, clientes ni eventos
// administrativos. No está aislada por negocio (print-agent hoy no sabe a
// qué negocio pertenece) — por diseño, no por descuido. No dispara push
// (ya lo hace broadcastNegocio para el mismo evento; evita duplicarlo).
function broadcastPrintAgentLegacy(data) {
  const mensaje = JSON.stringify(data);
  let enviados = 0;
  wss.clients.forEach(client => {
    if (client.readyState !== 1) return;
    if (client.tipo !== 'legacy') return;
    client.send(mensaje);
    enviados++;
  });
  return enviados;
}

// ✅ NUEVO — broadcast seguro para print-agents autenticados. Exige
// negocioId Y sucursalId (ambos obligatorios aquí, a diferencia de
// broadcastNegocio del panel) -- fail closed si falta cualquiera de los
// dos, sin excepción, sin caer nunca a broadcast()/broadcastPrintAgentLegacy.
// Envía EXCLUSIVAMENTE a ws.tipo==='print-agent' con ws.autenticado===true
// cuyo negocioId Y sucursalId coincidan exactamente -- nunca a 'panel',
// 'legacy' ni 'print-agent-pendiente' (sin autenticar). TODAVÍA no la
// invoca ningún emisor real de pedidos -- queda definida y disponible
// para la siguiente fase.
function broadcastPrintAgentNegocio(negocioId, sucursalId, data) {
  if (typeof negocioId !== 'string' || !negocioId.trim() || typeof sucursalId !== 'string' || !sucursalId.trim()) {
    console.error(`[PrintAgent] broadcastPrintAgentNegocio: negocioId/sucursalId inválido u omitido — no se envía a nadie (fail closed) [tipo=${data?.tipo}]`);
    return 0;
  }
  const negocioIdNorm = negocioId.trim();
  const sucursalIdNorm = sucursalId.trim();
  const mensaje = JSON.stringify(data);
  let enviados = 0;
  wss.clients.forEach(client => {
    if (client.readyState !== 1) return; // 1 = OPEN
    if (client.tipo !== 'print-agent') return;
    if (!client.autenticado) return;
    if (client.negocioId !== negocioIdNorm) return;
    if (client.sucursalId !== sucursalIdNorm) return;
    client.send(mensaje);
    enviados++;
  });
  // Log seguro: negocio/sucursal/tipo/folio -- nunca cliente, teléfono,
  // dirección, items ni token.
  const folio = data?.pedido?.id || data?.pedido?.folio || data?.folio || null;
  console.log(`[PrintAgent] broadcastPrintAgentNegocio — negocio=${negocioIdNorm} sucursal=${sucursalIdNorm} tipo=${data?.tipo} folio=${folio || '-'} destinatarios=${enviados}`);
  return enviados;
}
// Exportada únicamente para poder probarla de forma aislada y para que la
// siguiente fase (todavía no autorizada) la conecte a un emisor real de
// pedidos -- mismo patrón ya usado en este archivo para
// enviarPushARepartidores. Ningún llamador real la invoca todavía.
export { broadcastPrintAgentNegocio };

// Inyectar broadcast en el orderManager, whatsapp y rappi
setWsBroadcast(broadcastNegocio, broadcastPrintAgentLegacy);
setWsBroadcastWA(broadcast);
setWsBroadcastRappi(broadcastNegocio, broadcast);

// Activar WebSocket de voz (Conversation Relay)
setupVoiceWebSocket(wssVoice);

// Tiempo máximo para que una conexión /ws/print-agent envíe su mensaje de
// autenticación antes de cerrarse. Valor razonable, no configurable
// todavía (no se pidió que lo fuera).
const TIMEOUT_AUTH_PRINT_AGENT_MS = 5000;
const TAMANO_MAXIMO_MENSAJE_AUTH = 4096; // bytes -- protección contra payload excesivo

// wss recibe TRES clases de conexión hoy:
//   - 'panel'  → autenticada en autenticarUpgradePanel() (/ws/panel), carga
//     inicial aislada por negocio vía obtenerPedidos(ws.negocioId).
//   - 'print-agent-pendiente' → conexión de /ws/print-agent, upgrade ya
//     completado pero SIN autenticar todavía. No recibe absolutamente
//     nada -- ni pedidos, ni snapshot, ni eventos administrativos -- hasta
//     que su primer mensaje ({tipo:'autenticar_terminal', terminalId,
//     token}) valide correctamente contra terminales→sucursales→negocios,
//     o hasta que expire TIMEOUT_AUTH_PRINT_AGENT_MS, lo que ocurra primero.
//     Al autenticar con éxito pasa a ws.tipo='print-agent',
//     ws.autenticado=true. Nunca se clasifica como 'legacy'. Solo se
//     procesa el PRIMER mensaje recibido en toda la conexión -- cualquier
//     mensaje adicional (incluido un segundo intento de autenticación) se
//     rechaza cerrando el socket, para impedir reautenticarse como otra
//     terminal en la misma conexión.
//   - 'legacy' → ⚠ MULTIEMPRESA INSEGURO, sin autenticar (raíz "/", usada
//     hoy por print-agent.js). Usa obtenerTodosPedidosParaWebSocketLegacy()
//     (todos los pedidos de todos los negocios) para conservar el
//     comportamiento actual sin romper la impresión de Nonna Maye.
//     PENDIENTE DE ELIMINAR en cuanto print-agent.js migre a /ws/print-agent
//     (fase posterior, no autorizada todavía). NO DESPLEGAR PARA UN
//     SEGUNDO NEGOCIO mientras esta rama exista. broadcast() sigue
//     exactamente igual (llega solo a 'panel' y 'legacy'), sin cambios en
//     esta tarea.
wss.on('connection', (ws) => {
  const ctx = ws.contextoWS || { tipo: 'legacy', usuarioId: null, negocioId: null, rol: null, sucursalId: null, terminalId: null };
  ws.tipo       = ctx.tipo;
  ws.usuarioId  = ctx.usuarioId;
  ws.negocioId  = ctx.negocioId;
  ws.rol        = ctx.rol;
  ws.sucursalId = ctx.sucursalId;
  ws.terminalId = ctx.terminalId;
  ws.autenticado = ctx.autenticado ?? null; // null = no aplica (panel/legacy), false/true = print-agent

  if (ws.tipo === 'panel') {
    console.log(`[WS] Panel autenticado conectado — negocio=${ws.negocioId} usuario=${ws.usuarioId} rol=${ws.rol}`);
    const pedidosNegocio = obtenerPedidos(ws.negocioId).filter(p => p.estado !== 'entregado');
    pedidosNegocio.forEach(pedido => {
      ws.send(JSON.stringify({ tipo: 'nuevo_pedido', pedido }));
    });
    ws.on('close', () => console.log('[WS] Panel autenticado desconectado'));
    return;
  }

  if (ws.tipo === 'print-agent-pendiente') {
    // Sin volcado inicial de ningún tipo -- ni ahora ni tras autenticar
    // (ver Fase 9 del reporte de esta tarea): el agente nuevo solo
    // recibirá trabajos explícitos en una fase posterior, nunca un
    // snapshot al conectar. Esto es justo lo que elimina la reimpresión
    // masiva por reconexión que sí sufre el agente legacy.
    let procesado = false;

    const limpiarTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };

    let timer = setTimeout(() => {
      if (!ws.autenticado) {
        console.log('[PrintAgent] Conexión cerrada por timeout de autenticación (sin secretos en el log)');
        try { ws.close(1008, 'Timeout de autenticación'); } catch { ws.terminate(); }
      }
    }, TIMEOUT_AUTH_PRINT_AGENT_MS);

    const rechazar = (motivoLog) => {
      console.log(`[PrintAgent] Autenticación fallida (${motivoLog}) — sin revelar el motivo al cliente`);
      try { ws.send(JSON.stringify({ tipo: 'error', mensaje: 'Autenticación fallida' })); } catch {}
      limpiarTimer();
      try { ws.close(); } catch { ws.terminate(); }
    };

    ws.on('message', async (raw) => {
      if (procesado) {
        // Ya se procesó un mensaje en esta conexión -- ni reautenticación
        // como otra terminal, ni mensajes adicionales en esta fase.
        return rechazar('mensaje adicional tras el primero');
      }
      procesado = true;

      if (!raw || raw.length > TAMANO_MAXIMO_MENSAJE_AUTH) return rechazar('payload excesivo o vacío');

      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return rechazar('JSON inválido'); }

      if (!msg || msg.tipo !== 'autenticar_terminal') return rechazar('tipo de mensaje incorrecto');

      const { terminalId, token } = msg;
      if (typeof terminalId !== 'string' || !terminalId.trim() || terminalId.length > 100) return rechazar('terminalId inválido');
      if (typeof token !== 'string' || !token.trim() || token.length > 512) return rechazar('token inválido');
      const terminalIdNorm = terminalId.trim();

      const fila = await obtenerTerminalParaAutenticacion(terminalIdNorm);
      if (!fila) return rechazar('terminal inexistente');
      if (!fila.token_hash) return rechazar('sin credencial emitida');
      if (!fila.terminal_activo) return rechazar('terminal inactiva');
      if (!fila.sucursal_activo) return rechazar('sucursal inactiva');
      if (!fila.negocio_activo) return rechazar('negocio inactivo');

      // Comparación en tiempo constante -- mismo patrón que session.js
      // para verificar firmas. token nunca se loguea, nunca se guarda,
      // nunca se envía de regreso, nunca se almacena en ws.
      const hashRecibido    = Buffer.from(createHash('sha256').update(token).digest('hex'), 'hex');
      const hashAlmacenado  = Buffer.from(fila.token_hash, 'hex');
      if (hashRecibido.length !== hashAlmacenado.length || !timingSafeEqual(hashRecibido, hashAlmacenado)) {
        return rechazar('token incorrecto');
      }

      // Éxito -- limpiar timer inmediatamente.
      limpiarTimer();
      ws.tipo        = 'print-agent';
      ws.autenticado = true;
      ws.terminalId  = fila.terminal_id;
      ws.sucursalId  = fila.sucursal_id;
      ws.negocioId   = fila.negocio_id;

      ws.send(JSON.stringify({
        tipo: 'terminal_autenticada',
        terminalId: fila.terminal_id,
        negocioId: fila.negocio_id,
        sucursalId: fila.sucursal_id,
      }));

      // Fire-and-forget a propósito: un fallo de telemetría nunca debe
      // invalidar una autenticación ya correcta (ver Fase 7 del reporte).
      marcarUltimaConexionTerminal(fila.terminal_id);

      console.log(`[PrintAgent] Terminal autenticada — terminal=${fila.terminal_id} negocio=${fila.negocio_id} sucursal=${fila.sucursal_id}`);
    });

    ws.on('close', () => { limpiarTimer(); console.log(`[PrintAgent] Conexión ${ws.autenticado ? 'autenticada' : 'pendiente'} desconectada`); });
    ws.on('error', () => { limpiarTimer(); });
    return;
  }

  // 'legacy'
  console.log('[WS] Conexión legado (sin autenticar) conectada');
  const pedidosActivos = obtenerTodosPedidosParaWebSocketLegacy().filter(p => p.estado !== 'entregado');
  pedidosActivos.forEach(pedido => {
    ws.send(JSON.stringify({ tipo: 'nuevo_pedido', pedido }));
  });
  ws.on('close', () => console.log('[WS] Conexión legado desconectada'));
});

// ─── Middlewares ─────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Twilio envía form-urlencoded

// Archivos estáticos: panel y audios generados por ElevenLabs
app.use(express.static(join(__dirname, '../panel')));
app.use('/audio', express.static(join(__dirname, '../public/audio')));
app.use('/public', express.static(join(__dirname, '../public')));

// ─── Xabor Finanzas (módulo SAT — independiente) ────────────────────────────
app.use('/api/finanzas', requireAdmin, finanzasRouter);

// ─── Credenciales e.firma SAT ────────────────────────────────────────────────
// GET: devuelve info pública del cert (sin llave) para mostrar en panel
app.get('/api/admin/sat/credenciales/info', requireAdminSeguro, async (req, res) => {
  try {
    const info = await obtenerInfoCertSAT();
    res.json({ ok: true, info }); // info es null si no hay credenciales
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST: recibe cert (.cer) y llave (.key) como base64 + contraseña
// Verifica que coincidan, descifra la llave y guarda en DB cifrada
app.post('/api/admin/sat/credenciales', requireAdminSeguro, async (req, res) => {
  const { certBase64Raw, keyBase64Raw, password } = req.body;
  if (!certBase64Raw || !keyBase64Raw || !password) {
    return res.status(400).json({ error: 'Se requieren certBase64Raw, keyBase64Raw y password' });
  }
  try {
    const forge = (await import('node-forge')).default;
    const crypto = (await import('crypto')).default;

    // ── 1. Parsear certificado ──────────────────────────────────────────────
    const certDer = Buffer.from(certBase64Raw, 'base64');
    // normalizarDer inline (el archivo puede ser DER o PEM)
    let certDerFinal = certDer;
    if (certDer.slice(0, 30).toString('utf8').trim().startsWith('-----BEGIN')) {
      const pemStr = certDer.toString('utf8');
      const b64 = pemStr.replace(/-----BEGIN[^-]+-----/g, '').replace(/-----END[^-]+-----/g, '').replace(/\s+/g, '');
      certDerFinal = Buffer.from(b64, 'base64');
    }
    const cerB64 = certDerFinal.toString('base64');
    const certPem = `-----BEGIN CERTIFICATE-----\n${cerB64.match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----`;
    const certObj = new crypto.X509Certificate(certPem);
    const expiration = new Date(certObj.validTo);
    if (expiration < new Date()) {
      return res.status(422).json({ error: `El certificado está vencido (venció el ${expiration.toISOString()})` });
    }

    // ── 2. Descifrar llave privada ──────────────────────────────────────────
    const keyDer = Buffer.from(keyBase64Raw, 'base64');
    let keyDerFinal = keyDer;
    if (keyDer.slice(0, 30).toString('utf8').trim().startsWith('-----BEGIN')) {
      const pemStr = keyDer.toString('utf8');
      const b64 = pemStr.replace(/-----BEGIN[^-]+-----/g, '').replace(/-----END[^-]+-----/g, '').replace(/\s+/g, '');
      keyDerFinal = Buffer.from(b64, 'base64');
    }
    const asn1 = forge.asn1.fromDer(keyDerFinal.toString('binary'));
    const pkInfo = forge.pki.decryptPrivateKeyInfo(asn1, password);
    if (!pkInfo) return res.status(422).json({ error: 'Contraseña incorrecta o llave corrupta' });
    const privateKey = forge.pki.privateKeyFromAsn1(pkInfo);
    const privateKeyPem = forge.pki.privateKeyToPem(privateKey);

    // ── 3. Verificar que cert y llave coinciden ──────────────────────────────
    const testData = Buffer.from('xabor-efirma-check');
    const privKeyObj = crypto.createPrivateKey(privateKeyPem);
    const sig = crypto.sign('sha256', testData, privKeyObj);
    if (!crypto.verify('sha256', testData, certObj.publicKey, sig)) {
      return res.status(422).json({ error: 'La llave privada NO corresponde al certificado. Asegúrate de subir el par correcto.' });
    }

    // ── 4. Extraer metadatos del cert ──────────────────────────────────────
    const serial = BigInt('0x' + certObj.serialNumber).toString(10);
    const subject = certObj.subject;
    // Extraer RFC del subject (OID 2.5.4.45 o campo UniqueIdentifier / OU)
    const rfcMatch = subject.match(/(?:UniqueIdentifier|UID|OID\.2\.5\.4\.45)=([A-Z]{3,4}\d{6}[A-Z0-9]{3})/i)
      || subject.match(/([A-Z]{3,4}\d{6}[A-Z0-9]{3})/);
    const rfcCert = rfcMatch ? rfcMatch[1].toUpperCase() : null;

    const certInfo = {
      serial,
      rfc: rfcCert,
      validFrom: certObj.validFrom,
      validTo: certObj.validTo,
      subject: certObj.subject,
    };

    // ── 5. Guardar en DB (llave cifrada) ────────────────────────────────────
    await guardarCredencialesSAT({ certBase64: cerB64, privateKeyPem, certInfo });

    // ── 6. Invalidar caché en memoria ──────────────────────────────────────
    invalidarCacheCredenciales();

    res.json({ ok: true, info: certInfo });
  } catch (e) {
    console.error('[SAT] Error guardando credenciales:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// DELETE: eliminar credenciales SAT guardadas en DB
app.delete('/api/admin/sat/credenciales', requireAdminSeguro, async (req, res) => {
  try {
    await eliminarCredencialesSAT();
    invalidarCacheCredenciales();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Rutas de webhooks (canales) ────────────────────────────────────────────
app.use('/webhook/whatsapp', whatsappRouter);
app.use('/webhook/voice', voiceRouter);
app.use('/webhook/rappi', rappiRouter);

// Clip — notificación de pago completado
// ⚠ Se queda en broadcast() legado a propósito: es un webhook sin sesión,
// no hay req.negocioId (podría derivarse buscando el pedido por folio, pero
// esta fase solo migra rutas con contexto de sesión real — ver reporte).
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

// ─── Sesión multiempresa (Fase 2) ─────────────────────────────────────────
// Emisión de sesión: NO es un login por contraseña de usuario todavía (eso
// queda pendiente — ver riesgos). Por ahora, quien ya tiene el token admin
// legado puede emitir una sesión real para un usuario+negocio que ya exista
// en usuario_negocios, para poder probar y adoptar gradualmente el
// middleware requireSesionNegocio antes de construir el login final.
app.post('/api/auth/sesion', requireAdmin, async (req, res) => {
  const { usuarioId, negocioId } = req.body;
  if (!usuarioId) return res.status(400).json({ error: 'usuarioId requerido' });

  const usuario = await obtenerUsuarioPorId(usuarioId);
  if (!usuario) return res.status(404).json({ error: 'Usuario no encontrado' });

  const negocios = await obtenerNegociosDeUsuario(usuarioId);
  if (!negocios.length) return res.status(403).json({ error: 'El usuario no pertenece a ningún negocio activo' });

  const negocioElegido = negocioId
    ? negocios.find(n => n.negocio_id === negocioId)
    : negocios[0];
  if (!negocioElegido) return res.status(403).json({ error: 'El usuario no pertenece al negocio solicitado' });

  const token = crearTokenSesion({ usuarioId, negocioId: negocioElegido.negocio_id, rol: negocioElegido.rol });
  res.json({ token, negocioId: negocioElegido.negocio_id, negocioNombre: negocioElegido.nombre, rol: negocioElegido.rol });
});

// ─── Login real por correo y contraseña (Fase 3) ──────────────────────────
// Un solo endpoint cubre los dos pasos del flujo:
//  1) email + password → si el usuario pertenece a un solo negocio activo,
//     se emite la sesión de una vez (cookie httpOnly). Si pertenece a
//     varios, se devuelve la lista de negocios + un token corto de
//     preselección (preAuth) en vez de una sesión — el cliente no vuelve a
//     enviar la contraseña, solo el preAuth + el negocioId elegido.
//  2) preAuth + negocioId → completa la sesión para el negocio elegido.
// El mensaje de error para "no existe" y "contraseña incorrecta" es el
// mismo a propósito, para no revelar si un correo está registrado.
app.post('/api/auth/negocio/login', async (req, res) => {
  const { email, password, negocioId, preAuth } = req.body;
  try {
    let usuarioId;

    if (preAuth) {
      usuarioId = verificarTokenPreAuth(preAuth);
      if (!usuarioId) {
        return res.status(401).json({ error: 'Selección de negocio inválida o expirada — inicia sesión de nuevo' });
      }
    } else {
      if (!email || !password) {
        return res.status(400).json({ error: 'email y password son requeridos' });
      }
      const usuario = await obtenerUsuarioPorEmail(email);
      if (!usuario || !usuario.activo || !verifyPassword(password, usuario.password_hash)) {
        return res.status(401).json({ error: 'Correo o contraseña incorrectos' });
      }
      usuarioId = usuario.id;
    }

    const negocios = await obtenerNegociosDeUsuario(usuarioId);
    if (!negocios.length) {
      return res.status(403).json({ error: 'El usuario no pertenece a ningún negocio activo' });
    }

    // Si el cliente indicó explícitamente un negocioId, se valida pertenencia
    // real SIEMPRE — sin importar si el usuario tiene uno o varios negocios.
    // Nunca se ignora un negocioId inválido a favor de auto-seleccionar otro:
    // eso confundiría a un cliente que cree haber entrado a un negocio al
    // que en realidad no tiene acceso.
    if (negocioId) {
      const elegido = negocios.find(n => n.negocio_id === negocioId);
      if (!elegido) {
        return res.status(403).json({ error: 'El usuario no pertenece al negocio solicitado' });
      }
      const token = crearTokenSesion({ usuarioId, negocioId: elegido.negocio_id, rol: elegido.rol });
      setCookieSesion(res, token);
      return res.json({ ok: true, negocioId: elegido.negocio_id, negocioNombre: elegido.nombre, rol: elegido.rol });
    }

    // Sin negocioId y un solo negocio — auto-seleccionar, sesión de inmediato.
    if (negocios.length === 1) {
      const n = negocios[0];
      const token = crearTokenSesion({ usuarioId, negocioId: n.negocio_id, rol: n.rol });
      setCookieSesion(res, token);
      return res.json({ ok: true, negocioId: n.negocio_id, negocioNombre: n.nombre, rol: n.rol });
    }

    // Sin negocioId y varios negocios — devolver selector + preAuth.
    const preAuthToken = crearTokenPreAuth(usuarioId);
    res.json({
      ok: true,
      requiereSeleccion: true,
      preAuth: preAuthToken,
      negocios: negocios.map(n => ({ negocioId: n.negocio_id, nombre: n.nombre, rol: n.rol })),
    });
  } catch (e) {
    console.error('[POST /api/auth/negocio/login] Error:', e.message);
    res.status(500).json({ error: 'Error interno al iniciar sesión' });
  }
});

app.post('/api/auth/negocio/logout', (req, res) => {
  // Revocar el token en sí (no solo borrar la cookie) — si no se hace esto,
  // la misma cookie reenviada después de logout (p. ej. por el botón Atrás
  // restaurando una página cacheada) seguiría siendo válida hasta su
  // expiración natural.
  const auth = req.headers['authorization'];
  const tokenBearer = (auth && auth.startsWith('Bearer ')) ? auth.slice(7) : null;
  const token = leerCookieSesion(req) || tokenBearer;
  revocarTokenSesion(token);
  limpiarCookieSesion(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', requireSesionNegocio(), (req, res) => {
  res.json({ usuarioId: req.usuarioId, negocioId: req.negocioId, rol: req.rol });
});

// Diagnóstico de solo lectura para validar la exigencia de rol del nuevo
// middleware (requireSesionNegocio('admin')) — no expone ni modifica datos.
app.get('/api/auth/me/admin', requireSesionNegocio('admin'), (req, res) => {
  res.json({ ok: true, rol: req.rol });
});

// Gate legado para /api/* — a partir de Fase 4, CADA ruta trae su propio
// middleware de auth explícito (requireAuthSeguro/requireAdminSeguro/
// resolverNegocioSeguro/requireRepartidor, o es pública a propósito), así
// que este gate ya no necesita ser el mecanismo por defecto. Solo re-aplica
// el requireAuth legado a las pocas rutas de integración Rappi que aún no
// se migraron (ver auditoría de Fase 4 — no se tocaron porque disparan
// llamadas hacia Rappi y no están confirmadas como usadas por el panel
// actual). Cualquier ruta nueva que se agregue en el futuro DEBE traer su
// propio middleware — este gate ya no la protege por omisión.
const RUTAS_LEGADO_SOLAMENTE = [
  '/rappi/stockout',
  '/rappi/subir-catalogo',
  '/rappi/actualizar-schedule',
  '/rappi/estado-tienda',
  '/rappi/setup-webhooks',
];
app.use('/api', (req, res, next) => {
  if (RUTAS_LEGADO_SOLAMENTE.includes(req.path)) {
    return requireAuth(req, res, next);
  }
  next();
});

// Servir panel principal solo con sesión válida
app.get('/', (req, res) => {
  res.sendFile(join(__dirname, '../panel/index.html'));
});

// Xabor Finanzas — SPA independiente (auth client-side, igual que panel principal)
app.get('/finanzas', (req, res) => {
  res.sendFile(join(__dirname, '../panel/finanzas.html'));
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
// Fase 6 — aislamiento del tablero: el negocio SIEMPRE se toma de
// req.negocioId (resuelto por requireAuthSeguro a partir de la sesión
// validada), nunca de query/body/header/params. Esta ruta antes no tenía
// NINGÚN middleware de auth -- se agrega aquí porque sin sesión no hay
// forma de saber de qué negocio pedir el tablero (y sin ella,
// obtenerPedidos(undefined) ya devuelve [] por diseño, nunca el arreglo
// completo).
app.get('/pedidos', requireAuthSeguro, (req, res) => {
  res.json(obtenerPedidos(req.negocioId));
});

// Cambiar estado de un pedido (desde el panel)
// Fase 6: un pedido inexistente y un pedido de otro negocio responden
// exactamente igual (404 genérico) para no revelar si el folio existe en
// otro negocio -- ver actualizarEstadoPedido en orderManager.js, que ya
// devuelve null en ambos casos.
app.patch('/pedidos/:id/estado', requireAuthSeguro, async (req, res) => {
  const { estado } = req.body;
  const estadosValidos = ['nuevo', 'en_preparacion', 'listo', 'entregado'];
  if (!estadosValidos.includes(estado)) {
    return res.status(400).json({ error: 'Estado inválido' });
  }
  const pedido = actualizarEstadoPedido(req.params.id, estado, req.negocioId);
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

// ─── Cliente técnico para pedidos presenciales sin teléfono real ───────────
// clientes.telefono es VARCHAR(20) PRIMARY KEY GLOBAL (sin negocio_id en la
// clave) -- no se puede usar un solo literal 'presencial' para todos los
// negocios (colisiona entre ellos: el segundo negocio pisaría el nombre y
// pedidos de ambos apuntarían a la misma fila) ni el UUID completo de
// negocioId (36 caracteres, no cabe en VARCHAR(20)). Se deriva un hash
// corto y determinista del negocioId: el mismo negocio siempre produce el
// mismo identificador técnico (se reutiliza, nunca se duplica); negocios
// distintos siempre producen identificadores distintos. 'pos-' (4) + 12 hex
// = 16 caracteres, dentro del límite de VARCHAR(20) con margen. No es un
// UUID ni se puede revertir a uno -- no expone negocioId completo en UI ni
// logs. Nunca se acepta este valor desde el cliente: se deriva
// exclusivamente server-side a partir de un negocioId ya autenticado.
function idClienteTecnicoPresencial(negocioId) {
  return 'pos-' + createHash('sha256').update(negocioId).digest('hex').slice(0, 12);
}

// Pedido presencial — capturado desde el panel sin pasar por el bot
// rewards_telefono y rewards_nombre son opcionales — si se envían, el cliente
// quedará asignado en el pedido y los puntos se acumularán al entregar.
app.post('/api/pedido-presencial', requireAuthSeguro, async (req, res) => {
  // negocioId EXCLUSIVAMENTE de req.negocioId (sesión/membresía ya
  // validada por requireAuthSeguro) -- nunca de body/query/headers. Falla
  // cerrado antes de registrar, persistir, emitir o imprimir: sin esto, el
  // pedido quedaba etiquetado con el respaldo temporal de Nonna Maye sin
  // importar qué negocio lo creó (hallazgo de la fase anterior). Sin
  // fallback aquí -- si req.negocioId falta, es un error real de sesión,
  // no un caso a rellenar.
  if (typeof req.negocioId !== 'string' || !req.negocioId.trim()) {
    console.error('[Panel] POST /api/pedido-presencial: req.negocioId inválido u omitido — pedido rechazado (fail closed)');
    return res.status(401).json({ error: 'Sesión inválida — no se pudo determinar el negocio' });
  }
  const { items, nombre, forma_pago, total, descuento, motivo_descuento, billete, cambio,
          mixto_efectivo, mixto_terminal, rewards_telefono, rewards_nombre,
          rewards_canje_puntos } = req.body;
  if (!items || !items.length) return res.status(400).json({ error: 'Sin items' });
  const subtotal = items.reduce((s, i) => s + (i.precio_unitario || 0) * (i.cantidad || 1), 0);
  const desc     = parseFloat(descuento) || 0;
  // Si hay cliente Rewards asignado (teléfono real), usarlo como cliente
  // del pedido -- si no, un cliente técnico determinista por negocio (ver
  // idClienteTecnicoPresencial arriba), nunca el literal 'presencial'
  // global ni un valor que el cliente HTTP pueda controlar.
  const tieneTelefonoReal = !!rewards_telefono?.trim();
  const clienteTel = tieneTelefonoReal ? rewards_telefono.trim() : idClienteTecnicoPresencial(req.negocioId);
  const clienteNom = (tieneTelefonoReal ? (rewards_nombre || nombre) : (nombre || 'Cliente presencial')) || 'Cliente presencial';
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
    cliente: { nombre: clienteNom, telefono: clienteTel },
    costo_envio: 0,
    negocioId: req.negocioId
  };
  const pedido = registrarPedido(orden, 'presencial');
  emitirPedido(pedido);
  // Persistencia en el historial (tabla pedidos) -- en segundo plano, no
  // bloquea la respuesta ni la emisión al panel (igual que antes). Se debe
  // asegurar primero que exista la fila en clientes (upsertCliente) ANTES
  // de insertar en pedidos, porque pedidos.telefono es FK hacia
  // clientes.telefono -- si no, el INSERT viola la FK y falla en
  // silencio (hallazgo de la fase anterior). Mismo patrón ya usado por
  // Rappi (upsertCliente antes de guardarPedido). Se pasa "pedido" (no
  // "orden") a guardarPedido -- guardarPedido lee pedido.id para la
  // columna folio, y solo el objeto devuelto por registrarPedido lo tiene
  // (orden nunca lo recibe de vuelta); pasar "orden" dejaba folio siempre
  // NULL, un segundo hallazgo de persistencia distinto al de la FK.
  (async () => {
    try {
      const { upsertCliente, guardarPedido } = await import('./services/database.js');
      await upsertCliente(clienteTel, clienteNom, pedido.negocioId);
      await guardarPedido(clienteTel, pedido, pedido.negocioId);
    } catch (e) {
      console.error('[Panel] Error persistiendo pedido presencial en historial:', e.message);
    }
  })();

  // Rewards — registrar canje si aplica (sincrónico para que el folio exista)
  let canjeInfo = null;
  const puntosACanjear = parseInt(rewards_canje_puntos) || 0;
  if (puntosACanjear > 0 && rewards_telefono?.trim()) {
    try {
      canjeInfo = await registrarCanje(pedido.id, rewards_telefono.trim(), puntosACanjear, 'operador', REWARDS_TENANT);
    } catch (e) {
      console.error(`[Rewards] ❌ Error en canje POS (${pedido.id}):`, e.message);
      // El pedido ya fue registrado — devolvemos advertencia pero no fallamos
      return res.json({ ok: true, pedido, rewards_warning: e.message });
    }
  }

  res.json({ ok: true, pedido, canje: canjeInfo });
});

// Eliminar pedido (pruebas / limpieza) — requiere contraseña de administrador
app.delete('/pedidos/:id', requireAuthSeguro, async (req, res) => {
  const pin = req.headers['x-admin-pin'];
  if (!pin || pin !== ADMIN_PASSWORD) {
    return res.status(403).json({ error: 'Contraseña de administrador incorrecta' });
  }
  const ok = await eliminarPedido(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Pedido no encontrado' });
  res.json({ ok: true });
});

// Actualizar forma de pago — solo admin
app.patch('/api/admin/pedido/:folio/pago', requireAdminSeguro, async (req, res) => {
  const { folio } = req.params;
  const { forma_pago } = req.body;
  if (!forma_pago) return res.status(400).json({ error: 'forma_pago requerida' });
  const ok = await actualizarFormaPago(folio, forma_pago);
  if (!ok) return res.status(500).json({ error: 'No se pudo actualizar' });
  // Actualizar en memoria si el pedido sigue activo
  const { obtenerPedidoPorId } = await import('./orders/orderManager.js');
  const p = obtenerPedidoPorId(folio);
  if (p) p.forma_pago = forma_pago;
  broadcastNegocio(req.negocioId, { tipo: 'actualizar_pago', id: folio, forma_pago });
  res.json({ ok: true });
});

// Cancelar pedido activo — solo admin
app.post('/api/admin/pedido/:folio/cancelar', requireAdminSeguro, async (req, res) => {
  const { folio } = req.params;
  const { motivo } = req.body;
  if (!motivo?.trim()) return res.status(400).json({ error: 'Motivo requerido' });
  const ok = await cancelarPedidoActivo(folio, motivo.trim());
  if (!ok) return res.status(500).json({ error: 'No se pudo cancelar' });
  // Quitar del panel en tiempo real
  await eliminarPedido(folio).catch(() => {});
  broadcastNegocio(req.negocioId, { tipo: 'cancelar_pedido', id: folio, motivo });
  console.log(`[Panel] Pedido ${folio} CANCELADO — ${motivo}`);
  // Rewards — revertir puntos del folio (fire-and-forget, nunca bloquea)
  revertirMovimientosFolio(folio, REWARDS_TENANT).catch(e =>
    console.error(`[Rewards] Error en reverso al cancelar ${folio}:`, e.message)
  );
  res.json({ ok: true });
});

// Registrar devolución en pedido entregado — solo admin
app.post('/api/admin/pedido/:folio/devolucion', requireAdminSeguro, async (req, res) => {
  const { folio } = req.params;
  const { monto, motivo } = req.body;
  if (!monto || parseFloat(monto) <= 0) return res.status(400).json({ error: 'Monto inválido' });
  if (!motivo?.trim()) return res.status(400).json({ error: 'Motivo requerido' });
  const ok = await registrarDevolucion(folio, parseFloat(monto), motivo.trim());
  if (!ok) return res.status(500).json({ error: 'No se pudo registrar la devolución' });
  broadcastNegocio(req.negocioId, { tipo: 'devolucion_registrada', id: folio, monto: parseFloat(monto), motivo });
  console.log(`[Panel] Devolución ${folio}: $${monto} — ${motivo}`);
  res.json({ ok: true });
});

// Generar factura CFDI — solo admin
app.post('/api/admin/pedido/:folio/factura', requireAdminSeguro, async (req, res) => {
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
    const ents = await _ent(500, req.negocioId);
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
app.get('/api/admin/factura/:facturaId/pdf', requireAdminSeguro, async (req, res) => {
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
app.get('/api/conversaciones', requireAuthSeguro, async (req, res) => {
  const lista = await obtenerConversacionesRecientes(20);
  res.json(lista);
});

app.get('/api/conversacion/:telefono', requireAuthSeguro, async (req, res) => {
  const msgs = await obtenerConversacion(req.params.telefono);
  res.json(msgs);
});

// Enviar mensaje manual desde el panel (link de pago, etc.)
app.post('/api/send-message', requireAuthSeguro, async (req, res) => {
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
app.get('/api/historial', requireAuthSeguro, async (req, res) => {
  const lista = await obtenerPedidosEntregados(100, req.negocioId);
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

app.get('/api/ventas', requireAdminSeguro, async (req, res) => {
  const { desde, hasta } = req.query;
  const d = desde || inicioDelDiaMX().toISOString();
  const h = hasta || new Date().toISOString();
  const ventas = await obtenerVentas(d, h, req.negocioId);
  res.json(ventas);
});

app.get('/api/ventas/resumen', requireAdminSeguro, async (req, res) => {
  const { desde, hasta } = req.query;
  const d = desde || inicioDelDiaMX().toISOString();
  const h = hasta || new Date().toISOString();
  const resumen = await obtenerResumenVentas(d, h, req.negocioId);
  res.json(resumen);
});

// ─── Fondo de caja ────────────────────────────────────────────────────────────
function fechaHoyMX() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Matamoros' }).format(new Date());
}

app.post('/api/caja/fondo', requireAuthSeguro, async (req, res) => {
  const { monto } = req.body;
  if (!monto || isNaN(monto) || Number(monto) < 0) {
    return res.status(400).json({ error: 'Monto inválido' });
  }
  const fecha = fechaHoyMX();
  await guardarFondoCaja(fecha, Number(monto), req.negocioId);
  res.json({ ok: true, fecha, fondo: Number(monto) });
});

app.get('/api/caja/fondo', requireAuthSeguro, async (req, res) => {
  const fecha = fechaHoyMX();
  const registro = await obtenerFondoCaja(fecha, req.negocioId);
  res.json({ fecha, fondo: registro ? parseFloat(registro.fondo) : null });
});

// ─── Menú — endpoints ────────────────────────────────────────────────────────
app.get('/api/menu', resolverNegocioSeguro(), async (req, res) => {
  const menu = await obtenerMenuCompleto(req.negocioId);
  res.json(menu);
});

app.post('/api/admin/menu/categorias', resolverNegocioSeguro('admin'), async (req, res) => {
  const cat = await crearCategoria(req.body.nombre, req.negocioId);
  res.json(cat);
});

app.patch('/api/admin/menu/categorias/:id', resolverNegocioSeguro('admin'), async (req, res) => {
  await actualizarCategoria(req.params.id, req.body, req.negocioId);
  res.json({ ok: true });
});

app.delete('/api/admin/menu/categorias/:id', resolverNegocioSeguro('admin'), async (req, res) => {
  await eliminarCategoria(req.params.id, req.negocioId);
  res.json({ ok: true });
});

app.post('/api/admin/menu/productos', resolverNegocioSeguro('admin'), async (req, res) => {
  try {
    const prod = await crearProducto(req.body, req.negocioId);
    res.json(prod);
  } catch (e) {
    if (e.message?.includes('no encontrada') || e.message?.includes('no encontrado')) {
      return res.status(404).json({ error: e.message });
    }
    if (e.message?.includes('no pertenece al negocio actual')) {
      return res.status(403).json({ error: e.message });
    }
    console.error('[POST /api/admin/menu/productos] Error:', e.message);
    res.status(500).json({ error: 'Error al crear el producto' });
  }
});

app.patch('/api/admin/menu/productos/:id', resolverNegocioSeguro('admin'), async (req, res) => {
  try {
    await actualizarProducto(req.params.id, req.body, req.negocioId);
    res.json({ ok: true });
  } catch (e) {
    if (e.message?.includes('no encontrada') || e.message?.includes('no encontrado')) {
      return res.status(404).json({ error: e.message });
    }
    if (e.message?.includes('no pertenece al negocio actual')) {
      return res.status(403).json({ error: e.message });
    }
    console.error('[PATCH /api/admin/menu/productos/:id] Error:', e.message);
    res.status(500).json({ error: 'Error al actualizar el producto' });
  }
});

app.delete('/api/admin/menu/productos/:id', resolverNegocioSeguro('admin'), async (req, res) => {
  await eliminarProducto(req.params.id, req.negocioId);
  res.json({ ok: true });
});

// ─── Modificadores — endpoints ───────────────────────────────────────────────
app.get('/api/admin/menu/productos/:id/modificadores', resolverNegocioSeguro('admin'), async (req, res) => {
  const grupos = await obtenerModificadoresProducto(parseInt(req.params.id), req.negocioId);
  res.json(grupos);
});

app.post('/api/admin/menu/productos/:id/modificadores/grupos', resolverNegocioSeguro('admin'), async (req, res) => {
  try {
    const grupo = await crearGrupoModificador(parseInt(req.params.id), req.body, req.negocioId);
    res.json(grupo);
  } catch (e) {
    if (e.message?.includes('no encontrado')) {
      return res.status(404).json({ error: e.message });
    }
    if (e.message?.includes('no pertenece al negocio actual')) {
      return res.status(403).json({ error: e.message });
    }
    console.error('[POST /api/admin/menu/productos/:id/modificadores/grupos] Error:', e.message);
    res.status(500).json({ error: 'Error al crear el grupo de modificadores' });
  }
});

app.patch('/api/admin/menu/modificadores/grupos/:id', resolverNegocioSeguro('admin'), async (req, res) => {
  await actualizarGrupoModificador(parseInt(req.params.id), req.body, req.negocioId);
  res.json({ ok: true });
});

app.delete('/api/admin/menu/modificadores/grupos/:id', resolverNegocioSeguro('admin'), async (req, res) => {
  await eliminarGrupoModificador(parseInt(req.params.id), req.negocioId);
  res.json({ ok: true });
});

app.post('/api/admin/menu/modificadores/grupos/:id/opciones', resolverNegocioSeguro('admin'), async (req, res) => {
  try {
    const opcion = await crearOpcionModificador(parseInt(req.params.id), req.body, req.negocioId);
    res.json(opcion);
  } catch (e) {
    if (e.message?.includes('no encontrado')) {
      return res.status(404).json({ error: e.message });
    }
    if (e.message?.includes('no pertenece al negocio actual')) {
      return res.status(403).json({ error: e.message });
    }
    console.error('[POST /api/admin/menu/modificadores/grupos/:id/opciones] Error:', e.message);
    res.status(500).json({ error: 'Error al crear la opción de modificador' });
  }
});

app.patch('/api/admin/menu/modificadores/opciones/:id', resolverNegocioSeguro('admin'), async (req, res) => {
  await actualizarOpcionModificador(parseInt(req.params.id), req.body, req.negocioId);
  res.json({ ok: true });
});

app.delete('/api/admin/menu/modificadores/opciones/:id', resolverNegocioSeguro('admin'), async (req, res) => {
  await eliminarOpcionModificador(parseInt(req.params.id), req.negocioId);
  res.json({ ok: true });
});

// ─── Push Notifications — endpoints ─────────────────────────────────────────
app.get('/api/push/vapid-public-key', (req, res) => {
  if (!VAPID_PUBLIC) return res.status(503).json({ error: 'Push no configurado' });
  res.json({ key: VAPID_PUBLIC });
});

app.post('/api/push/subscribe', requireAuthSeguro, async (req, res) => {
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

app.delete('/api/push/subscribe', requireAuthSeguro, async (req, res) => {
  const { endpoint } = req.body;
  if (!endpoint) return res.status(400).json({ error: 'endpoint requerido' });
  await eliminarSuscripcionPush(endpoint).catch(() => {});
  res.json({ ok: true });
});

// Corte de caja — disponible para staff (resumen del día por forma de pago)
// Aislamiento completo por negocio (migración 009): ventas, resumen y
// fondo de caja se filtran/escriben con req.negocioId. caja_fondos ahora
// tiene UNIQUE(negocio_id, fecha) en vez de UNIQUE(fecha) global — dos
// negocios pueden tener cada uno su propio fondo el mismo día sin
// pisarse. Ver migrations/009_caja_fondos_por_negocio*.
app.get('/api/corte-caja', requireAuthSeguro, async (req, res) => {
  const d = inicioDelDiaMX().toISOString();
  const h = new Date().toISOString();
  const [ventas, resumen, fondoReg] = await Promise.all([
    obtenerVentas(d, h, req.negocioId),
    obtenerResumenVentas(d, h, req.negocioId),
    obtenerFondoCaja(fechaHoyMX(), req.negocioId)
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
// ⚠ bot_pausado se queda en broadcast() legado a propósito: aunque la ruta
// tiene req.negocioId, la conversación de WhatsApp en sí (mensajes,
// telefono) todavía no resuelve/filtra por negocio (mismo gap documentado
// de nuevo_mensaje, fuera de alcance de esta fase) — no es un evento de
// "pedidos", que es lo único que esta fase migra.
app.post('/api/conversacion/:telefono/pausar', requireAuthSeguro, async (req, res) => {
  await setBotPausado(req.params.telefono, true);
  broadcast({ tipo: 'bot_pausado', telefono: req.params.telefono, pausado: true });
  res.json({ ok: true, pausado: true });
});

app.post('/api/conversacion/:telefono/reactivar', requireAuthSeguro, async (req, res) => {
  await setBotPausado(req.params.telefono, false);
  broadcast({ tipo: 'bot_pausado', telefono: req.params.telefono, pausado: false });
  res.json({ ok: true, pausado: false });
});

app.get('/api/conversacion/:telefono/estado-bot', requireAuthSeguro, async (req, res) => {
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

// Rappi — registrar webhooks en producción (ejecutar una vez al configurar)
// Flujo: GET estado actual → POST registro → GET verificación → guardar secret en DB
app.post('/api/rappi/setup-webhooks', requireAdmin, async (req, res) => {
  const baseUrl = process.env.PUBLIC_URL || req.body?.baseUrl || 'https://xabor-agent-production.up.railway.app';
  const webhookUrl = `${baseUrl}/webhook/rappi`;

  try {
    // 1. Estado antes del registro
    const antesNEW = await obtenerWebhook('NEW_ORDER').catch(() => null);
    console.log('[Setup Webhooks] NEW_ORDER antes:', antesNEW ? JSON.stringify(antesNEW).slice(0, 200) : 'no existe');

    // 2. Registrar todos los webhooks con el formato oficial de Rappi
    const results = await configurarWebhooks(baseUrl);

    // 3. Guardar secret en DB si Rappi lo devuelve (sin imprimirlo completo)
    const secret = results['NEW_ORDER']?.registro?.secret
                || results['NEW_ORDER']?.registro?.data?.[0]?.secret;
    if (secret) {
      await actualizarConfiguracion({ rappi_webhook_secret: secret }).catch(() => {});
      console.log(`[Setup Webhooks] Secret guardado en DB — últimos 4: ...${secret.slice(-4)}`);
    }

    // 4. Respuesta: incluye verificación post-registro, oculta el secret completo
    const resp = {
      ok: true,
      storeId: process.env.RAPPI_STORE_ID,
      webhookUrl,
      secretGuardado: !!secret,
      eventos: {}
    };
    for (const [ev, r] of Object.entries(results)) {
      resp.eventos[ev] = r.error
        ? { error: r.error }
        : {
            registrado: !r.error,
            verificacion: r.verificacion
              ? { event: r.verificacion.event, stores: r.verificacion.stores || r.verificacion.data, state: r.verificacion.state || r.verificacion.status }
              : null
          };
    }
    res.json(resp);
  } catch (e) {
    console.error('[Setup Webhooks] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Pedido de prueba (solo para desarrollo)
// Configuración del negocio
app.get('/api/vapid-public', (req, res) => {
  const key = getIntegracion('vapid_public_key') || VAPID_PUBLIC;
  res.json({ publicKey: key || null });
});

app.get('/api/config', resolverNegocioSeguro(), async (req, res) => {
  if (req.esNegocioPorDefecto) return res.json(negocioConfig);
  const cfg = await obtenerConfiguracion(req.negocioId);
  res.json(cfg);
});
app.put('/api/config', resolverNegocioSeguro('admin'), async (req, res) => {
  const ok = await actualizarConfiguracion(req.body, req.negocioId);
  if (!ok) return res.status(500).json({ error: 'Error al guardar' });
  if (req.esNegocioPorDefecto) {
    negocioConfig = { ...negocioConfig, ...req.body };
    broadcastNegocio(req.negocioId, { tipo: 'config_actualizada', config: negocioConfig });
    return res.json({ ok: true, config: negocioConfig });
  }
  const cfgActualizada = await obtenerConfiguracion(req.negocioId);
  res.json({ ok: true, config: cfgActualizada });
});

// ─── Integraciones (claves de API configurables desde panel) ──────────────────
const INT_CLAVES = [
  'wa_token','wa_phone_id','wa_verify_token','wa_admin_numero',
  'clip_api_key','clip_api_secret',
  'facturapi_key',
  'anthropic_api_key',
  'vapid_public_key','vapid_private_key','vapid_email',
];

app.get('/api/admin/integraciones', requireAdminSeguro, async (req, res) => {
  const cfg = await obtenerConfiguracion();
  const result = {};
  INT_CLAVES.forEach(k => {
    const val = cfg['int_' + k] || '';
    // Enmascarar: mostrar solo últimos 4 caracteres
    result[k] = val.length > 8 ? '••••••••' + val.slice(-4) : (val ? '••••' : '');
  });
  res.json(result);
});

app.put('/api/admin/integraciones', requireAdminSeguro, async (req, res) => {
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
  const [disponibles, misPedidos] = await Promise.all([
    obtenerPedidosParaRepartidor(),
    obtenerPedidosAsignadosARepartidor(req.repartidor.id)
  ]);
  const mapear = p => ({
    folio: p.folio,
    estado: p.estado,
    cliente: p.datos?.cliente?.nombre,
    telefono: p.datos?.cliente?.telefono,
    calle: p.datos?.cliente?.calle,
    colonia: p.datos?.cliente?.colonia,
    entre_calles: p.datos?.cliente?.entre_calles,
    direccion: [p.datos?.cliente?.calle, p.datos?.cliente?.colonia].filter(Boolean).join(', '),
    total: p.datos?.total,
    items: p.datos?.items?.length
  });
  res.json({ disponibles: disponibles.map(mapear), misPedidos: misPedidos.map(mapear) });
});

// Aceptar pedido (atómico — solo uno lo puede tomar)
// ⚠ repartidor_asignado se queda en broadcast() legado: requireRepartidor
// autentica por token individual del repartidor, no por sesión de negocio
// -- sin req.negocioId real (mismo gap ya documentado para
// actualizarEstadoPedidoLegacySinNegocio en orderManager.js).
app.post('/api/repartidor/pedido/:folio/aceptar', requireRepartidor, async (req, res) => {
  const { folio } = req.params;
  const asignado = await asignarRepartidor(folio, req.repartidor.id, req.repartidor.nombre);
  if (!asignado) return res.status(409).json({ error: 'Este pedido ya fue tomado por otro repartidor' });
  broadcast({ tipo: 'repartidor_asignado', folio, repartidor: req.repartidor.nombre });
  console.log(`[Repartidor] ${req.repartidor.nombre} tomó el pedido ${folio}`);

  // WA "en camino" al cliente
  try {
    const pedido = obtenerPedidoPorId(folio);
    const tel = pedido?.cliente?.telefono;
    if (tel && tel !== '—' && !tel.startsWith('rappi-')) {
      const nombre = pedido?.cliente?.nombre?.split(' ')[0] || 'cliente';
      await enviarMensaje(tel,
        `¡Hola ${nombre}! 🛵 Tu pedido *${folio}* ya está en camino. ` +
        `Lo lleva ${req.repartidor.nombre}. ¡Llegará en breve!`
      );
    }
  } catch (e) {
    console.error('[Repartidor] Error enviando WA en camino:', e.message);
  }

  res.json({ ok: true, folio });
});

// Repartidor marca pedido como entregado desde su celular
// ⚠ PENDIENTE DE SEGURIDAD: requireRepartidor autentica por token
// individual del repartidor (SELECT * FROM repartidores WHERE token=$1),
// no por sesión de negocio -- y repartidores.negocio_id nunca se puebla
// hoy al registrar un repartidor (fuera del alcance de esta tarea, vive
// en whatsapp-meta.js). Sin un negocioId real y confiable que derivar,
// se usa actualizarEstadoPedidoLegacySinNegocio en vez de inventar uno o
// usar Nonna Maye como relleno. Conserva exactamente el comportamiento
// previo a esta tarea -- ver diagnóstico completo en orderManager.js.
app.post('/api/repartidor/pedido/:folio/entregado', requireRepartidor, async (req, res) => {
  const { folio } = req.params;
  const pedido = actualizarEstadoPedidoLegacySinNegocio(folio, 'entregado');
  if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
  // Este broadcast() directo se queda legado a propósito (misma razón que
  // el comentario de arriba: sin req.negocioId real). No es una fuga real:
  // _persistirCambioEstado (orderManager.js) YA emitió este mismo
  // actualizar_estado vía broadcastNegocio(pedido.negocioId, ...) al
  // actualizar el estado unas líneas arriba -- el panel del negocio
  // correcto ya lo recibió aislado. Este es un envío redundante heredado,
  // documentado, no una segunda fuente de verdad.
  broadcast({ tipo: 'actualizar_estado', id: folio, estado: 'entregado' });
  console.log(`[Repartidor] ${req.repartidor.nombre} marcó ${folio} como entregado`);

  // WA confirmación de entrega al cliente
  try {
    const tel = pedido?.cliente?.telefono;
    if (tel && tel !== '—' && !tel.startsWith('rappi-')) {
      const nombre = pedido?.cliente?.nombre?.split(' ')[0] || 'cliente';
      await enviarMensaje(tel,
        `¡Listo ${nombre}! ✅ Tu pedido *${folio}* fue entregado. ` +
        `¡Gracias por tu preferencia! Esperamos verte pronto. 🙏`
      );
    }
  } catch (e) {
    console.error('[Repartidor] Error enviando WA entregado:', e.message);
  }

  res.json({ ok: true });
});

// Guardar push subscription del repartidor
app.post('/api/repartidor/push/subscribe', requireRepartidor, async (req, res) => {
  const { subscription } = req.body;
  if (!subscription) return res.status(400).json({ error: 'subscription requerida' });
  await guardarPushRepartidor(req.repartidor.id, subscription);
  res.json({ ok: true });
});

// Lista de repartidores (admin)
app.get('/api/admin/repartidores', requireAdminSeguro, async (req, res) => {
  res.json(await obtenerRepartidores());
});

// Actividad de repartidores por período — hoy / ayer / antier / semana
app.get('/api/admin/repartidores/estado', requireAdminSeguro, async (req, res) => {
  try {
    const periodo = req.query.periodo || 'hoy'; // hoy | ayer | antier | semana
    const tz = 'America/Matamoros';
    let whereDate;
    // created_at es TIMESTAMP WITHOUT TIME ZONE almacenado en UTC.
    // Conversión correcta: marcar como UTC primero, luego convertir a Matamoros.
    const dateExpr = `(created_at AT TIME ZONE 'UTC' AT TIME ZONE '${tz}')::date`;
    const hoyMx    = `(NOW() AT TIME ZONE '${tz}')::date`;
    if (periodo === 'hoy')    whereDate = `${dateExpr} = ${hoyMx}`;
    else if (periodo === 'ayer')   whereDate = `${dateExpr} = ${hoyMx} - 1`;
    else if (periodo === 'antier') whereDate = `${dateExpr} = ${hoyMx} - 2`;
    else                           whereDate = `${dateExpr} >= ${hoyMx} - 6`;

    const { rows: pedidos } = await pool.query(`
      SELECT folio, estado, datos, created_at,
             (datos->>'repartidor_id')::int AS repartidor_id,
             datos->>'repartidor_nombre' AS repartidor_nombre
      FROM pedidos_activos
      WHERE ${whereDate}
        AND datos->>'modalidad' ILIKE '%domicilio%'
        AND (datos->>'canal') IS DISTINCT FROM 'rappi'
      ORDER BY created_at DESC
    `);

    // Agrupar por repartidor (o "sin_asignar" si no tiene)
    const porRep = {};
    pedidos.forEach(p => {
      const id = p.repartidor_id || 'sin_asignar';
      const nombre = p.repartidor_nombre || 'Sin repartidor asignado';
      if (!porRep[id]) porRep[id] = { id, nombre, pedidos: [] };
      porRep[id].pedidos.push({
        folio: p.folio,
        estado: p.estado,
        cliente: p.datos?.cliente?.nombre,
        telefono: p.datos?.cliente?.telefono,
        calle: p.datos?.cliente?.calle,
        colonia: p.datos?.cliente?.colonia,
        entre_calles: p.datos?.cliente?.entre_calles,
        total: p.datos?.total,
        hora: new Date(p.created_at).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', timeZone: tz })
      });
    });

    // Repartidores con pedidos primero, sin asignar al final
    const resultado = Object.values(porRep).sort((a, b) =>
      a.id === 'sin_asignar' ? 1 : b.id === 'sin_asignar' ? -1 : 0
    );
    res.json(resultado);
  } catch (e) {
    console.error('[repartidores/estado]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/admin/repartidores/:id', requireAdminSeguro, async (req, res) => {
  await eliminarRepartidor(req.params.id);
  res.json({ ok: true });
});

// Candidatos a repartidor — mensajes con "repartidor" en las últimas 72h
app.get('/api/admin/repartidores/candidatos', requireAdminSeguro, async (req, res) => {
  try {
    const rows = await obtenerCandidatosRepartidor();
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DEBUG TEMPORAL — diagnóstico de un pedido en pedidos_activos
app.get('/api/admin/debug/pedido/:folio', requireAdminSeguro, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT folio, estado, created_at,
           datos->>'modalidad' AS modalidad,
           datos->>'repartidor_id' AS repartidor_id,
           datos->>'repartidor_nombre' AS repartidor_nombre,
           DATE(created_at AT TIME ZONE 'America/Matamoros') AS fecha_mx,
           (NOW() AT TIME ZONE 'America/Matamoros')::date AS hoy_mx
    FROM pedidos_activos WHERE folio = $1
  `, [req.params.folio]).catch(e => ({ rows: [], error: e.message }));
  res.json(rows[0] || { error: 'no encontrado' });
});

app.post('/api/admin/reporte-diario/enviar', requireAdminSeguro, async (req, res) => {
  await enviarReporteDiario();
  res.json({ ok: true });
});

// Endpoint — forzar enriquecimiento de perfiles manualmente
app.post('/api/admin/memory/enriquecer', requireAdminSeguro, async (req, res) => {
  const n = await enriquecerTodosLosPerfiles();
  res.json({ ok: true, perfiles_actualizados: n });
});

// ─── Clientes CRM ─────────────────────────────────────────────────────────────
app.get('/api/admin/clientes', requireAdminSeguro, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        c.telefono, c.nombre, c.ultima_visita,
        p.pedidos_total, p.ticket_promedio, p.total_gastado,
        p.ultimo_pedido_hace_dias, p.dia_favorito, p.hora_favorita,
        p.modalidad_favorita, p.pago_favorito, p.productos_favoritos,
        p.segmento, p.score_abandono, p.dias_entre_compras_prom
      FROM clientes c
      LEFT JOIN perfiles_clientes p ON p.telefono = c.telefono
      WHERE c.telefono != '—'
        AND NOT COALESCE(c.es_interno, FALSE)
      ORDER BY COALESCE(p.total_gastado, 0) DESC
      LIMIT 500
    `);
    res.json(rows);
  } catch (e) {
    console.error('[clientes]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Marcar/desmarcar cliente como interno (excluye de lista, stats y campañas)
app.patch('/api/admin/clientes/:telefono/interno', requireAdminSeguro, async (req, res) => {
  try {
    const { es_interno } = req.body;
    await toggleClienteInterno(req.params.telefono, !!es_interno);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Resumen de segmentos para el tab Clientes
app.get('/api/admin/clientes/segmentos', requireAdminSeguro, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT segmento, COUNT(*) AS total
      FROM perfiles_clientes
      GROUP BY segmento
      ORDER BY total DESC
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Oportunidades pendientes (conversaciones con intención sin pedido)
app.get('/api/admin/clientes/oportunidades', requireAdminSeguro, async (req, res) => {
  try {
    const rows = await obtenerOportunidadesPendientes();
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Métricas de conversión: chats totales vs pedidos
app.get('/api/admin/clientes/conversion', requireAdminSeguro, async (req, res) => {
  try {
    const { rows: [conv] } = await pool.query(`
      SELECT
        COUNT(DISTINCT sesion_id) FILTER (WHERE tipo_evento = 'mensaje_recibido') AS chats_unicos,
        COUNT(DISTINCT sesion_id) FILTER (WHERE tipo_evento = 'pedido_confirmado') AS chats_con_pedido,
        COUNT(*) FILTER (WHERE tipo_evento = 'menu_solicitado') AS menus_enviados,
        COUNT(*) FILTER (WHERE tipo_evento = 'pedido_iniciado') AS pedidos_iniciados,
        COUNT(*) FILTER (WHERE tipo_evento = 'pedido_confirmado') AS pedidos_confirmados
      FROM eventos
      WHERE ocurrido_at > NOW() - INTERVAL '30 days'
    `);
    const chats = parseInt(conv.chats_unicos || 0);
    const conPedido = parseInt(conv.chats_con_pedido || 0);
    res.json({
      chats_unicos: chats,
      chats_con_pedido: conPedido,
      tasa_conversion: chats > 0 ? Math.round((conPedido / chats) * 100) : 0,
      menus_enviados: parseInt(conv.menus_enviados || 0),
      pedidos_iniciados: parseInt(conv.pedidos_iniciados || 0),
      pedidos_confirmados: parseInt(conv.pedidos_confirmados || 0)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Rewards ──────────────────────────────────────────────────────────────────
import {
  obtenerConfig as obtenerConfigRewards,
  actualizarConfig as actualizarConfigRewards,
  obtenerResumenRewards,
  buscarClientesRewards,
  listarClientesRewards,
  obtenerPerfilRewards,
  obtenerMovimientosCliente,
  obtenerMovimientosRecientes,
  obtenerOCrearCuenta,
  obtenerCuentaPorTelefono,
  calcularPuntos,
  calcularBloquesDisponibles,
  registrarCanje,
  revertirMovimientosFolio,
  ajustarPuntosManual,
} from './services/rewardsService.js';

const REWARDS_TENANT = 'xabor-principal';

// Configuración del programa
app.get('/api/rewards/config', requireAdminSeguro, async (req, res) => {
  try {
    const config = await obtenerConfigRewards(REWARDS_TENANT);
    res.json(config);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/rewards/config', requireAdminSeguro, async (req, res) => {
  try {
    await actualizarConfigRewards(REWARDS_TENANT, req.body);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Resumen estadístico
app.get('/api/rewards/resumen', requireAdminSeguro, async (req, res) => {
  try {
    const resumen = await obtenerResumenRewards(REWARDS_TENANT);
    res.json(resumen);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Lista de clientes inscritos
app.get('/api/rewards/clientes', requireAdminSeguro, async (req, res) => {
  try {
    const lista = await listarClientesRewards(REWARDS_TENANT);
    res.json(lista);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Búsqueda de clientes (admin y staff — para asignar en POS)
app.get('/api/rewards/clientes/buscar', requireAuthSeguro, async (req, res) => {
  const { q = '' } = req.query;
  if (!q.trim()) return res.json([]);
  try {
    const lista = await buscarClientesRewards(q, REWARDS_TENANT);
    res.json(lista);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Perfil de un cliente + estimación de puntos
app.get('/api/rewards/cliente/:telefono', requireAuthSeguro, async (req, res) => {
  try {
    const perfil = await obtenerPerfilRewards(req.params.telefono, REWARDS_TENANT);
    if (!perfil) return res.status(404).json({ error: 'No encontrado' });
    // Calcular estimación de puntos según total query param
    const total = parseFloat(req.query.total) || 0;
    if (total > 0) {
      const config = await obtenerConfigRewards(REWARDS_TENANT);
      perfil.puntos_estimados = calcularPuntos(total, config);
    }
    res.json(perfil);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Movimientos de un cliente
app.get('/api/rewards/cliente/:telefono/movimientos', requireAdminSeguro, async (req, res) => {
  try {
    const perfil = await obtenerPerfilRewards(req.params.telefono, REWARDS_TENANT);
    if (!perfil?.account_id) return res.json([]);
    const movimientos = await obtenerMovimientosCliente(perfil.account_id);
    res.json(movimientos);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Movimientos recientes globales
app.get('/api/rewards/movimientos', requireAdminSeguro, async (req, res) => {
  try {
    const movimientos = await obtenerMovimientosRecientes(REWARDS_TENANT);
    res.json(movimientos);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Crear o recuperar cliente para Rewards (staff + admin)
// Si el cliente no existe en `clientes`, lo crea primero.
app.post('/api/rewards/cliente', requireAuthSeguro, async (req, res) => {
  const { telefono, nombre } = req.body;
  if (!telefono?.trim() || !nombre?.trim()) {
    return res.status(400).json({ error: 'Nombre y teléfono requeridos' });
  }
  const tel = telefono.trim().replace(/\D/g, '').slice(-10);
  if (tel.length < 7) return res.status(400).json({ error: 'Teléfono inválido' });
  try {
    // Upsert en tabla clientes (reutiliza existente si ya existe)
    await pool.query(
      `INSERT INTO clientes (telefono, nombre, ultima_visita)
       VALUES ($1, $2, NOW())
       ON CONFLICT (telefono) DO UPDATE SET
         nombre = COALESCE(NULLIF($2, ''), clientes.nombre),
         ultima_visita = NOW()`,
      [tel, nombre.trim()]
    );
    const cuenta = await obtenerOCrearCuenta(tel, REWARDS_TENANT);
    const perfil = await obtenerPerfilRewards(tel, REWARDS_TENANT);
    res.json({ ok: true, perfil });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Consultar bloques de canje disponibles para un cliente en POS
app.get('/api/rewards/cliente/:telefono/canje-disponible', requireAuthSeguro, async (req, res) => {
  const { telefono } = req.params;
  const { total } = req.query;
  try {
    const [cuenta, config] = await Promise.all([
      obtenerCuentaPorTelefono(telefono, REWARDS_TENANT),
      obtenerConfigRewards(REWARDS_TENANT)
    ]);
    if (!cuenta || !config) return res.json({ puntos_balance: 0, bloques: 0, puntos: 0, valor: 0 });
    const totalVenta = parseFloat(total) || 0;
    const result = calcularBloquesDisponibles(cuenta.puntos_balance, totalVenta, config);
    res.json({ puntos_balance: cuenta.puntos_balance, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Ajuste manual de puntos — solo admin
app.post('/api/rewards/cliente/:telefono/ajustar', requireAdminSeguro, async (req, res) => {
  const { telefono } = req.params;
  const { puntos, tipo, motivo } = req.body;
  try {
    const usuario = req.user || 'admin';
    const result = await ajustarPuntosManual(telefono, puntos, tipo, motivo, usuario, REWARDS_TENANT);
    res.json({ ok: true, ...result });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ─── Campañas WA ──────────────────────────────────────────────────────────────

// Preview: cuántos destinatarios tiene un segmento
app.get('/api/admin/campanas/preview', requireAdminSeguro, async (req, res) => {
  const { segmento = 'todos' } = req.query;
  try {
    const destinatarios = await obtenerDestinatariosCampana(segmento);
    res.json({ total: destinatarios.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Historial de campañas
app.get('/api/admin/campanas', requireAdminSeguro, async (req, res) => {
  try {
    res.json(await obtenerCampanas(req.negocioId));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Crear y enviar campaña (background — responde inmediato)
// NOTA: la campaña (quién la creó) queda aislada por negocio_id, pero la
// SELECCIÓN de destinatarios (obtenerDestinatariosCampana) todavía consulta
// clientes/rewards sin filtrar por negocio — ver auditoría Fase 4. Con un
// solo negocio real hoy esto no tiene efecto observable, pero es un riesgo
// de fuga documentado, no resuelto.
app.post('/api/admin/campanas', requireAdminSeguro, async (req, res) => {
  const { nombre, segmento = 'todos', mensaje } = req.body;
  if (!nombre || !mensaje) return res.status(400).json({ error: 'nombre y mensaje requeridos' });

  try {
    const destinatarios = await obtenerDestinatariosCampana(segmento);
    if (destinatarios.length === 0) return res.status(400).json({ error: 'Sin destinatarios para ese segmento' });

    const campanaId = await crearCampana({ nombre, segmento, mensaje, totalDestinatarios: destinatarios.length, negocioId: req.negocioId });
    res.json({ ok: true, campanaId, total: destinatarios.length });

    // Envío en background (1 msg/seg para no saturar la API de Meta)
    setImmediate(async () => {
      for (const { telefono, nombre: nomCliente } of destinatarios) {
        const primerNombre = nomCliente?.split(' ')[0] || '';
        const msgPersonalizado = primerNombre
          ? mensaje.replace(/\{nombre\}/gi, primerNombre)
          : mensaje.replace(/,?\s*\{nombre\}/gi, '');
        let ok = false;
        try {
          await enviarMensaje(telefono, msgPersonalizado);
          ok = true;
        } catch (e) {
          console.error(`[Campaña ${campanaId}] Error enviando a ${telefono}:`, e.message);
        }
        await registrarEnvioCampana(campanaId, telefono, nomCliente, ok);
        await new Promise(r => setTimeout(r, 1000)); // 1 msg/seg
      }
      await completarCampana(campanaId);
      console.log(`[Campaña ${campanaId}] Completada — ${destinatarios.length} destinatarios`);
    });
  } catch (e) {
    console.error('[Campañas] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/rappi/menu-status', requireAdminSeguro, async (req, res) => {
  try {
    const result = await consultarAprobacionMenu();
    res.json({ ok: true, result });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/rappi/subir-menu', requireAdminSeguro, async (req, res) => {
  try {
    const catalogo = construirCatalogoRappi();
    const result = await subirCatalogo(catalogo);
    console.log('[Rappi] Menú subido manualmente:', JSON.stringify(result).slice(0, 200));
    res.json({ ok: true, result });
  } catch(e) {
    console.error('[Rappi] Error subiendo menú:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/test/pedido', requireAdminSeguro, (req, res) => {
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

      // negocioId viene del propio pedido (ya resuelto cuando se creó vía
      // WhatsApp/Voz, con el mismo respaldo temporal que usan sus pedidos
      // regulares -- ver registrarPedido en orderManager.js), nunca
      // inventado aquí. Fail closed: si falta o es inválido, se salta esta
      // fila por completo -- no se persiste, no se agrega a memoria, no se
      // emite (ni por broadcastNegocio ni por broadcast() global), y NO se
      // marca activado, para que quede pendiente y se pueda corregir el
      // dato y reintentar en la siguiente corrida del job (5 min después).
      // Nunca se usa Nonna Maye ni ningún otro negocio por defecto. El log
      // solo incluye el folio (identificador interno) -- nunca nombre,
      // teléfono, dirección, items ni el payload completo.
      if (typeof pedido.negocioId !== 'string' || !pedido.negocioId.trim()) {
        console.error(`[Scheduler] Pedido programado ${row.folio} sin negocioId válido — no se activa (queda pendiente para corregir y reintentar)`);
        continue;
      }

      // Persistir en DB (reinsertar en pedidos_activos) y agregar a memoria
      const { guardarPedidoActivo } = await import('./services/database.js');
      const { agregarPedidoAMemoria } = await import('./orders/orderManager.js');
      await guardarPedidoActivo(pedido);
      agregarPedidoAMemoria(pedido); // ← sin esto, el panel pierde el pedido al recargar
      // Aislado por negocio (mismo patrón que emitirPedido en
      // orderManager.js) + compatibilidad temporal con print-agent legacy.
      // Ya no se usa broadcast() global para este evento.
      broadcastNegocio(pedido.negocioId, { tipo: 'nuevo_pedido', pedido });
      broadcastPrintAgentLegacy({ tipo: 'nuevo_pedido', pedido });
      await marcarPedidoProgramadoActivado(row.folio);
      console.log(`[Scheduler] Pedido ${row.folio} activado`);
    }
  } catch (e) {
    console.error('[Scheduler] Error activando pedidos programados:', e.message);
  }
}

// Endpoint para que el panel liste los pedidos programados pendientes
app.get('/api/pedidos-programados', requireAuthSeguro, async (req, res) => {
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
app.get('/api/llamadas', requireAuthSeguro, async (req, res) => {
  const lista = await obtenerLlamadasRecientes(30);
  res.json(lista);
});

app.get('/api/llamadas/:callSid', requireAuthSeguro, async (req, res) => {
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

// ⚠ LEGADO — job sin contexto de request: no hay req.negocioId disponible.
// Reutiliza el mismo mecanismo de negocio-por-defecto ya usado por el
// middleware legado resolverNegocio (resolverNegocioActualPorDefecto,
// cacheado a 'nonna-maye') — no se inventa un fallback nuevo. Este reporte
// de WhatsApp es de un solo negocio por diseño (WHATSAPP_ADMIN_NUMERO es un
// único número); PENDIENTE DE ELIMINAR/rediseñar si se necesita el reporte
// diario para más de un negocio.
async function enviarReporteDiario() {
  if (!WHATSAPP_ADMIN_NUMERO) return;
  const ahora = new Date().toISOString();
  const inicio = inicioDelDiaTexto(ahora);
  const negocioIdReporte = await resolverNegocioActualPorDefecto();
  const [ventas, resumen, fondoReg] = await Promise.all([
    obtenerVentas(inicio, ahora, negocioIdReporte),
    obtenerResumenVentas(inicio, ahora, negocioIdReporte),
    obtenerFondoCaja(fechaHoyMX(), negocioIdReporte)
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
  if (now === '02:00') jobDiarioSAT(); // Sync SAT diaria a las 2am CST
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
// ⚠ broadcast() legado a propósito: job programado sin request/sesión, sin
// req.negocioId — misma razón que /webhook/clip arriba.
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

// ─── Seguimiento WA a oportunidades abandonadas ──────────────────────────────
async function enviarSeguimientoOportunidades() {
  const tz = 'America/Matamoros';
  try {
    // Teléfonos de repartidores registrados — excluirlos siempre
    const { rows: reps } = await pool.query(`SELECT telefono FROM repartidores WHERE telefono IS NOT NULL`);
    const telefonosRep = new Set(reps.map(r => r.telefono));

    // Oportunidades pendientes sin seguimiento, creadas el día anterior,
    // y en la misma hora local que tuvieron actividad (ventana de ±30 min)
    const { rows: pendientes } = await pool.query(`
      SELECT
        o.id, o.telefono, o.intents_detectados, o.ultima_actividad_at,
        c.nombre,
        EXTRACT(HOUR FROM o.ultima_actividad_at AT TIME ZONE 'UTC' AT TIME ZONE $1) AS hora_original,
        EXTRACT(HOUR FROM NOW() AT TIME ZONE $1) AS hora_actual
      FROM oportunidades o
      LEFT JOIN clientes c ON c.telefono = o.telefono
      WHERE o.estado = 'pendiente'
        AND o.seguimiento_count = 0
        AND o.telefono IS NOT NULL
        AND o.telefono NOT LIKE 'rappi-%'
        -- Que sea al menos del día anterior (no del mismo día)
        AND (o.ultima_actividad_at AT TIME ZONE 'UTC' AT TIME ZONE $1)::date < (NOW() AT TIME ZONE $1)::date
        -- Misma hora que cuando preguntaron (ventana ±1 hora)
        AND ABS(
          EXTRACT(HOUR FROM NOW() AT TIME ZONE $1) -
          EXTRACT(HOUR FROM o.ultima_actividad_at AT TIME ZONE 'UTC' AT TIME ZONE $1)
        ) <= 1
    `, [tz]);

    for (const op of pendientes) {
      // Excluir repartidores
      if (telefonosRep.has(op.telefono)) continue;

      const nombre = op.nombre?.split(' ')[0] || 'cliente';
      let msg;

      if (op.intents_detectados?.includes('pedido_iniciado')) {
        msg = `Hola ${nombre} 👋 Ayer quedaste a punto de hacer tu pedido. ¿Quieres que te ayudemos ahora? 🌮`;
      } else if (op.intents_detectados?.includes('precio_consultado') || op.intents_detectados?.includes('menu_solicitado')) {
        msg = `Hola ${nombre} 😊 Ayer preguntaste sobre nuestro menú. ¿Hay algo en lo que te podamos ayudar hoy? 🌮`;
      } else {
        continue; // sin intent relevante
      }

      try {
        await enviarMensaje(op.telefono, msg);
        await pool.query(
          `UPDATE oportunidades SET seguimiento_enviado_at = NOW(), seguimiento_count = 1
           WHERE id = $1`,
          [op.id]
        );
        console.log(`[Memory] Seguimiento WA enviado a ${op.telefono} (op #${op.id})`);
      } catch (e) {
        console.error(`[Memory] Error enviando seguimiento a ${op.telefono}:`, e.message);
      }
    }
  } catch (e) {
    console.error('[Memory] Error en enviarSeguimientoOportunidades:', e.message);
  }
}

// ─── Inicio ──────────────────────────────────────────────────────────────────
initDB()
  .then(() => resolverNegocioActualPorDefecto())
  .then((negocioId) => seedMenuDesdeJSON(menuJSON, negocioId))
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
    // Memory Engine: detectar conversaciones abandonadas cada 10 minutos y enviar seguimiento
    setInterval(async () => {
      await detectarConversacionesAbandonadas(30);
      await enviarSeguimientoOportunidades();
    }, 10 * 60 * 1000);
    // Memory Engine: enriquecer perfiles de clientes cada 2 horas
    setTimeout(() => {
      enriquecerTodosLosPerfiles(); // primer cálculo inicial (con delay para no sobrecargar arranque)
      setInterval(enriquecerTodosLosPerfiles, 2 * 60 * 60 * 1000);
    }, 30 * 1000);
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
