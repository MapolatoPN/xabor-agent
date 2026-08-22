import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHmac, createHash, timingSafeEqual, randomUUID } from 'crypto';

import { procesarMensaje, simularMensaje } from './agent/brain.js';
import { validarEstructuraReglas } from './agent/prompts.js';
import {
  registrarPedido,
  emitirPedido,
  actualizarEstadoPedido,
  actualizarEstadoPedidoLegacySinNegocio,
  eliminarPedido,
  obtenerPedidos,
  obtenerPedidoPorId,
  setWsBroadcast,
  setWsBroadcastSuperadmin,
  cargarPedidosDesdeDB,
  confirmarPedidoPendientePago,
  reconciliarEmisionesPendientes,
  convertirPedidoAProgramado,
  reconciliarEmisionesOperacionalesPendientes
} from './orders/orderManager.js';
import { deleteSession } from './agent/session.js';
import { setBroadcastsImpresion, emitirTrabajoImpresion } from './printing/printRouter.js';
import { getPaymentStatus as getPaymentStatusClip } from './services/providers/clipProvider.js';
import { procesarWebhookPago, reconciliarPagosMercadoPago,
         derivarPedidoPorPagoAsentado, reconciliarDerivacionesPendientes,
         verificarYAsentarClip, reconciliarCandidatosClip,
         expirarPagosVencidos, procesarExpiracionProveedorClip,
         reconciliarLegacyClip, marcarEnvejecidosSinTerminalClip } from './services/webhookPagos.js';
import { setEntregaEdge } from './printing/edgeComanda.js';
import {
  listarEdges, crearEdge, generarEmparejamiento, canjearEmparejamiento, revocarCredencial,
} from './services/edgeService.js';
import {
  listarImpresoras, crearImpresora, actualizarImpresora,
  listarRutas, crearRuta, eliminarRuta,
  crearTrabajosDeComanda, crearTrabajosDeDocumento, crearTrabajoDePrueba, reimprimirTrabajo,
  trabajosPendientesDeTerminal, cursorDeTrabajo, marcarEntregado, registrarAckDeTerminal,
  registrarInstalacion,
  estadoImpresion, listarTrabajos,
} from './services/impresionService.js';
import { estadoImpresorasNegocio, asignarImpresora, desactivarImpresora, registrarImpresoraParaPrueba, quitarImpresora } from './services/impresionSelfService.js';
import { pool, initDB, obtenerConversacion, obtenerConversacionesRecientes, obtenerPertenenciaConversacion, guardarMensaje, obtenerVentas, obtenerResumenVentas, obtenerPedidosEntregados, setBotPausado, getBotPausado, confirmarPagoPedido, obtenerPedidosPorActivar, marcarPedidoProgramadoActivado, obtenerPedidosProgramadosPendientes, obtenerLlamadasRecientes, obtenerTranscripcionPorLlamada, obtenerPagosPendientesConLink, guardarFondoCaja, obtenerFondoCaja, seedMenuDesdeJSON, obtenerMenuCompleto, crearCategoria, actualizarCategoria, eliminarCategoria, crearProducto, actualizarProducto, eliminarProducto, duplicarProducto, obtenerModificadoresProducto, crearGrupoModificador, actualizarGrupoModificador, eliminarGrupoModificador, crearOpcionModificador, actualizarOpcionModificador, eliminarOpcionModificador, guardarSuscripcionPush, obtenerSuscripcionesPush, eliminarSuscripcionPush, actualizarFormaPago, obtenerConfiguracion, actualizarConfiguracion, obtenerNegocioIdPorSlug, negocioEstaActivo, moduloHabilitado, obtenerEstadoModulo, obtenerModulosHabilitados, obtenerCredencialesWhatsappNegocio, obtenerMembresiaUsuarioNegocio, obtenerNegociosDeUsuario, normalizarEmail, crearSolicitudResetPassword, validarTokenReset, restablecerPasswordConToken, obtenerUsuarioPorId, obtenerUsuarioPorEmail, crearUsuarioConPassword, crearMeseroConPin, listarMeserosDelNegocio, listarMeserosEstacion, meseroVigente, verificarPinMesero, esMiembroActivoDelNegocio, obtenerUsuariosDeNegocio, obtenerMembresiaCualquierEstado, actualizarEstadoMembresia, cancelarPedidoActivo, registrarDevolucion, obtenerEntregasRepartidor, marcarEstadoEntrega, marcarEntregadoRepartidor, registrarIncidenciaEntrega, TIPOS_INCIDENCIA, obtenerNombreNegocio, crearCampana, registrarEnvioCampana, completarCampana, obtenerCampanas, obtenerDestinatariosCampana, toggleClienteInterno, obtenerDiagnosticoNegocio, obtenerPlanComercial, actualizarPlanComercial, crearProspectoComercial, marcarCorreoProspectoEnviado, obtenerProspectosComerciales, obtenerProspectoComercialPorId, actualizarProspectoComercial, obtenerPagoPorReferenciaInterna, obtenerPagoClipPorId, obtenerPagoClipPorCheckoutId, asentarPagoRealVerificado, obtenerPagoVigentePorFolioClip, existePagoDeLedgerClip, pagosReconciliablesDeProveedor, marcarAnomaliaPago, registrarCandidatoCheckoutClip, listarPagosPorPedido, listarMetodosPagoNegocio, guardarMetodoPagoNegocio, obtenerMetodosPagoDisponibles, invalidarPagosVigentesDePedido, confirmarPagoManual, rechazarPagoManual, obtenerPertenenciaDocumento, obtenerDocumento, marcarDocumentoListo, marcarDocumentoError, eliminarDocumentoRegistro, obtenerPertenenciaCotizacion, obtenerCotizacion, listarCotizaciones, crearCotizacion, actualizarCotizacion, crearDocumentoSaliente, resolverNegocioLegacyUnico, reclamarTrabajosLegacyPendientes, devolverTrabajoLegacyAPendiente } from './services/database.js';
import { listarProveedores, esProveedorValido } from './services/paymentProviders.js';
import { guardarIntegracionPago, listarIntegracionesPago, suspenderIntegracionPago, reactivarIntegracionPago, eliminarCredencialesPago, marcarProveedorPrincipal, probarIntegracionPago, obtenerProveedorPrincipal } from './services/integracionesService.js';
import { crearEnlacePago, SinProveedorPrincipalError, PedidoInvalidoError } from './services/pagosService.js';
import { recalcularItemsDesdeMenu, construirOrdenPOS, POSValidacionError, recordarIdempotencia, reservarIdempotencia } from './services/posEnvios.js';
import { resolverProductoConModificadores, ModificadoresError } from './services/modificadores.js';
import { guardarArchivo, leerArchivo, obtenerUrlDescarga, eliminarArchivo, driverEsLocal } from './services/almacenamiento.js';
import { validarPdfReal, sanitizarNombreArchivo, procesarDocumentoSaliente } from './services/documentos.js';
import { procesarImagenSaliente, crearRegistroImagenSaliente, MAX_IMAGENES_POR_ENVIO } from './services/imagenes.js';
import { obtenerMenuNegocio, guardarConfigMenu, guardarImagenMenu, eliminarImagenMenu, eliminarImagenMenuPagina, reordenarImagenesMenu, leerImagenMenu, tamanoMaximoBytes as menuTamanoMaximoBytes } from './services/menuAutomatico.js';
import { obtenerOGenerarPdfCotizacion, marcarCotizacionEnviada } from './services/cotizaciones.js';
import { obtenerSesionPorCotizacion, finalizarSesion } from './services/sesionComercial.js';
import { crearTokenSesion, verificarTokenSesion, crearTokenPreAuth, verificarTokenPreAuth, revocarTokenSesion } from './services/session.js';
import {
  esSuperadmin, obtenerDashboardSuperadmin, obtenerNegociosParaSuperadmin, obtenerNegocioDetalleSuperadmin,
  crearNegocioCompleto, actualizarEstadoNegocioSuperadmin, actualizarPlanNegocioSuperadmin,
  actualizarModulosNegocioSuperadmin, actualizarChecklistNegocioSuperadmin, obtenerAuditoriaPlataforma,
  reenviarInvitacion, validarInvitacion, crearPasswordDesdeInvitacion, registrarAuditoriaPlataforma,
  obtenerBotWhatsappActivoNegocio, actualizarBotWhatsappActivoNegocio, obtenerChecklistActivacionBot,
  actualizarDatosNegocioSuperadmin, actualizarAdminNegocioSuperadmin, obtenerInvitacionesNegocio,
  listarModulosDisponibles,
} from './services/database.js';
import {
  obtenerFichaNegocio, actualizarPasoChecklistOperativo, actualizarOnboardingEstado, actualizarImplementacion,
  listarNegociosCentral, crearSesionSoporte, sesionSoporteVigente, cerrarSesionSoporte, listarSesionesSoporte,
} from './services/centralOperaciones.js';
import {
  obtenerIntegracionNegocio, obtenerIntegracionesNegocio, guardarCredencialesCifradas, actualizarEstadoIntegracion,
  suspenderIntegracion, eliminarCredencialesIntegracion, obtenerEstadoIntegracion, completarActivacionWhatsapp,
  guardarCredencialesClip,
} from './services/integracionesService.js';
import { crearState, validarYConsumirState } from './services/embeddedSignupState.js';
import { intercambiarCodigoPorToken, GRAPH_VERSION } from './services/metaEmbeddedSignup.js';
import { registrarIntentoPendiente, cancelarIntentoPendiente, hayIntentoPendiente, validarIntentoVigente, limpiarIntentoPendiente } from './services/intentoSignupPendiente.js';
import { enviarCorreoInvitacion, enviarCorreoResetPassword, enviarNotificacionNuevoProspecto } from './services/email.js';
import { rateLimitMiddleware } from './services/rateLimit.js';
import { conIdentidadDePedido } from './services/eventosPanel.js';
import { registrarRutasTienda } from './services/tiendaRutas.js';
import { obtenerConfigRed, guardarConfigRed, evaluarSolicitudRed, obtenerCentralReparto, CAMPOS_DECLARATIVOS_RED } from './services/redRepartidores.js';
import {
  listarMesas, abrirMesa, obtenerCuenta, agregarItems, enviarComanda, cancelarItem,
  registrarPago, dividirEnPartesIguales, cerrarCuenta, moverMesa, reabrirCuenta, indicadoresRestaurante,
  revertirVentaCuenta,
} from './services/restauranteService.js';
import { verifyPassword } from './services/password.js';
import { generarFactura, enviarFacturaPorEmail, descargarFacturaPDF } from './services/facturapi.js';
import webpush from 'web-push';
import { puedeAdministrarWhatsapp, estadoWhatsappNegocio, accionesFaltantes, traducirErrorMeta } from './services/whatsappAutoservicio.js';
import whatsappRouter, { enviarMensaje, enviarDocumento, enviarImagenBuffer, setWsBroadcastWA, setWsBroadcastSuperadminWA, procesarAceptacionTokenRepartidor, consultarOfertaRepartidor } from './channels/whatsapp-meta.js'; // Meta Cloud API
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
import { registrarRepartidor, obtenerRepartidorPorToken, obtenerRepartidorPorTelefono, obtenerRepartidores, guardarPushRepartidor, obtenerPushRepartidores, asignarRepartidor, obtenerPedidosParaRepartidor, obtenerPedidosAsignadosARepartidor, obtenerCandidatosRepartidor, eliminarRepartidor, ESTADOS_REPARTIDOR_VALIDOS, cambiarEstadoRepartidor, editarPerfilRepartidor, detectarDuplicadosRepartidor, obtenerResumenRosterRepartidores, obtenerRosterRepartidores, obtenerDetalleRepartidor, obtenerServiciosReparto, obtenerDetalleServicioReparto, obtenerMetricasRedRepartidores, obtenerRankingRepartidores, filasARegistrosCSV } from './services/database.js';

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

// Mapa: clave interna → variable de entorno de respaldo.
// clip_api_key/clip_api_secret (Incidente P0) se retiraron de este mapa a
// propósito: eran la causa raíz de que Clip se resolviera con una única
// cuenta GLOBAL en vez de por negocio. clip-api.js ya no lee de aquí --
// ver integracionesService.js (canal='pagos', proveedor='clip') y la
// ruta PUT /api/superadmin/negocios/:id/integraciones/clip.
const ENV_MAP = {
  wa_token:          'WHATSAPP_TOKEN',
  wa_phone_id:       'WHATSAPP_PHONE_ID',
  wa_verify_token:   'WHATSAPP_VERIFY_TOKEN',
  wa_admin_numero:   'WHATSAPP_ADMIN_NUMERO',
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

// Sesiones emitidas ANTES de que el usuario restableciera su contraseña
// (migración 042). Las sesiones de Xabor son tokens firmados sin registro
// server-side, así que no hay una lista que borrar: se compara el `iat` del
// token con la marca que dejó el restablecimiento. La membresía ya se
// consulta en cada request, así que esto no agrega ninguna consulta.
// Cambiar la contraseña cierra las sesiones abiertas con la anterior --
// incluida la de quien haya entrado con ella.
function sesionAnteriorAlCambioDePassword(payload, membresia) {
  const marca = membresia?.sesiones_invalidas_antes;
  if (!marca) return false;
  return Number(payload?.iat || 0) < new Date(marca).getTime();
}

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

    // Sesión de SOPORTE (Central de Operaciones): un superadmin operando el
    // panel de un negocio ajeno. No hay membresía usuario↔negocio que
    // verificar (por diseño: el superadmin no pertenece al negocio) — en su
    // lugar se re-verifica en CADA request que (1) la sesión siga viva en
    // sesiones_soporte (no cerrada manualmente, no expirada — revocación
    // server-side real, no solo la expiración del HMAC) y (2) el usuario
    // siga siendo superadmin. El negocioId sale EXCLUSIVAMENTE del token
    // firmado — URL/query/body/headers no pueden cambiarlo.
    if (payload.sop === true) {
      const [vigente, esSuper] = await Promise.all([
        sesionSoporteVigente(token),
        esSuperadmin(payload.usuarioId),
      ]);
      if (!vigente || !esSuper || vigente.negocio_id !== payload.negocioId) {
        return res.status(401).json({ error: 'Sesión de soporte cerrada o expirada' });
      }
      req.usuarioId = payload.usuarioId;
      req.negocioId = payload.negocioId;
      req.rol = 'admin';
      req.esSoporte = true;
      return next();
    }

    // Verificar que el usuario de la sesión SIGUE perteneciendo al negocio
    // que la sesión indica — no basta con confiar en el token: la membresía
    // pudo revocarse después de emitido.
    const membresia = await obtenerMembresiaUsuarioNegocio(payload.usuarioId, payload.negocioId);
    if (!membresia || !membresia.activo) {
      return res.status(403).json({ error: 'El usuario ya no pertenece a este negocio' });
    }
    if (sesionAnteriorAlCambioDePassword(payload, membresia)) {
      limpiarCookieSesion(res);
      return res.status(401).json({ error: 'Tu contraseña cambió: inicia sesión de nuevo', code: 'SESION_REVOCADA' });
    }

    // Un mesero NO es una cuenta de panel: no tiene correo ni contraseña, así
    // que no puede iniciar sesión por diseño. Esta comprobación es la barrera
    // de fondo -- si alguna vez apareciera una sesión con rol 'mesero' (token
    // viejo, alta manual en base, error futuro), se rechaza aquí en vez de
    // heredar los permisos de staff. Su identidad viaja como meseroUsuarioId
    // + PIN al abrir mesa, nunca como sesión.
    if (membresia.rol === 'mesero') {
      return res.status(403).json({
        error: 'Los meseros no acceden al panel: se identifican con su PIN al abrir una mesa',
        code: 'MESERO_SIN_ACCESO_PANEL',
      });
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
      // Sesión de SOPORTE — mismo contrato que en requireSesionNegocio: sin
      // membresía (por diseño), re-validada server-side en cada request
      // contra sesiones_soporte + privilegio superadmin vivo. negocioId
      // sale solo del token firmado.
      if (payload.sop === true) {
        const [vigente, esSuper] = await Promise.all([
          sesionSoporteVigente(tokenSesionNueva),
          esSuperadmin(payload.usuarioId),
        ]);
        if (!vigente || !esSuper || vigente.negocio_id !== payload.negocioId) {
          return res.status(401).json({ error: 'Sesión de soporte cerrada o expirada' });
        }
        const negocioDefaultId = await resolverNegocioActualPorDefecto();
        req.usuarioId = payload.usuarioId;
        req.negocioId = payload.negocioId;
        req.rol = 'admin';
        req.esSoporte = true;
        req.esNegocioPorDefecto = payload.negocioId === negocioDefaultId;
        req.sesionNueva = true;
        return next();
      }
      const membresia = await obtenerMembresiaUsuarioNegocio(payload.usuarioId, payload.negocioId);
      if (!membresia || !membresia.activo) {
        return res.status(403).json({ error: 'El usuario ya no pertenece a este negocio' });
      }
      if (sesionAnteriorAlCambioDePassword(payload, membresia)) {
        limpiarCookieSesion(res);
        return res.status(401).json({ error: 'Tu contraseña cambió: inicia sesión de nuevo', code: 'SESION_REVOCADA' });
      }
      // Mismo candado que en requireSesionNegocio: el rol 'mesero' nunca
      // navega el panel. Su identidad viaja como meseroUsuarioId + PIN.
      if (membresia.rol === 'mesero') {
        return res.status(403).json({
          error: 'Los meseros no acceden al panel: se identifican con su PIN al abrir una mesa',
          code: 'MESERO_SIN_ACCESO_PANEL',
        });
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
// ESTACIÓN DE MESEROS — acceso operativo por PIN
//
// Flujo separado a propósito del login administrativo: /api/auth/negocio/login
// sigue siendo correo + contraseña y un mesero (sin correo) NO puede entrar
// por ahí. Aquí la identidad es (negocio por slug) + mesero + PIN, y la sesión
// que se emite lleva `est: true`: solo abre la operación de Restaurante.
//
// El negocio SIEMPRE viene del slug de la URL: sin él no hay autenticación
// posible. Dos negocios pueden tener un "Juan" con PIN 1234 y ambos son
// válidos; sin acotar por negocio, un PIN suelto no identifica a nadie.
//
// Decisión sobre enumerar nombres: el selector (/opciones) devuelve los
// nombres de pila de los meseros activos de ESE negocio, sin correos ni
// hashes. Es el mismo dato que cualquiera ve escrito en el gafete dentro del
// local, la lista no revela cuántos empleados administrativos hay ni sus
// identidades, y evita que el mesero teclee su nombre exacto en una tablet
// compartida. Si algún negocio prefiere no publicarla, el login acepta
// igualmente el id sin haber pedido /opciones.
const LIMITE_PIN_INTENTOS = 10;         // por IP+negocio
const VENTANA_PIN_MS = 5 * 60 * 1000;   // 5 minutos

// Puerta ÚNICA por la que entra una sesión de estación. Las rutas del panel
// siguen rechazando el rol 'mesero' (ver resolverNegocioSeguro y
// requireSesionNegocio): un mesero solo existe para la operación de mesas.
// En cada request se relee el estado real del mesero y del módulo, así que
// desactivarlo o apagar Restaurante corta la sesión abierta al instante.
function requireOperacionRestaurante(req, res, next) {
  const token = leerCookieSesion(req);
  const payload = token ? verificarTokenSesion(token) : null;
  if (!payload || payload.est !== true) {
    // No es una sesión de estación: se atiende con el flujo normal del panel.
    return requireAuthSeguro(req, res, next);
  }
  (async () => {
    const mesero = await meseroVigente(payload.usuarioId, payload.negocioId);
    if (!mesero) {
      limpiarCookieSesion(res);
      return res.status(403).json({ error: 'Tu acceso de mesero ya no está activo', code: 'MESERO_NO_VIGENTE' });
    }
    if (!(await negocioEstaActivo(payload.negocioId)) || (await obtenerEstadoModulo(payload.negocioId, 'restaurante')) !== 'activo') {
      return res.status(403).json({ error: 'Restaurante no disponible', code: 'RESTAURANTE_NO_DISPONIBLE' });
    }
    req.usuarioId = mesero.id;
    req.negocioId = payload.negocioId;
    req.rol = 'mesero';
    req.esMesero = true;
    // Nombre vigente del mesero (releído en cada request, igual que el resto
    // del estado): la estación lo muestra en la barra para que la tablet
    // compartida deje claro quién está trabajando.
    req.meseroNombre = mesero.nombre;
    req.sesionNueva = true;
    next();
  })().catch((e) => {
    console.error('[Estacion] Error validando sesión de mesero:', e.message);
    res.status(500).json({ error: 'Error de sesión' });
  });
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

// negocioId OBLIGATORIO — falla cerrado (Auditoría P0 complementaria,
// push). Reemplaza a enviarPushATodos: nunca envía a nadie sin negocioId
// válido, nunca consulta suscripciones fuera del negocio indicado, y
// valida que el negocio siga activo justo antes de enviar (un negocio
// puede suspenderse después de que ya existan suscripciones guardadas).
async function enviarPushANegocio(negocioId, titulo, cuerpo, data = {}) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    console.warn('[Push] enviarPushANegocio: negocioId inválido u omitido — no se envía a nadie (fail closed)');
    return;
  }
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) { console.log('[Push] VAPID no configurado — omitiendo'); return; }
  if (!(await negocioEstaActivo(negocioId))) {
    console.log(`[Push] Negocio ${negocioId} inactivo/suspendido — envío omitido`);
    return;
  }
  let subs;
  try { subs = await obtenerSuscripcionesPush(negocioId); } catch (e) { console.error('[Push] Error leyendo suscripciones:', e.message); return; }
  console.log(`[Push] Enviando "${titulo}" a ${subs.length} suscripción(es) del negocio`);
  const payload = JSON.stringify({ titulo, cuerpo, data });
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { auth: sub.auth, p256dh: sub.p256dh } },
        payload
      );
    } catch (e) {
      if (e.statusCode === 410 || e.statusCode === 404) {
        // Suscripción expirada — limpiar (mismo negocio, nunca ajeno)
        await eliminarSuscripcionPush(sub.endpoint, negocioId).catch(() => {});
      } else {
        console.error('[Push] Error enviando notificación:', e.message);
      }
    }
  }
}

// negocioId OBLIGATORIO — mismo criterio que enviarPushANegocio. Sigue
// sin tener llamador real (ver comentario más abajo), se corrige de todos
// modos para que, si algún día se conecta, ya nazca aislada por negocio.
async function enviarPushARepartidores(negocioId, titulo, cuerpo, data = {}) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    console.warn('[Push Repartidor] negocioId inválido u omitido — no se envía a nadie (fail closed)');
    return;
  }
  const vapidPub = getIntegracion('vapid_public_key') || VAPID_PUBLIC;
  const vapidPri = getIntegracion('vapid_private_key') || VAPID_PRIVATE;
  const vapidEmail = getIntegracion('vapid_email') || VAPID_EMAIL;
  if (!vapidPub || !vapidPri) return;
  if (!(await negocioEstaActivo(negocioId))) return;
  try { webpush.setVapidDetails(vapidEmail, vapidPub, vapidPri); } catch {}
  const subs = await obtenerPushRepartidores(negocioId);
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
// Railway pone la app detrás de un único proxy inverso -- sin esto, req.ip
// devuelve la IP interna del proxy para todas las requests (colapsa el rate
// limit por IP de las rutas de invitación en uno solo compartido por todos
// los usuarios, en vez de uno por cliente real).
app.set('trust proxy', 1);
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
  // Misma revocación que en las rutas HTTP: una contraseña restablecida
  // cierra también los WebSocket abiertos con la sesión anterior.
  if (sesionAnteriorAlCambioDePassword(payload, membresia)) return rechazar(401, 'Unauthorized');

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

// ═══════════════════════════════════════════════════════════════════════════
// ✅ NUEVO (Fase C, Red de Repartidores) — autenticación del handshake
// WebSocket de Superadmin (/ws/superadmin). Mismo patrón que
// autenticarUpgradePanel: nunca confía en nada que el cliente envíe, todo
// se deriva de la cookie de sesión httpOnly ya firmada. A diferencia del
// panel, NO exige negocioId de la sesión coincidente con nada -- el
// privilegio de Superadmin es cross-negocio por diseño (mismo criterio que
// requireSuperadmin, HTTP). Rechaza antes de completar el upgrade.
async function autenticarUpgradeSuperadmin(req, socket, head) {
  function rechazar(status, motivo) {
    socket.write(`HTTP/1.1 ${status} ${motivo}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  }

  const token = leerCookieSesion(req);
  if (!token) return rechazar(401, 'Unauthorized');

  const payload = verificarTokenSesion(token);
  if (!payload || !payload.usuarioId) return rechazar(401, 'Unauthorized');

  const esSuper = await esSuperadmin(payload.usuarioId);
  if (!esSuper) return rechazar(403, 'Forbidden');

  const contextoWS = {
    tipo: 'superadmin',
    usuarioId: payload.usuarioId,
    negocioId: null, // cross-negocio a propósito -- ver comentario arriba
    rol: 'superadmin',
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

  if (pathname === '/ws/superadmin') {
    autenticarUpgradeSuperadmin(req, socket, head);
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

  // LEGADO — la raíz "/", usada por el print-agent anterior a la ruta
  // autenticada. Ese binario está instalado en la máquina del negocio y no
  // manda ninguna identidad: ni credencial, ni cabecera, ni query. No se le
  // puede pedir sin cambiarlo, y no se puede cambiar desde aquí.
  //
  // Así que la identidad la determina el SERVIDOR, y solo si es inequívoca: el
  // ÚNICO negocio en modo legacy. Cero negocios o más de uno ⇒ se rechaza el
  // upgrade. La ruta se cierra sola el día que el último negocio pase a Edge.
  //
  // No ampliar esta ruta para nuevos clientes: cualquier terminal nueva va por
  // /ws/print-agent, que sí autentica.
  resolverNegocioLegacyUnico().then(({ negocioId, razon }) => {
    if (!negocioId) {
      console.error(`[WS] Conexión legado RECHAZADA (fail closed) razon=${razon}`);
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.contextoWS = { tipo: 'legacy', usuarioId: null, negocioId, rol: null, sucursalId: null, terminalId: null };
      wss.emit('connection', ws, req);
    });
  }).catch((e) => {
    // Sin poder resolver el negocio no se entrega nada: una comanda en la
    // impresora equivocada es peor que una comanda que no sale.
    console.error(`[WS] Conexión legado RECHAZADA (error resolviendo negocio): ${e.message}`);
    socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    socket.destroy();
  });
});

// negocioId OBLIGATORIO (Auditoría P0 complementaria, push) — antes
// disparaba enviarPushATodos() sin filtrar, incluso desde
// broadcastNegocio() ya aislado por negocio. Ahora: sin negocioId válido
// no se envía nada (fail closed, nunca cae a broadcast() global ni a
// Nonna Maye como relleno), y el contenido se redujo a lo genérico —
// nunca teléfono, texto del mensaje, nombre completo de cliente ni monto.
// El detalle real se consulta dentro del panel ya autenticado.
function dispararPushParaEvento(data, negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return;
  if (data.tipo === 'nuevo_pedido') {
    enviarPushANegocio(
      negocioId,
      '🛎 Nuevo pedido',
      'Tienes un nuevo pedido en Xabor',
      {}
    ).catch(() => {});
  }
  if (data.tipo === 'nuevo_mensaje' && data.mensaje?.direccion === 'entrante') {
    enviarPushANegocio(
      negocioId,
      '💬 Nuevo mensaje de WhatsApp',
      'Tienes una conversación nueva en Xabor',
      {}
    ).catch(() => {});
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
// data) para cualquier evento operativo nuevo. Nunca tiene negocioId real
// que ofrecer, así que dispararPushParaEvento simplemente no envía nada
// (fail closed) para lo que pase por aquí.
function broadcast(data) {
  const mensaje = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === 1) { // 1 = OPEN
      client.send(mensaje);
    }
  });
  dispararPushParaEvento(data, null);
}

// ✅ NUEVO (Fase 7) — broadcast seguro por negocio. Envía EXCLUSIVAMENTE a
// conexiones ws.tipo==='panel' cuyo ws.negocioId coincida exactamente —
// nunca a 'legacy' (print-agent), nunca a wssVoice, nunca a otro negocio.
// Fail closed: sin negocioId válido, no envía a nadie y NUNCA cae a
// broadcast() global. El push (dispararPushParaEvento) ahora comparte el
// mismo negocioId ya validado aquí -- ya no es global (Auditoría P0
// complementaria).
export function broadcastNegocio(negocioId, data, opciones = {}) {
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
    // opciones.soloAdmin (Fase C, Red de Repartidores): algunos eventos de
    // administración de repartidores no deben llegar a staff aunque
    // comparta la misma conexión /ws/panel que el admin de su negocio --
    // staff nunca administra la red, solo ve la comanda (badge ya
    // existente). Ningún otro tipo de evento usa esta opción todavía.
    if (opciones.soloAdmin && client.rol === 'staff') return;
    // opciones.sucursalId / opciones.terminalId: reservado para filtros
    // futuros más finos (no usado todavía — no se inventa comportamiento
    // no solicitado en esta fase).
    client.send(mensaje);
    enviados++;
  });
  dispararPushParaEvento(data, negocioIdNorm);
  return enviados;
}

// ✅ NUEVO (Fase C, Red de Repartidores) — broadcast global exclusivo para
// Superadmin. A diferencia de broadcastNegocio, NUNCA filtra por negocio a
// propósito (el privilegio de Superadmin es cross-negocio por diseño) --
// pero SÍ sigue exigiendo ws.tipo==='superadmin' (nunca 'panel', 'legacy'
// ni ninguna otra conexión). Los payloads que se envían por aquí deben ser
// siempre mínimos (folio/negocioId/repartidorId) -- nunca teléfonos,
// tokens, credenciales ni datos completos del cliente (ver cada llamador).
export function broadcastSuperadmin(data) {
  const mensaje = JSON.stringify(data);
  let enviados = 0;
  wss.clients.forEach(client => {
    if (client.readyState !== 1) return;
    if (client.tipo !== 'superadmin') return;
    client.send(mensaje);
    enviados++;
  });
  return enviados;
}

// Envío hacia el print-agent legado (conexiones ws.tipo==='legacy' en la raíz
// "/"), EXCLUSIVAMENTE para nuevo_pedido. Mantiene funcionando la impresión del
// último negocio que no ha migrado a Edge. Nunca debe usarse para mensajes,
// pagos, clientes ni eventos administrativos. No dispara push (ya lo hace
// broadcastNegocio para el mismo evento; evita duplicarlo).
//
// AISLADO POR NEGOCIO: negocioId es obligatorio y se compara contra el que el
// upgrade resolvió para esa conexión. Antes esta función mandaba a TODA
// conexión legado sin mirar de quién era el pedido -- la fuga entre negocios
// que documentaba el comentario anterior.
function broadcastPrintAgentLegacy(negocioId, data) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    console.error(`[WS] broadcastPrintAgentLegacy sin negocioId — no se envía a nadie (fail closed) [tipo=${data?.tipo}]`);
    return 0;
  }
  const negocioIdNorm = negocioId.trim();
  const mensaje = JSON.stringify(data);
  let enviados = 0;
  wss.clients.forEach(client => {
    if (client.readyState !== 1) return;
    if (client.tipo !== 'legacy') return;
    if (client.negocioId !== negocioIdNorm) return;
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
export { broadcastPrintAgentNegocio };

// ─── Xabor Edge: entrega de trabajos de impresión ───────────────────────────
//
// Envía un trabajo a la terminal (Edge) DUEÑA de la impresora, no a todas las
// del negocio: cada impresora cuelga de una terminal concreta. El filtro por
// `terminalId` es lo que impide que el Edge de un negocio reciba trabajos de
// otro, y ese id sale de la fila de la impresora, nunca del cliente.
function enviarTrabajoATerminal(terminalId, trabajo) {
  let enviados = 0;
  const mensaje = JSON.stringify({ tipo: 'trabajo_impresion', trabajo });
  wss.clients.forEach(client => {
    if (client.readyState !== 1) return;
    if (client.tipo !== 'print-agent' || !client.autenticado) return;
    if (client.terminalId !== terminalId) return;
    client.send(mensaje);
    enviados++;
  });
  // Log sin payload: lleva nombres de platillos y notas de clientes.
  console.log(`[Edge] trabajo=${trabajo.id} documento=${trabajo.documento} impresora=${trabajo.impresoraNombre} terminal=${terminalId} entregado_a=${enviados}`);
  return enviados;
}

// Da forma al trabajo tal como lo espera el Edge. host/puerto viajan como
// DATOS de configuración: quien abre el socket es el Edge dentro de la LAN,
// jamás este proceso (ver docs/xabor-edge-arquitectura.md, sección SSRF).
function trabajoParaEdge(fila) {
  return {
    id: fila.id,
    documento: fila.documento,
    impresoraId: fila.impresora_id,
    impresoraNombre: fila.impresora_nombre,
    transporte: fila.transporte || 'mock',
    host: fila.host ?? null,
    puerto: fila.puerto ?? null,
    anchoColumnas: fila.ancho_columnas ?? 42,
    // Lo específico del destino según el transporte: para windows_spooler, el
    // nombre con el que Windows conoce la impresora. Va aparte de
    // `impresoraNombre` a propósito -- ese es el nombre VISIBLE, que el dueño
    // puede renombrar en el panel, y `config.spoolerNombre` es el
    // identificador técnico con el que se abre la cola. Hoy coinciden porque
    // el self-service los crea iguales; confiar en esa coincidencia sería un
    // atajo que se rompe la primera vez que alguien renombre su impresora.
    config: fila.config ?? {},
    payload: fila.payload,
  };
}

// Entrega inmediata tras crear los trabajos. Si no hay ningún Edge conectado
// el trabajo se queda en 'pendiente' y saldrá en cuanto uno se conecte: por
// eso la comanda nunca se pierde aunque la PC del restaurante esté apagada.
async function entregarTrabajos(trabajos) {
  for (const t of trabajos) {
    if (!t.terminal_id) continue;
    let fila = t;
    if (fila.transporte === undefined) {
      const { rows } = await pool.query(
        `SELECT transporte, host, puerto, ancho_columnas, config FROM impresoras WHERE id = $1`, [t.impresora_id]);
      fila = { ...t, ...(rows[0] || {}) };
    }
    const enviados = enviarTrabajoATerminal(t.terminal_id, trabajoParaEdge(fila));
    if (enviados > 0) await marcarEntregado(t.id, t.terminal_id);
  }
}

// Tope de cordura para la recuperación al conectar. No es un límite de
// diseño: si un local acumuló más que esto sin imprimir, lo que necesita es
// que alguien mire por qué, no que le entren mil comandas viejas de golpe.
const MAX_RECUPERACION_POR_CONEXION = 500;
const LOTE_RECUPERACION = 50;

async function entregarTrabajosPendientes(ws) {
  let cursor = null;
  let enviados = 0;

  // Se pagina con cursor por (created_at, id). Hace falta porque marcar un
  // trabajo como 'entregado' NO lo saca de la consulta -- entregado sin
  // confirmar sigue siendo trabajo por resolver. Sin cursor, un lote fijo se
  // repetiría en bucle y una cola mayor que el lote dejaría trabajos
  // esperando a la siguiente reconexión, que podía no llegar en toda la noche.
  while (enviados < MAX_RECUPERACION_POR_CONEXION) {
    const lote = await trabajosPendientesDeTerminal(ws.terminalId, { limite: LOTE_RECUPERACION, desde: cursor });
    if (!lote.length) break;

    for (const fila of lote) {
      if (ws.readyState !== 1) return;
      ws.send(JSON.stringify({ tipo: 'trabajo_impresion', trabajo: trabajoParaEdge(fila) }));
      await marcarEntregado(fila.id, ws.terminalId);
      enviados++;
    }
    cursor = cursorDeTrabajo(lote[lote.length - 1]);
    if (lote.length < LOTE_RECUPERACION) break;
  }

  if (enviados) console.log(`[Edge] terminal=${ws.terminalId} recupera ${enviados} trabajo(s) sin confirmar`);
  if (enviados >= MAX_RECUPERACION_POR_CONEXION) {
    console.warn(`[Edge] terminal=${ws.terminalId} superó ${MAX_RECUPERACION_POR_CONEXION} trabajos sin confirmar: revisar por qué estuvo tanto tiempo sin imprimir`);
  }
}

// ─── Consulta de impresoras a un Edge ───────────────────────────────────────
//
// La nube NUNCA manda algo ejecutable: manda `solicitar_impresoras`, sin
// parámetros. El Edge decide cómo consultarle a Windows y responde una lista
// ya saneada. Si mañana cambiara la forma de preguntar (Get-Printer, WMI,
// otra API), no cambia ni un byte de este lado.
//
// La respuesta se empareja por `solicitudId`.
const solicitudesImpresoras = new Map();   // solicitudId -> { resolver, temporizador }
// Veinticinco segundos, MAS que los 20 del Edge (edge/impresorasWindows.js).
//
// Estaban al reves -- nube 6 s, Edge 8 s -- asi que la nube se rendia antes de
// que el equipo terminara de responder. Aunque PowerShell contestara bien en
// el segundo 7, el panel ya habia dado el listado por perdido. Quien espera la
// respuesta no puede rendirse antes que quien la produce; hay una prueba de
// contrato que lo fija.
//
// PERO: 25 s es la vida de la SOLICITUD al Edge, no lo que un request del
// panel espera. Subirlo destapó lo contrario del problema original: el panel
// se quedaba colgado 25 s cuando el equipo no contestaba. La solución no es
// elegir entre los dos males sino separar los dos tiempos -- ver
// ESPERA_INTERACTIVA_MS y la caché de abajo.
const TIMEOUT_IMPRESORAS_MS = 25000;

// Lo que un request interactivo del panel espera por la respuesta del Edge.
// Si en 6 s no llegó, el request responde { estado: 'consultando' } -- que NO
// es un error: la solicitud sigue viva por debajo hasta los 25 s, y cuando el
// resultado llegue (un PowerShell en frío puede tardar ~20 s tras un reboot)
// se guarda en caché para que el siguiente refresh del panel lo encuentre listo.
const ESPERA_INTERACTIVA_MS = 6000;

// Caché del último listado por terminal. Un minuto: las impresoras de Windows
// no cambian a mitad de una sesión de configuración, y así abrir dos veces
// Config → Impresoras no lanza dos PowerShell en el equipo del negocio.
const CACHE_IMPRESORAS_TTL_MS = 60000;
// Un resultado fallido se recuerda mucho menos: lo justo para no martillar al
// equipo con reintentos en cadena, pero dejando reintentar pronto.
const CACHE_IMPRESORAS_TTL_ERROR_MS = 8000;
const cacheImpresoras = new Map();       // terminalId -> { resultado, expira }
// Una sola solicitud viva por terminal: si tres pestañas del panel refrescan a
// la vez, el Edge recibe UNA solicitud (y Windows corre UN PowerShell), no tres.
const solicitudImpresorasEnVuelo = new Map();  // terminalId -> Promise<resultado>

// El listado cacheado deja de valer cuando el Edge se va o vuelve: una
// reconexión suele ser un reinicio del equipo, y tras un reinicio la lista
// puede haber cambiado. También se descarta la solicitud en vuelo -- estaba
// hablando con un socket que ya no existe.
function invalidarCacheImpresoras(terminalId) {
  if (!terminalId) return;
  cacheImpresoras.delete(terminalId);
  solicitudImpresorasEnVuelo.delete(terminalId);
}

function socketDeTerminal(terminalId) {
  let encontrado = null;
  wss.clients.forEach((c) => {
    if (encontrado) return;
    if (c.readyState !== 1) return;
    // Mismo predicado que enviarTrabajoATerminal: la identidad del Edge vive
    // en el socket autenticado, no en nada que venga del mensaje.
    if (c.tipo === 'print-agent' && c.autenticado && c.terminalId === terminalId) encontrado = c;
  });
  return encontrado;
}

// Lanza (o reutiliza) LA solicitud al Edge de esta terminal. Vive hasta
// TIMEOUT_IMPRESORAS_MS aunque ningún request del panel la esté esperando ya:
// su resultado -- tardío o no -- se cachea al llegar, y la entrada en vuelo se
// limpia siempre al terminar.
function solicitarImpresorasAlEdge(terminalId, ws) {
  const enVuelo = solicitudImpresorasEnVuelo.get(terminalId);
  if (enVuelo) return enVuelo;

  const promesa = new Promise((resolve) => {
    const solicitudId = randomUUID();
    const temporizador = setTimeout(() => {
      solicitudesImpresoras.delete(solicitudId);
      resolve({ ok: false, conectado: true, impresoras: [],
                error: 'El equipo no respondió a tiempo' });
    }, TIMEOUT_IMPRESORAS_MS);
    temporizador.unref?.();

    solicitudesImpresoras.set(solicitudId, {
      terminalId,
      resolver: (r) => { clearTimeout(temporizador); resolve({ conectado: true, ...r }); },
    });

    try {
      ws.send(JSON.stringify({ tipo: 'solicitar_impresoras', solicitudId }));
    } catch (e) {
      clearTimeout(temporizador);
      solicitudesImpresoras.delete(solicitudId);
      resolve({ ok: false, conectado: false, impresoras: [], error: 'No se pudo hablar con el equipo' });
    }
  }).then((resultado) => {
    // Solo cachear si esta sigue siendo LA solicitud de la terminal: si el
    // Edge se reconectó a mitad, invalidarCacheImpresoras ya la descartó y su
    // resultado describe a un socket que ya no existe.
    if (solicitudImpresorasEnVuelo.get(terminalId) === promesa) {
      solicitudImpresorasEnVuelo.delete(terminalId);
      const ttl = resultado.ok ? CACHE_IMPRESORAS_TTL_MS : CACHE_IMPRESORAS_TTL_ERROR_MS;
      cacheImpresoras.set(terminalId, { resultado, expira: Date.now() + ttl });
    }
    return resultado;
  });

  solicitudImpresorasEnVuelo.set(terminalId, promesa);
  return promesa;
}

// `terminalId` llega YA validado contra el negocio de la sesión por el
// llamador. Esta función no vuelve a decidir de quién es la terminal: su
// única responsabilidad es hablar con el socket.
//
// Contrato de respuesta -- exactamente TRES formas:
//   { ok:true,  conectado:true,  impresoras:[...] }        listado real
//   { estado:'consultando', conectado:true, ... }          aún sin respuesta; NO es error
//   { ok:false, conectado, impresoras:[], error }          fallo con motivo
async function pedirImpresorasATerminal(terminalId) {
  const cacheada = cacheImpresoras.get(terminalId);
  if (cacheada && cacheada.expira > Date.now()) return cacheada.resultado;
  if (cacheada) cacheImpresoras.delete(terminalId);

  const ws = socketDeTerminal(terminalId);
  if (!ws) {
    return { ok: false, conectado: false, impresoras: [],
             error: 'El equipo de impresión no está conectado' };
  }

  const solicitud = solicitarImpresorasAlEdge(terminalId, ws);

  // El request interactivo espera poco; la solicitud, lo que haga falta.
  let venceEspera;
  const espera = new Promise((resolve) => {
    venceEspera = setTimeout(() => resolve({ estado: 'consultando', conectado: true, impresoras: [] }),
                             ESPERA_INTERACTIVA_MS);
    venceEspera.unref?.();
  });
  const resultado = await Promise.race([solicitud, espera]);
  clearTimeout(venceEspera);
  return resultado;
}

// Mensajes que un Edge ya autenticado puede mandar. Todo lo que necesita
// identidad se toma de `ws` -- el mensaje solo aporta a QUÉ trabajo se
// refiere, y el UPDATE filtra por terminal_id: un Edge no puede confirmar,
// cancelar ni tocar el trabajo de otro aunque conozca su uuid.
async function manejarMensajeDeEdge(ws, raw) {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return; }

  if (msg.tipo === 'latido') {
    marcarUltimaConexionTerminal(ws.terminalId);
    return;
  }

  if (msg.tipo === 'impresoras_detectadas') {
    const pendiente = solicitudesImpresoras.get(msg.solicitudId);
    // La solicitud tiene que ser de ESTA terminal: un Edge no puede contestar
    // por otro aunque conozca el id de la solicitud.
    if (!pendiente || pendiente.terminalId !== ws.terminalId) return;
    solicitudesImpresoras.delete(msg.solicitudId);
    const lista = Array.isArray(msg.impresoras) ? msg.impresoras : [];
    pendiente.resolver({
      ok: msg.ok === true,
      // Se vuelve a sanear en la nube: que el Edge ya lo haga no es motivo
      // para confiar en lo que llega por el cable.
      impresoras: lista.slice(0, 50).map((i) => ({
        nombre: typeof i?.nombre === 'string' ? i.nombre.slice(0, 200) : '',
        predeterminada: i?.predeterminada === true,
        estado: typeof i?.estado === 'string' ? i.estado.slice(0, 30) : 'desconocido',
      })).filter((i) => i.nombre),
      error: typeof msg.error === 'string' ? msg.error.slice(0, 200) : null,
    });
    return;
  }

  if (msg.tipo === 'ack_impresion') {
    if (typeof msg.trabajoId !== 'string' || !msg.trabajoId) return;
    try {
      const actualizado = await registrarAckDeTerminal(ws.terminalId, {
        trabajoId: msg.trabajoId,
        resultado: msg.resultado,
        error: msg.error,
      });
      if (!actualizado) {
        // Ni existe, ni es suyo, ni estaba en un estado que admita ACK.
        console.warn(`[Edge] ACK rechazado — terminal=${ws.terminalId} trabajo=${msg.trabajoId} resultado=${msg.resultado}`);
        return;
      }
      console.log(`[Edge] ACK terminal=${ws.terminalId} trabajo=${msg.trabajoId} estado=${actualizado.estado} intentos=${actualizado.intentos}`);
    } catch (e) {
      console.error(`[Edge] error procesando ACK de terminal=${ws.terminalId}: ${e.message}`);
    }
    return;
  }

  console.warn(`[Edge] mensaje no reconocido de terminal=${ws.terminalId} tipo=${msg.tipo}`);
}

// Inyectar broadcast en el orderManager, whatsapp y rappi
// negocioId (Incidente P0): setWsBroadcastWA(broadcast) era la fuga en vivo
// confirmada -- cada mensaje de WhatsApp de CUALQUIER negocio se emitía a
// TODOS los paneles conectados. whatsapp-meta.js ahora resuelve negocioId
// por webhook (integraciones_canal) y llama wsBroadcast(negocioId, data)
// con la misma firma que broadcastNegocio.
setWsBroadcast(broadcastNegocio);
setWsBroadcastWA(broadcastNegocio);
setWsBroadcastRappi(broadcastNegocio, broadcast);
// Fase C (tiempo real, Red de Repartidores): canal global de Superadmin,
// inyectado por separado del broadcast por-negocio de arriba.
setWsBroadcastSuperadmin(broadcastSuperadmin);
setWsBroadcastSuperadminWA(broadcastSuperadmin);

// Inyectar los broadcasts de impresión en printRouter -- una sola vez al
// arrancar, nunca por pedido. printRouter decide legacy vs. autenticado;
// aquí solo se le da acceso a los dos canales WebSocket reales.
setBroadcastsImpresion({ legacy: broadcastPrintAgentLegacy, autenticado: broadcastPrintAgentNegocio });

// Entregar un trabajo al Edge conectado exige el WebSocket, que solo existe
// aquí. Se inyecta con el mismo patrón que los broadcasts de arriba, para que
// orderManager pueda decidir si Edge se hace cargo de un pedido sin tener que
// importar server.js -- eso sería un ciclo.
setEntregaEdge(entregarTrabajos);

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
//   - 'legacy' → raíz "/", usada por el print-agent anterior a la ruta
//     autenticada. El agente no manda identidad, así que el negocio lo
//     resuelve el SERVIDOR en el upgrade y solo si es inequívoco (un único
//     negocio con print_agent_legacy_activo). Cero o varios ⇒ upgrade
//     rechazado. Al conectarse recibe únicamente los trabajos PENDIENTES de
//     SU negocio, cada uno con printJobId y reclamados de la cola -- nunca el
//     tablero completo, nunca pedidos de otro negocio, nunca dos veces el
//     mismo trabajo. La ruta se cierra sola cuando el último negocio migre a
//     Edge. Cualquier terminal nueva va por /ws/print-agent.
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
    // Volcado inicial: el panel recibe TODO lo activo como `nuevo_pedido`. Sin
    // identidad, cada reconexion era un lote de eventos "nuevos" -- y lo unico
    // que evitaba el sonido y la impresion era una bandera temporal del
    // navegador. Con la clave determinista, lo que ese panel ya proceso no
    // vuelve a producir efecto por reconectarse.
    // Un checkout de la tienda en línea sin pagar NO es una orden del
    // restaurante: no se vuelca al tablero. Cuando el pago se confirme,
    // confirmarPedidoPendientePago lo emite como nuevo_pedido normal. Los
    // pendiente_pago de OTROS canales (anticipo de WhatsApp) conservan su
    // comportamiento histórico.
    const pedidosNegocio = obtenerPedidos(ws.negocioId).filter(p =>
      p.estado !== 'entregado'
      && !(p.canal === 'tienda_online' && p.estado === 'pendiente_pago'));
    pedidosNegocio.forEach(pedido => {
      ws.send(JSON.stringify(conIdentidadDePedido(
        { tipo: 'nuevo_pedido', pedido, replay: true }, pedido)));
    });
    ws.on('close', () => console.log('[WS] Panel autenticado desconectado'));
    return;
  }

  // ✅ NUEVO (Fase C, Red de Repartidores) — sin volcado inicial: el cliente
  // (panel/superadmin.html) hace su propio fetch HTTP al conectar/reconectar
  // (mismos endpoints ya existentes de roster/servicios), el WS solo avisa
  // "algo cambió, vuelve a pedir" -- así el canal en tiempo real nunca es
  // la única fuente de verdad y la operación completa sigue funcionando
  // por HTTP si este WS falla o tarda en reconectar.
  if (ws.tipo === 'superadmin') {
    console.log(`[WS] Superadmin conectado — usuario=${ws.usuarioId}`);
    ws.on('close', () => console.log('[WS] Superadmin desconectado'));
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
      // Después de autenticar, la conexión SÍ acepta mensajes: son los ACK
      // de impresión y los latidos de Xabor Edge. Lo que sigue prohibido es
      // volver a autenticarse como otra terminal en la misma conexión -- la
      // identidad se fija una vez y no se cambia.
      if (procesado && ws.autenticado) {
        return manejarMensajeDeEdge(ws, raw);
      }
      if (procesado) {
        // Un segundo mensaje sin haber autenticado: nada legítimo hace eso.
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

      // UNA conexión viva por terminal. Si ya había otra con esta misma
      // identidad, se cierra: dos procesos Edge con la misma credencial
      // recibirían los mismos trabajos y sacarían CADA COMANDA POR
      // DUPLICADO. Pasa de verdad -- alguien deja el agente viejo abierto,
      // o el servicio de Windows arranca dos veces -- y el restaurante lo
      // descubre con dos papeles idénticos en cocina.
      //
      // Gana la conexión nueva: si el proceso anterior se colgó, su socket
      // puede seguir "abierto" para el servidor durante minutos, y nadie
      // debería quedarse sin imprimir por eso.
      let desplazadas = 0;
      wss.clients.forEach(otro => {
        if (otro === ws) return;
        if (otro.tipo !== 'print-agent' || !otro.autenticado) return;
        if (otro.terminalId !== fila.terminal_id) return;
        desplazadas++;
        try { otro.send(JSON.stringify({ tipo: 'desplazada', mensaje: 'Otra conexión tomó esta terminal' })); } catch {}
        // 4001 es el código acordado con el Edge: significa "otro proceso
        // tomó tu identidad, NO reconectes". Sin él, el desplazado vuelve a
        // conectar, desplaza al nuevo, y los dos se turnan la conexión
        // recibiendo trabajos por separado -- cada uno con su cola local, y
        // la comanda acaba saliendo dos veces igual.
        try { otro.close(4001, 'Reemplazada por una conexión nueva'); } catch { otro.terminate(); }
      });
      if (desplazadas) {
        console.warn(`[PrintAgent] terminal=${fila.terminal_id} tenía ${desplazadas} conexión(es) previa(s): se cierran para no imprimir por duplicado`);
      }

      ws.tipo        = 'print-agent';
      ws.autenticado = true;
      ws.terminalId  = fila.terminal_id;
      ws.sucursalId  = fila.sucursal_id;
      ws.negocioId   = fila.negocio_id;

      // Una conexión nueva suele ser un reinicio del equipo: el listado de
      // impresoras cacheado y cualquier solicitud dirigida al socket anterior
      // dejan de describir la realidad.
      invalidarCacheImpresoras(fila.terminal_id);

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

      // Antes de entregar nada: ¿este Edge conserva su memoria local? Si
      // vuelve con otra instalación, su cola se borró y lo que quedó como
      // 'entregado' pudo haber salido en papel. Esos trabajos pasan a
      // 'incierto' y NO se reenvían -- reenviarlos sacaría comandas
      // repetidas en cocina.
      registrarInstalacion(fila.terminal_id, msg.instalacionId)
        .then((r) => {
          if (r.amnesia) {
            console.warn(`[Edge] terminal=${fila.terminal_id} volvió con la cola local borrada: ${r.trabajosMarcados} trabajo(s) sin confirmar pasan a incierto y NO se reenvían`);
          }
          return entregarTrabajosPendientes(ws);
        })
        .catch((e) =>
          console.error(`[PrintAgent] No se pudieron entregar los pendientes a terminal=${fila.terminal_id}: ${e.message}`));
    });

    ws.on('close', () => {
      limpiarTimer();
      if (ws.autenticado) invalidarCacheImpresoras(ws.terminalId);
      console.log(`[PrintAgent] Conexión ${ws.autenticado ? 'autenticada' : 'pendiente'} desconectada`);
    });
    ws.on('error', () => { limpiarTimer(); });
    return;
  }

  // 'legacy' — el agente viejo de UN negocio, ya resuelto en el upgrade.
  //
  // Antes esto volcaba el tablero COMPLETO de TODOS los negocios, sin
  // printJobId y sin pasar por ningún registro. Dos consecuencias: la impresora
  // de un negocio imprimía pedidos de otro, y cada reconexión reimprimía todo
  // lo que hubiera activo -- el agente viejo imprime cuanto le llega, no
  // deduplica nada.
  //
  // Ahora recibe SOLO los trabajos pendientes de SU negocio, cada uno con su
  // printJobId, reclamados de la cola con un UPDATE condicional: lo que ya se
  // entregó no vuelve a salir, por muchas veces que se reconecte.
  console.log(`[WS] Conexión legado conectada — negocio=${ws.negocioId}`);
  reclamarTrabajosLegacyPendientes(ws.negocioId).then((pendientes) => {
    for (const { printJobId, pedido } of pendientes) {
      const mensaje = JSON.stringify({ tipo: 'nuevo_pedido', printJobId, tipoDocumento: 'comanda', pedido });
      ws.send(mensaje, (err) => {
        if (!err) return;
        // No salió del servidor: vuelve a la cola en vez de darse por entregado.
        console.error(`[WS] No se pudo entregar el pendiente ${printJobId}: ${err.message}`);
        devolverTrabajoLegacyAPendiente(ws.negocioId, printJobId);
      });
    }
    if (pendientes.length) {
      console.log(`[WS] Legado negocio=${ws.negocioId}: ${pendientes.length} trabajo(s) pendiente(s) entregado(s)`);
    }
  }).catch(e => console.error(`[WS] Error entregando pendientes legado: ${e.message}`));

  ws.on('close', () => console.log('[WS] Conexión legado desconectada'));
});

// ─── Middlewares ─────────────────────────────────────────────────────────────
// Límite elevado porque /api/imagenes/enviar y /api/documentos/enviar
// reciben el archivo como base64 dentro del body JSON (sin multipart) --
// el default de Express (100kb) rechazaba cualquier foto o PDF real
// antes de que la validación propia de tamaño (MEDIA_MAX_IMAGE_MB /
// PDF_TAMANO_MAXIMO_MB) tuviera oportunidad de correr.
// `verify` conserva los BYTES CRUDOS del body, pero solo para el webhook de
// Meta: la firma X-Hub-Signature-256 se calcula sobre exactamente lo que Meta
// envió (Meta firma la versión unicode-escapada del payload tal cual viaja
// por el cable) -- un JSON.stringify(req.body) re-serializado produce una
// firma distinta y rompería la validación. Ningún otro endpoint recibe
// req.rawBody: no se retiene memoria extra fuera del webhook.
app.use(express.json({
  limit: '20mb',
  verify: (req, _res, buf) => {
    if (req.originalUrl && req.originalUrl.startsWith('/webhook/whatsapp')) req.rawBody = buf;
  },
}));
app.use(express.urlencoded({ extended: true })); // Twilio envía form-urlencoded

// Archivos estáticos: panel y audios generados por ElevenLabs
app.use(express.static(join(__dirname, '../panel'), { index: false }));
app.use('/audio', express.static(join(__dirname, '../public/audio')));
app.use('/public', express.static(join(__dirname, '../public')));

// ─── Xabor Finanzas (módulo SAT — independiente) ────────────────────────────
app.use('/api/finanzas', requireAdmin, finanzasRouter);

// ─── Credenciales e.firma SAT ────────────────────────────────────────────────
// GET: devuelve info pública del cert (sin llave) para mostrar en panel
app.get('/api/admin/sat/credenciales/info', requireAdminSeguro, requireModulo('facturacion'), async (req, res) => {
  try {
    const info = await obtenerInfoCertSAT();
    res.json({ ok: true, info }); // info es null si no hay credenciales
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST: recibe cert (.cer) y llave (.key) como base64 + contraseña
// Verifica que coincidan, descifra la llave y guarda en DB cifrada
app.post('/api/admin/sat/credenciales', requireAdminSeguro, requireModulo('facturacion'), async (req, res) => {
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
app.delete('/api/admin/sat/credenciales', requireAdminSeguro, requireModulo('facturacion'), async (req, res) => {
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
// negocioId (Incidente P0): webhook sin sesión, se deriva buscando el
// pedido por folio (obtenerPedidoPorId) -- si no se puede resolver, se
// omite el broadcast en vez de mandarlo global (fail closed, nunca se
// inventa negocio).
// ─── Webhook multiproveedor de pagos ────────────────────────────────────────
// El token de la URL es lo único que identifica de quién es este aviso; el
// cuerpo no decide negocio, folio, monto ni estado. Toda la disciplina vive en
// webhookPagos.js -- aquí sólo se transporta.
app.post('/webhook/pagos/:proveedor/:routingToken', async (req, res) => {
  try {
    const { http, resultado } = await procesarWebhookPago({
      proveedor: String(req.params.proveedor || ''),
      routingToken: String(req.params.routingToken || ''),
      req,
    });
    // Nunca se devuelve detalle interno al emisor del webhook: sólo el código.
    res.sendStatus(http);
    if (resultado?.razon && resultado.razon !== 'confirmado') {
      console.warn(`[WebhookPagos] ${req.params.proveedor}: ${resultado.razon}`);
    } else if (resultado?.razon === 'confirmado') {
      console.log(`[WebhookPagos] ✅ pago confirmado folio=${resultado.folio} payment=${resultado.paymentId}`);
    }
  } catch (e) {
    console.error('[WebhookPagos] Error inesperado:', e.message);
    res.sendStatus(500);
  }
});

// ── Normalizador de body EXCLUSIVO de /webhook/clip ─────────────────────────
// Causa raíz XAB-0171: express.json() global solo parsea Content-Type
// `application/json` EXACTO; el webhook real de Clip llega con otro tipo, el
// stream queda sin leer, req.body queda undefined y el handler descartaba
// TODOS los avisos -- el asiento quedaba siempre en manos del reconciliador
// de 5 minutos. El express.raw de la ruta (límite chico) lee el stream solo
// cuando el parser global no lo hizo (body-parser marca req._body), y aquí
// se interpreta ÚNICAMENTE la forma: JSON válido → objeto; cualquier otra
// cosa → objeto vacío y el handler lo ignora fail-closed como siempre. La
// autoridad del pago no cambia: sigue siendo la reconsulta autenticada.
function normalizarBodyWebhookClip(req, _res, next) {
  const crudo = req.body;
  let cuerpo = crudo;
  const texto = Buffer.isBuffer(crudo) ? crudo.toString('utf8')
    : (typeof crudo === 'string' ? crudo : null);
  if (texto !== null) {
    cuerpo = null;
    if (texto.trim()) {
      try {
        const j = JSON.parse(texto);
        if (j && typeof j === 'object' && !Array.isArray(j)) cuerpo = j;
      } catch { /* body no-JSON → fail closed abajo */ }
    }
  }
  if (!cuerpo || typeof cuerpo !== 'object' || Array.isArray(cuerpo)) cuerpo = {};
  // Diagnóstico SEGURO cuando no hay nada interpretable: solo la FORMA del
  // body (tipo, llaves) -- jamás valores, tokens, headers de auth ni PII.
  if (['resource', 'resource_status', 'me_reference_id', 'payment_request_id']
      .every(k => cuerpo[k] === undefined)) {
    const llaves = Buffer.isBuffer(crudo) ? '"(buffer no-JSON)"'
      : (crudo && typeof crudo === 'object' && !Buffer.isBuffer(crudo))
        ? JSON.stringify(Object.keys(crudo).slice(0, 15)) : '[]';
    console.warn(`[Clip] Webhook sin campos interpretables — content-type: ${req.headers['content-type'] || '(ausente)'}, typeof body: ${typeof crudo}, esArray: ${Array.isArray(crudo)}, llaves: ${llaves}`);
  }
  req.body = cuerpo;
  next();
}

app.post('/webhook/clip', express.raw({ type: () => true, limit: '100kb' }), normalizarBodyWebhookClip, async (req, res) => {
  // EL ACK NO ES LO PRIMERO.
  //
  // Antes se respondía 200 al entrar y todo lo demás ocurría después. Eso deja
  // una ventana real: Clip recibe éxito, el proceso muere, y el
  // `payment_request_id` -- que para una creación ambigua es lo ÚNICO que ata
  // el dinero con la fila -- nunca llegó a la base.
  //
  // Y no se puede confiar en un reintento: la documentación pública de Clip no
  // describe ninguna política de reintentos ante non-2xx, ni número de
  // intentos, ni backoff. No se inventa la que no está escrita. Por eso el
  // orden es: durabilizar primero, acusar recibo después. Si la persistencia
  // falla, se responde non-2xx -- que Clip reintente o no, lo que no se hace es
  // mentir diciendo que el evento quedó capturado.
  let acusado = false;
  const acusar = (codigo = 200) => { if (!acusado) { acusado = true; res.sendStatus(codigo); } };

  try {
    const evento = req.body;
    // Clip Checkout Webhook: resource_status + me_reference_id
    const status = evento?.resource_status;
    const ref    = evento?.me_reference_id;
    console.log(`[Clip] Webhook recibido — pedido: ${ref}, status: ${status}, resource: ${evento?.resource}`);

    // ── ESQUEMA REAL DE CLIP (checkout-api) ────────────────────────────────
    //
    // El webhook que Clip envía de verdad -- confirmado en producción y por su
    // documentación -- es:
    //     { id: "<payment_request_id>", origin: "checkout-api",
    //       event_type: "INSERT" | "UPDATE" }
    //
    // Tres cosas que NO se hacen aquí, a propósito:
    //   · `event_type` NO es autoridad de pago: INSERT/UPDATE solo dicen que
    //     algo cambió, jamás que se cobró. No se traduce a "COMPLETED".
    //   · `id` es el payment_request_id (pagos.referencia_externa), NO
    //     pagos.id (ese es el external_reference que viaja HACIA Clip).
    //     Confundirlos resolvería la fila equivocada.
    //   · el payload no asienta nada: solo DESPIERTA la misma reconsulta
    //     autenticada de siempre (verificarYAsentarClip), que es quien decide
    //     con el estado real del checkout. Fail-closed intacto.
    //
    // Un `event_type` desconocido/futuro también dispara la reconsulta
    // (origin + id válidos bastan): preguntarle a Clip nunca es peligroso;
    // creerle al aviso, sí. Un `origin` distinto NO se interpreta.
    const idWebhook = typeof evento?.id === 'string' ? evento.id.trim() : '';
    const origenWebhook = typeof evento?.origin === 'string' ? evento.origin.trim() : '';
    const esquemaCheckoutApi = Boolean(idWebhook) && Boolean(origenWebhook)
      && evento?.resource === undefined && evento?.me_reference_id === undefined;
    if (esquemaCheckoutApi) {
      const tipoEvento = typeof evento?.event_type === 'string' ? evento.event_type.trim() : '';
      if (origenWebhook !== 'checkout-api') {
        console.warn(`[Clip] Webhook de origen no soportado: origin=${origenWebhook} event_type=${tipoEvento || '(vacio)'} — ignorado (fail closed)`);
        acusar();
        return;
      }
      const pagoCk = await obtenerPagoClipPorCheckoutId(idWebhook);
      if (!pagoCk) {
        console.warn(`[Clip] Webhook checkout-api sin fila de pago para el checkout indicado (event_type=${tipoEvento || '(vacio)'}) — se ignora (fail closed)`);
        acusar();
        return;
      }
      // Evento capturado y resoluble: recién ahora se acusa recibo.
      acusar();
      const rCk = await verificarYAsentarClip({ pago: pagoCk, checkoutId: idWebhook });
      if (!rCk.ok) {
        // Lo normal en un INSERT (el checkout acaba de nacer y no hay dinero):
        // no es un error, es el fail-closed haciendo su trabajo.
        console.log(`[Clip] Webhook checkout-api ${tipoEvento || '(sin tipo)'} no asentó ${pagoCk.id}: ${rCk.razon}`);
        if (rCk.razon === 'transicion_doble_cobro') {
          broadcastNegocio(pagoCk.negocio_id, {
            tipo: 'pago_anomalia', anomalia: 'doble_cobro_real',
            pedidoId: pagoCk.pedido_folio, pagos: rCk.transicion?.pagosImplicados,
          });
        }
        return;
      }
      await derivarPedidoPorPagoAsentado({
        pagoId: pagoCk.id, negocioId: pagoCk.negocio_id, folio: pagoCk.pedido_folio });
      broadcastNegocio(pagoCk.negocio_id, { tipo: 'pago_confirmado', pedidoId: pagoCk.pedido_folio, proveedor: 'clip' });
      console.log(`[Clip] ✅ Pago ${rCk.transicion.resultado} para pedido ${pagoCk.pedido_folio} (webhook checkout-api ${tipoEvento || 'sin tipo'})`);
      return;
    }

    // Dos generaciones de external_reference moderno (mas el legacy por folio
    // del final):
    //   · UUID de 36 chars = pagos.id (contrato actual: el limite oficial de
    //     Clip para metadata.external_reference es 36 caracteres).
    //   · "negocioId:folio:versionHash[:proveedor:rand]" = referencia interna
    //     historica; se conserva porque existen checkouts vivos creados asi.
    // Un UUID que no resuelve fila NO cae al camino legacy por folio: un UUID
    // jamas es un folio -- fail closed.
    const refTexto = String(ref || '');
    const esUuidRef = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(refTexto);

    // CLIP expires_at: el webhook oficial de expiracion (resource=CHECKOUT,
    // resource_status=EXPIRED -- documentado en
    // https://developer.clip.mx/reference/checkout-webhook). El aviso NO
    // decide nada por si solo (Clip no firma webhooks): se resuelve la fila
    // por la referencia interna y procesarExpiracionProveedorClip RECONSULTA
    // el checkout con las credenciales del negocio -- solo un
    // CHECKOUT_EXPIRED real, con la referencia correcta, produce la
    // transicion comun de vencimiento (vencerEsperaDePago: idempotente y
    // money-aware). Un EXPIRED repetido devuelve `ya_no_vencible` y no toca
    // nada; un EXPIRED falso sobre un checkout vivo tampoco.
    if (status === 'EXPIRED' && evento?.resource === 'CHECKOUT') {
      let pagoExp = null;
      if (esUuidRef) {
        pagoExp = await obtenerPagoClipPorId(refTexto);
      } else {
        const partesExp = refTexto.split(':');
        if (partesExp.length >= 3) {
          const [negocioIdExp] = partesExp;
          pagoExp = await obtenerPagoPorReferenciaInterna(negocioIdExp, refTexto);
        }
      }
      if (pagoExp) {
        const checkoutExp = pagoExp.referencia_externa
          || String(evento?.payment_request_id || '').trim() || null;
        if (checkoutExp) {
          acusar();
          const rExp = await procesarExpiracionProveedorClip({ pago: pagoExp, checkoutId: checkoutExp });
          console.log(`[Clip] Webhook EXPIRED para ${pagoExp.pedido_folio}: ${rExp.razon}`);
          return;
        }
      }
      acusar();
      return;
    }

    if (status !== 'COMPLETED' || evento?.resource !== 'CHECKOUT') { acusar(); return; }

    // Fase 12 (arquitectura de pagos multiempresa): Clip no firma sus
    // webhooks en su API pública -- nunca se confía en el payload por sí
    // solo. me_reference_id trae "negocioId:folio:versionHash" cuando el
    // enlace se creó vía pagosService.crearEnlacePago(); se resuelve
    // negocioId de ESE valor (nunca adivinado), se recupera el pago real
    // en `pagos` por (negocioId, referencia_interna), y se re-consulta el
    // estado REAL en Clip con las credenciales de ESE negocio antes de
    // marcar pagado -- el webhook por sí solo nunca es suficiente.
    const partes = refTexto.split(':');
    // >= 3: la referencia interna incorpora ahora el proveedor como cuarta
    // parte (P1, cambio de proveedor principal). Las posiciones 0 y 1 -- negocio
    // y folio -- no se movieron, así que las referencias antiguas de tres
    // partes se siguen resolviendo igual. El contrato ACTUAL es un UUID de 36
    // chars = pagos.id (limite oficial de external_reference en Clip).
    if (esUuidRef || partes.length >= 3) {
      const pago = esUuidRef
        ? await obtenerPagoClipPorId(refTexto)
        : await obtenerPagoPorReferenciaInterna(partes[0], refTexto);
      if (!pago) {
        console.warn(`[Clip] Webhook: no existe pago registrado para referencia ${refTexto} — se ignora (fail closed)`);
        acusar();
        return;
      }
      // Tenant y folio salen de LA FILA (la autoridad), no de parsear la
      // referencia: en el contrato UUID no hay nada que parsear, y en el
      // historico la fila se resolvio ya acotada al negocio embebido.
      const negocioIdWebhook = pago.negocio_id;
      const folioWebhook = pago.pedido_folio;
      // Nota: NO se corta aquí por `pago.estado === 'pagado'`. La transición
      // financiera es idempotente y además es la única que sabe mirar a los
      // intentos hermanos: cortar antes escondería un doble cobro real.
      //
      // ¿Qué checkout se reconsulta? El de la fila si ya lo conocemos. Si la
      // creación quedó AMBIGUA -- mandamos el POST y se perdió la respuesta --
      // la fila no tiene referencia_externa, y el único lugar donde aparece ese
      // id es el `payment_request_id` del webhook (documentado). Se toma como
      // CANDIDATO, nunca como verdad: el webhook de Clip no viene firmado.
      const candidato = String(evento?.payment_request_id || '').trim() || null;
      const idAConsultar = pago.referencia_externa || candidato;
      if (!idAConsultar) {
        console.warn(`[Clip] Webhook sin checkout consultable para ${pago.id} — no se marca pagado`);
        acusar();
        return;
      }
      // Si la fila YA tiene identidad externa y el webhook nombra otra, eso no
      // es este cobro: se registra y se para. Nunca se sobrescribe.
      if (pago.referencia_externa && candidato && candidato !== pago.referencia_externa) {
        console.error(`[Clip] El webhook nombra el checkout ${candidato} pero el pago ${pago.id} es del ${pago.referencia_externa} — se ignora`);
        await marcarAnomaliaPago(pago.id, negocioIdWebhook, 'checkout_ajeno',
          'un webhook de Clip nombró un checkout distinto al de esta fila');
        acusar();
        return;
      }

      // ── PERSISTIR EL CANDIDATO ANTES DE PODER PERDERLO ──────────────────
      //
      // Este endpoint ya respondió 200. Si la reconsulta falla de forma
      // transitoria, o el proceso muere aquí mismo, este `payment_request_id`
      // sería lo único que ataba el dinero de Clip con esta fila -- y se
      // perdería: la reconciliación de Clip recorre filas CON referencia
      // externa, y esta no la tiene. Dinero real y Xabor ambiguo para siempre.
      //
      // Se guarda como CANDIDATO NO VERIFICADO, en metadata. No es identidad:
      // eso solo lo decide la reconsulta. Un candidato falso o ajeno se queda
      // ahí sin ascender nunca.
      if (candidato && !pago.referencia_externa) {
        // Punto de muerte inyectable EXACTAMENTE aquí: antes de durabilizar.
        // Sirve para demostrar que en esa ventana NO se acusó recibo.
        if (process.env.NODE_ENV !== 'production'
            && process.env.XABOR_PAGOS_FALLA_EN === 'antes_de_candidato_clip') {
          const e = new Error("Fallo inyectado en 'antes_de_candidato_clip'");
          e.inyectado = true;
          throw e;
        }
        const guardado = await registrarCandidatoCheckoutClip(pago.id, negocioIdWebhook, candidato);
        if (!guardado) {
          // rowCount 0 con la fila sin identidad significa que ya había OTRO
          // candidato distinto: dos avisos nombrando checkouts distintos para
          // la misma fila. Es anomalía, no un fallo de escritura.
          console.error(`[Clip] Candidato en conflicto para ${pago.id}: llegó ${candidato}`);
          await marcarAnomaliaPago(pago.id, negocioIdWebhook, 'candidato_en_conflicto',
            `un segundo webhook nombró el checkout ${candidato}`);
          acusar();
          return;
        }
      }

      // A partir de aquí el evento YA está durablemente capturado: el candidato
      // vive en la base y el reconciliador puede terminar el trabajo aunque
      // este proceso muera ahora mismo. Recién ahora se acusa recibo.
      acusar();

      // Verificación y asiento por el camino COMPARTIDO con el reconciliador de
      // candidatos: reconsulta con las credenciales del negocio, valida
      // referencia/monto/moneda, adopta identidad y asienta.
      const r = await verificarYAsentarClip({ pago, checkoutId: idAConsultar });
      if (!r.ok) {
        console.warn(`[Clip] No se asentó ${pago.id}: ${r.razon}`);
        // El evento ya quedó capturado; lo que falta lo recoge la reconciliación.
        if (r.razon === 'transicion_doble_cobro') {
          broadcastNegocio(negocioIdWebhook, {
            tipo: 'pago_anomalia', anomalia: 'doble_cobro_real',
            pedidoId: folioWebhook, pagos: r.transicion?.pagosImplicados,
          });
        }
        return;
      }
      const transicion = r.transicion;

      // P0 (anticipo estructurado): si el pedido nació pendiente_pago, el
      // pago re-verificado es LA autorización. Va por el MISMO descargo de
      // deuda que Mercado Pago: derivar y después saldar.
      await derivarPedidoPorPagoAsentado({
        pagoId: pago.id, negocioId: negocioIdWebhook, folio: folioWebhook });
      broadcastNegocio(negocioIdWebhook, { tipo: 'pago_confirmado', pedidoId: folioWebhook, proveedor: 'clip' });
      console.log(`[Clip] ✅ Pago ${transicion.resultado} para pedido ${folioWebhook}, negocio ${negocioIdWebhook}${transicion.honradoTrasInvalidacion ? ' (honrado tras invalidación)' : ''}`);
      return;
    }

    // Camino legacy: enlaces creados directamente por clip-api.js sin pasar
    // por pagosService -- whatsapp-meta.js ya migró sus tres puntos de
    // generación de enlace a pagosService.crearEnlacePago, salvo pedidos
    // PROGRAMADOS aún no activados (excepción documentada ahí: todavía no
    // existen en pedidos_activos, que crearEnlacePago exige). Ese es hoy el
    // único caso real que sigue llegando por este camino: me_reference_id
    // es solo el folio, sin negocioId embebido, y se resuelve por el
    // pedido en memoria. Riesgo residual documentado (ver
    // docs/pagos-multiempresa.md): si el proceso se reinició, este pago no
    // se reconcilia por esta vía y depende del job de reconciliación en
    // background (obtenerPagosPendientesConLink).
    acusar();
    const pedido = obtenerPedidoPorId(ref);
    if (pedido?.negocioId) {
      await confirmarPagoPedido(ref, pedido.negocioId);
      await confirmarPedidoPendientePago(ref, pedido.negocioId); // P0: mismo gate que el camino nuevo
      broadcastNegocio(pedido.negocioId, { tipo: 'pago_confirmado', pedidoId: ref, proveedor: 'clip' });
      console.log(`[Clip] ✅ Pago confirmado y guardado para pedido ${ref} (camino legacy)`);
    } else {
      console.warn(`[Clip] pago_confirmado: no se pudo resolver negocioId para ${ref} — se omite confirmación y broadcast (fail closed)`);
    }
  } catch (e) {
    console.error('[Clip] Error al procesar webhook:', e.message);
    // Si el fallo ocurrió ANTES de acusar recibo, el evento no quedó capturado:
    // se responde non-2xx en vez de fingir que sí. Si ya se acusó, el candidato
    // está durable y la reconciliación termina el trabajo.
    acusar(503);
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
app.get('/api/auth/mesero/opciones', rateLimitMiddleware(req => `mesero-op:${req.ip}`, 60, 60 * 1000), async (req, res) => {
  const slug = String(req.query.negocio || '').trim().toLowerCase();
  if (!slug) return res.status(400).json({ error: 'Falta el negocio' });
  const negocioId = await obtenerNegocioIdPorSlug(slug);
  // Un slug inexistente y un negocio sin restaurante responden IGUAL: la
  // pantalla pública no confirma qué negocios existen.
  if (!negocioId || !(await negocioEstaActivo(negocioId)) || (await obtenerEstadoModulo(negocioId, 'restaurante')) !== 'activo') {
    return res.status(404).json({ error: 'Restaurante no disponible', code: 'RESTAURANTE_NO_DISPONIBLE' });
  }
  res.json({ negocio: await obtenerNombreNegocio(negocioId), meseros: await listarMeserosEstacion(negocioId) });
});

app.post('/api/auth/mesero/login',
  // Freno al tanteo de PIN de 4-6 dígitos. En memoria del proceso, como el
  // resto de rateLimit del proyecto: con varias instancias el límite es por
  // instancia (documentado; sin Redis nuevo). La llave incluye el negocio
  // para que un atacante no deje sin servicio a otros restaurantes.
  rateLimitMiddleware(req => `mesero-pin:${req.ip}:${String(req.body?.negocio || '').toLowerCase()}`, LIMITE_PIN_INTENTOS, VENTANA_PIN_MS),
  async (req, res) => {
  const { negocio, meseroUsuarioId, pin } = req.body || {};
  const slug = String(negocio || '').trim().toLowerCase();
  const generico = { error: 'Mesero o PIN incorrecto', code: 'CREDENCIALES_INVALIDAS' };
  if (!slug || !meseroUsuarioId || !pin) return res.status(401).json(generico);

  const negocioId = await obtenerNegocioIdPorSlug(slug);
  if (!negocioId) return res.status(401).json(generico);
  // Negocio suspendido o módulo apagado: sí se distingue, porque es un estado
  // operativo que el personal necesita entender (y no revela credenciales).
  if (!(await negocioEstaActivo(negocioId)) || (await obtenerEstadoModulo(negocioId, 'restaurante')) !== 'activo') {
    return res.status(403).json({ error: 'Restaurante no disponible', code: 'RESTAURANTE_NO_DISPONIBLE' });
  }
  const mesero = await meseroVigente(String(meseroUsuarioId), negocioId);
  const pinOk = mesero ? await verificarPinMesero(mesero.id, negocioId, String(pin)) : false;
  if (!mesero || !pinOk) {
    // Mesero inexistente, de otro negocio, inactivo o PIN equivocado: mismo
    // 401 y el mismo texto. El log no incluye el PIN ni el hash.
    console.warn(`[Estacion] intento de acceso rechazado negocio=${negocioId}`);
    return res.status(401).json(generico);
  }

  const token = crearTokenSesion({ usuarioId: mesero.id, negocioId, rol: 'mesero', est: true });
  setCookieSesion(res, token);
  console.log(`[Estacion] sesion_mesero_iniciada negocio=${negocioId} usuario=${mesero.id}`);
  res.json({ ok: true, mesero: { id: mesero.id, nombre: mesero.nombre }, negocio: await obtenerNombreNegocio(negocioId) });
});

app.post('/api/auth/mesero/logout', (req, res) => {
  const token = leerCookieSesion(req);
  if (token) revocarTokenSesion(token);
  limpiarCookieSesion(res);
  res.json({ ok: true });
});

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

// negocioId (Auditoría P0 complementaria, push): se lee del propio token
// de sesión (antes de revocarlo), nunca del body -- así se sabe de qué
// negocio desvincular la suscripción sin volver a confiar en el cliente.
// Si el navegador no manda endpoint, no se borra nada (nunca se adivina
// ni se borran otras suscripciones del mismo negocio).
app.post('/api/auth/negocio/logout', async (req, res) => {
  // Revocar el token en sí (no solo borrar la cookie) — si no se hace esto,
  // la misma cookie reenviada después de logout (p. ej. por el botón Atrás
  // restaurando una página cacheada) seguiría siendo válida hasta su
  // expiración natural.
  const auth = req.headers['authorization'];
  const tokenBearer = (auth && auth.startsWith('Bearer ')) ? auth.slice(7) : null;
  const token = leerCookieSesion(req) || tokenBearer;

  const { endpoint } = req.body || {};
  if (endpoint) {
    const payload = verificarTokenSesion(token);
    if (payload?.negocioId) {
      await eliminarSuscripcionPush(endpoint, payload.negocioId).catch(() => {});
    }
  }

  revocarTokenSesion(token);
  limpiarCookieSesion(res);
  res.json({ ok: true });
});

// ─── Invitación → crear contraseña (Fase 7) ─────────────────────────────────
// Públicas a propósito -- la seguridad no viene de exigir sesión (no puede
// haberla: el usuario todavía no tiene contraseña), sino de que el token de
// 256 bits es indistinguible de aleatorio y de un solo uso. Rate limit por
// IP en ambas para dificultar fuerza bruta sobre el espacio de tokens.
app.get('/api/auth/invitacion/:token', rateLimitMiddleware(req => `val-inv:${req.ip}`, 20, 60 * 1000), async (req, res) => {
  const resultado = await validarInvitacion(req.params.token);
  res.json(resultado);
});

app.post('/api/auth/crear-password', rateLimitMiddleware(req => `crear-pw:${req.ip}`, 10, 60 * 1000), async (req, res) => {
  const { token, password, passwordConfirm } = req.body;
  if (typeof token !== 'string' || !token) return res.status(400).json({ error: 'Token requerido' });
  if (typeof password !== 'string' || typeof passwordConfirm !== 'string') return res.status(400).json({ error: 'Contraseña requerida' });
  if (password !== passwordConfirm) return res.status(400).json({ error: 'Las contraseñas no coinciden' });
  try {
    await crearPasswordDesdeInvitacion(token, password);
    res.json({ ok: true });
  } catch (e) {
    if (e.code === 'USADO') return res.status(409).json({ error: 'Este enlace ya fue utilizado' });
    if (e.code === 'EXPIRADO') return res.status(410).json({ error: 'Este enlace expiró' });
    if (e.code === 'INVALIDO') return res.status(404).json({ error: 'Enlace inválido' });
    if (e.code === 'PASSWORD_INVALIDA') return res.status(400).json({ error: e.message });
    console.error('[POST /api/auth/crear-password] Error:', e.message);
    res.status(500).json({ error: 'No se pudo crear la contraseña' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// RECUPERACIÓN DE CONTRASEÑA — "¿Olvidaste tu contraseña?"
//
// Solo para cuentas ADMINISTRATIVAS (correo + contraseña). Un mesero no
// entra por aquí: su acceso es un PIN sin correo y quien se lo repone es un
// administrador desde Usuarios. Son dos sistemas separados y este flujo
// nunca toca pin_hash.
//
// La respuesta de la solicitud es SIEMPRE la misma, exista o no la cuenta,
// esté activa o no, pertenezca a un negocio o a ninguno: decir "ese correo
// no existe" convierte el formulario en un detector de clientes de Xabor.
// Por la misma razón el trabajo (buscar, generar, enviar) se hace igual
// antes de responder, para no regalar la respuesta por su tiempo.
const RESET_MINUTOS = 60;

app.post('/api/auth/negocio/forgot-password',
  // Dos llaves a la vez: por IP (freno grueso al tanteo automatizado) y por
  // correo normalizado (evita bombardear el buzón de una persona concreta).
  // El límite por correo es el que de verdad protege al usuario; el de IP se
  // deja holgado a propósito porque un restaurante entero sale por la misma
  // IP y no debe quedarse sin recuperar contraseñas por culpa de un
  // compañero. Ninguno de los dos deja sin servicio a otros negocios.
  rateLimitMiddleware(req => `forgot-ip:${req.ip}`, 20, 15 * 60 * 1000),
  rateLimitMiddleware(req => `forgot-mail:${normalizarEmail(req.body?.email)}`, 3, 15 * 60 * 1000),
  async (req, res) => {
    const respuestaGenerica = { ok: true, mensaje: 'Si existe una cuenta asociada a ese correo, enviaremos instrucciones para restablecer la contraseña.' };
    try {
      const solicitud = await crearSolicitudResetPassword(req.body?.email);
      if (solicitud.creado) {
        const baseUrl = process.env.PUBLIC_URL || 'https://xabor.mx';
        const enlace = `${baseUrl}/restablecer-contrasena?token=${solicitud.token}`;
        // El correo puede fallar; la respuesta pública no cambia por eso.
        // El enlace NO se devuelve nunca por HTTP ni se escribe en logs.
        await enviarCorreoResetPassword({
          to: solicitud.usuario.email, nombre: solicitud.usuario.nombre, enlace, minutos: RESET_MINUTOS,
        }).catch(() => {});
      }
      res.json(respuestaGenerica);
    } catch (e) {
      // Ni siquiera un error interno debe distinguirse desde afuera.
      console.error('[POST /api/auth/negocio/forgot-password] Error:', e.message);
      res.json(respuestaGenerica);
    }
  });

// Estado del enlace, para que la pantalla sepa qué mostrar antes de pedir la
// contraseña nueva. Nunca devuelve correo ni negocio: solo el primer nombre.
app.get('/api/auth/reset-password/:token',
  rateLimitMiddleware(req => `val-reset:${req.ip}`, 20, 60 * 1000),
  async (req, res) => {
    res.json(await validarTokenReset(req.params.token));
  });

app.post('/api/auth/negocio/reset-password',
  rateLimitMiddleware(req => `reset-pw:${req.ip}`, 10, 60 * 1000),
  async (req, res) => {
    const { token, password, passwordConfirm } = req.body || {};
    if (typeof token !== 'string' || !token) return res.status(400).json({ error: 'Token requerido' });
    if (typeof password !== 'string' || typeof passwordConfirm !== 'string') return res.status(400).json({ error: 'Contraseña requerida' });
    if (password !== passwordConfirm) return res.status(400).json({ error: 'Las contraseñas no coinciden' });
    try {
      await restablecerPasswordConToken(token, password);
      // Mismos códigos que el flujo de invitación, para que la pantalla no
      // tenga que aprender un vocabulario nuevo.
      res.json({ ok: true });
    } catch (e) {
      if (e.code === 'USADO') return res.status(409).json({ error: 'Este enlace ya fue utilizado' });
      if (e.code === 'EXPIRADO') return res.status(410).json({ error: 'Este enlace expiró' });
      if (e.code === 'INVALIDO') return res.status(404).json({ error: 'Enlace inválido' });
      if (e.code === 'PASSWORD_INVALIDA') return res.status(400).json({ error: e.message });
      console.error('[POST /api/auth/negocio/reset-password] Error:', e.message);
      res.status(500).json({ error: 'No se pudo restablecer la contraseña' });
    }
  });

app.get('/api/auth/me', requireSesionNegocio(), async (req, res) => {
  const modulos = await obtenerModulosHabilitados(req.negocioId);
  // Nunca expone phone_number_id/token -- solo si el negocio tiene AMBOS
  // configurados. Sirve para que el panel muestre "pendiente de
  // configuración" en vez de un chat vacío ambiguo.
  const whatsappConfigurado = modulos.includes('whatsapp')
    ? !!(await obtenerCredencialesWhatsappNegocio(req.negocioId))
    : false;
  // soporte: true cuando la sesión es de la Central de Operaciones (un
  // superadmin dentro del panel de este negocio). El panel usa esto para
  // mostrar la barra "Estás administrando [NEGOCIO] como Superadmin" con el
  // botón de salida — nunca es información sensible (el propio usuario de
  // la sesión ya lo sabe).
  const respuesta = { usuarioId: req.usuarioId, negocioId: req.negocioId, rol: req.rol, modulos, whatsappConfigurado };
  if (req.esSoporte) {
    const { rows } = await pool.query('SELECT nombre FROM negocios WHERE id = $1', [req.negocioId]);
    respuesta.soporte = { activo: true, negocioNombre: rows[0]?.nombre || req.negocioId };
  }
  res.json(respuesta);
});

// Cierre manual de una sesión de soporte desde el panel del negocio (botón
// "Salir y volver a Superadmin" de la barra). Solo tiene efecto si la
// sesión actual ES de soporte — una sesión normal recibe 400 y no se toca.
app.post('/api/auth/soporte/salir', requireSesionNegocio(), async (req, res) => {
  if (!req.esSoporte) return res.status(400).json({ error: 'La sesión actual no es de soporte' });
  try {
    const token = leerCookieSesion(req);
    await cerrarSesionSoporte(token, req.usuarioId, 'salida manual desde el panel');
    revocarTokenSesion(token);
    limpiarCookieSesion(res);
    res.json({ ok: true });
  } catch (e) {
    console.error('[Soporte] Error al salir:', e.message);
    res.status(500).json({ error: 'Error al cerrar la sesión de soporte' });
  }
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
  res.sendFile(join(__dirname, '../public/landing/index.html'));
});

app.get('/aviso-privacidad.html', (req, res) => {
  res.sendFile(join(__dirname, '../public/landing/aviso-privacidad.html'));
});

// ─── Marca ──────────────────────────────────────────────────────────────────
// Los assets viven en public/brand (fuente única) y ya se sirven bajo
// /public/brand. Estas tres rutas existen porque los navegadores, los
// lectores de RSS y los bots piden estas direcciones EXACTAS sin mirar el
// HTML: /favicon.ico es la que pide una pestaña antes de leer la página, y
// hasta ahora respondía 404 — por eso seguía viéndose el icono viejo que el
// navegador tenía guardado. No se duplica el archivo: se sirve el mismo.
//
// Cache-Control corto: si la marca vuelve a cambiar, un día basta para que
// todos lo vean sin tener que pedirle a nadie que limpie su caché.
const ASSET_MARCA = (archivo) => (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(join(__dirname, '../public/brand/', archivo));
};
app.get('/favicon.ico', ASSET_MARCA('favicon.ico'));
app.get('/apple-touch-icon.png', ASSET_MARCA('xabor-icono-180.png'));
app.get('/apple-touch-icon-precomposed.png', ASSET_MARCA('xabor-icono-180.png'));
app.get('/site.webmanifest', ASSET_MARCA('site.webmanifest'));

app.get('/login', (req, res) => {
  res.sendFile(join(__dirname, '../panel/login-negocio.html'));
});

app.get('/app', (req, res) => {
  res.sendFile(join(__dirname, '../panel/index.html'));
});

// Xabor Finanzas — SPA independiente (auth client-side, igual que panel principal)
app.get('/finanzas', (req, res) => {
  res.sendFile(join(__dirname, '../panel/finanzas.html'));
});

// Panel de superadmin — completamente separado de /app (panel/index.html).
// Servir el HTML aquí no expone nada: la página está vacía de datos hasta
// que su JS llama a /api/superadmin/*, y esas rutas exigen requireSuperadmin
// real. Un admin de negocio o staff que entre a esta URL directamente ve la
// página cargar y de inmediato un 401/403 en cada llamada -- nunca datos.
// Estación de meseros: /mesero/<slug-del-negocio>. El slug identifica al
// negocio ANTES de pedir el PIN -- sin él no hay autenticación posible.
app.get('/mesero/:slug', (req, res) => {
  res.sendFile(join(__dirname, '../panel/mesero.html'));
});
app.get('/mesero', (req, res) => {
  res.sendFile(join(__dirname, '../panel/mesero.html'));
});

// Espacio de trabajo de Restaurante. Es la MISMA pantalla para el mesero que
// entró por /mesero/<slug> y para el admin que la abre desde /app: una sola
// UI operativa, con las acciones que cada rol puede ejecutar de verdad.
// /mesas.html sigue sirviendo el mismo archivo (enlaces y tablets antiguas).
app.get('/restaurante', (req, res) => {
  res.sendFile(join(__dirname, '../panel/mesas.html'));
});

app.get('/superadmin', (req, res) => {
  res.sendFile(join(__dirname, '../panel/superadmin.html'));
});

// Página pública de creación de contraseña -- el token vive en la query
// string y se valida client-side vía GET /api/auth/invitacion/:token; el
// HTML en sí no contiene ningún dato sensible.
app.get('/crear-password', (req, res) => {
  res.sendFile(join(__dirname, '../panel/crear-password.html'));
});

// Página pública para restablecer la contraseña olvidada. Mismo criterio que
// /crear-password: el token viaja en la query string y se valida contra
// GET /api/auth/reset-password/:token; el HTML en sí no contiene nada.
app.get('/restablecer-contrasena', (req, res) => {
  res.sendFile(join(__dirname, '../panel/restablecer-password.html'));
});

// Salud del servidor
// El puerto solo se abre cuando el bootstrap terminó (ver "Inicio" al final
// del archivo), así que si esta ruta responde, la aplicación ya está lista:
// `listo` lo hace explícito para quien mire el healthcheck.
app.get('/health', (req, res) => res.json({ status: 'ok', listo: appReady, timestamp: new Date().toISOString() }));

// ─── Captura pública de prospectos (landing) ───────────────────────────────
// Endpoint público (sin sesión) -- reemplaza el flujo anterior de mailto:.
// La persistencia en PostgreSQL es la fuente de verdad; el correo a
// hola@xabor.mx es una notificación secundaria que nunca bloquea ni
// condiciona la respuesta 201 (ver enviarNotificacionNuevoProspecto).
const TIPOS_NEGOCIO_PROSPECTO = ['Restaurante', 'Cafetería', 'Cocina', 'Repostería', 'Florería', 'Otro negocio con pedidos por WhatsApp'];
const VOLUMENES_PROSPECTO = ['Menos de 10', 'Entre 10 y 30', 'Entre 30 y 60', 'Más de 60'];
const TIEMPO_MINIMO_LLENADO_MS = 1200;

function limpiarTexto(v, maxLen) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t || t.length > maxLen) return null;
  if (t.includes('<') || t.includes('>')) return null; // "no aceptar HTML"
  return t;
}

app.post(
  '/api/public/prospectos',
  rateLimitMiddleware(req => `prospecto:${req.ip}`, 6, 10 * 60 * 1000),
  rateLimitMiddleware(() => 'prospecto:global', 120, 10 * 60 * 1000, 'El formulario está recibiendo muchas solicitudes. Intenta de nuevo en unos minutos.'),
  async (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};

      // Honeypot: un bot que llena todos los campos llenará también este,
      // invisible para una persona real. Se responde éxito sin persistir
      // nada -- un rechazo explícito (400/403) le enseñaría al bot cuál
      // campo evitar la próxima vez.
      if (typeof body.empresaWeb === 'string' && body.empresaWeb.trim()) {
        return res.status(201).json({ ok: true, message: 'Recibimos tus datos. Nos pondremos en contacto contigo.' });
      }

      // Tiempo mínimo de llenado: si el formulario se envía más rápido de
      // lo humanamente posible, se trata igual que el honeypot (éxito
      // silencioso, sin persistir). Si el cliente no manda el timestamp
      // (JS deshabilitado, integración distinta), no se bloquea por esto
      // solo -- el honeypot y el rate limit siguen aplicando.
      if (typeof body.cargadoEn === 'number' && Number.isFinite(body.cargadoEn)) {
        if (Date.now() - body.cargadoEn < TIEMPO_MINIMO_LLENADO_MS) {
          return res.status(201).json({ ok: true, message: 'Recibimos tus datos. Nos pondremos en contacto contigo.' });
        }
      }

      const nombre = limpiarTexto(body.nombre, 120);
      const negocio = limpiarTexto(body.negocio, 150);
      const ciudad = limpiarTexto(body.ciudad, 100);
      const telefonoBruto = typeof body.telefono === 'string' ? body.telefono.trim() : '';
      // Normalización sin asumir país: solo se conservan dígitos y un
      // '+' inicial opcional -- nunca se agrega una lada por defecto.
      const telefono = telefonoBruto.replace(/[^\d+]/g, '').replace(/(?!^)\+/g, '');
      const tipoNegocio = typeof body.tipoNegocio === 'string' ? body.tipoNegocio.trim() : '';
      const volumenMensajes = typeof body.volumenMensajes === 'string' ? body.volumenMensajes.trim() : '';
      const comentario = body.comentario ? limpiarTexto(body.comentario, 800) : null;
      if (body.comentario && comentario === null) {
        return res.status(400).json({ error: 'El comentario es demasiado largo o contiene caracteres no permitidos.' });
      }

      if (!nombre) return res.status(400).json({ error: 'El nombre es requerido.' });
      if (!negocio) return res.status(400).json({ error: 'El nombre del negocio es requerido.' });
      if (!ciudad) return res.status(400).json({ error: 'La ciudad es requerida.' });
      if (telefono.length < 7 || telefono.length > 20) return res.status(400).json({ error: 'El teléfono no es válido.' });
      if (!TIPOS_NEGOCIO_PROSPECTO.includes(tipoNegocio)) return res.status(400).json({ error: 'Selecciona un tipo de negocio válido.' });
      if (volumenMensajes && !VOLUMENES_PROSPECTO.includes(volumenMensajes)) return res.status(400).json({ error: 'Selecciona una opción válida de volumen de mensajes.' });

      // Solo se aceptan los campos esperados -- cualquier otra clave en el
      // body se ignora silenciosamente (nunca se persiste "tal cual").
      const ipHash = createHmac('sha256', PANEL_SECRET).update(String(req.ip || '')).digest('hex');
      const userAgentResumen = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 160) : null;

      const { creado, prospecto } = await crearProspectoComercial({
        nombre, negocio, ciudad, telefono, tipoNegocio,
        volumenMensajes: volumenMensajes || null, comentario, origen: 'landing',
        ipHash, userAgentResumen,
      });

      if (creado) {
        // Notificación asíncrona -- no se espera (await) su resultado
        // porque nunca debe demorar ni condicionar la respuesta 201; el
        // prospecto ya quedó guardado antes de esta línea.
        enviarNotificacionNuevoProspecto({
          id: prospecto.id, nombre, negocio, ciudad, telefono, tipoNegocio,
          volumenMensajes, comentario, createdAt: prospecto.created_at,
        }).then(r => marcarCorreoProspectoEnviado(prospecto.id, !!r.enviado))
          .catch(e => console.error('[Leads] Error notificando prospecto (registro ya guardado):', e.message));
      }

      res.status(201).json({ ok: true, message: 'Recibimos tus datos. Nos pondremos en contacto contigo.' });
    } catch (e) {
      console.error('[Leads] Error al procesar prospecto:', e.message);
      res.status(500).json({ error: 'No pudimos procesar tu solicitud. Intenta de nuevo más tarde.' });
    }
  }
);

// Chat de prueba (sin Twilio)
app.post('/chat', async (req, res) => {
  const { sessionId, mensaje } = req.body;
  if (!sessionId || !mensaje) {
    return res.status(400).json({ error: 'Se requiere sessionId y mensaje' });
  }

  try {
    const resultado = await procesarMensaje(sessionId, mensaje);

    if (resultado.orden) {
      const pedido = await registrarPedido(resultado.orden, 'api');
      emitirPedido(pedido).catch(e => console.error(`[Pedido] emitirPedido(${pedido.id}) fallo sin emitir efectos externos: ${e.message}`));
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
app.get('/pedidos', requireAuthSeguro, requireModulo('pos'), (req, res) => {
  res.json(obtenerPedidos(req.negocioId));
});

// Cambiar estado de un pedido (desde el panel)
// Fase 6: un pedido inexistente y un pedido de otro negocio responden
// exactamente igual (404 genérico) para no revelar si el folio existe en
// otro negocio -- ver actualizarEstadoPedido en orderManager.js, que ya
// devuelve null en ambos casos.
app.patch('/pedidos/:id/estado', requireAuthSeguro, requireModulo('pos'), async (req, res) => {
  const { estado } = req.body;
  const estadosValidos = ['nuevo', 'en_preparacion', 'listo', 'entregado'];
  if (!estadosValidos.includes(estado)) {
    return res.status(400).json({ error: 'Estado inválido' });
  }
  let pedido;
  try {
    pedido = actualizarEstadoPedido(req.params.id, estado, req.negocioId);
  } catch (e) {
    // Invariante tienda_online (orderManager): un pedido de la tienda en
    // línea sin pagar no puede moverse a cocina desde el panel.
    if (e.codigo === 'PAGO_PENDIENTE') {
      return res.status(409).json({ error: e.message, codigo: 'PAGO_PENDIENTE' });
    }
    throw e;
  }
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
        // Fase A: credenciales propias del negocio de la sesión -- nunca
        // caché global. Sin integración propia, se omite en silencio
        // (nunca bloquea el cambio de estado del pedido, ya confirmado arriba).
        const credenciales = await obtenerCredencialesWhatsappNegocio(req.negocioId);
        if (credenciales) {
          await enviarMensaje(tel, msg, credenciales);
          console.log(`[Panel] Notificación "listo" enviada a ${tel} para ${pedido.id}`);
        } else {
          console.log(`[Panel] Notificación "listo" omitida — sin integración propia para negocio ${req.negocioId}`);
        }
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
// ─── Módulo de restaurante: mesas, meseros, comandas, pagos divididos ───────
// (Frente C). Roles con el vocabulario actual (admin/staff): mesero=staff
// (abrir mesa, agregar, enviar comanda, ver mesas), caja/encargado=staff
// (cobrar, dividir, mover, cerrar -- hoy staff cubre ambos papeles),
// admin (cancelar items, reabrir, configurar). La separación fina
// mesero/caja llegará con la arquitectura de roles futura -- documentada,
// no bloqueada por este MVP. Todo gateado por requireModulo('restaurante').
function manejarErrorRestaurante(res, e) {
  const mapa = {
    MESA_OCUPADA: 409, CUENTA_NO_ENCONTRADA: 404, CUENTA_NO_ABIERTA: 409,
    SIN_ITEMS_PENDIENTES: 409, SALDO_PENDIENTE: 409, PAGO_EXCEDE_SALDO: 409,
    METODO_NO_HABILITADO: 400, MONTO_INVALIDO: 400, MESA_INVALIDA: 400,
    MESERO_INVALIDO: 400, ITEM_INVALIDO: 400, SIN_ITEMS: 400,
    MOTIVO_REQUERIDO: 400, ITEM_NO_CANCELABLE: 409, PARTES_INVALIDAS: 400,
    VENTA_CONTABILIZADA: 409, SIN_VENTA_QUE_REVERTIR: 409,
  };
  const status = mapa[e.code];
  if (status) return res.status(status).json({ error: e.message, code: e.code });
  // Modificadores de menu: mismas reglas que en POS (una sola implementacion).
  if (e instanceof ModificadoresError) return res.status(400).json({ error: e.message, code: e.codigo });
  console.error('[Restaurante] Error:', e.message);
  return res.status(500).json({ error: 'Error interno del módulo de restaurante' });
}

app.get('/api/restaurante/mesas', requireOperacionRestaurante, requireModulo('restaurante'), async (req, res) => {
  try { res.json(await listarMesas(req.negocioId)); } catch (e) { manejarErrorRestaurante(res, e); }
});

// Personas que pueden atender una mesa en este negocio (para el selector).
// Nunca expone PIN ni hash: solo id, nombre, rol y si tiene PIN configurado.
app.get('/api/restaurante/meseros', requireOperacionRestaurante, requireModulo('restaurante'), async (req, res) => {
  try {
    const meseros = await listarMeserosDelNegocio(req.negocioId);
    // El usuario de la sesión solo se sugiere si REALMENTE pertenece a este
    // negocio: un superadmin en sesión de soporte no puede autoasignarse.
    // En sesión de estación no hay nada que elegir: el mesero ya se identificó
    // con su PIN al entrar.
    // El nombre del negocio y el de quien opera son datos que esa persona ya
    // tiene delante (está dentro del local, con su sesión abierta): sirven
    // para que la barra diga "Xabor · Restaurante — <negocio>" y "Mesero:
    // <nombre>" sin pedir otra ruta del panel, que un mesero no puede usar.
    const { rows: neg } = await pool.query('SELECT nombre FROM negocios WHERE id = $1', [req.negocioId]);
    const negocio = neg[0]?.nombre || null;
    if (req.esMesero) {
      return res.json({
        meseros: [], sugerido: req.usuarioId, sesionMesero: true,
        negocio, yo: { id: req.usuarioId, nombre: req.meseroNombre || null },
      });
    }
    const propio = await esMiembroActivoDelNegocio(req.usuarioId, req.negocioId);
    const yo = propio ? (meseros.find(m => m.id === req.usuarioId) || null) : null;
    res.json({
      meseros, sugerido: propio ? req.usuarioId : null, sesionMesero: false,
      negocio, yo: yo ? { id: yo.id, nombre: yo.nombre } : null,
    });
  } catch (e) { manejarErrorRestaurante(res, e); }
});

app.post('/api/restaurante/mesas/abrir', requireOperacionRestaurante, requireModulo('restaurante'), async (req, res) => {
  const { mesa, personas, meseroUsuarioId, pin } = req.body || {};
  try {
    // Quién queda registrado como mesero -- decidido SIEMPRE en el servidor:
    //  a) sin mesero explícito: solo puede ser el usuario de la sesión, y
    //     solo si de verdad pertenece a este negocio. Un superadmin operando
    //     por soporte no pertenece, así que debe elegir un mesero local en
    //     vez de quedar él registrado en un tenant ajeno.
    //  b) el propio usuario de la sesión: ya está autenticado, no pide PIN.
    //  c) cualquier otro mesero del negocio: exige su PIN.
    // Sesión de estación: el mesero es quien está autenticado; no se le
    // vuelve a preguntar ni se acepta que abra a nombre de otro.
    if (req.esMesero) {
      const cuenta = await abrirMesa(req.negocioId, {
        mesaNumero: mesa, personas, meseroUsuarioId: req.usuarioId, abiertaPor: req.usuarioId,
      });
      return res.status(201).json({ ok: true, cuenta });
    }
    const propio = await esMiembroActivoDelNegocio(req.usuarioId, req.negocioId);
    let meseroId = meseroUsuarioId;
    if (!meseroId) {
      if (!propio) {
        return res.status(400).json({
          error: 'Selecciona el mesero que abre la mesa',
          code: 'MESERO_REQUERIDO',
        });
      }
      meseroId = req.usuarioId;
    } else if (meseroId !== req.usuarioId) {
      const pinOk = await verificarPinMesero(meseroId, req.negocioId, pin);
      if (!pinOk) {
        // Si es alguien de ESTE negocio pero todavía sin PIN, se dice con
        // claridad (es un problema de configuración, no un intento fallido).
        // Para cualquier otro caso el mensaje es el genérico: un usuario de
        // otro negocio y un PIN equivocado se ven igual desde afuera.
        if (await esMiembroActivoDelNegocio(meseroId, req.negocioId)) {
          const { rows } = await pool.query('SELECT pin_hash FROM usuarios WHERE id = $1', [meseroId]);
          if (rows.length && !rows[0].pin_hash) {
            return res.status(400).json({
              error: 'Ese usuario todavía no tiene PIN. Créaselo en Usuarios o abre la mesa con tu propia sesión.',
              code: 'MESERO_SIN_PIN',
            });
          }
        }
        // Mismo mensaje para PIN incorrecto y para un usuario que no es de
        // este negocio: desde afuera no se distingue qué falló.
        console.warn(`[Restaurante] PIN de mesero rechazado negocio=${req.negocioId} mesa=${mesa}`);
        return res.status(401).json({ error: 'PIN incorrecto', code: 'PIN_INCORRECTO' });
      }
    }
    const cuenta = await abrirMesa(req.negocioId, {
      mesaNumero: mesa, personas,
      meseroUsuarioId: meseroId,
      abiertaPor: req.usuarioId,
    });
    res.status(201).json({ ok: true, cuenta });
  } catch (e) { manejarErrorRestaurante(res, e); }
});

app.get('/api/restaurante/cuentas/:cuentaId', requireOperacionRestaurante, requireModulo('restaurante'), async (req, res) => {
  try {
    const cuenta = await obtenerCuenta(req.params.cuentaId, req.negocioId);
    if (!cuenta) return res.status(404).json({ error: 'Cuenta no encontrada' });
    res.json(cuenta);
  } catch (e) { manejarErrorRestaurante(res, e); }
});

app.post('/api/restaurante/cuentas/:cuentaId/items', requireOperacionRestaurante, requireModulo('restaurante'), async (req, res) => {
  try {
    // Dos caminos, misma cuenta:
    //  - item del MENU (producto_id): el servidor resuelve nombre, precio y
    //    modificadores desde la base -- identico a POS, sin implementacion
    //    divergente. El precio que mande el frontend se ignora.
    //  - item libre (producto + precio_unitario): flujo manual de siempre,
    //    para lo que no esta en el menu.
    const crudos = Array.isArray(req.body?.items) ? req.body.items : [];
    const items = [];
    for (const it of crudos) {
      if (it && (it.producto_id !== undefined && it.producto_id !== null && it.producto_id !== '')) {
        const r = await resolverProductoConModificadores(req.negocioId, it.producto_id, it.modificadores);
        const notasLibres = String(it.notas || '').slice(0, 300);
        items.push({
          producto: r.producto.nombre,
          cantidad: it.cantidad,
          precio_unitario: r.precioUnitario,
          modificadores: r.modificadores.map(m => `${m.grupo}: ${m.opcion}`),
          notas: notasLibres || null,
        });
      } else {
        items.push(it);
      }
    }
    const guardados = await agregarItems(req.params.cuentaId, req.negocioId, items, req.usuarioId);
    res.json({ ok: true, items: guardados });
  } catch (e) { manejarErrorRestaurante(res, e); }
});

app.post('/api/restaurante/cuentas/:cuentaId/comanda', requireOperacionRestaurante, requireModulo('restaurante'), async (req, res) => {
  try {
    const comanda = await enviarComanda(req.params.cuentaId, req.negocioId, req.usuarioId);

    // Xabor Edge PRIMERO: se crean trabajos persistentes, uno por impresora
    // destino según las reglas de routing. Un negocio con estaciones las
    // reparte; uno con una sola impresora de cocina recibe la ronda entera.
    const impresion = await crearTrabajosDeComanda({
      negocioId: req.negocioId, cuentaId: req.params.cuentaId, comanda,
    });
    await entregarTrabajos(impresion.creados);
    const edgeSeHizoCargo = impresion.creados.length + impresion.duplicados.length > 0;

    // Y el camino anterior SOLO si Edge no se hizo cargo. Antes corrían los
    // dos siempre: un negocio con print-agent.js viejo Y Edge configurado
    // sacaba la misma ronda dos veces en la misma cocina.
    //
    // Contrato C8 sobre printRouter -- nunca lanza; si el negocio no tiene
    // impresión configurada, el resultado es 'omitido' y la comanda digital
    // sigue siendo la fuente de verdad.
    if (!edgeSeHizoCargo) {
      await emitirTrabajoImpresion({
        id: `MESA${comanda.mesa}-C${comanda.comanda}`,
        negocioId: req.negocioId,
        canal: 'restaurante',
        tipo_comanda: comanda.tipo,
        mesa: comanda.mesa, personas: comanda.personas, mesero: comanda.mesero,
        items: comanda.items.map(i => ({ nombre: i.producto, cantidad: i.cantidad, precio_unitario: Number(i.precio_unitario), notas: [i.notas, ...(Array.isArray(i.modificadores) ? i.modificadores : [])].filter(Boolean).join(', ') })),
        total: comanda.items.reduce((s, i) => s + i.cantidad * Number(i.precio_unitario), 0),
        cliente: { nombre: `Mesa ${comanda.mesa}` },
        modalidad: 'mesa',
        estado: 'nuevo',
      });
    }

    // La respuesta lleva el aviso, no un error: la ronda YA está guardada y
    // el mesero necesita seguir trabajando. Si falta configurar una
    // impresora, se dice, pero no se le devuelve un fallo.
    res.json({
      ok: true, ...comanda,
      impresion: {
        trabajos: impresion.creados.length,
        duplicados: impresion.duplicados.length,
        sinRuta: impresion.sinRuta,
        avisos: impresion.avisos,
      },
    });
  } catch (e) { manejarErrorRestaurante(res, e); }
});

// Cancelar un item exige rol admin y motivo -- queda auditado quién agregó,
// quién canceló y por qué. Si el item ya había salido a cocina, se emite la
// comanda de cancelación (solo ese item).
app.post('/api/restaurante/cuentas/:cuentaId/items/:itemId/cancelar', requireAdminSeguro, requireModulo('restaurante'), async (req, res) => {
  try {
    const item = await cancelarItem(req.params.itemId, req.params.cuentaId, req.negocioId, req.usuarioId, req.body?.motivo);
    if (item.ya_enviado) {
      await emitirTrabajoImpresion({
        id: `CANCEL-${String(item.id).slice(0, 8)}`,
        negocioId: req.negocioId,
        canal: 'restaurante',
        tipo_comanda: 'cancelacion',
        items: [{ nombre: `CANCELADO: ${item.producto}`, cantidad: item.cantidad, precio_unitario: 0, notas: req.body?.motivo || '' }],
        total: 0, cliente: { nombre: 'Cocina' }, modalidad: 'mesa', estado: 'nuevo',
      });
    }
    res.json({ ok: true, item });
  } catch (e) { manejarErrorRestaurante(res, e); }
});

app.post('/api/restaurante/cuentas/:cuentaId/pagos', requireAuthSeguro, requireModulo('restaurante'), async (req, res) => {
  try {
    const r = await registrarPago(req.params.cuentaId, req.negocioId, req.body || {}, req.usuarioId);
    res.json({ ok: true, ...r });
  } catch (e) { manejarErrorRestaurante(res, e); }
});

// División en partes iguales -- cálculo de solo lectura (los cobros reales
// se registran uno a uno con /pagos, cada quien con su método).
app.get('/api/restaurante/cuentas/:cuentaId/dividir', requireOperacionRestaurante, requireModulo('restaurante'), async (req, res) => {
  try {
    const cuenta = await obtenerCuenta(req.params.cuentaId, req.negocioId);
    if (!cuenta) return res.status(404).json({ error: 'Cuenta no encontrada' });
    const partes = dividirEnPartesIguales(cuenta.saldo, req.query.partes || cuenta.personas);
    res.json({ saldo: cuenta.saldo, partes });
  } catch (e) { manejarErrorRestaurante(res, e); }
});

app.post('/api/restaurante/cuentas/:cuentaId/cerrar', requireAuthSeguro, requireModulo('restaurante'), async (req, res) => {
  try {
    const r = await cerrarCuenta(req.params.cuentaId, req.negocioId, req.usuarioId);
    // Ticket final de cuenta (tipo 'cuenta_final'): UNA sola vez, solo cuando
    // este request fue el que cerró (un reintento idempotente responde
    // yaCerrada y NO reimprime). Nunca reimprime comandas de cocina, y usa
    // el contrato C8 (printRouter no lanza; sin impresora => 'omitido').
    if (!r.yaCerrada) {
      const cuenta = await obtenerCuenta(req.params.cuentaId, req.negocioId);

      // Xabor Edge: la cuenta va SOLO a las impresoras declaradas para el
      // documento 'cuenta' (normalmente la de tickets, junto a la caja).
      // Nunca hereda las reglas de categoría, así que jamás aparece en
      // cocina -- eso está garantizado por destinosDeDocumento().
      const impresionCuenta = await crearTrabajosDeDocumento({
        negocioId: req.negocioId,
        documento: 'cuenta',
        origenTipo: 'restaurante_cuenta',
        origenId: String(r.ventaFolio),
        payload: {
          negocio: cuenta?.negocioNombre || null,
          mesa: cuenta?.mesa, personas: cuenta?.personas, mesero: cuenta?.mesero?.nombre,
          folio: r.ventaFolio,
          items: (cuenta?.items || []).filter(i => i.estado !== 'cancelado').map(i => ({
            producto: i.producto, cantidad: i.cantidad, precioUnitario: Number(i.precio_unitario),
            modificadores: Array.isArray(i.modificadores) ? i.modificadores : [],
          })),
          subtotal: r.total, propina: r.propinas, total: r.total, pagos: r.pagos,
        },
      });
      await entregarTrabajos(impresionCuenta.creados);
      const edgeSeHizoCargoDeLaCuenta =
        impresionCuenta.creados.length + impresionCuenta.duplicados.length > 0;

      // El ticket por el camino anterior SOLO si Edge no lo tomó. Los dos
      // caminos corrían siempre en la misma petición: en cuanto alguien
      // asignara una impresora al destino "Caja", el cliente recibía dos
      // tickets del mismo cierre.
      if (!edgeSeHizoCargoDeLaCuenta) await emitirTrabajoImpresion({
        id: r.ventaFolio,
        negocioId: req.negocioId,
        canal: 'restaurante',
        tipo_comanda: 'cuenta_final',
        mesa: cuenta?.mesa, personas: cuenta?.personas, mesero: cuenta?.mesero?.nombre,
        items: (cuenta?.items || []).filter(i => i.estado !== 'cancelado').map(i => ({
          nombre: i.producto, cantidad: i.cantidad, precio_unitario: Number(i.precio_unitario),
          notas: [i.notas, ...(Array.isArray(i.modificadores) ? i.modificadores : [])].filter(Boolean).join(', '),
        })),
        total: r.total,
        propina: r.propinas,
        pagos: r.pagos,
        folio_venta: r.ventaFolio,
        cliente: { nombre: `Mesa ${cuenta?.mesa ?? ''}`.trim() },
        modalidad: 'mesa',
        estado: 'entregado',
      });
    }
    res.json(r);
  } catch (e) { manejarErrorRestaurante(res, e); }
});

app.post('/api/restaurante/cuentas/:cuentaId/mover', requireOperacionRestaurante, requireModulo('restaurante'), async (req, res) => {
  try { res.json({ ok: true, cuenta: await moverMesa(req.params.cuentaId, req.negocioId, req.body?.mesa) }); }
  catch (e) { manejarErrorRestaurante(res, e); }
});

app.post('/api/restaurante/cuentas/:cuentaId/reabrir', requireAdminSeguro, requireModulo('restaurante'), async (req, res) => {
  try { res.json({ ok: true, cuenta: await reabrirCuenta(req.params.cuentaId, req.negocioId) }); }
  catch (e) { manejarErrorRestaurante(res, e); }
});

// ─── Xabor Edge: administración de impresión ────────────────────────────────
//
// Todo lo de aquí exige sesión de administrador del negocio y toma el
// negocioId de la SESIÓN, nunca del cuerpo del request: un administrador de
// un restaurante no puede tocar las impresoras de otro aunque conozca sus
// uuid. Cada servicio vuelve a comprobar la pertenencia por su cuenta.
function manejarErrorImpresion(res, e) {
  const mapa = {
    TENANT_CONTEXT_REQUIRED: 401,
    TERMINAL_NO_ENCONTRADA: 404,
    IMPRESORA_NO_ENCONTRADA: 404,
    RUTA_NO_ENCONTRADA: 404,
    TRABAJO_NO_ENCONTRADO: 404,
    NOMBRE_DUPLICADO: 409,
    RUTA_DUPLICADA: 409,
    IMPRESORA_INACTIVA: 409,
    TRABAJO_NO_PERSISTIDO: 500,
  };
  const status = mapa[e.code] || 400;
  if (status >= 500) console.error(`[Impresion] ${e.code}: ${e.message}`);
  res.status(status).json({ error: e.message, code: e.code || null });
}

// ── Dispositivos Edge y su credencial ──
// ─── Config → Impresoras (self-service del negocio) ─────────────────────────
//
// Mismo guardia que el resto de /api/impresion: requireAdminSeguro resuelve el
// negocio desde la SESIÓN. Ningún endpoint de aquí lee negocio_id del cuerpo,
// de la query ni de la URL -- por eso un admin de Carnitas no puede nombrar
// una terminal de Mapolato ni aunque conozca su uuid: la validación no compara
// contra lo que mandó, compara contra lo que su sesión dice que es.

app.get('/api/impresion/self-service', requireAdminSeguro, async (req, res) => {
  try {
    res.json(await estadoImpresorasNegocio(req.negocioId, { pedirImpresoras: pedirImpresorasATerminal }));
  } catch (e) {
    console.error('[Impresion] self-service estado:', e.message);
    res.status(500).json({ error: 'No pudimos leer la configuración de tus impresoras' });
  }
});

app.post('/api/impresion/self-service/asignar', requireAdminSeguro, async (req, res) => {
  // `destinos` (array) = multidestino; `destino` (string) sigue aceptado.
  const { terminalId, nombreWindows, destino, destinos, anchoMm } = req.body || {};
  try {
    const r = await asignarImpresora(req.negocioId, { terminalId, nombreWindows, destino, destinos, anchoMm });
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json(r);
  } catch (e) {
    console.error('[Impresion] self-service asignar:', e.message);
    res.status(500).json({ error: 'No pudimos guardar la configuración de la impresora' });
  }
});

// Apaga sin borrar: la impresora puede estar simplemente desconectada hoy y
// el negocio no debería perder su asignación por eso.
app.post('/api/impresion/self-service/impresoras/:id/desactivar', requireAdminSeguro, async (req, res) => {
  try {
    const r = await desactivarImpresora(req.negocioId, req.params.id);
    if (!r.ok) return res.status(404).json({ error: r.error });
    res.json(r);
  } catch (e) {
    manejarErrorImpresion(res, e);
  }
});

// Prueba física ANTES de asignar destino. Con dos impresoras del mismo
// modelo ("POS58 Printer" y "POS58 Printer (Copy 1)"), la única forma
// honesta de saber cuál es cuál es imprimir y ver cuál soltó papel -- y eso
// tiene que poder hacerse ANTES de decidir Cocina/Caja, no después. Registra
// la impresora sin destino (upsert idempotente) y le manda la página de
// prueba.
app.post('/api/impresion/self-service/probar', requireAdminSeguro, async (req, res) => {
  const { terminalId, nombreWindows, anchoMm } = req.body || {};
  try {
    // anchoMm pasa tal cual (puede venir vacío): la prueba NUNCA fuerza un
    // ancho -- con `|| 58` cada "imprimir prueba" reseteaba a 58 mm una
    // impresora ya configurada en 80 (el panel no manda ancho al probar).
    const reg = await registrarImpresoraParaPrueba(req.negocioId, { terminalId, nombreWindows, anchoMm: anchoMm ?? null });
    if (!reg.ok) return res.status(400).json({ error: reg.error });
    const trabajo = await crearTrabajoDePrueba(req.negocioId, reg.impresoraId, { solicitadoPor: req.usuarioId });
    await entregarTrabajos([trabajo]);
    res.status(201).json({ ok: true, impresoraId: reg.impresoraId });
  } catch (e) {
    console.error('[Impresion] self-service probar:', e.message);
    res.status(500).json({ error: 'No pudimos enviar la prueba a esa impresora' });
  }
});

// "No usar": quita el destino y desactiva, identificando la impresora por el
// nombre de Windows que el dueño ve -- nunca por un id interno.
app.post('/api/impresion/self-service/quitar', requireAdminSeguro, async (req, res) => {
  const { terminalId, nombreWindows } = req.body || {};
  try {
    const r = await quitarImpresora(req.negocioId, { terminalId, nombreWindows });
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json(r);
  } catch (e) {
    console.error('[Impresion] self-service quitar:', e.message);
    res.status(500).json({ error: 'No pudimos quitar esa impresora' });
  }
});

// De dónde se descarga el instalador de Xabor Edge. La URL vive en una
// variable de entorno (no en el repo: el binario pesa ~30 MB y se publica
// aparte). Si no está configurada, el panel lo dice con honestidad en vez de
// mostrar un botón muerto.
app.get('/api/impresion/self-service/descarga', requireAdminSeguro, (req, res) => {
  const url = (process.env.XABOR_EDGE_SETUP_URL || '').trim();
  res.json({ disponible: Boolean(url), url: url || null });
});

app.get('/api/impresion/edges', requireAdminSeguro, async (req, res) => {
  try { res.json({ edges: await listarEdges(req.negocioId) }); }
  catch (e) { manejarErrorImpresion(res, e); }
});

app.post('/api/impresion/edges', requireAdminSeguro, async (req, res) => {
  try { res.status(201).json({ ok: true, edge: await crearEdge(req.negocioId, req.body || {}) }); }
  catch (e) { manejarErrorImpresion(res, e); }
});

// Devuelve el código EN CLARO una sola vez. No se guarda: si se pierde, se
// genera otro. Se responde con no-store para que ningún proxy lo cachee.
app.post('/api/impresion/edges/:id/emparejar', requireAdminSeguro, async (req, res) => {
  try {
    const r = await generarEmparejamiento(req.negocioId, req.params.id, { usuarioId: req.usuarioId });
    res.set('Cache-Control', 'no-store');
    res.status(201).json({ ok: true, ...r });
  } catch (e) { manejarErrorImpresion(res, e); }
});

app.post('/api/impresion/edges/:id/revocar', requireAdminSeguro, async (req, res) => {
  try { res.json(await revocarCredencial(req.negocioId, req.params.id)); }
  catch (e) { manejarErrorImpresion(res, e); }
});

// PÚBLICO por necesidad: el Edge todavía no tiene credencial cuando llama
// aquí -- eso es justo lo que viene a obtener. Lo que lo protege es el
// código: de un solo uso, con caducidad de minutos, buscado por hash y
// canjeado de forma atómica. Con límite de intentos por IP para que nadie
// pruebe códigos a lo bruto.
app.post('/api/edge/emparejar', rateLimitMiddleware(req => `edge-emparejar:${req.ip}`, 10, 15 * 60 * 1000), async (req, res) => {
  try {
    const r = await canjearEmparejamiento(req.body?.codigo || '');
    res.set('Cache-Control', 'no-store');
    res.status(201).json({ ok: true, ...r });
  } catch (e) {
    // Un solo mensaje para todos los motivos: no se revela si el código
    // existía, si ya se usó o si venció.
    console.warn(`[Edge] emparejamiento rechazado (${e.code || 'ERROR'})`);
    res.status(400).json({ error: 'Código de emparejamiento inválido o vencido' });
  }
});

app.get('/api/impresion/impresoras', requireAdminSeguro, async (req, res) => {
  try { res.json({ impresoras: await listarImpresoras(req.negocioId) }); }
  catch (e) { manejarErrorImpresion(res, e); }
});

app.post('/api/impresion/impresoras', requireAdminSeguro, async (req, res) => {
  try { res.status(201).json({ ok: true, impresora: await crearImpresora(req.negocioId, req.body || {}) }); }
  catch (e) { manejarErrorImpresion(res, e); }
});

app.patch('/api/impresion/impresoras/:id', requireAdminSeguro, async (req, res) => {
  try { res.json({ ok: true, impresora: await actualizarImpresora(req.negocioId, req.params.id, req.body || {}) }); }
  catch (e) { manejarErrorImpresion(res, e); }
});

app.get('/api/impresion/rutas', requireAdminSeguro, async (req, res) => {
  try { res.json({ rutas: await listarRutas(req.negocioId) }); }
  catch (e) { manejarErrorImpresion(res, e); }
});

app.post('/api/impresion/rutas', requireAdminSeguro, async (req, res) => {
  try { res.status(201).json({ ok: true, ruta: await crearRuta(req.negocioId, req.body || {}) }); }
  catch (e) { manejarErrorImpresion(res, e); }
});

app.delete('/api/impresion/rutas/:id', requireAdminSeguro, async (req, res) => {
  try { res.json(await eliminarRuta(req.negocioId, req.params.id)); }
  catch (e) { manejarErrorImpresion(res, e); }
});

// Prueba de impresora: pasa por la MISMA tubería que una comanda real
// (trabajo persistente -> entrega al Edge -> ACK). Si usara un atajo estaría
// probando un camino que la operación nunca recorre.
app.post('/api/impresion/impresoras/:id/prueba', requireAdminSeguro, async (req, res) => {
  try {
    const trabajo = await crearTrabajoDePrueba(req.negocioId, req.params.id, { solicitadoPor: req.usuarioId });
    await entregarTrabajos([trabajo]);
    res.status(201).json({ ok: true, trabajo: { id: trabajo.id, estado: trabajo.estado, impresora: trabajo.impresora_nombre } });
  } catch (e) { manejarErrorImpresion(res, e); }
});

app.get('/api/impresion/estado', requireAdminSeguro, async (req, res) => {
  try { res.json(await estadoImpresion(req.negocioId)); }
  catch (e) { manejarErrorImpresion(res, e); }
});

app.get('/api/impresion/trabajos', requireAdminSeguro, async (req, res) => {
  try { res.json({ trabajos: await listarTrabajos(req.negocioId, { limite: req.query.limite, estado: req.query.estado || null }) }); }
  catch (e) { manejarErrorImpresion(res, e); }
});

// Reimprimir crea un trabajo NUEVO que apunta al original; nunca resetea el
// viejo. Así queda registrado que hubo que reimprimir, quién lo pidió y por
// qué -- información que se perdería al reutilizar el trabajo anterior.
app.post('/api/impresion/trabajos/:id/reimprimir', requireAdminSeguro, async (req, res) => {
  try {
    const trabajo = await reimprimirTrabajo(req.negocioId, req.params.id, {
      usuarioId: req.usuarioId, motivo: req.body?.motivo || null,
    });
    await entregarTrabajos([trabajo]);
    res.status(201).json({ ok: true, trabajo: { id: trabajo.id, estado: trabajo.estado, original: trabajo.trabajo_original_id } });
  } catch (e) { manejarErrorImpresion(res, e); }
});

// Reverso de venta contabilizada (SOLO admin, motivo obligatorio): cancela
// la venta consolidada en reportes (estado 'cancelado' + auditoría en
// datos.cancelacion), reabre la cuenta y garantiza folio nuevo en un
// re-cierre (reversos+1). Es el ÚNICO camino para deshacer una cuenta ya
// contabilizada -- reabrir directo responde 409 VENTA_CONTABILIZADA.
app.post('/api/restaurante/cuentas/:cuentaId/revertir-venta', requireAdminSeguro, requireModulo('restaurante'), async (req, res) => {
  try { res.json(await revertirVentaCuenta(req.params.cuentaId, req.negocioId, req.usuarioId, req.body?.motivo)); }
  catch (e) { manejarErrorRestaurante(res, e); }
});

app.get('/api/restaurante/indicadores', requireAuthSeguro, requireModulo('restaurante'), async (req, res) => {
  try { res.json(await indicadoresRestaurante(req.negocioId)); } catch (e) { manejarErrorRestaurante(res, e); }
});

app.post('/api/pedido-presencial', requireAuthSeguro, requireModulo('pos'), async (req, res) => {
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
  // Items del MENU (producto_id): el servidor resuelve nombre, precio base y
  // modificadores desde la base del propio negocio -- el precio que mande el
  // frontend se ignora. Los items libres (sin producto_id) conservan el
  // comportamiento manual de siempre para lo que no esta en el menu.
  let itemsResueltos;
  try {
    itemsResueltos = [];
    for (const it of items) {
      if (it && it.producto_id !== undefined && it.producto_id !== null && it.producto_id !== '') {
        const r = await resolverProductoConModificadores(req.negocioId, it.producto_id, it.modificadores);
        const cantidad = Math.max(1, Math.min(99, parseInt(it.cantidad, 10) || 1));
        const notasLibres = String(it.notas || '').slice(0, 300);
        itemsResueltos.push({
          producto_id: r.producto.id,
          nombre: r.producto.nombre,
          cantidad,
          precio_unitario: r.precioUnitario,
          precio_base: r.precioBase,
          modificadores: r.modificadores,
          notas: [r.texto, notasLibres].filter(Boolean).join(' · ').slice(0, 400),
        });
      } else {
        itemsResueltos.push(it);
      }
    }
  } catch (e) {
    if (e instanceof ModificadoresError) return res.status(400).json({ error: e.message, codigo: e.codigo });
    console.error('[Panel] Error resolviendo items presenciales:', e.message);
    return res.status(500).json({ error: 'No se pudo preparar el pedido' });
  }
  const todosDelMenu = itemsResueltos.length > 0 && itemsResueltos.every(i => i && i.producto_id);
  items.length = 0;
  items.push(...itemsResueltos);
  const subtotal = items.reduce((s, i) => s + (i.precio_unitario || 0) * (i.cantidad || 1), 0);
  const desc     = parseFloat(descuento) || 0;
  // Si hay cliente Rewards asignado (teléfono real), usarlo como cliente
  // del pedido -- si no, un cliente técnico determinista por negocio (ver
  // idClienteTecnicoPresencial arriba), nunca el literal 'presencial'
  // global ni un valor que el cliente HTTP pueda controlar.
  const tieneTelefonoReal = !!rewards_telefono?.trim();
  const clienteTel = tieneTelefonoReal ? rewards_telefono.trim() : idClienteTecnicoPresencial(req.negocioId);
  const clienteNom = (tieneTelefonoReal ? (rewards_nombre || nombre) : (nombre || 'Cliente presencial')) || 'Cliente presencial';
  // ── Captura vs cobro (reingeniería UX) ──
  // Sin forma_pago (o 'por_cobrar' explícito) el pedido NACE ABIERTO: se
  // captura, imprime comanda y aparece en el tablero, pero el cobro completo
  // (forma de pago, descuento, billete/mixto, canje Rewards) ocurre después
  // vía PATCH /pedidos/:folio/cobro. Con forma_pago explícita se conserva el
  // flujo clásico intacto (crear = cobrar) por compatibilidad.
  const esPorCobrar = !forma_pago || forma_pago === 'por_cobrar';
  const orden = {
    items,
    subtotal,
    descuento: esPorCobrar ? 0 : desc,
    motivo_descuento: esPorCobrar ? null : (motivo_descuento || null),
    billete: esPorCobrar ? 0 : (parseFloat(billete) || 0),
    cambio: esPorCobrar ? 0 : (parseFloat(cambio) || 0),
    mixto_efectivo: esPorCobrar ? null : (parseFloat(mixto_efectivo) || null),
    mixto_terminal: esPorCobrar ? null : (parseFloat(mixto_terminal) || null),
    // Con un pedido 100% de menu el total lo fija el servidor (subtotal
    // recalculado - descuento): el frontend no puede mandar un total propio.
    // Con items libres se conserva el comportamiento manual de siempre.
    // Un por_cobrar nace con total = subtotal (sin descuento ni canje): el
    // total FINAL lo fija el servidor al cobrar.
    total: esPorCobrar
      ? Math.round(subtotal * 100) / 100
      : (todosDelMenu ? Math.round((subtotal - desc) * 100) / 100 : (total ?? (subtotal - desc))),
    modalidad: 'recoger en tienda',
    canal: 'presencial',
    forma_pago: esPorCobrar ? 'por_cobrar' : forma_pago,
    ...(esPorCobrar ? { pago_confirmado: false } : {}),
    cliente: { nombre: clienteNom, telefono: clienteTel },
    costo_envio: 0,
    negocioId: req.negocioId
  };
  // Rewards en pedido abierto: el canje se RESERVA como intención pero solo
  // se CONSUME al cobrar con éxito — cancelar antes del cobro nunca quema
  // puntos. (En el flujo clásico el canje sigue consumiéndose al crear.)
  const puntosIntencion = parseInt(rewards_canje_puntos) || 0;
  if (esPorCobrar && puntosIntencion > 0 && rewards_telefono?.trim()) {
    orden.rewards_pendiente = { telefono: rewards_telefono.trim(), nombre: rewards_nombre || null, puntos: puntosIntencion };
  }
  let pedido;
  try {
    pedido = await registrarPedido(orden, 'presencial');
  } catch (e) {
    console.error('[Panel] Error registrando pedido presencial:', e.message);
    return res.status(500).json({ error: 'No se pudo registrar el pedido' });
  }
  emitirPedido(pedido).catch(e => console.error(`[Pedido] emitirPedido(${pedido.id}) fallo sin emitir efectos externos: ${e.message}`));
  // Persistencia en el historial (tabla pedidos) -- AWAITED antes de
  // responder (antes corría en segundo plano). Contrato de la reingeniería:
  // cuando el frontend recibe el OK de creación, TODA la persistencia del
  // pedido ya está confirmada — el cobro inmediato (PATCH /pedidos/:folio/
  // cobro) nunca puede correr contra una fila que aún no existe. La fila
  // operativa (pedidos_activos, la que usa el cobro/corte/historial) ya la
  // escribió registrarPedido de forma síncrona; esto cubre además la fila
  // de archivo. Si el archivo falla, se loguea sin tumbar la creación (el
  // pedido operativo es válido; el espejo del cobro sobre `pedidos` es
  // best-effort).
  // Orden: upsertCliente ANTES de guardarPedido (FK pedidos.telefono →
  // clientes.telefono, hallazgo de fase anterior); se pasa "pedido" (no
  // "orden") porque solo el objeto de registrarPedido trae el folio.
  try {
    const { upsertCliente, guardarPedido } = await import('./services/database.js');
    await upsertCliente(clienteTel, clienteNom, pedido.negocioId);
    await guardarPedido(clienteTel, pedido, pedido.negocioId);
  } catch (e) {
    console.error('[Panel] Error persistiendo pedido presencial en historial:', e.message);
  }

  // Rewards — canje inmediato SOLO en el flujo clásico (crear = cobrar).
  // En un pedido por_cobrar el canje quedó como intención (rewards_pendiente)
  // y lo consume el endpoint de cobro.
  let canjeInfo = null;
  const puntosACanjear = esPorCobrar ? 0 : (parseInt(rewards_canje_puntos) || 0);
  if (puntosACanjear > 0 && rewards_telefono?.trim()) {
    try {
      canjeInfo = await registrarCanje(pedido.id, rewards_telefono.trim(), puntosACanjear, 'operador', req.negocioId);
    } catch (e) {
      console.error(`[Rewards] ❌ Error en canje POS (${pedido.id}):`, e.message);
      // El pedido ya fue registrado — devolvemos advertencia pero no fallamos
      return res.json({ ok: true, pedido, rewards_warning: e.message });
    }
  }

  res.json({ ok: true, pedido, canje: canjeInfo });
});

// ── Cobro de un pedido abierto (reingeniería UX: captura ≠ cobro) ───────────
// Cierra el ciclo de un pedido creado como por_cobrar: el SERVIDOR recalcula
// subtotal desde los items persistidos, autoriza el descuento (staff ≤ 10%,
// misma regla que el POS aplicaba solo en frontend), consume el canje Rewards
// reservado (idempotente por folio) y fija el total final. Transaccional e
// idempotente (cobrarPedidoActivo: FOR UPDATE + regate): doble click = un
// solo cobro; el reintento recibe yaCobrado. NO imprime nada: la comanda
// salió al crear y el ticket sigue siendo manual.
// Staff puede cobrar (requireAuthSeguro + módulo pos): es el mismo rol que
// hoy cobra al crear en mostrador. negocioId EXCLUSIVAMENTE de la sesión.
app.patch('/pedidos/:folio/cobro', requireAuthSeguro, requireModulo('pos'), async (req, res) => {
  if (typeof req.negocioId !== 'string' || !req.negocioId.trim()) {
    return res.status(401).json({ error: 'Sesión inválida — no se pudo determinar el negocio' });
  }
  const { folio } = req.params;
  const { forma_pago, descuento, motivo_descuento, billete, mixto_efectivo, mixto_terminal } = req.body || {};
  const FORMAS_COBRO = ['efectivo', 'terminal (tarjeta presente)', 'mixto'];
  if (!FORMAS_COBRO.includes(forma_pago)) {
    return res.status(400).json({ error: 'forma_pago inválida (efectivo, terminal (tarjeta presente) o mixto)' });
  }

  const { obtenerPedidoActivoParaCobro, cobrarPedidoActivo } = await import('./services/database.js');
  const fila = await obtenerPedidoActivoParaCobro(folio, req.negocioId);
  if (!fila) return res.status(404).json({ error: 'Pedido no encontrado' });
  if (fila.estado === 'cancelado') return res.status(409).json({ error: 'El pedido está cancelado' });
  const datos = fila.datos || {};
  if (datos.pago_confirmado === true) {
    return res.json({ ok: true, yaCobrado: true, folio, forma_pago: datos.forma_pago, total: datos.total });
  }

  // Subtotal REAL: recalculado de los items persistidos — el cliente nunca
  // decide el total final.
  const items = Array.isArray(datos.items) ? datos.items : [];
  const subtotal = Math.round(items.reduce((s, i) =>
    s + (parseFloat(i.precio_unitario) || 0) * (Math.max(1, parseInt(i.cantidad, 10) || 1)), 0) * 100) / 100;

  // Descuento autorizado en servidor: mismas reglas que el POS (motivo
  // obligatorio; staff máximo 10% del subtotal — antes solo se validaba en
  // frontend, ahora el servidor la impone).
  const desc = Math.round((parseFloat(descuento) || 0) * 100) / 100;
  if (desc < 0 || desc > subtotal) return res.status(400).json({ error: 'Descuento inválido' });
  if (desc > 0 && !String(motivo_descuento || '').trim()) {
    return res.status(400).json({ error: 'El motivo del descuento es obligatorio' });
  }
  if (desc > 0 && req.rol !== 'admin' && desc > subtotal * 0.10 + 0.005) {
    return res.status(403).json({ error: 'El descuento máximo para staff es 10% del subtotal' });
  }

  // Canje Rewards reservado en la captura: se consume AQUÍ (registrarCanje es
  // idempotente por folio — un reintento no vuelve a mover puntos; el monto
  // original se recupera de rewards_movements).
  let canje = null;
  if (datos.rewards_pendiente?.puntos > 0 && datos.rewards_pendiente?.telefono) {
    try {
      canje = await registrarCanje(folio, datos.rewards_pendiente.telefono,
        parseInt(datos.rewards_pendiente.puntos, 10), 'operador', req.negocioId);
      if (!canje) canje = await obtenerCanjeDeFolio(folio, req.negocioId);
    } catch (e) {
      return res.status(400).json({ error: `Rewards: ${e.message}` });
    }
  }
  const montoCanje = canje ? (parseFloat(canje.monto) || 0) : 0;

  const totalFinal = Math.max(0, Math.round((subtotal - desc - montoCanje) * 100) / 100);

  // Pago: efectivo con billete/cambio o mixto que debe cubrir el total.
  let bil = 0, cam = 0, mEfe = null, mTer = null;
  if (forma_pago === 'mixto') {
    mEfe = Math.round((parseFloat(mixto_efectivo) || 0) * 100) / 100;
    mTer = Math.round((parseFloat(mixto_terminal) || 0) * 100) / 100;
    if (mEfe <= 0 || mTer <= 0) return res.status(400).json({ error: 'Pago mixto requiere monto en efectivo y en terminal' });
    if (mTer > totalFinal + 0.009) return res.status(400).json({ error: 'La parte en terminal no puede exceder el total' });
    if (mEfe + mTer < totalFinal - 0.009) return res.status(400).json({ error: 'El pago mixto no cubre el total' });
    bil = mEfe;
    cam = Math.round((mEfe + mTer - totalFinal) * 100) / 100;
  } else if (forma_pago === 'efectivo') {
    bil = Math.round((parseFloat(billete) || 0) * 100) / 100;
    if (bil > 0 && bil < totalFinal - 0.009) return res.status(400).json({ error: 'El billete no cubre el total' });
    cam = bil > 0 ? Math.round((bil - totalFinal) * 100) / 100 : 0;
  }

  const campos = {
    forma_pago,
    subtotal,
    descuento: desc,
    motivo_descuento: desc > 0 ? String(motivo_descuento).trim() : null,
    billete: bil,
    cambio: cam,
    mixto_efectivo: mEfe,
    mixto_terminal: mTer,
    total: totalFinal,
    pago_confirmado: true,
    cobrado_at: new Date().toISOString(),
    ...(canje ? { rewards_canje: { puntos: canje.puntos, monto: montoCanje } } : {}),
  };
  const r = await cobrarPedidoActivo(folio, req.negocioId, campos);
  if (r.error === 'no_encontrado') return res.status(404).json({ error: 'Pedido no encontrado' });
  if (r.error === 'cancelado') return res.status(409).json({ error: 'El pedido está cancelado' });
  if (r.error) return res.status(500).json({ error: 'No se pudo registrar el cobro' });
  if (r.yaCobrado) {
    return res.json({ ok: true, yaCobrado: true, folio, forma_pago: r.datos.forma_pago, total: r.datos.total });
  }

  // Memoria + tiempo real (mensajes WS existentes; SIN impresión nueva)
  const { obtenerPedidoPorId } = await import('./orders/orderManager.js');
  const p = obtenerPedidoPorId(folio, req.negocioId);
  if (p) Object.assign(p, {
    forma_pago, total: totalFinal, subtotal, descuento: desc,
    billete: bil, cambio: cam, mixto_efectivo: mEfe, mixto_terminal: mTer, pago_confirmado: true,
  });
  broadcastNegocio(req.negocioId, { tipo: 'actualizar_pago', id: folio, forma_pago });
  broadcastNegocio(req.negocioId, { tipo: 'pago_confirmado', pedidoId: folio });
  console.log(`[Panel] Pedido ${folio} COBRADO — ${forma_pago} $${totalFinal}`);
  res.json({
    ok: true, folio, forma_pago, subtotal, descuento: desc,
    canje: canje ? { puntos: canje.puntos, monto: montoCanje } : null,
    total: totalFinal, cambio: cam,
  });
});

// Eliminar pedido (pruebas / limpieza) — requiere contraseña de administrador
app.delete('/pedidos/:id', requireAuthSeguro, requireModulo('pos'), async (req, res) => {
  const pin = req.headers['x-admin-pin'];
  if (!pin || pin !== ADMIN_PASSWORD) {
    return res.status(403).json({ error: 'Contraseña de administrador incorrecta' });
  }
  const ok = await eliminarPedido(req.params.id, req.negocioId);
  if (!ok) return res.status(404).json({ error: 'Pedido no encontrado' });
  res.json({ ok: true });
});

// Actualizar forma de pago — solo admin
// negocioId OBLIGATORIO (Auditoría P0, Categoría B): un folio de otro
// negocio responde 404, idéntico a un folio inexistente -- nunca revela
// cuál de los dos casos ocurrió, nunca modifica nada ajeno.
app.patch('/api/admin/pedido/:folio/pago', requireAdminSeguro, requireModulo('pos'), async (req, res) => {
  const { folio } = req.params;
  const { forma_pago } = req.body;
  if (!forma_pago) return res.status(400).json({ error: 'forma_pago requerida' });
  const ok = await actualizarFormaPago(folio, forma_pago, req.negocioId);
  if (!ok) return res.status(404).json({ error: 'Pedido no encontrado' });
  // Actualizar en memoria si el pedido sigue activo
  const { obtenerPedidoPorId } = await import('./orders/orderManager.js');
  const p = obtenerPedidoPorId(folio, req.negocioId);
  if (p) p.forma_pago = forma_pago;
  broadcastNegocio(req.negocioId, { tipo: 'actualizar_pago', id: folio, forma_pago });
  res.json({ ok: true });
});

// Cancelar pedido activo — solo admin
app.post('/api/admin/pedido/:folio/cancelar', requireAdminSeguro, requireModulo('pos'), async (req, res) => {
  const { folio } = req.params;
  const { motivo } = req.body;
  if (!motivo?.trim()) return res.status(400).json({ error: 'Motivo requerido' });
  const ok = await cancelarPedidoActivo(folio, motivo.trim(), req.negocioId);
  if (!ok) return res.status(404).json({ error: 'Pedido no encontrado' });
  // Quitar del panel en tiempo real
  await eliminarPedido(folio, req.negocioId).catch(() => {});
  broadcastNegocio(req.negocioId, { tipo: 'cancelar_pedido', id: folio, motivo });
  console.log(`[Panel] Pedido ${folio} CANCELADO — ${motivo}`);
  // Rewards — revertir puntos del folio (fire-and-forget, nunca bloquea)
  revertirMovimientosFolio(folio, req.negocioId).catch(e =>
    console.error(`[Rewards] Error en reverso al cancelar ${folio}:`, e.message)
  );
  res.json({ ok: true });
});

// Registrar devolución en pedido entregado — solo admin
app.post('/api/admin/pedido/:folio/devolucion', requireAdminSeguro, requireModulo('pos'), async (req, res) => {
  const { folio } = req.params;
  const { monto, motivo } = req.body;
  if (!monto || parseFloat(monto) <= 0) return res.status(400).json({ error: 'Monto inválido' });
  if (!motivo?.trim()) return res.status(400).json({ error: 'Motivo requerido' });
  const ok = await registrarDevolucion(folio, parseFloat(monto), motivo.trim(), req.negocioId);
  if (!ok) return res.status(404).json({ error: 'Pedido no encontrado' });
  broadcastNegocio(req.negocioId, { tipo: 'devolucion_registrada', id: folio, monto: parseFloat(monto), motivo });
  console.log(`[Panel] Devolución ${folio}: $${monto} — ${motivo}`);
  res.json({ ok: true });
});

// Generar factura CFDI — solo admin
app.post('/api/admin/pedido/:folio/factura', requireAdminSeguro, requireModulo('facturacion'), async (req, res) => {
  const { folio } = req.params;
  const { nombre_fiscal, rfc, regimen, email, uso_cfdi, cp } = req.body;
  if (!nombre_fiscal || !rfc) return res.status(400).json({ error: 'nombre_fiscal y rfc son requeridos' });
  if (!process.env.FACTURAPI_KEY) return res.status(503).json({ error: 'FACTURAPI_KEY no configurada en Railway' });

  // Obtener datos del pedido
  const { obtenerPedidoActivoPorFolio } = await import('./services/database.js');
  const { obtenerPedidosEntregados: _ent } = await import('./services/database.js');
  // Buscar en activos primero, luego en entregados
  let pedidoDatos = await obtenerPedidoActivoPorFolio(folio, req.negocioId);
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
app.get('/api/admin/factura/:facturaId/pdf', requireAdminSeguro, requireModulo('facturacion'), async (req, res) => {
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
app.get('/api/conversaciones', requireAuthSeguro, requireModulo('whatsapp'), async (req, res) => {
  const lista = await obtenerConversacionesRecientes(req.negocioId, 20);
  res.json(lista);
});

app.get('/api/conversacion/:telefono', requireAuthSeguro, requireModulo('whatsapp'), async (req, res) => {
  const msgs = await obtenerConversacion(req.params.telefono, req.negocioId);
  res.json(msgs);
});

// Enviar mensaje manual desde el panel (link de pago, etc.)
// Fix de seguridad: antes enviarMensaje() se llamaba sin credenciales,
// usando siempre el caché global (hardcodeado a Nonna Maye) o env vars --
// CUALQUIER negocio con el módulo whatsapp habilitado habría enviado por
// el número real de Nonna Maye. Ahora se resuelven credenciales propias
// del negocio de sesión; sin ellas, el envío se rechaza (409) y nunca se
// intenta -- nunca hay fallback a Nonna Maye ni a env vars para este envío
// manual desde el panel.
app.post('/api/send-message', requireAuthSeguro, requireModulo('whatsapp'), async (req, res) => {
  const { telefono, mensaje } = req.body;
  if (!telefono || !mensaje) {
    return res.status(400).json({ error: 'Se requiere telefono y mensaje' });
  }
  const credenciales = await obtenerCredencialesWhatsappNegocio(req.negocioId);
  if (!credenciales) {
    return res.status(409).json({ error: 'WhatsApp no configurado para este negocio' });
  }
  try {
    await enviarMensaje(telefono, mensaje, credenciales);
    console.log(`[Panel] Mensaje manual enviado a ${telefono}: ${mensaje.slice(0, 60)}`);
    // Guardar y emitir al panel
    const msgGuardado = await guardarMensaje(telefono, null, 'saliente', mensaje, req.negocioId, 'humano');
    if (msgGuardado) broadcastNegocio(req.negocioId, { tipo: 'nuevo_mensaje', mensaje: msgGuardado });
    res.json({ ok: true });
  } catch (error) {
    console.error('[Panel] Error al enviar mensaje:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Historial de entregados
app.get('/api/historial', requireAuthSeguro, requireModulo('pos'), async (req, res) => {
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

app.get('/api/ventas', requireAdminSeguro, requireModulo('pos'), async (req, res) => {
  const { desde, hasta } = req.query;
  const d = desde || inicioDelDiaMX().toISOString();
  const h = hasta || new Date().toISOString();
  const ventas = await obtenerVentas(d, h, req.negocioId);
  res.json(ventas);
});

app.get('/api/ventas/resumen', requireAdminSeguro, requireModulo('pos'), async (req, res) => {
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

app.post('/api/caja/fondo', requireAuthSeguro, requireModulo('caja'), async (req, res) => {
  const { monto } = req.body;
  if (!monto || isNaN(monto) || Number(monto) < 0) {
    return res.status(400).json({ error: 'Monto inválido' });
  }
  const fecha = fechaHoyMX();
  await guardarFondoCaja(fecha, Number(monto), req.negocioId);
  res.json({ ok: true, fecha, fondo: Number(monto) });
});

app.get('/api/caja/fondo', requireAuthSeguro, requireModulo('caja'), async (req, res) => {
  const fecha = fechaHoyMX();
  const registro = await obtenerFondoCaja(fecha, req.negocioId);
  res.json({ fecha, fondo: registro ? parseFloat(registro.fondo) : null });
});

// ─── Menú — endpoints ────────────────────────────────────────────────────────
// Lectura del menú: también la usa la estación de meseros para tomar la orden
// (mismo modal de modificadores). Sigue siendo SOLO lectura del propio
// negocio; editar el menú continúa reservado a las rutas /api/admin/menu.
app.get('/api/menu', requireOperacionRestaurante, requireModulo('menu'), async (req, res) => {
  const menu = await obtenerMenuCompleto(req.negocioId);
  res.json(menu);
});

app.post('/api/admin/menu/categorias', resolverNegocioSeguro('admin'), requireModulo('menu'), async (req, res) => {
  const cat = await crearCategoria(req.body.nombre, req.negocioId);
  res.json(cat);
});

app.patch('/api/admin/menu/categorias/:id', resolverNegocioSeguro('admin'), requireModulo('menu'), async (req, res) => {
  await actualizarCategoria(req.params.id, req.body, req.negocioId);
  res.json({ ok: true });
});

app.delete('/api/admin/menu/categorias/:id', resolverNegocioSeguro('admin'), requireModulo('menu'), async (req, res) => {
  await eliminarCategoria(req.params.id, req.negocioId);
  res.json({ ok: true });
});

app.post('/api/admin/menu/productos', resolverNegocioSeguro('admin'), requireModulo('menu'), async (req, res) => {
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

app.patch('/api/admin/menu/productos/:id', resolverNegocioSeguro('admin'), requireModulo('menu'), async (req, res) => {
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

app.delete('/api/admin/menu/productos/:id', resolverNegocioSeguro('admin'), requireModulo('menu'), async (req, res) => {
  await eliminarProducto(req.params.id, req.negocioId);
  res.json({ ok: true });
});

app.post('/api/admin/menu/productos/:id/duplicar', resolverNegocioSeguro('admin'), requireModulo('menu'), async (req, res) => {
  try {
    const copia = await duplicarProducto(req.params.id, req.negocioId);
    res.json(copia);
  } catch (e) {
    if (e.message?.includes('no encontrado')) return res.status(404).json({ error: e.message });
    console.error('[POST /api/admin/menu/productos/:id/duplicar] Error:', e.message);
    res.status(500).json({ error: 'Error al duplicar el producto' });
  }
});

// ─── Modificadores — endpoints ───────────────────────────────────────────────
app.get('/api/admin/menu/productos/:id/modificadores', resolverNegocioSeguro('admin'), requireModulo('menu'), async (req, res) => {
  const grupos = await obtenerModificadoresProducto(parseInt(req.params.id), req.negocioId);
  res.json(grupos);
});

app.post('/api/admin/menu/productos/:id/modificadores/grupos', resolverNegocioSeguro('admin'), requireModulo('menu'), async (req, res) => {
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

app.patch('/api/admin/menu/modificadores/grupos/:id', resolverNegocioSeguro('admin'), requireModulo('menu'), async (req, res) => {
  await actualizarGrupoModificador(parseInt(req.params.id), req.body, req.negocioId);
  res.json({ ok: true });
});

app.delete('/api/admin/menu/modificadores/grupos/:id', resolverNegocioSeguro('admin'), requireModulo('menu'), async (req, res) => {
  await eliminarGrupoModificador(parseInt(req.params.id), req.negocioId);
  res.json({ ok: true });
});

app.post('/api/admin/menu/modificadores/grupos/:id/opciones', resolverNegocioSeguro('admin'), requireModulo('menu'), async (req, res) => {
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

app.patch('/api/admin/menu/modificadores/opciones/:id', resolverNegocioSeguro('admin'), requireModulo('menu'), async (req, res) => {
  await actualizarOpcionModificador(parseInt(req.params.id), req.body, req.negocioId);
  res.json({ ok: true });
});

app.delete('/api/admin/menu/modificadores/opciones/:id', resolverNegocioSeguro('admin'), requireModulo('menu'), async (req, res) => {
  await eliminarOpcionModificador(parseInt(req.params.id), req.negocioId);
  res.json({ ok: true });
});

// ─── Push Notifications — endpoints ─────────────────────────────────────────
app.get('/api/push/vapid-public-key', (req, res) => {
  if (!VAPID_PUBLIC) return res.status(503).json({ error: 'Push no configurado' });
  res.json({ key: VAPID_PUBLIC });
});

// negocioId (Auditoría P0 complementaria, push): SIEMPRE de req.negocioId
// (requireAuthSeguro ya validó sesión + membresía + negocio activo) --
// cualquier negocio_id que el body pudiera traer se ignora por completo,
// nunca se lee. Chequeo explícito de negocio activo aquí también, además
// del que ya hace el middleware, para no depender solo de esa cadena.
app.post('/api/push/subscribe', requireAuthSeguro, async (req, res) => {
  const { endpoint, keys } = req.body;
  if (!endpoint || !keys?.auth || !keys?.p256dh) {
    return res.status(400).json({ error: 'Suscripción inválida' });
  }
  if (!(await negocioEstaActivo(req.negocioId))) {
    return res.status(403).json({ error: 'Negocio suspendido o inactivo' });
  }
  try {
    await guardarSuscripcionPush({ endpoint, auth: keys.auth, p256dh: keys.p256dh }, req.negocioId);
    res.json({ ok: true });
  } catch (e) {
    console.error('[Push] Error guardando suscripción:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Borra únicamente si el endpoint pertenece al negocio de la sesión --
// nunca borra una suscripción de otro negocio aunque el endpoint llegara
// a coincidir (eliminarSuscripcionPush ya lo valida con AND negocio_id).
app.delete('/api/push/subscribe', requireAuthSeguro, async (req, res) => {
  const { endpoint } = req.body;
  if (!endpoint) return res.status(400).json({ error: 'endpoint requerido' });
  await eliminarSuscripcionPush(endpoint, req.negocioId).catch(() => {});
  res.json({ ok: true });
});

// Corte de caja — disponible para staff (resumen del día por forma de pago)
// Aislamiento completo por negocio (migración 009): ventas, resumen y
// fondo de caja se filtran/escriben con req.negocioId. caja_fondos ahora
// tiene UNIQUE(negocio_id, fecha) en vez de UNIQUE(fecha) global — dos
// negocios pueden tener cada uno su propio fondo el mismo día sin
// pisarse. Ver migrations/009_caja_fondos_por_negocio*.
app.get('/api/corte-caja', requireAuthSeguro, requireModulo('caja'), async (req, res) => {
  const d = inicioDelDiaMX().toISOString();
  const h = new Date().toISOString();
  const [ventas, resumen, fondoReg] = await Promise.all([
    obtenerVentas(d, h, req.negocioId),
    obtenerResumenVentas(d, h, req.negocioId),
    obtenerFondoCaja(fechaHoyMX(), req.negocioId)
  ]);
  const fondo = fondoReg ? parseFloat(fondoReg.fondo) : 0;
  // Reingeniería UX: INGRESO COBRADO vs OPERACIÓN PENDIENTE. Un pedido
  // abierto (por_cobrar sin pago_confirmado) NO entra al agrupado por forma
  // de pago ni al efectivo esperado — aún no hay forma de pago real. Se
  // reporta aparte en `pendiente` para que el corte lo muestre explícito.
  const esPendiente = (v) => v.forma_pago === 'por_cobrar' && v.pago_confirmado !== true;
  const porPago = {};
  let pendienteNum = 0, pendienteTotal = 0;
  (ventas || []).forEach(v => {
    if (esPendiente(v)) {
      pendienteNum++;
      pendienteTotal += parseFloat(v.total || 0);
      return;
    }
    const pago = v.forma_pago || 'no especificado';
    if (!porPago[pago]) porPago[pago] = { count: 0, total: 0 };
    porPago[pago].count++;
    porPago[pago].total += parseFloat(v.total || 0);
  });
  const totalVentas = resumen.total_ventas || 0; // ya excluye por_cobrar (obtenerResumenVentas)
  // Efectivo en caja = fondo inicial + ventas en efectivo COBRADAS
  const ventasEfectivo = (porPago['efectivo']?.total || 0) + (porPago['Efectivo']?.total || 0);
  res.json({
    fecha: new Date().toLocaleDateString('es-MX', { timeZone: 'America/Matamoros', dateStyle: 'full' }),
    fondo_inicial: fondo,
    total_dia: totalVentas,
    efectivo_esperado: fondo + ventasEfectivo,
    num_pedidos: resumen.num_pedidos || 0,
    pendiente: { num: pendienteNum, total: Math.round(pendienteTotal * 100) / 100 },
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

// Control operativo por conversación. Admin y staff pueden usarlo; el
// recurso se valida contra el negocio de la sesión antes de leer o escribir.
async function validarConversacionPropia(req, res, next) {
  const pertenencia = await obtenerPertenenciaConversacion(req.params.telefono, req.negocioId);
  if (pertenencia === 'ajena') return res.status(403).json({ error: 'La conversación pertenece a otro negocio' });
  if (pertenencia === 'inexistente') return res.status(404).json({ error: 'Conversación no encontrada' });
  next();
}

async function cambiarAtencionConversacion(req, res, pausado) {
  const anterior = await getBotPausado(req.params.telefono, req.negocioId);
  const actualizado = await setBotPausado(req.params.telefono, pausado, req.negocioId);
  if (!actualizado) return res.status(403).json({ error: 'No se pudo modificar esta conversación' });
  await registrarAuditoriaPlataforma({
    superadminId: req.usuarioId, accion: pausado ? 'tomar_conversacion' : 'devolver_conversacion_bot',
    negocioId: req.negocioId, estadoAnterior: { telefono: req.params.telefono, bot_pausado: anterior },
    estadoNuevo: { telefono: req.params.telefono, bot_pausado: pausado },
  });
  broadcastNegocio(req.negocioId, { tipo: 'bot_pausado', telefono: req.params.telefono, pausado });
  res.json({ ok: true, pausado });
}

app.post('/api/conversacion/:telefono/pausar', requireAuthSeguro, requireModulo('whatsapp'), validarConversacionPropia, async (req, res) => {
  await cambiarAtencionConversacion(req, res, true);
});

app.post('/api/conversacion/:telefono/reactivar', requireAuthSeguro, requireModulo('whatsapp'), validarConversacionPropia, async (req, res) => {
  await cambiarAtencionConversacion(req, res, false);
});

app.get('/api/conversacion/:telefono/estado-bot', requireAuthSeguro, requireModulo('whatsapp'), validarConversacionPropia, async (req, res) => {
  const [pausado, botWhatsappActivo] = await Promise.all([
    getBotPausado(req.params.telefono, req.negocioId), obtenerBotWhatsappActivoNegocio(req.negocioId),
  ]);
  res.json({ pausado, botWhatsappActivo });
});

// ─── Documentos PDF en el chat ────────────────────────────────────────────────
// Módulo por negocio (chat_documentos_pdf) + validación de pertenencia de la
// conversación (mismo criterio que /api/conversacion/*) -- el frontend nunca
// es la fuente de verdad: si el botón se manipula para llamar a estas rutas
// sin el módulo habilitado, requireModulo responde 403 igual.

app.post('/api/documentos/enviar', requireAuthSeguro, requireModulo('chat_documentos_pdf'),
  rateLimitMiddleware(req => `doc-enviar:${req.negocioId}`, 20, 60 * 1000),
  async (req, res) => {
    const { telefono, filename, base64, caption } = req.body || {};
    if (typeof telefono !== 'string' || !telefono.trim()) return res.status(400).json({ error: 'telefono requerido' });
    if (typeof base64 !== 'string' || !base64.trim()) return res.status(400).json({ error: 'base64 requerido' });

    const pertenencia = await obtenerPertenenciaConversacion(telefono, req.negocioId);
    if (pertenencia === 'ajena') return res.status(403).json({ error: 'La conversación pertenece a otro negocio' });

    let buffer;
    try {
      buffer = Buffer.from(base64, 'base64');
    } catch {
      return res.status(400).json({ error: 'base64 inválido' });
    }

    const resultado = await procesarDocumentoSaliente({ negocioId: req.negocioId, buffer, filename });
    if (!resultado.ok) {
      const mensajes = { archivo_vacio: 'Archivo vacío', tamano_excedido: 'El archivo excede el tamaño máximo permitido', mime_invalido: 'El archivo no es un PDF válido' };
      return res.status(400).json({ error: mensajes[resultado.motivo] || 'Archivo inválido' });
    }

    const credenciales = await obtenerCredencialesWhatsappNegocio(req.negocioId);
    if (!credenciales?.accessToken) return res.status(409).json({ error: 'WhatsApp no configurado para este negocio' });

    try {
      const envio = await enviarDocumento(telefono, buffer, resultado.filename, caption || '', credenciales);
      const documento = await crearDocumentoSaliente({
        negocioId: req.negocioId, telefono, filename: resultado.filename, sizeBytes: resultado.sizeBytes,
        storageKey: resultado.storageKey, caption: caption || null, wamid: envio?.messages?.[0]?.id || null,
        createdBy: req.usuarioId,
      });
      const msg = await guardarMensaje(telefono, null, 'saliente', `📄 ${resultado.filename}`, req.negocioId, 'humano', documento.wamid, 'documento', documento.id);
      if (msg) broadcastNegocio(req.negocioId, { tipo: 'nuevo_mensaje', mensaje: msg, documento });
      res.json({ ok: true, documento });
    } catch (e) {
      console.error('[POST /api/documentos/enviar] Error:', e.message);
      res.status(502).json({ error: 'No se pudo enviar el documento a WhatsApp' });
    }
  }
);

app.get('/api/documentos/:id', requireAuthSeguro, requireModulo('chat_documentos_pdf'), async (req, res) => {
  const pertenencia = await obtenerPertenenciaDocumento(req.params.id, req.negocioId);
  if (pertenencia === 'ajena') return res.status(403).json({ error: 'El documento pertenece a otro negocio' });
  if (pertenencia === 'inexistente') return res.status(404).json({ error: 'Documento no encontrado' });
  const documento = await obtenerDocumento(req.params.id, req.negocioId);
  res.json(documento);
});

app.get('/api/documentos/:id/archivo', requireAuthSeguro, requireModulo('chat_documentos_pdf'), async (req, res) => {
  const documento = await obtenerDocumento(req.params.id, req.negocioId);
  if (!documento) return res.status(404).json({ error: 'Documento no encontrado' });
  if (documento.estado !== 'listo' || !documento.storage_key) return res.status(409).json({ error: 'El documento no está listo todavía' });

  if (driverEsLocal()) {
    const buffer = await leerArchivo(documento.storage_key);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${sanitizarNombreArchivo(documento.filename)}"`);
    return res.send(buffer);
  }
  const url = await obtenerUrlDescarga(documento.storage_key, { ttlSegundos: 300 });
  res.redirect(url);
});

// Borrar un documento: solo admin (operador nunca borra, por especificación).
app.delete('/api/documentos/:id', requireAdminSeguro, requireModulo('chat_documentos_pdf'), async (req, res) => {
  const documento = await obtenerDocumento(req.params.id, req.negocioId);
  if (!documento) return res.status(404).json({ error: 'Documento no encontrado' });
  if (documento.storage_key) await eliminarArchivo(documento.storage_key);
  await eliminarDocumentoRegistro(req.params.id);
  broadcastNegocio(req.negocioId, { tipo: 'documento_eliminado', documentoId: req.params.id });
  res.json({ ok: true });
});

// ─── Imágenes en el chat ───────────────────────────────────────────────────────
// Mismo patrón que documentos PDF (arriba), gateado por 'chat_imagenes' en
// vez de 'chat_documentos_pdf' -- son módulos independientes. Reutiliza la
// misma tabla `documentos` (categoria='imagen') y las mismas funciones de
// pertenencia (obtenerPertenenciaDocumento/obtenerDocumento no filtran por
// categoria a propósito: un documento es un documento, sea PDF o imagen,
// para efectos de aislamiento por negocio).
//
// Envía hasta MAX_IMAGENES_POR_ENVIO en un solo POST (un mensaje de WhatsApp
// por imagen -- Meta no soporta múltiples adjuntos en un solo mensaje) --
// se procesan en serie y se reporta cuáles tuvieron éxito/error, en vez de
// abortar todo el lote ante el primer fallo.
app.post('/api/imagenes/enviar', requireAuthSeguro, requireModulo('chat_imagenes'),
  rateLimitMiddleware(req => `img-enviar:${req.negocioId}`, 20, 60 * 1000),
  async (req, res) => {
    const { telefono, imagenes, caption } = req.body || {};
    if (typeof telefono !== 'string' || !telefono.trim()) return res.status(400).json({ error: 'telefono requerido' });
    if (!Array.isArray(imagenes) || imagenes.length === 0) return res.status(400).json({ error: 'Al menos una imagen requerida' });
    if (imagenes.length > MAX_IMAGENES_POR_ENVIO) return res.status(400).json({ error: `Máximo ${MAX_IMAGENES_POR_ENVIO} imágenes por envío` });

    const pertenencia = await obtenerPertenenciaConversacion(telefono, req.negocioId);
    if (pertenencia === 'ajena') return res.status(403).json({ error: 'La conversación pertenece a otro negocio' });

    const credenciales = await obtenerCredencialesWhatsappNegocio(req.negocioId);
    if (!credenciales?.accessToken) return res.status(409).json({ error: 'WhatsApp no configurado para este negocio' });

    const resultados = [];
    for (const item of imagenes) {
      const { filename, base64 } = item || {};
      if (typeof base64 !== 'string' || !base64.trim()) {
        resultados.push({ ok: false, filename: filename || null, error: 'base64 requerido' });
        continue;
      }
      let buffer;
      try {
        buffer = Buffer.from(base64, 'base64');
      } catch {
        resultados.push({ ok: false, filename: filename || null, error: 'base64 inválido' });
        continue;
      }

      const resultado = await procesarImagenSaliente({ negocioId: req.negocioId, telefono, buffer, filename });
      if (!resultado.ok) {
        const mensajes = { archivo_vacio: 'Archivo vacío', tamano_excedido: 'El archivo excede el tamaño máximo permitido', mime_invalido: 'El archivo no es una imagen jpg/png/webp válida', imagen_corrupta: 'La imagen está dañada o incompleta' };
        resultados.push({ ok: false, filename: filename || null, error: mensajes[resultado.motivo] || 'Archivo inválido' });
        continue;
      }

      try {
        const envio = await enviarImagenBuffer(telefono, resultado.buffer, resultado.filename, resultado.mimeType, caption || '', credenciales);
        const documento = await crearRegistroImagenSaliente({
          negocioId: req.negocioId, telefono, filename: resultado.filename, mimeType: resultado.mimeType,
          sizeBytes: resultado.sizeBytes, storageKey: resultado.storageKey, caption: caption || null,
          wamid: envio?.messages?.[0]?.id || null, createdBy: req.usuarioId, checksum: resultado.checksum,
        });
        const msg = await guardarMensaje(telefono, null, 'saliente', caption ? `📷 ${caption}` : '📷 Imagen', req.negocioId, 'humano', documento.wamid, 'imagen', documento.id);
        if (msg) broadcastNegocio(req.negocioId, { tipo: 'nuevo_mensaje', mensaje: msg, documento });
        resultados.push({ ok: true, documento });
      } catch (e) {
        console.error('[POST /api/imagenes/enviar] Error:', e.message);
        resultados.push({ ok: false, filename: resultado.filename, error: 'No se pudo enviar la imagen a WhatsApp' });
      }
    }

    const huboExito = resultados.some(r => r.ok);
    res.status(huboExito ? 200 : 502).json({ ok: huboExito, resultados });
  }
);

app.get('/api/imagenes/:id', requireAuthSeguro, requireModulo('chat_imagenes'), async (req, res) => {
  const pertenencia = await obtenerPertenenciaDocumento(req.params.id, req.negocioId);
  if (pertenencia === 'ajena') return res.status(403).json({ error: 'La imagen pertenece a otro negocio' });
  if (pertenencia === 'inexistente') return res.status(404).json({ error: 'Imagen no encontrada' });
  res.json(await obtenerDocumento(req.params.id, req.negocioId));
});

app.get('/api/imagenes/:id/archivo', requireAuthSeguro, requireModulo('chat_imagenes'), async (req, res) => {
  const documento = await obtenerDocumento(req.params.id, req.negocioId);
  if (!documento) return res.status(404).json({ error: 'Imagen no encontrada' });
  if (documento.estado !== 'listo' || !documento.storage_key) return res.status(409).json({ error: 'La imagen no está lista todavía' });

  if (driverEsLocal()) {
    const buffer = await leerArchivo(documento.storage_key);
    res.setHeader('Content-Type', documento.mime_type || 'image/jpeg');
    // A diferencia de los documentos PDF, el filename de una imagen
    // SALIENTE ya quedó saneado con su extensión real (jpg/png/webp) al
    // crearse; una imagen ENTRANTE se registra sin extensión (Meta no
    // manda filename para imágenes, a diferencia de documentos) -- se le
    // agrega aquí a partir del mime_type real si todavía no la tiene.
    // sanitizarNombreArchivo() (la de documentos.js) NO sirve porque
    // fuerza ".pdf".
    const extPorMime = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
    let nombreDescarga = documento.filename.replace(/[\\/"]/g, '_');
    if (!/\.(jpe?g|png|webp)$/i.test(nombreDescarga)) {
      nombreDescarga += `.${extPorMime[documento.mime_type] || 'jpg'}`;
    }
    res.setHeader('Content-Disposition', `inline; filename="${nombreDescarga}"`);
    return res.send(buffer);
  }
  const url = await obtenerUrlDescarga(documento.storage_key, { ttlSegundos: 300 });
  res.redirect(url);
});

// ─── Cotizaciones ──────────────────────────────────────────────────────────────
// Límite temporal del piloto: generoso para el caso de uso real de
// eventos/catering/florería, pero evita una cotización con cientos de
// partidas (PDF grande, renderización lenta en Chromium).
const COTIZACION_ITEMS_MAXIMO = 50;
// Hotfix (desglose de IVA): validado en la frontera de la API -- fail
// closed con 400 claro en vez de dejar que una tasa inválida llegue al
// CHECK de la base (que respondería un 500 genérico).
function impuestosPctInvalido(valor) {
  return valor !== undefined && (typeof valor !== 'number' || !Number.isFinite(valor) || valor < 0 || valor > 100);
}

app.get('/api/cotizaciones', requireAuthSeguro, requireModulo('cotizaciones'), async (req, res) => {
  const cotizaciones = await listarCotizaciones(req.negocioId, { telefono: req.query.telefono || null });
  res.json(cotizaciones);
});

app.get('/api/cotizaciones/:id', requireAuthSeguro, requireModulo('cotizaciones'), async (req, res) => {
  const pertenencia = await obtenerPertenenciaCotizacion(req.params.id, req.negocioId);
  if (pertenencia === 'ajena') return res.status(403).json({ error: 'La cotización pertenece a otro negocio' });
  if (pertenencia === 'inexistente') return res.status(404).json({ error: 'Cotización no encontrada' });
  res.json(await obtenerCotizacion(req.params.id, req.negocioId));
});

app.post('/api/cotizaciones', requireAdminSeguro, requireModulo('cotizaciones'), requireModulo('generador_cotizaciones'), async (req, res) => {
  const { telefono, evento, vigenciaHasta, anticipoRequerido, notas, terminos, items, impuestosPct } = req.body || {};
  if (typeof telefono !== 'string' || !telefono.trim()) return res.status(400).json({ error: 'telefono requerido' });
  // Hotfix: NO se valida "pertenencia" del teléfono aquí a propósito.
  // obtenerPertenenciaConversacion() responde 'ajena' si ese teléfono ya
  // aparece en `clientes`/`mensajes` (tablas con PK global por telefono,
  // pre-Fase-0-CRM) bajo OTRO negocio -- correcto para no filtrar el
  // HISTORIAL de chat de otro negocio, pero equivocado aquí: un mismo
  // teléfono puede y debe poder ser cliente de varios negocios
  // simultáneamente. crearCotizacion() nunca lee ni escribe
  // clientes/perfiles_clientes -- la cotización queda aislada solo por
  // negocio_id (columna propia, con folio único por negocio), así que no
  // hay ninguna mezcla de datos posible al quitar este gate. Ver
  // fase-cotizaciones-multiempresa-telefono.mjs para la prueba explícita
  // del contrato (mismo teléfono, negocios distintos, cero fuga).
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'Al menos un item requerido' });
  if (items.length > COTIZACION_ITEMS_MAXIMO) return res.status(400).json({ error: `Máximo ${COTIZACION_ITEMS_MAXIMO} partidas por cotización` });
  if (impuestosPctInvalido(impuestosPct)) return res.status(400).json({ error: 'impuestosPct debe ser un número entre 0 y 100' });
  try {
    const cotizacion = await crearCotizacion({
      negocioId: req.negocioId, telefono, createdBy: req.usuarioId, evento, vigenciaHasta,
      anticipoRequerido, notas, terminos, items, impuestosPct,
    });
    res.json(cotizacion);
  } catch (e) {
    console.error('[POST /api/cotizaciones] Error:', e.message);
    res.status(400).json({ error: 'No se pudo crear la cotización' });
  }
});

app.patch('/api/cotizaciones/:id', requireAdminSeguro, requireModulo('cotizaciones'), requireModulo('generador_cotizaciones'), async (req, res) => {
  const pertenencia = await obtenerPertenenciaCotizacion(req.params.id, req.negocioId);
  if (pertenencia === 'ajena') return res.status(403).json({ error: 'La cotización pertenece a otro negocio' });
  if (pertenencia === 'inexistente') return res.status(404).json({ error: 'Cotización no encontrada' });
  const { evento, vigenciaHasta, anticipoRequerido, notas, terminos, items, impuestosPct } = req.body || {};
  if (Array.isArray(items) && items.length > COTIZACION_ITEMS_MAXIMO) return res.status(400).json({ error: `Máximo ${COTIZACION_ITEMS_MAXIMO} partidas por cotización` });
  if (impuestosPctInvalido(impuestosPct)) return res.status(400).json({ error: 'impuestosPct debe ser un número entre 0 y 100' });
  try {
    const cotizacion = await actualizarCotizacion(req.params.id, req.negocioId, { evento, vigenciaHasta, anticipoRequerido, notas, terminos }, items || null, impuestosPct);
    res.json(cotizacion);
  } catch (e) {
    console.error('[PATCH /api/cotizaciones/:id] Error:', e.message);
    res.status(400).json({ error: 'No se pudo actualizar la cotización' });
  }
});

app.get('/api/cotizaciones/:id/pdf', requireAuthSeguro, requireModulo('cotizaciones'), async (req, res) => {
  const pertenencia = await obtenerPertenenciaCotizacion(req.params.id, req.negocioId);
  if (pertenencia === 'ajena') return res.status(403).json({ error: 'La cotización pertenece a otro negocio' });
  if (pertenencia === 'inexistente') return res.status(404).json({ error: 'Cotización no encontrada' });
  try {
    const resultado = await obtenerOGenerarPdfCotizacion(req.params.id, req.negocioId);
    if (driverEsLocal()) {
      const buffer = resultado.buffer || await leerArchivo(resultado.storageKey);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${resultado.cotizacion.folio}.pdf"`);
      return res.send(buffer);
    }
    const url = await obtenerUrlDescarga(resultado.storageKey, { ttlSegundos: 300 });
    res.redirect(url);
  } catch (e) {
    console.error('[GET /api/cotizaciones/:id/pdf] Error:', e.message);
    res.status(500).json({ error: 'No se pudo generar el PDF' });
  }
});

app.post('/api/cotizaciones/:id/enviar', requireAuthSeguro, requireModulo('cotizaciones'), requireModulo('chat_documentos_pdf'), async (req, res) => {
  const pertenencia = await obtenerPertenenciaCotizacion(req.params.id, req.negocioId);
  if (pertenencia === 'ajena') return res.status(403).json({ error: 'La cotización pertenece a otro negocio' });
  if (pertenencia === 'inexistente') return res.status(404).json({ error: 'Cotización no encontrada' });

  const credenciales = await obtenerCredencialesWhatsappNegocio(req.negocioId);
  if (!credenciales?.accessToken) return res.status(409).json({ error: 'WhatsApp no configurado para este negocio' });

  try {
    const { cotizacion, buffer, storageKey } = await obtenerOGenerarPdfCotizacion(req.params.id, req.negocioId);
    const bytesPdf = buffer || await leerArchivo(storageKey);
    const mensajeTexto = (req.body?.mensaje && String(req.body.mensaje).trim())
      || 'Hola, te compartimos la cotización solicitada. Quedamos atentos a cualquier ajuste.';
    const filename = `${cotizacion.folio}.pdf`;

    const envio = await enviarDocumento(cotizacion.telefono, bytesPdf, filename, mensajeTexto, credenciales);
    const documento = await crearDocumentoSaliente({
      negocioId: req.negocioId, telefono: cotizacion.telefono, filename, sizeBytes: bytesPdf.length,
      storageKey: storageKey, caption: mensajeTexto, wamid: envio?.messages?.[0]?.id || null, createdBy: req.usuarioId,
    });
    await pool.query('UPDATE documentos SET cotizacion_id = $2 WHERE id = $1', [documento.id, cotizacion.id]);
    const msg = await guardarMensaje(cotizacion.telefono, null, 'saliente', `📄 ${filename}`, req.negocioId, 'humano', documento.wamid, 'documento', documento.id);
    if (msg) broadcastNegocio(req.negocioId, { tipo: 'nuevo_mensaje', mensaje: msg, documento });

    const actualizada = await marcarCotizacionEnviada(req.params.id, req.usuarioId);

    // Fase 5 del Asistente Comercial: si esta cotización fue generada a
    // partir de una sesión conversacional de WhatsApp, la aprobación
    // humana explícita (esta misma request, ya autenticada) es el
    // momento correcto para finalizar esa sesión -- nunca antes. Nunca
    // bloquea la respuesta al admin si falla.
    obtenerSesionPorCotizacion(cotizacion.id, req.negocioId)
      .then(sesion => sesion && finalizarSesion(sesion.id, req.negocioId, 'aprobada'))
      .catch(e => console.error('[POST /api/cotizaciones/:id/enviar] Error finalizando sesión comercial:', e.message));

    res.json({ ok: true, cotizacion: actualizada, documento });
  } catch (e) {
    console.error('[POST /api/cotizaciones/:id/enviar] Error:', e.message);
    res.status(502).json({ error: 'No se pudo enviar la cotización' });
  }
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

// ⚠ Solo admin: configuracion.* incluye credenciales SAT (cert/llave cifrada/IV)
// y rappi_webhook_secret sin filtrar -- nunca debe llegar a un staff (ver
// hallazgo de seguridad de esta tarea). El panel de operación normal (todos
// los roles) usa /api/config/operativa, abajo, que sí filtra por allowlist.
app.get('/api/config', resolverNegocioSeguro('admin'), async (req, res) => {
  if (req.esNegocioPorDefecto) return res.json(negocioConfig);
  const cfg = await obtenerConfiguracion(req.negocioId);
  res.json(cfg);
});

// ✅ Config operativa — accesible a cualquier sesión válida (admin y staff).
// Allowlist cerrada a propósito (nunca blacklist): solo las claves que el
// panel realmente necesita para membrete/encabezado y tickets impresos. Si
// mañana se agrega una clave sensible nueva a `configuracion`, esta lista NO
// la expone automáticamente -- hay que agregarla aquí a mano, a propósito.
// Fase 2 (panel comercial): datos de contacto/ubicación agregados a la
// allowlist -- son información pública del negocio (igual que
// telefono/direccion, ya expuestos), nunca secretos. reglas_atencion
// (horarios/pedidos/políticas/entrenamiento del bot) NO se agrega aquí a
// propósito: es un JSON estructurado, no un campo de membrete, y ya se
// lee completo (sin filtrar) vía GET /api/config, admin-only.
const CONFIG_CLAVES_OPERATIVAS = [
  'nombre', 'nombre_corto', 'direccion', 'ciudad', 'rfc', 'telefono', 'whatsapp', 'horario', 'bot_avisos',
  'descripcion', 'email', 'referencia', 'codigo_postal', 'ubicacion', 'logo_url',
];
app.get('/api/config/operativa', resolverNegocioSeguro(), async (req, res) => {
  const cfgCompleta = req.esNegocioPorDefecto ? negocioConfig : await obtenerConfiguracion(req.negocioId);
  const cfgOperativa = {};
  for (const clave of CONFIG_CLAVES_OPERATIVAS) cfgOperativa[clave] = cfgCompleta[clave] ?? '';
  res.json(cfgOperativa);
});

// reglas_atencion llega del panel como objeto JS (Fase 2/4) -- se valida
// con la MISMA función que usa prompts.js para decidir si confía en un
// JSON guardado (validarEstructuraReglas), así que nunca se guarda algo
// que el propio bot rechazaría en tiempo de ejecución. Se normaliza a
// string antes de persistir porque configuracion.valor es TEXT.
app.put('/api/config', resolverNegocioSeguro('admin'), async (req, res) => {
  const cambios = { ...req.body };
  if ('reglas_atencion' in cambios) {
    let reglas = cambios.reglas_atencion;
    if (typeof reglas === 'string') {
      try { reglas = JSON.parse(reglas); } catch { return res.status(400).json({ error: 'reglas_atencion no es JSON válido' }); }
    }
    if (!validarEstructuraReglas(reglas)) {
      return res.status(400).json({ error: 'reglas_atencion no tiene la estructura esperada (horarios de los 7 días, pedidos.costo_envio, pedidos.pedido_minimo_entrega como número, cierres_especiales/promociones/politicas como arreglos)' });
    }
    cambios.reglas_atencion = JSON.stringify(reglas);
  }
  const ok = await actualizarConfiguracion(cambios, req.negocioId);
  if (!ok) return res.status(500).json({ error: 'Error al guardar' });
  if (req.esNegocioPorDefecto) {
    negocioConfig = { ...negocioConfig, ...cambios };
    broadcastNegocio(req.negocioId, { tipo: 'config_actualizada', config: negocioConfig });
    return res.json({ ok: true, config: negocioConfig });
  }
  const cfgActualizada = await obtenerConfiguracion(req.negocioId);
  res.json({ ok: true, config: cfgActualizada });
});

// ─── Usuarios del panel (Fase 5) ─────────────────────────────────────────────
// Las tres rutas exigen admin y resuelven el negocio EXCLUSIVAMENTE desde la
// sesión (req.negocioId, puesto por resolverNegocioSeguro) -- nunca desde
// body/query/params. Ningún handler acepta negocio_id del cliente, así que
// no hay forma de que un admin opere sobre un negocio que no es el suyo.
//
// requireAdminModerno, no requireAdminSeguro: administrar usuarios exige
// además req.usuarioId (identidad real de sesión nueva). El modo legado
// ADMIN_PASSWORD no tiene ningún usuarioId asociado -- no representa a una
// persona concreta, solo un rol compartido -- así que "no desactivarse a sí
// mismo" no tendría ningún significado ahí, y dejarlo pasar abriría la
// puerta a que cualquiera con esa contraseña compartida administre
// identidades reales sin quedar ligado a una cuenta. El resto del sistema
// (pedidos, config, etc.) sigue aceptando el modo legado sin cambios.
function requireAdminModerno(req, res, next) {
  requireAdminSeguro(req, res, () => {
    if (!req.usuarioId) {
      return res.status(403).json({ error: 'Esta acción requiere iniciar sesión con el sistema de usuarios (no con la contraseña de administrador compartida)' });
    }
    next();
  });
}

// ─── Control real de módulos por negocio ────────────────────────────────────
// Middleware reutilizable -- se coloca DESPUÉS de requireAuthSeguro/
// requireAdminSeguro/resolverNegocioSeguro en la ruta (esos ya dejaron
// req.negocioId listo; este solo decide si ESE negocio puede usar el
// módulo). El negocio SIEMPRE sale de req.negocioId -- nunca de query/body/
// header, nunca se acepta uno enviado por el cliente. Ocultar la pestaña en
// el frontend no es suficiente: sin este middleware, la ruta seguía
// respondiendo 200 con datos reales aunque el módulo estuviera apagado.
// Funciona igual para admin y para staff -- ninguno de los dos evade el
// bloqueo por rol, el módulo se exige de todos modos.
// Respuesta 403 con código estructurado -- el frontend no debe depender
// solo del texto (que es para mostrar al usuario, puede cambiar de
// redacción); `codigo` es el campo estable para tomar decisiones de UI.
function responderModuloBloqueado(res, codigo, error) {
  return res.status(403).json({ error, codigo });
}

function requireModulo(modulo) {
  return async (req, res, next) => {
    if (typeof req.negocioId !== 'string' || !req.negocioId.trim()) {
      return responderModuloBloqueado(res, 'sesion_invalida', 'Sesión inválida — no se pudo determinar el negocio');
    }
    if (!(await negocioEstaActivo(req.negocioId))) {
      return responderModuloBloqueado(res, 'negocio_suspendido', 'Negocio suspendido o inactivo');
    }
    const estado = await obtenerEstadoModulo(req.negocioId, modulo);
    if (MODULO_ESTADOS_DISPONIBLES_API.includes(estado)) return next();
    if (estado === 'suspendido') {
      return responderModuloBloqueado(res, 'modulo_suspendido', 'Este módulo está temporalmente suspendido.');
    }
    // 'pendiente' (vocabulario heredado) y 'pendiente_configuracion'
    // (vocabulario canónico, usado por Rewards) son equivalentes aquí --
    // ambos significan "contratado pero técnicamente no configurado".
    if (estado === 'pendiente' || estado === 'pendiente_configuracion') {
      return responderModuloBloqueado(res, 'modulo_pendiente_configuracion', 'Este módulo está pendiente de configuración.');
    }
    // 'no_configurado' (heredado), 'no_contratado' (canónico) o sin fila --
    // no contratado, el default seguro.
    return responderModuloBloqueado(res, 'modulo_no_contratado', 'Este módulo no está incluido para este negocio.');
  };
}

// ─── Tienda Online ────────────────────────────────────────────────────────
// Vive en su propio módulo porque tiene dos superficies muy distintas (una
// pública sin sesión y otra de backoffice) y porque este archivo ya es
// demasiado grande. Se monta aquí, después de requireModulo, porque las
// rutas de backoffice lo necesitan.
registrarRutasTienda(app, { requireAuthSeguro, requireModulo });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

app.get('/api/admin/usuarios', requireAdminModerno, requireModulo('usuarios'), async (req, res) => {
  const usuarios = await obtenerUsuariosDeNegocio(req.negocioId);
  res.json(usuarios);
});

app.post('/api/admin/usuarios', requireAdminModerno, requireModulo('usuarios'), async (req, res) => {
  const { nombre, email, password, tipo, pin } = req.body;
  if (typeof nombre !== 'string' || !nombre.trim()) {
    return res.status(400).json({ error: 'El nombre es obligatorio' });
  }

  // Mesero: persona de piso. Nombre + PIN, sin correo, sin invitación. El
  // rol se fija aquí ('mesero'), nunca se lee del body -- esta ruta no puede
  // usarse para fabricar un admin. El PIN se guarda hasheado (scrypt) y no
  // vuelve a salir por ninguna API.
  if (tipo === 'mesero') {
    if (typeof pin !== 'string' || !/^[0-9]{4,6}$/.test(pin)) {
      return res.status(400).json({ error: 'El PIN debe tener entre 4 y 6 dígitos', codigo: 'PIN_INVALIDO' });
    }
    try {
      const mesero = await crearMeseroConPin({ negocioId: req.negocioId, nombre: nombre.trim(), pin });
      console.log(`[Usuarios] mesero_creado negocio=${req.negocioId} usuario=${req.usuarioId} mesero=${mesero.id}`);
      return res.status(201).json(mesero);
    } catch (e) {
      if (e.code === 'PIN_INVALIDO') return res.status(400).json({ error: e.message, codigo: e.code });
      console.error('[POST /api/admin/usuarios] Error creando mesero:', e.message);
      return res.status(500).json({ error: 'Error al crear el mesero' });
    }
  }

  if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) {
    return res.status(400).json({ error: 'Correo inválido' });
  }
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
  }
  const emailNorm = email.trim().toLowerCase();
  try {
    // El rol SIEMPRE es 'staff' aquí -- nunca se lee del body, así que esta
    // ruta no puede usarse para crear un admin.
    const existente = await obtenerUsuarioPorEmail(emailNorm);
    if (existente) {
      // El correo ya existe como identidad global (migración 006). Nunca se
      // vincula en silencio: se distingue entre "ya tiene cuenta en TU
      // negocio" (mensaje específico, accionable) y "el correo pertenece a
      // otra parte" (mensaje genérico, sin confirmar ni negar a qué negocio
      // pertenece -- evita filtrar información entre negocios).
      const membresia = await obtenerMembresiaCualquierEstado(existente.id, req.negocioId);
      if (membresia) {
        return res.status(409).json({
          error: membresia.activo
            ? 'Ya existe un usuario activo con ese correo en tu negocio'
            : 'Ya existe un usuario con ese correo en tu negocio, pero está desactivado. Actívalo en vez de crear uno nuevo.'
        });
      }
      return res.status(409).json({ error: 'Ya existe una cuenta con este correo. No se puede crear automáticamente desde aquí.' });
    }
    const nuevo = await crearUsuarioConPassword({ negocioId: req.negocioId, nombre: nombre.trim(), email: emailNorm, password, rol: 'staff' });
    res.status(201).json({ id: nuevo.id, nombre: nuevo.nombre, email: nuevo.email, rol: 'staff', activo: true });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Ya existe una cuenta con este correo' });
    console.error('[POST /api/admin/usuarios] Error:', e.message);
    res.status(500).json({ error: 'Error al crear usuario' });
  }
});

app.patch('/api/admin/usuarios/:usuarioId/estado', requireAdminModerno, requireModulo('usuarios'), async (req, res) => {
  const { usuarioId } = req.params;
  const { activo } = req.body;
  if (typeof activo !== 'boolean') {
    return res.status(400).json({ error: 'Falta el campo "activo" (boolean)' });
  }
  if (usuarioId === req.usuarioId) {
    return res.status(400).json({ error: 'No puedes desactivar tu propia cuenta' });
  }
  const ok = await actualizarEstadoMembresia(usuarioId, req.negocioId, activo);
  if (!ok) return res.status(404).json({ error: 'Usuario no encontrado en tu negocio' });
  res.json({ ok: true });
});

// ─── Superadmin de plataforma (Fase 6) ───────────────────────────────────────
// Deliberadamente NO usa resolverNegocioSeguro/requireAdminSeguro: un
// superadmin no opera "dentro" de un negocio -- ve y toca varios a la vez.
// La única credencial que exige es una sesión moderna (cookie válida, con
// usuarioId) cuyo usuarioId esté marcado en administradores_plataforma. El
// negocioId que esa sesión traiga (si trae alguno) es irrelevante aquí --
// por eso el privilegio "no depende de ser admin de Nonna Maye": basta con
// tener CUALQUIER sesión moderna válida más el registro en la tabla
// separada. Distingue 401 (sin sesión reconocible) de 403 (sesión
// reconocida -- moderna sin privilegio, o legado -- pero no autorizada
// aquí), tal como exige el resto de la plataforma.
async function requireSuperadmin(req, res, next) {
  const token = leerCookieSesion(req);
  const payload = token ? verificarTokenSesion(token) : null;
  if (payload && payload.usuarioId) {
    // Una sesión de SOPORTE está acotada a operar el panel de UN negocio --
    // nunca vale como sesión de la consola Superadmin. Sin este rechazo,
    // una cookie de soporte (cuyo usuarioId ES un superadmin) podría
    // encadenar una segunda sesión de soporte hacia otro negocio o tocar
    // cualquier endpoint /api/superadmin/* mientras "está dentro" de un
    // negocio. Para volver a la consola: salir de soporte (que revoca y
    // limpia la cookie) e iniciar sesión normal.
    if (payload.sop === true) {
      return res.status(403).json({ error: 'Estás en una sesión de soporte — sal de soporte para usar la consola de Superadmin' });
    }
    const esSuper = await esSuperadmin(payload.usuarioId);
    if (esSuper) { req.usuarioId = payload.usuarioId; return next(); }
    return res.status(403).json({ error: 'Acceso exclusivo del propietario de la plataforma' });
  }
  const auth = req.headers['authorization'];
  const bearerToken = (auth && auth.startsWith('Bearer ')) ? auth.slice(7) : null;
  if (bearerToken && getRole(bearerToken)) {
    return res.status(403).json({ error: 'Esta sección requiere sesión de superadmin, no el modo legado' });
  }
  return res.status(401).json({ error: 'No autenticado' });
}

const MODULOS_VALIDOS_API = [
  'pos', 'usuarios', 'caja', 'menu', 'impresion', 'whatsapp', 'voz', 'rappi', 'facturacion', 'rewards',
  'chat_imagenes', 'chat_documentos_pdf', 'cotizaciones', 'generador_cotizaciones', 'pagos', 'repartidores',
  'asistente_comercial_cotizaciones', 'restaurante', 'tienda_online',
];
const MODULO_ESTADOS_DISPONIBLES_API = ['activo', 'configurado'];
const PLANES_VALIDOS_API = ['prueba', 'basico', 'pro', 'personalizado'];
const ESTADOS_NEGOCIO_VALIDOS_API = ['pendiente', 'activo', 'suspendido'];
const ESTADOS_INTEGRACION_VALIDOS_API = ['no_configurado', 'pendiente_configuracion', 'activo', 'suspendido', 'error'];

async function negocioExisteSuperadmin(negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return false;
  const { rows } = await pool.query('SELECT 1 FROM negocios WHERE id = $1', [negocioId.trim()]);
  return !!rows[0];
}

app.get('/api/superadmin/dashboard', requireSuperadmin, async (req, res) => {
  res.json(await obtenerDashboardSuperadmin());
});

app.get('/api/superadmin/negocios', requireSuperadmin, async (req, res) => {
  const { buscar = '', estado = '', plan = '', limit, offset } = req.query;
  const negocios = await obtenerNegociosParaSuperadmin({ buscar: String(buscar), estado: String(estado), plan: String(plan), limit, offset });
  res.json(negocios);
});

app.post('/api/superadmin/negocios', requireSuperadmin, async (req, res) => {
  const { nombre, slug, nombrePropietario, emailAdmin, telefono, nombreSucursal, ciudad, plan, modulosIniciales, estadoInicial } = req.body;

  if (typeof nombre !== 'string' || !nombre.trim()) return res.status(400).json({ error: 'El nombre comercial es obligatorio' });
  if (typeof nombrePropietario !== 'string' || !nombrePropietario.trim()) return res.status(400).json({ error: 'El nombre del propietario es obligatorio' });
  if (typeof emailAdmin !== 'string' || !EMAIL_RE.test(emailAdmin.trim())) return res.status(400).json({ error: 'Correo del administrador inválido' });
  if (typeof nombreSucursal !== 'string' || !nombreSucursal.trim()) return res.status(400).json({ error: 'El nombre de la sucursal principal es obligatorio' });
  if (!PLANES_VALIDOS_API.includes(plan)) return res.status(400).json({ error: 'Plan inválido' });
  if (!['pendiente', 'activo'].includes(estadoInicial)) return res.status(400).json({ error: 'Estado inicial inválido (solo pendiente o activo)' });
  if (modulosIniciales !== undefined && (!Array.isArray(modulosIniciales) || modulosIniciales.some(m => !MODULOS_VALIDOS_API.includes(m)))) {
    return res.status(400).json({ error: 'Módulos iniciales inválidos' });
  }

  try {
    const resultado = await crearNegocioCompleto({
      nombre: nombre.trim(), slugDeseado: slug, nombrePropietario: nombrePropietario.trim(),
      emailAdmin: emailAdmin.trim(), telefono: telefono || '', nombreSucursal: nombreSucursal.trim(),
      ciudad: ciudad || '', plan, modulosIniciales: modulosIniciales || [], estadoInicial,
      superadminId: req.usuarioId,
    });

    const baseUrl = process.env.PUBLIC_URL || 'https://xabor.mx';
    const enlace = `${baseUrl}/crear-password?token=${resultado.invitacion.token}`;
    let entregadoPorCorreo = false;
    try {
      const r = await enviarCorreoInvitacion({ to: resultado.usuario.email, nombre: resultado.usuario.nombre, negocioNombre: resultado.negocio.nombre, enlace });
      entregadoPorCorreo = r.enviado;
    } catch (errCorreo) {
      console.error('[POST /api/superadmin/negocios] Error al enviar invitación (negocio ya quedó creado):', errCorreo.message);
    }

    // Decisión aceptada (sin proveedor de correo configurado): el enlace se
    // muestra UNA SOLA VEZ en esta respuesta para que el superadmin lo copie
    // y lo envíe manualmente. Nunca se loguea, nunca queda recuperable
    // después (no hay ningún GET que vuelva a exponerlo) -- solo existe en
    // este JSON, una vez, para quien acaba de crear el negocio. Si en el
    // futuro se conecta un proveedor real, entregadoPorCorreo=true y el
    // enlace deja de incluirse automáticamente (ya no hace falta copiarlo).
    const { invitacion, ...resultadoSeguro } = resultado;
    res.status(201).json({
      ...resultadoSeguro,
      invitacionEnviadaPorCorreo: entregadoPorCorreo,
      enlaceInvitacion: entregadoPorCorreo ? undefined : enlace,
    });
  } catch (e) {
    if (e.code === 'SLUG_DUPLICADO' || e.code === '23505') return res.status(409).json({ error: 'El slug ya está en uso' });
    if (e.code === 'EMAIL_EXISTENTE') return res.status(409).json({ error: e.message });
    if (e.code === 'SLUG_INVALIDO') return res.status(400).json({ error: e.message });
    console.error('[POST /api/superadmin/negocios] Error:', e.message);
    res.status(500).json({ error: 'Error al crear el negocio' });
  }
});

app.post('/api/superadmin/negocios/:negocioId/reenviar-invitacion', requireSuperadmin, rateLimitMiddleware(req => `reenviar:${req.usuarioId}`, 10, 60 * 1000), async (req, res) => {
  try {
    const resultado = await reenviarInvitacion(req.params.negocioId, req.usuarioId);
    if (!resultado) return res.status(404).json({ error: 'Negocio no encontrado' });

    const baseUrl = process.env.PUBLIC_URL || 'https://xabor.mx';
    const enlace = `${baseUrl}/crear-password?token=${resultado.token}`;
    let entregado = false;
    try {
      const r = await enviarCorreoInvitacion({ to: resultado.usuario.email, nombre: resultado.usuario.nombre, negocioNombre: resultado.negocioNombre, enlace });
      entregado = r.enviado;
    } catch (errCorreo) {
      console.error('[POST /api/superadmin/negocios/:id/reenviar-invitacion] Error al enviar:', errCorreo.message);
    }

    // Mismo criterio que en la creación de negocio: sin proveedor de correo,
    // el enlace se devuelve UNA VEZ para que el superadmin lo copie a mano.
    // Nunca se loguea, y esta es la única respuesta que lo expone -- no hay
    // ningún GET que lo recupere después.
    res.json({
      ok: true, negocioNombre: resultado.negocioNombre, expiresAt: resultado.expiresAt,
      correoEntregado: entregado,
      enlaceInvitacion: entregado ? undefined : enlace,
    });
  } catch (e) {
    if (e.code === 'SIN_ADMIN' || e.code === 'INVITACION_ACEPTADA') return res.status(409).json({ error: e.message, codigo: e.code });
    console.error('[POST /api/superadmin/negocios/:id/reenviar-invitacion] Error:', e.message);
    res.status(500).json({ error: 'Error al reenviar la invitación' });
  }
});

app.get('/api/superadmin/negocios/:negocioId', requireSuperadmin, async (req, res) => {
  const detalle = await obtenerNegocioDetalleSuperadmin(req.params.negocioId);
  if (!detalle) return res.status(404).json({ error: 'Negocio no encontrado' });
  res.json(detalle);
});

// ─── Edición de negocios (Superadmin) ───────────────────────────────────────
// PATCH parcial: solo los campos enviados se tocan; validaciones con códigos
// explícitos → 400/409; todo cambio queda en auditoría de plataforma.
const CODIGOS_EDICION_400 = ['NOMBRE_INVALIDO', 'SLUG_INVALIDO', 'SLUG_RESERVADO', 'EMAIL_INVALIDO'];
const CODIGOS_EDICION_409 = ['SLUG_DUPLICADO', 'EMAIL_EN_USO', 'SIN_ADMIN', 'INVITACION_ACEPTADA'];
function responderErrorEdicion(res, e, fallback) {
  if (CODIGOS_EDICION_400.includes(e.code)) return res.status(400).json({ error: e.message, codigo: e.code });
  if (CODIGOS_EDICION_409.includes(e.code)) return res.status(409).json({ error: e.message, codigo: e.code });
  console.error(fallback, e.message);
  return res.status(500).json({ error: 'Error interno' });
}

app.patch('/api/superadmin/negocios/:negocioId', requireSuperadmin, async (req, res) => {
  try {
    const { nombre, slug, contacto } = req.body || {};
    if (nombre === undefined && slug === undefined && (contacto === undefined || typeof contacto !== 'object')) {
      return res.status(400).json({ error: 'Nada que editar: envía nombre, slug y/o contacto' });
    }
    const resultado = await actualizarDatosNegocioSuperadmin(req.params.negocioId, { nombre, slug, contacto }, req.usuarioId);
    if (!resultado) return res.status(404).json({ error: 'Negocio no encontrado' });
    res.json({ ok: true, ...resultado });
  } catch (e) {
    responderErrorEdicion(res, e, '[PATCH /api/superadmin/negocios/:id] Error:');
  }
});

app.patch('/api/superadmin/negocios/:negocioId/admin', requireSuperadmin, async (req, res) => {
  try {
    const { email, nombre } = req.body || {};
    if (email === undefined && nombre === undefined) {
      return res.status(400).json({ error: 'Nada que editar: envía email y/o nombre' });
    }
    const resultado = await actualizarAdminNegocioSuperadmin(req.params.negocioId, { email, nombre }, req.usuarioId);
    if (!resultado) return res.status(404).json({ error: 'Negocio no encontrado' });
    res.json({ ok: true, ...resultado });
  } catch (e) {
    responderErrorEdicion(res, e, '[PATCH /api/superadmin/negocios/:id/admin] Error:');
  }
});

app.get('/api/superadmin/negocios/:negocioId/invitaciones', requireSuperadmin, async (req, res) => {
  const detalle = await obtenerNegocioDetalleSuperadmin(req.params.negocioId);
  if (!detalle) return res.status(404).json({ error: 'Negocio no encontrado' });
  res.json({ invitaciones: await obtenerInvitacionesNegocio(req.params.negocioId) });
});

// "Generar nueva invitación": mismo núcleo transaccional que reenviar (la
// creación interna ya revoca las pendientes del usuario), pensada para
// usarse DESPUÉS de corregir el correo del admin. Guard compartido: si la
// invitación ya fue aceptada, 409 — jamás dos admins ni contraseñas pisadas.
app.post('/api/superadmin/negocios/:negocioId/invitaciones/nueva', requireSuperadmin,
  rateLimitMiddleware(req => `inv-nueva:${req.usuarioId}`, 10, 60 * 1000), async (req, res) => {
  try {
    const resultado = await reenviarInvitacion(req.params.negocioId, req.usuarioId);
    if (!resultado) return res.status(404).json({ error: 'Negocio no encontrado' });
    const baseUrl = process.env.PUBLIC_URL || 'https://xabor.mx';
    const enlace = `${baseUrl}/crear-password?token=${resultado.token}`;
    let entregado = false;
    try {
      const r = await enviarCorreoInvitacion({ to: resultado.usuario.email, nombre: resultado.usuario.nombre, negocioNombre: resultado.negocioNombre, enlace });
      entregado = r.enviado;
    } catch (errCorreo) {
      console.error('[POST /api/superadmin/negocios/:id/invitaciones/nueva] Error al enviar:', errCorreo.message);
    }
    res.json({
      ok: true, negocioNombre: resultado.negocioNombre, correoDestino: resultado.usuario.email,
      expiresAt: resultado.expiresAt, correoEntregado: entregado,
      enlaceInvitacion: entregado ? undefined : enlace,
    });
  } catch (e) {
    responderErrorEdicion(res, e, '[POST /api/superadmin/negocios/:id/invitaciones/nueva] Error:');
  }
});

app.patch('/api/superadmin/negocios/:negocioId/estado', requireSuperadmin, async (req, res) => {
  const { estado } = req.body;
  if (!ESTADOS_NEGOCIO_VALIDOS_API.includes(estado)) return res.status(400).json({ error: 'Estado inválido' });
  try {
    const resultado = await actualizarEstadoNegocioSuperadmin(req.params.negocioId, estado, req.usuarioId);
    if (!resultado) return res.status(404).json({ error: 'Negocio no encontrado' });
    res.json(resultado);
  } catch (e) {
    console.error('[PATCH /api/superadmin/negocios/:id/estado] Error:', e.message);
    res.status(500).json({ error: 'Error al actualizar el estado' });
  }
});

app.patch('/api/superadmin/negocios/:negocioId/plan', requireSuperadmin, async (req, res) => {
  const { plan } = req.body;
  if (!PLANES_VALIDOS_API.includes(plan)) return res.status(400).json({ error: 'Plan inválido' });
  try {
    const resultado = await actualizarPlanNegocioSuperadmin(req.params.negocioId, plan, req.usuarioId);
    if (!resultado) return res.status(404).json({ error: 'Negocio no encontrado' });
    res.json(resultado);
  } catch (e) {
    console.error('[PATCH /api/superadmin/negocios/:id/plan] Error:', e.message);
    res.status(500).json({ error: 'Error al actualizar el plan' });
  }
});

// Plan comercial (Fase 7) -- exclusivo de Superadmin, seguimiento
// interno de mensualidad/fechas/estado del contrato. Nunca se expone en
// ninguna ruta de autoservicio del propio negocio.
app.get('/api/superadmin/negocios/:negocioId/plan-comercial', requireSuperadmin, async (req, res) => {
  const plan = await obtenerPlanComercial(req.params.negocioId);
  if (!plan) return res.status(404).json({ error: 'Negocio no encontrado' });
  res.json(plan);
});

app.patch('/api/superadmin/negocios/:negocioId/plan-comercial', requireSuperadmin, async (req, res) => {
  try {
    const resultado = await actualizarPlanComercial(req.params.negocioId, req.body || {}, req.usuarioId);
    if (!resultado) return res.status(404).json({ error: 'Negocio no encontrado' });
    res.json(resultado);
  } catch (e) {
    if (e.code === 'ESTADO_INVALIDO') return res.status(400).json({ error: e.message });
    console.error('[PATCH /api/superadmin/negocios/:id/plan-comercial] Error:', e.message);
    res.status(500).json({ error: 'Error al actualizar el plan comercial' });
  }
});

app.patch('/api/superadmin/negocios/:negocioId/modulos', requireSuperadmin, async (req, res) => {
  const { modulos } = req.body;
  if (!modulos || typeof modulos !== 'object' || Array.isArray(modulos)) return res.status(400).json({ error: 'Formato de módulos inválido' });
  try {
    const resultado = await actualizarModulosNegocioSuperadmin(req.params.negocioId, modulos, req.usuarioId);
    if (!resultado) return res.status(404).json({ error: 'Negocio no encontrado' });
    res.json(resultado);
  } catch (e) {
    if (e.code === 'MODULO_INVALIDO' || e.code === 'ESTADO_MODULO_INVALIDO') return res.status(400).json({ error: e.message });
    // Desactivación segura de Restaurante: mesas abiertas bloquean el apagado
    // del módulo. No se cierra ni se borra nada; el operador decide.
    if (e.code === 'RESTAURANTE_CON_CUENTAS_ABIERTAS') {
      return res.status(409).json({ error: e.message, codigo: e.code, cuentasAbiertas: e.cuentasAbiertas });
    }
    console.error('[PATCH /api/superadmin/negocios/:id/modulos] Error:', e.message);
    res.status(500).json({ error: 'Error al actualizar los módulos' });
  }
});

// Fuente única de módulos para la UI (fix readiness restaurante): la lista
// y las etiquetas salen del backend (MODULOS_VALIDOS) -- el frontend deja
// de duplicarlas hardcodeadas, que es exactamente el desfase que dejó a
// 'restaurante' invisible en el panel.
app.get('/api/superadmin/modulos-disponibles', requireSuperadmin, (req, res) => {
  res.json({ modulos: listarModulosDisponibles() });
});

// ─── Readiness del módulo Restaurante (Superadmin, solo lectura) ────────────
// Criterio mínimo para operar: módulo activo + >=1 usuario activo +
// >=1 producto disponible + número de mesas válido (default 12 si no se
// configuró -- el default nunca bloquea la activación).
app.get('/api/superadmin/negocios/:negocioId/restaurante-readiness', requireSuperadmin, async (req, res) => {
  const negocioId = req.params.negocioId;
  const { rows: existe } = await pool.query('SELECT 1 FROM negocios WHERE id = $1', [negocioId]);
  if (!existe.length) return res.status(404).json({ error: 'Negocio no encontrado' });
  try {
    const [modulo, cfg, usuarios, productos] = await Promise.all([
      pool.query(`SELECT estado FROM negocio_modulos WHERE negocio_id = $1 AND modulo = 'restaurante'`, [negocioId]),
      pool.query(`SELECT valor FROM configuracion WHERE negocio_id = $1 AND clave = 'restaurante_num_mesas'`, [negocioId]),
      pool.query(`SELECT COUNT(*)::int c FROM usuario_negocios un JOIN usuarios u ON u.id = un.usuario_id WHERE un.negocio_id = $1 AND un.activo AND u.activo`, [negocioId]),
      pool.query(`SELECT COUNT(*)::int c FROM menu_productos WHERE negocio_id = $1 AND disponible AND NOT COALESCE(agotado, FALSE)`, [negocioId]),
    ]);
    const estadoModulo = modulo.rows[0]?.estado || 'no_contratado';
    const numMesasConfigurado = parseInt(cfg.rows[0]?.valor, 10);
    const usandoDefault = !Number.isInteger(numMesasConfigurado) || numMesasConfigurado < 1;
    const numMesas = usandoDefault ? 12 : Math.min(numMesasConfigurado, 500);
    const usuariosActivos = usuarios.rows[0].c;
    const productosActivos = productos.rows[0].c;
    const listo = estadoModulo === 'activo' && usuariosActivos >= 1 && productosActivos >= 1 && numMesas >= 1 && numMesas <= 500;
    res.json({
      moduloEstado: estadoModulo, numMesas, usandoDefault,
      usuariosActivos, productosActivos,
      estado: listo ? 'LISTO' : 'CONFIGURACION_PENDIENTE',
    });
  } catch (e) {
    console.error('[GET /api/superadmin/negocios/:id/restaurante-readiness] Error:', e.message);
    res.status(500).json({ error: 'Error al calcular el readiness' });
  }
});

// Número de mesas: entero estricto 1-500 (decimales y fuera de rango se
// rechazan). Reutiliza configuracion (clave restaurante_num_mesas que
// listarMesas ya lee); sin migración, sin tabla de mesas. Auditado.
app.put('/api/superadmin/negocios/:negocioId/restaurante-config', requireSuperadmin, async (req, res) => {
  const negocioId = req.params.negocioId;
  const { rows: existe } = await pool.query('SELECT 1 FROM negocios WHERE id = $1', [negocioId]);
  if (!existe.length) return res.status(404).json({ error: 'Negocio no encontrado' });
  const crudo = req.body?.numMesas;
  const numMesas = Number(crudo);
  if (!Number.isInteger(numMesas) || String(crudo).includes('.') || numMesas < 1 || numMesas > 500) {
    return res.status(400).json({ error: 'Número de mesas inválido: entero entre 1 y 500' });
  }
  try {
    const { rows: prev } = await pool.query(`SELECT valor FROM configuracion WHERE negocio_id = $1 AND clave = 'restaurante_num_mesas'`, [negocioId]);
    await actualizarConfiguracion({ restaurante_num_mesas: String(numMesas) }, negocioId);
    await registrarAuditoriaPlataforma({
      superadminId: req.usuarioId, accion: 'restaurante_num_mesas', negocioId,
      estadoAnterior: { numMesas: prev[0]?.valor ?? null }, estadoNuevo: { numMesas },
    });
    res.json({ ok: true, numMesas });
  } catch (e) {
    console.error('[PUT /api/superadmin/negocios/:id/restaurante-config] Error:', e.message);
    res.status(500).json({ error: 'Error al guardar el número de mesas' });
  }
});

app.patch('/api/superadmin/negocios/:negocioId/checklist', requireSuperadmin, async (req, res) => {
  const { checklist } = req.body;
  if (!checklist || typeof checklist !== 'object' || Array.isArray(checklist)) return res.status(400).json({ error: 'Formato de checklist inválido' });
  if (Object.values(checklist).some(v => typeof v !== 'boolean')) return res.status(400).json({ error: 'Los valores del checklist deben ser boolean' });
  try {
    const resultado = await actualizarChecklistNegocioSuperadmin(req.params.negocioId, checklist, req.usuarioId);
    if (!resultado) return res.status(404).json({ error: 'Negocio no encontrado' });
    res.json(resultado);
  } catch (e) {
    console.error('[PATCH /api/superadmin/negocios/:id/checklist] Error:', e.message);
    res.status(500).json({ error: 'Error al actualizar el checklist' });
  }
});

// ---------------------------------------------------------------------
// Fase B -- Integraciones por negocio (Superadmin). Almacenamiento
// cifrado de credenciales y estado técnico, sin conexión real a Meta
// todavía (Embedded Signup / OAuth es Fase C). Ningún endpoint de esta
// sección devuelve access_token, IV ni auth tag en ninguna respuesta.
// ---------------------------------------------------------------------

app.get('/api/superadmin/negocios/:negocioId/integraciones', requireSuperadmin, async (req, res) => {
  if (!(await negocioExisteSuperadmin(req.params.negocioId))) return res.status(404).json({ error: 'Negocio no encontrado' });
  try {
    const integraciones = await obtenerIntegracionesNegocio(req.params.negocioId);
    res.json({ integraciones });
  } catch (e) {
    console.error('[GET /api/superadmin/negocios/:id/integraciones] Error:', e.message);
    res.status(500).json({ error: 'Error al obtener las integraciones' });
  }
});

// Clip por negocio (Incidente P0, Fase 7): guarda apiKey/apiSecret
// cifrados exclusivamente para ESTE negocio (integraciones_canal,
// canal='pagos' proveedor='clip'). Nunca se exponen de vuelta -- ni aquí
// ni en GET /integraciones -- el listado general ya excluye toda columna
// cifrada (ver COLUMNAS_SEGURAS en integracionesService.js).
app.put('/api/superadmin/negocios/:negocioId/integraciones/clip', requireSuperadmin, async (req, res) => {
  const negocioId = req.params.negocioId;
  if (!(await negocioExisteSuperadmin(negocioId))) return res.status(404).json({ error: 'Negocio no encontrado' });
  const { apiKey, apiSecret } = req.body || {};
  if (typeof apiKey !== 'string' || !apiKey.trim()) return res.status(400).json({ error: 'apiKey requerido' });
  if (typeof apiSecret !== 'string' || !apiSecret.trim()) return res.status(400).json({ error: 'apiSecret requerido' });
  try {
    const resultado = await guardarCredencialesClip(negocioId, apiKey, apiSecret, req.usuarioId);
    res.json(resultado);
  } catch (e) {
    console.error('[PUT /api/superadmin/negocios/:id/integraciones/clip] Error:', e.message);
    res.status(500).json({ error: 'Error al guardar las credenciales de Clip' });
  }
});

// ─── Pagos multiempresa (Fase 4) — Superadmin → Negocios → Integraciones → Pagos ──
// Genérico para cualquier proveedor registrado en paymentProviders.js. No
// reemplaza la ruta de Clip de arriba (se deja por compatibilidad hacia
// atrás), pero a partir de aquí Clip es solo un caso más del registro
// genérico -- el panel nuevo debe usar estas rutas, no la de Clip.
app.get('/api/superadmin/proveedores-pago', requireSuperadmin, (req, res) => {
  res.json({ proveedores: listarProveedores() });
});

app.get('/api/superadmin/negocios/:negocioId/integraciones/pagos', requireSuperadmin, async (req, res) => {
  const negocioId = req.params.negocioId;
  if (!(await negocioExisteSuperadmin(negocioId))) return res.status(404).json({ error: 'Negocio no encontrado' });
  try {
    res.json({ integraciones: await listarIntegracionesPago(negocioId) });
  } catch (e) {
    console.error('[GET /api/superadmin/negocios/:id/integraciones/pagos] Error:', e.message);
    res.status(500).json({ error: 'Error al obtener las integraciones de pago' });
  }
});

app.put('/api/superadmin/negocios/:negocioId/integraciones/pagos/:proveedor', requireSuperadmin, async (req, res) => {
  const { negocioId, proveedor } = req.params;
  if (!(await negocioExisteSuperadmin(negocioId))) return res.status(404).json({ error: 'Negocio no encontrado' });
  if (!esProveedorValido(proveedor)) return res.status(400).json({ error: 'Proveedor no reconocido' });
  const { credenciales, ambiente } = req.body || {};
  if (!credenciales || typeof credenciales !== 'object') return res.status(400).json({ error: 'credenciales requerido' });
  try {
    const resultado = await guardarIntegracionPago(negocioId, proveedor, credenciales, { ambiente: ambiente === 'produccion' ? 'produccion' : 'sandbox', actualizadoPor: req.usuarioId });
    res.json(resultado);
  } catch (e) {
    console.error('[PUT /api/superadmin/negocios/:id/integraciones/pagos/:proveedor] Error:', e.message);
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/superadmin/negocios/:negocioId/integraciones/pagos/:proveedor/probar', requireSuperadmin, async (req, res) => {
  const { negocioId, proveedor } = req.params;
  if (!(await negocioExisteSuperadmin(negocioId))) return res.status(404).json({ error: 'Negocio no encontrado' });
  if (!esProveedorValido(proveedor)) return res.status(400).json({ error: 'Proveedor no reconocido' });
  try {
    res.json(await probarIntegracionPago(negocioId, proveedor));
  } catch (e) {
    console.error('[POST .../pagos/:proveedor/probar] Error:', e.message);
    res.status(500).json({ error: 'Error al probar la conexión' });
  }
});

app.post('/api/superadmin/negocios/:negocioId/integraciones/pagos/:proveedor/principal', requireSuperadmin, async (req, res) => {
  const { negocioId, proveedor } = req.params;
  if (!(await negocioExisteSuperadmin(negocioId))) return res.status(404).json({ error: 'Negocio no encontrado' });
  if (!esProveedorValido(proveedor)) return res.status(400).json({ error: 'Proveedor no reconocido' });
  const ok = await marcarProveedorPrincipal(negocioId, proveedor, req.usuarioId);
  if (!ok) return res.status(400).json({ error: 'No se pudo marcar como principal (¿está activo?)' });
  res.json({ ok: true });
});

app.post('/api/superadmin/negocios/:negocioId/integraciones/pagos/:proveedor/suspender', requireSuperadmin, async (req, res) => {
  const { negocioId, proveedor } = req.params;
  if (!(await negocioExisteSuperadmin(negocioId))) return res.status(404).json({ error: 'Negocio no encontrado' });
  if (!esProveedorValido(proveedor)) return res.status(400).json({ error: 'Proveedor no reconocido' });
  const resultado = await suspenderIntegracionPago(negocioId, proveedor, req.usuarioId);
  if (!resultado.ok) return res.status(400).json(resultado);
  res.json(resultado);
});

app.post('/api/superadmin/negocios/:negocioId/integraciones/pagos/:proveedor/reactivar', requireSuperadmin, async (req, res) => {
  const { negocioId, proveedor } = req.params;
  if (!(await negocioExisteSuperadmin(negocioId))) return res.status(404).json({ error: 'Negocio no encontrado' });
  if (!esProveedorValido(proveedor)) return res.status(400).json({ error: 'Proveedor no reconocido' });
  const resultado = await reactivarIntegracionPago(negocioId, proveedor, req.usuarioId);
  if (!resultado.ok) return res.status(400).json(resultado);
  res.json(resultado);
});

app.delete('/api/superadmin/negocios/:negocioId/integraciones/pagos/:proveedor', requireSuperadmin, async (req, res) => {
  const { negocioId, proveedor } = req.params;
  if (!(await negocioExisteSuperadmin(negocioId))) return res.status(404).json({ error: 'Negocio no encontrado' });
  if (!esProveedorValido(proveedor)) return res.status(400).json({ error: 'Proveedor no reconocido' });
  const ok = await eliminarCredencialesPago(negocioId, proveedor, req.usuarioId);
  if (!ok) return res.status(404).json({ error: 'Integración no encontrada' });
  res.json({ ok: true });
});

app.get('/api/superadmin/negocios/:negocioId/integraciones/whatsapp', requireSuperadmin, async (req, res) => {
  if (!(await negocioExisteSuperadmin(req.params.negocioId))) return res.status(404).json({ error: 'Negocio no encontrado' });
  try {
    const integracion = await obtenerIntegracionNegocio(req.params.negocioId, 'whatsapp', 'meta');
    const estadoModulo = await obtenerEstadoModulo(req.params.negocioId, 'whatsapp');
    res.json({ integracion, estadoModulo: estadoModulo || 'no_contratado', conexionPendiente: hayIntentoPendiente(req.params.negocioId) });
  } catch (e) {
    console.error('[GET /api/superadmin/negocios/:id/integraciones/whatsapp] Error:', e.message);
    res.status(500).json({ error: 'Error al obtener la integración' });
  }
});

// PUT manual -- solo para pruebas internas y migraciones controladas.
// No se expone como formulario de "pegar token" en la UI normal
// (Fase C usará Embedded Signup en su lugar).
app.put('/api/superadmin/negocios/:negocioId/integraciones/whatsapp', requireSuperadmin, async (req, res) => {
  // Apagado por defecto -- esta vía manual solo existe para pruebas
  // internas y migraciones controladas (ver comentario arriba). En
  // producción la variable debe quedar ausente o en 'false'; nunca se
  // imprime su valor, solo se compara.
  if (process.env.ALLOW_MANUAL_INTEGRATION_CREDENTIALS !== 'true') {
    return res.status(403).json({ error: 'Configuración manual de credenciales de WhatsApp deshabilitada en este entorno' });
  }
  const negocioId = req.params.negocioId;
  if (!(await negocioExisteSuperadmin(negocioId))) return res.status(404).json({ error: 'Negocio no encontrado' });
  const estadoModulo = await obtenerEstadoModulo(negocioId, 'whatsapp');
  if (!estadoModulo || estadoModulo === 'no_contratado') {
    return res.status(403).json({ error: 'El módulo de WhatsApp no está contratado para este negocio' });
  }
  if (estadoModulo === 'suspendido') {
    return res.status(403).json({ error: 'El módulo de WhatsApp está suspendido para este negocio' });
  }
  const { phoneNumberId, wabaId, businessId, displayPhoneNumber, accessToken, nombre } = req.body || {};
  if (typeof phoneNumberId !== 'string' || !phoneNumberId.trim()) return res.status(400).json({ error: 'phoneNumberId requerido' });
  if (typeof accessToken !== 'string' || !accessToken.trim()) return res.status(400).json({ error: 'accessToken requerido' });
  try {
    const resultado = await guardarCredencialesCifradas(
      negocioId, 'whatsapp', 'meta',
      { phoneNumberId, wabaId, businessId, displayPhoneNumber, accessToken, nombre },
      req.usuarioId
    );
    // Mismo criterio que el callback de Embedded Signup: guardar
    // credenciales nunca deja la integración en 'activo' por sí solo (ver
    // completarActivacionWhatsapp) -- se intenta completar la activación
    // real de inmediato también en esta vía manual, para no tener dos
    // rutas con comportamiento distinto.
    let activacion = null;
    try {
      activacion = await completarActivacionWhatsapp(negocioId, req.usuarioId);
    } catch (eActivacion) {
      console.error('[PUT /api/superadmin/negocios/:id/integraciones/whatsapp] Error al completar activación:', eActivacion.message);
    }
    res.json({ ...resultado, estado: activacion?.estado || resultado.estado, activacion });
  } catch (e) {
    console.error('[PUT /api/superadmin/negocios/:id/integraciones/whatsapp] Error:', e.message);
    res.status(500).json({ error: 'Error al guardar las credenciales' });
  }
});

app.patch('/api/superadmin/negocios/:negocioId/integraciones/whatsapp/estado', requireSuperadmin, async (req, res) => {
  const negocioId = req.params.negocioId;
  if (!(await negocioExisteSuperadmin(negocioId))) return res.status(404).json({ error: 'Negocio no encontrado' });
  const { estado } = req.body || {};
  if (!ESTADOS_INTEGRACION_VALIDOS_API.includes(estado)) return res.status(400).json({ error: 'Estado inválido' });
  const estadoModulo = await obtenerEstadoModulo(negocioId, 'whatsapp');
  if (estado === 'activo' && (!estadoModulo || estadoModulo === 'no_contratado' || estadoModulo === 'suspendido')) {
    return res.status(403).json({ error: 'No se puede activar: el módulo de WhatsApp no está contratado o está suspendido' });
  }
  try {
    const resultado = await actualizarEstadoIntegracion(negocioId, 'whatsapp', 'meta', estado, req.usuarioId);
    if (!resultado.ok) return res.status(400).json({ error: resultado.error });
    res.json(resultado);
  } catch (e) {
    console.error('[PATCH /api/superadmin/negocios/:id/integraciones/whatsapp/estado] Error:', e.message);
    res.status(500).json({ error: 'Error al actualizar el estado' });
  }
});

app.delete('/api/superadmin/negocios/:negocioId/integraciones/whatsapp/credenciales', requireSuperadmin, async (req, res) => {
  const negocioId = req.params.negocioId;
  if (!(await negocioExisteSuperadmin(negocioId))) return res.status(404).json({ error: 'Negocio no encontrado' });
  if (req.body?.confirmar !== true) {
    return res.status(400).json({ error: 'Se requiere confirmación explícita ({ confirmar: true }) para eliminar credenciales' });
  }
  try {
    const resultado = await eliminarCredencialesIntegracion(negocioId, 'whatsapp', 'meta', req.usuarioId);
    if (!resultado.ok) return res.status(400).json({ error: resultado.error });
    res.json(resultado);
  } catch (e) {
    console.error('[DELETE /api/superadmin/negocios/:id/integraciones/whatsapp/credenciales] Error:', e.message);
    res.status(500).json({ error: 'Error al eliminar las credenciales' });
  }
});

// ---------------------------------------------------------------------
// Fase C -- Embedded Signup de Meta. No conecta números reales todavía
// (eso es una acción manual explícita posterior). El callback nunca
// confía en negocio_id del body -- solo en el que trae el state firmado
// y ya validado. Ningún log ni respuesta incluye access_token/code.
// ---------------------------------------------------------------------
// Configuración PÚBLICA únicamente -- nunca META_APP_SECRET, tokens, ni
// la llave de cifrado. Leída de process.env en cada request (runtime),
// nunca fijada en build ni hardcodeada.
app.get('/api/superadmin/meta/embedded-signup/config', requireSuperadmin, (req, res) => {
  const appId = process.env.META_APP_ID;
  const configId = process.env.META_CONFIG_ID;
  if (!appId || !configId) {
    return res.status(503).json({ error: 'Embedded Signup no está configurado en este entorno (falta META_APP_ID/META_CONFIG_ID)' });
  }
  res.json({ appId, configId, graphApiVersion: GRAPH_VERSION });
});

// Interruptor global de bot de WhatsApp por negocio (migración 019).
// Independiente del estado técnico de la integración -- puede haber
// credenciales válidas y el bot seguir apagado. Vista Superadmin:
// cualquier negocio, por :negocioId.
app.get('/api/superadmin/negocios/:negocioId/bot-whatsapp', requireSuperadmin, async (req, res) => {
  if (!(await negocioExisteSuperadmin(req.params.negocioId))) return res.status(404).json({ error: 'Negocio no encontrado' });
  res.json({ botWhatsappActivo: await obtenerBotWhatsappActivoNegocio(req.params.negocioId) });
});

app.get('/api/superadmin/negocios/:negocioId/checklist-activacion-bot', requireSuperadmin, async (req, res) => {
  const chequeo = await obtenerChecklistActivacionBot(req.params.negocioId);
  if (!chequeo) return res.status(404).json({ error: 'Negocio no encontrado' });
  res.json(chequeo);
});

// Estado del sistema (Fase 6: diagnóstico y soporte). Solo lectura,
// agrega datos que ya existen -- ver obtenerDiagnosticoNegocio. La
// integración de WhatsApp se resuelve aquí con columnas ya filtradas
// (COLUMNAS_SEGURAS en integracionesService.js nunca incluye secretos).
app.get('/api/admin/diagnostico', requireAdminSeguro, async (req, res) => {
  const integracionWhatsapp = await obtenerIntegracionNegocio(req.negocioId, 'whatsapp', 'meta');
  const diagnostico = await obtenerDiagnosticoNegocio(req.negocioId, integracionWhatsapp);
  if (!diagnostico) return res.status(404).json({ error: 'Negocio no encontrado' });
  res.json(diagnostico);
});

// Vista propia del administrador (Fase 5: onboarding guiado) -- mismos
// datos que la versión de superadmin, autoservicio sobre req.negocioId.
app.get('/api/admin/checklist-activacion-bot', requireAdminSeguro, async (req, res) => {
  const chequeo = await obtenerChecklistActivacionBot(req.negocioId);
  if (!chequeo) return res.status(404).json({ error: 'Negocio no encontrado' });
  res.json(chequeo);
});

// Confirmaciones manuales del propio negocio (mensaje_inicial_revisado,
// prueba_manual_confirmada, aceptacion_administrador) -- mismas 3 claves
// que ya usa el checklist de activación de superadmin, mismo
// negocios.checklist JSONB. Solo permite tocar esas 3 claves desde
// autoservicio: cualquier otra (p. ej. las del checklist de instalación
// de superadmin) queda fuera de este endpoint a propósito.
const CLAVES_CHECKLIST_AUTOSERVICIO = ['mensaje_inicial_revisado', 'prueba_manual_confirmada', 'aceptacion_administrador'];
app.patch('/api/admin/checklist', requireAdminSeguro, async (req, res) => {
  const { checklist } = req.body || {};
  if (!checklist || typeof checklist !== 'object' || Array.isArray(checklist)) return res.status(400).json({ error: 'Formato de checklist inválido' });
  const claves = Object.keys(checklist);
  if (!claves.length || claves.some(c => !CLAVES_CHECKLIST_AUTOSERVICIO.includes(c))) {
    return res.status(400).json({ error: `Solo se pueden actualizar: ${CLAVES_CHECKLIST_AUTOSERVICIO.join(', ')}` });
  }
  if (Object.values(checklist).some(v => typeof v !== 'boolean')) return res.status(400).json({ error: 'Los valores del checklist deben ser boolean' });
  try {
    const resultado = await actualizarChecklistNegocioSuperadmin(req.negocioId, checklist, req.usuarioId);
    if (!resultado) return res.status(404).json({ error: 'Negocio no encontrado' });
    res.json(resultado);
  } catch (e) {
    console.error('[PATCH /api/admin/checklist] Error:', e.message);
    res.status(500).json({ error: 'Error al actualizar el checklist' });
  }
});

app.patch('/api/superadmin/negocios/:negocioId/bot-whatsapp', requireSuperadmin, async (req, res) => {
  const { activo } = req.body || {};
  if (typeof activo !== 'boolean') return res.status(400).json({ error: 'activo debe ser boolean' });
  // El checklist de activación (GET .../checklist-activacion-bot) es
  // asesor -- gatea el botón "Activar" en el panel, pero deliberadamente
  // NO bloquea esta API. Un negocio ya operando (p. ej. uno cuyo perfil
  // de configuración es anterior a este checklist) nunca debe quedar
  // atrapado sin poder reactivar su propio bot por un chequeo nuevo que
  // no puede verificarse contra sus datos reales de producción desde
  // este entorno de trabajo local.
  try {
    const resultado = await actualizarBotWhatsappActivoNegocio(req.params.negocioId, activo, { superadminId: req.usuarioId });
    if (!resultado) return res.status(404).json({ error: 'Negocio no encontrado' });
    res.json(resultado);
  } catch (e) {
    console.error('[PATCH /api/superadmin/negocios/:id/bot-whatsapp] Error:', e.message);
    res.status(500).json({ error: 'Error al actualizar el interruptor del bot' });
  }
});

// Aviso previo a Embedded Signup estándar (Fase 6 -- preparación para
// primeros clientes): registra que el superadmin vio y aceptó
// explícitamente el aviso de migración antes de iniciar la conexión real
// con Meta. Solo auditoría -- nunca guarda número, token ni ningún dato
// sensible, solo negocio/usuario/fecha/versión del aviso. No bloquea
// /iniciar (ese endpoint sigue igual); el gate real es el modal en el
// panel, que no deja llamar a /iniciar sin pasar por aquí primero.
const AVISO_MIGRACION_WHATSAPP_VERSION = '1';
app.post('/api/superadmin/negocios/:negocioId/integraciones/whatsapp/aviso-migracion', requireSuperadmin, async (req, res) => {
  const negocioId = req.params.negocioId;
  if (!(await negocioExisteSuperadmin(negocioId))) return res.status(404).json({ error: 'Negocio no encontrado' });
  await registrarAuditoriaPlataforma({
    superadminId: req.usuarioId, accion: 'aviso_migracion_whatsapp_aceptado', negocioId,
    contexto: { version: AVISO_MIGRACION_WHATSAPP_VERSION },
  });
  res.json({ ok: true, version: AVISO_MIGRACION_WHATSAPP_VERSION });
});

app.post('/api/superadmin/negocios/:negocioId/integraciones/whatsapp/iniciar', requireSuperadmin, async (req, res) => {
  const negocioId = req.params.negocioId;
  if (!(await negocioExisteSuperadmin(negocioId))) return res.status(404).json({ error: 'Negocio no encontrado' });
  const estadoModulo = await obtenerEstadoModulo(negocioId, 'whatsapp');
  if (!estadoModulo || estadoModulo === 'no_contratado') {
    return res.status(403).json({ error: 'El módulo de WhatsApp no está contratado para este negocio' });
  }
  if (estadoModulo === 'suspendido') {
    return res.status(403).json({ error: 'El módulo de WhatsApp está suspendido para este negocio' });
  }
  // Ya no bloquea con 409: iniciar de nuevo simplemente reemplaza
  // cualquier intento previo de este negocio -- el state anterior (si
  // alguien lo usa después) se rechaza como "reemplazado" en el
  // callback (ver validarIntentoVigente). Esto evita quedar atorado
  // esperando el vencimiento de 10 minutos cuando un intento previo se
  // abandonó (popup cerrado, recarga de página, etc.).
  const state = crearState({ negocioId, superadminId: req.usuarioId });
  registrarIntentoPendiente(negocioId, state);
  await registrarAuditoriaPlataforma({
    superadminId: req.usuarioId, accion: 'integracion_embedded_signup_iniciado', negocioId,
    contexto: { canal: 'whatsapp', proveedor: 'meta' },
  });
  res.json({ state }); // appId/configId se obtienen aparte de GET /api/superadmin/meta/embedded-signup/config
});

// Cancela el intento pendiente vigente del negocio -- idempotente
// (llamarlo sin intento pendiente, o dos veces seguidas, sigue
// devolviendo 200). No toca integraciones ni credenciales, solo el
// rastreo efímero del intento en curso.
app.delete('/api/superadmin/negocios/:negocioId/integraciones/whatsapp/conexion-pendiente', requireSuperadmin, async (req, res) => {
  const negocioId = req.params.negocioId;
  if (!(await negocioExisteSuperadmin(negocioId))) return res.status(404).json({ error: 'Negocio no encontrado' });
  cancelarIntentoPendiente(negocioId);
  await registrarAuditoriaPlataforma({
    superadminId: req.usuarioId, accion: 'integracion_embedded_signup_cancelado', negocioId,
    contexto: { canal: 'whatsapp', proveedor: 'meta' },
  });
  res.json({ ok: true });
});

app.get('/api/superadmin/negocios/:negocioId/integraciones/whatsapp/estado', requireSuperadmin, async (req, res) => {
  if (!(await negocioExisteSuperadmin(req.params.negocioId))) return res.status(404).json({ error: 'Negocio no encontrado' });
  res.json({ estado: await obtenerEstadoIntegracion(req.params.negocioId, 'whatsapp', 'meta') });
});

// "Completar activación" / "Reintentar registro" -- ejecuta los dos pasos
// que Embedded Signup por sí solo no cubre (POST /register y POST
// /subscribed_apps, ver metaEmbeddedSignup.js) sobre credenciales YA
// guardadas, sin repetir el flujo de Embedded Signup ni tocar el
// access_token/identificadores existentes. Se usa tanto automáticamente
// tras un signup nuevo como manualmente para reintentar uno que quedó
// pendiente (p. ej. el incidente real del negocio Alora).
app.post('/api/superadmin/negocios/:negocioId/integraciones/whatsapp/completar-activacion', requireSuperadmin, async (req, res) => {
  const negocioId = req.params.negocioId;
  if (!(await negocioExisteSuperadmin(negocioId))) return res.status(404).json({ error: 'Negocio no encontrado' });
  try {
    const resultado = await completarActivacionWhatsapp(negocioId, req.usuarioId);
    if (!resultado.ok && resultado.error) return res.status(400).json({ error: resultado.error });
    res.json(resultado);
  } catch (e) {
    console.error('[POST /api/superadmin/negocios/:id/integraciones/whatsapp/completar-activacion] Error:', e.message);
    res.status(500).json({ error: 'Error al completar la activación' });
  }
});

// Sin requireSuperadmin -- el propio state firmado es la credencial (el
// navegador del superadmin es redirigido aquí por Meta, no llega con
// cookie de sesión del panel en todos los flujos). Nunca confía en
// negocio_id del body; solo en el que trae el state ya validado.
const MENSAJES_INTENTO_INVALIDO = {
  no_vigente: 'No hay una conexión pendiente vigente para este negocio',
  cancelado: 'Esta conexión fue cancelada',
  vencido: 'Esta conexión venció, inicia una nueva',
  reemplazado: 'Esta conexión fue reemplazada por un intento más reciente',
};


// ─── Autoservicio de WhatsApp para el negocio ────────────────────────────────
//
// Mismo flujo de Embedded Signup que ya usa Superadmin, con otro actor. NO se
// duplica el backend: el callback publico
// (/api/integraciones/whatsapp/meta/callback) es el mismo, y sigue derivando
// el negocio del `state` firmado -- nunca del cuerpo de la peticion. Eso es
// lo que permite que el popup de Meta responda a un endpoint sin sesion sin
// que nadie pueda conectar WhatsApp al negocio de otro.
//
// Aqui solo se agrega la puerta de entrada del cliente y la lectura de estado
// sin secretos.

// El negocio SIEMPRE sale de la sesion. Un negocioId en el cuerpo o en la
// query se ignora por completo: no es un dato, es un intento.
function requireAdminNegocio(req, res, next) {
  if (!puedeAdministrarWhatsapp(req.rol)) {
    return res.status(403).json({
      error: 'Solo un administrador del negocio puede conectar WhatsApp',
    });
  }
  next();
}

// Datos publicos que necesita el SDK de Meta en el navegador. No son
// secretos: el App ID viaja en cualquier integracion de Facebook Login.
app.get('/api/integraciones/whatsapp/config', requireAuthSeguro, requireModulo('whatsapp'), requireAdminNegocio, (req, res) => {
  const appId = process.env.META_APP_ID || null;
  const configId = process.env.META_CONFIG_ID || null;   // la misma que usa Superadmin
  res.json({
    appId, configId,
    graphApiVersion: GRAPH_VERSION,
    listo: Boolean(appId && configId),
  });
});

// Arranca un intento. Devuelve el state firmado que el navegador le pasa a
// Meta y que volvera en el callback.
app.post('/api/integraciones/whatsapp/iniciar', requireAuthSeguro, requireModulo('whatsapp'), requireAdminNegocio, async (req, res) => {
  const negocioId = req.negocioId;      // de la sesion, jamas del cuerpo
  try {
    const state = crearState({ negocioId, usuarioId: req.usuarioId });
    registrarIntentoPendiente(negocioId, state);
    res.json({ state });
  } catch (e) {
    console.error('[WA autoservicio] no se pudo iniciar:', e.message);
    res.status(500).json({ error: 'No pudimos preparar la conexion con Meta' });
  }
});

// Cancelar: el cliente cerro la ventana de Meta. Idempotente.
app.delete('/api/integraciones/whatsapp/conexion-pendiente', requireAuthSeguro, requireModulo('whatsapp'), requireAdminNegocio, (req, res) => {
  cancelarIntentoPendiente(req.negocioId);
  res.json({ ok: true });
});

// Estado para pintar la seccion. Sin un solo secreto dentro.
app.get('/api/integraciones/whatsapp/estado', requireAuthSeguro, requireModulo('whatsapp'), requireAdminNegocio, async (req, res) => {
  try {
    res.json(await estadoWhatsappNegocio(req.negocioId));
  } catch (e) {
    console.error('[WA autoservicio] estado:', e.message);
    res.status(500).json({ error: 'No pudimos leer el estado de la conexion' });
  }
});

// Verificar conexion: comprueba lo que ya sabemos sin mandar un mensaje real
// al cliente. Un "verificar" que le escribe a alguien no es una verificacion,
// es un mensaje no solicitado.
app.post('/api/integraciones/whatsapp/verificar', requireAuthSeguro, requireModulo('whatsapp'), requireAdminNegocio, async (req, res) => {
  try {
    const estado = await estadoWhatsappNegocio(req.negocioId);
    // Mensajes sensibles al modo: en coexistence el registro se omite a
    // propósito y jamás se reporta como faltante (ver accionesFaltantes).
    const faltantes = accionesFaltantes(estado);

    // Coexistence: la evidencia de que el modo dual sigue vivo son los
    // campos oficiales del número (is_on_biz_app) -- se consultan con las
    // credenciales del negocio SOLO en este "Verificar conexión" (lectura
    // a Meta, jamás un mensaje al cliente). Sin credenciales resolubles no
    // se adivina: simplemente no se agrega ni quita nada.
    if (estado.connectionMode === 'coexistence' && estado.conectado) {
      try {
        const { obtenerCredencialesWhatsappNegocio } = await import('./services/database.js');
        const cred = await obtenerCredencialesWhatsappNegocio(req.negocioId);
        if (cred) {
          const { verificarModoNumero } = await import('./services/metaEmbeddedSignup.js');
          const modo = await verificarModoNumero(cred.phoneNumberId, cred.accessToken);
          if (modo.ok && modo.isOnBizApp !== true) {
            faltantes.push('El numero ya no esta vinculado a la WhatsApp Business App del telefono.');
          }
        }
      } catch (eCoex) {
        console.error('[WA autoservicio] verificacion coexistence:', eCoex.message);
      }
    }

    await pool.query(
      `UPDATE integraciones_canal SET ultima_prueba_at = NOW(), ultima_prueba_ok = $2
        WHERE negocio_id = $1 AND canal = 'whatsapp'`,
      [req.negocioId, faltantes.length === 0]).catch(() => {});

    res.json({
      ok: faltantes.length === 0,
      mensaje: faltantes.length === 0 ? 'Todo listo' : 'Hay algo pendiente',
      acciones: faltantes,
      estado,
    });
  } catch (e) {
    const traducido = traducirErrorMeta(e);
    console.error('[WA autoservicio] verificar:', e.message);
    res.status(502).json({ ok: false, mensaje: traducido.mensaje });
  }
});

// Reintentar activación SIN repetir OAuth: si el Embedded Signup ya dejó
// credenciales completas (token + PNID + WABA) pero alguna etapa posterior
// falló (suscripción, verificación de modo), el negocio puede reintentar
// desde su panel. El connection_mode NO viene del frontend: la autoridad es
// el guardado en la integración canónica (completarActivacionWhatsapp lo lee
// de la fila cuando no se le pasa modo) -- un retry de coexistence jamás
// dispara /register. Tenant de la sesión, mismo trío de middlewares del
// autoservicio.
app.post('/api/integraciones/whatsapp/reintentar-activacion', requireAuthSeguro, requireModulo('whatsapp'), requireAdminNegocio, async (req, res) => {
  try {
    const resultado = await completarActivacionWhatsapp(req.negocioId, req.usuarioId);
    if (!resultado.ok && resultado.error) return res.status(400).json({ error: resultado.error });
    res.json({ ok: resultado.ok, estado: resultado.estado, estadoNegocio: await estadoWhatsappNegocio(req.negocioId) });
  } catch (e) {
    console.error('[WA autoservicio] reintentar-activacion:', e.message);
    res.status(500).json({ error: 'No pudimos completar la activacion' });
  }
});

// ─── Menú automático de WhatsApp (autoservicio del negocio) ─────────────────
//
// El negocio_id sale SIEMPRE de req.negocioId (la sesión), nunca del cuerpo ni
// de la URL: un admin de un negocio no tiene forma de nombrar el menú de otro.
// Mismo trío de middlewares que el resto del autoservicio de WhatsApp, así que
// mesero/operador/repartidor reciben 403 por requireAdminNegocio.

app.get('/api/config/whatsapp/menu', requireAuthSeguro, requireModulo('whatsapp'), requireAdminNegocio, async (req, res) => {
  try {
    res.json(await obtenerMenuNegocio(req.negocioId));
  } catch (e) {
    console.error('[Menu WA] estado:', e.message);
    res.status(500).json({ error: 'No pudimos leer la configuración de tu menú' });
  }
});

app.post('/api/config/whatsapp/menu', requireAuthSeguro, requireModulo('whatsapp'), requireAdminNegocio, async (req, res) => {
  const { activo, frases } = req.body || {};
  try {
    const r = await guardarConfigMenu(req.negocioId, { activo, frases }, req.usuarioId);
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json(r.menu);
  } catch (e) {
    console.error('[Menu WA] guardar config:', e.message);
    res.status(500).json({ error: 'No pudimos guardar la configuración de tu menú' });
  }
});

// La imagen llega en base64 dentro del JSON, igual que /api/imagenes/enviar --
// se reutiliza el parser que ya existe en vez de meter multipart nuevo.
app.post('/api/config/whatsapp/menu/imagen', requireAuthSeguro, requireModulo('whatsapp'), requireAdminNegocio,
  rateLimitMiddleware(req => `menu-imagen:${req.negocioId}`, 10, 60 * 1000),
  async (req, res) => {
    const { base64, filename } = req.body || {};
    if (typeof base64 !== 'string' || !base64.trim()) {
      return res.status(400).json({ error: 'No recibimos ninguna imagen' });
    }
    let buffer;
    try {
      buffer = Buffer.from(base64, 'base64');
    } catch {
      return res.status(400).json({ error: 'La imagen no se pudo leer' });
    }
    if (buffer.length > menuTamanoMaximoBytes()) {
      return res.status(413).json({ error: `La imagen pesa más de ${Math.round(menuTamanoMaximoBytes() / 1024 / 1024)} MB` });
    }
    try {
      // Multiimagen (050): sin imagenId agrega una PÁGINA nueva al final;
      // con imagenId reemplaza esa página (verificada como del negocio).
      const r = await guardarImagenMenu(req.negocioId, buffer, filename, req.usuarioId, { imagenId: req.body?.imagenId || null });
      if (!r.ok) return res.status(400).json({ error: r.error });
      res.json(r.menu);
    } catch (e) {
      console.error('[Menu WA] subir imagen:', e.message);
      res.status(500).json({ error: 'No pudimos guardar la imagen de tu menú' });
    }
  });

// Multiimagen (050): quitar UNA página. Si era la última, el servicio
// desactiva el menú de forma segura (jamás activo con cero imágenes).
app.delete('/api/config/whatsapp/menu/imagen/:imagenId', requireAuthSeguro, requireModulo('whatsapp'), requireAdminNegocio, async (req, res) => {
  try {
    const r = await eliminarImagenMenuPagina(req.negocioId, req.params.imagenId, req.usuarioId);
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json(r.menu);
  } catch (e) {
    console.error('[Menu WA] eliminar página:', e.message);
    res.status(500).json({ error: 'No pudimos quitar esa página del menú' });
  }
});

// Multiimagen (050): reordenar páginas. `ids` debe ser exactamente el
// conjunto actual de páginas del negocio (el servicio lo valida).
app.post('/api/config/whatsapp/menu/imagenes/orden', requireAuthSeguro, requireModulo('whatsapp'), requireAdminNegocio, async (req, res) => {
  try {
    const r = await reordenarImagenesMenu(req.negocioId, req.body?.ids, req.usuarioId);
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json(r.menu);
  } catch (e) {
    console.error('[Menu WA] reordenar páginas:', e.message);
    res.status(500).json({ error: 'No pudimos reordenar las páginas del menú' });
  }
});

// Multiimagen (050): vista previa de UNA página específica (misma política
// que la vista previa clásica: bytes por el backend, jamás una URL del
// bucket; el id se resuelve SIEMPRE dentro del negocio de la sesión).
app.get('/api/config/whatsapp/menu/imagen/:imagenId', requireAuthSeguro, requireModulo('whatsapp'), requireAdminNegocio, async (req, res) => {
  try {
    const imagen = await leerImagenMenu(req.negocioId, req.params.imagenId);
    if (!imagen) return res.status(404).json({ error: 'Esa página del menú no existe' });
    res.setHeader('Content-Type', imagen.mimeType);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', `inline; filename="${String(imagen.nombre).replace(/[\/"]/g, '_')}"`);
    res.send(imagen.buffer);
  } catch (e) {
    console.error('[Menu WA] vista previa de página:', e.message);
    res.status(500).json({ error: 'No pudimos mostrar esa página' });
  }
});

app.delete('/api/config/whatsapp/menu/imagen', requireAuthSeguro, requireModulo('whatsapp'), requireAdminNegocio, async (req, res) => {
  try {
    const r = await eliminarImagenMenu(req.negocioId, req.usuarioId);
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json(r.menu);
  } catch (e) {
    console.error('[Menu WA] eliminar imagen:', e.message);
    res.status(500).json({ error: 'No pudimos quitar la imagen de tu menú' });
  }
});

// Vista previa. Sirve los bytes por el propio backend re-validando la sesión
// en cada request: nunca se le entrega al navegador la storage_key ni una URL
// del bucket. Con driver s3 se leen los bytes y se reenvían, para que la
// imagen del menú de un negocio no exista jamás como enlace compartible.
app.get('/api/config/whatsapp/menu/imagen', requireAuthSeguro, requireModulo('whatsapp'), requireAdminNegocio, async (req, res) => {
  try {
    const imagen = await leerImagenMenu(req.negocioId);
    if (!imagen) return res.status(404).json({ error: 'Todavía no has subido tu menú' });
    res.setHeader('Content-Type', imagen.mimeType);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', `inline; filename="${String(imagen.nombre).replace(/[\/"]/g, '_')}"`);
    res.send(imagen.buffer);
  } catch (e) {
    console.error('[Menu WA] vista previa:', e.message);
    res.status(500).json({ error: 'No pudimos mostrar tu menú' });
  }
});

app.post('/api/integraciones/whatsapp/meta/callback', async (req, res) => {
  const { state, code, phoneNumberId, wabaId, businessId, displayPhoneNumber } = req.body || {};
  // Modo de conexión: lo manda el frontend según la opción elegida, pero el
  // servidor lo valida contra la lista cerrada -- cualquier valor
  // desconocido cae a 'cloud_api' (el comportamiento seguro de siempre).
  // 'coexistence' NUNCA salta controles: al contrario, añade la
  // verificación is_on_biz_app antes de marcar 'activo'.
  const connectionMode = req.body?.connectionMode === 'coexistence' ? 'coexistence' : 'cloud_api';
  const consumido = validarYConsumirState(state);
  if (!consumido) {
    return res.status(400).json({ error: 'state inválido, vencido o ya utilizado' });
  }
  const { negocioId, superadminId, usuarioId: actorUsuarioId } = consumido;

  // La bitacora es importante, pero NO es la integracion. Si Meta ya devolvio
  // la WABA y el numero, y subscribe_apps ya funciono, tumbar la respuesta
  // porque no se pudo escribir una fila de auditoria empuja al cliente a
  // repetir todo el onboarding -- que es justo lo que paso en produccion con
  // Mapolato: 500 despues de que lo critico ya estaba hecho.
  //
  // Se intenta siempre, se registra el fallo con detalle, y se sigue. No es
  // un catch silencioso: deja rastro y no se traga la causa.
  // OJO: llama DIRECTAMENTE a registrarAuditoriaPlataforma. En df95af1 esta
  // función se llamaba a sí misma (recursión infinita -> RangeError: Maximum
  // call stack size exceeded) y ninguna auditoría del callback llegó a
  // escribirse en producción. Hay una prueba explícita que falla si vuelve.
  const auditar = async (datos) => {
    try {
      await registrarAuditoriaPlataforma({ superadminId, actorUsuarioId, ...datos });
    } catch (e) {
      const esBug = e instanceof TypeError || e instanceof RangeError || e instanceof ReferenceError;
      console.error(`[AUDITORIA]${esBug ? '[BUG]' : ''} no se pudo registrar "${datos.accion}" para el negocio ${datos.negocioId || negocioId}: ${e.message}`);
      if (esBug) console.error(e.stack);
    }
  };

  // El actor viaja por TODA la cadena de servicios. Sale del state ya
  // validado/consumido -- nunca del cuerpo de la petición.
  const actor = { superadminId, actorUsuarioId };

  // Capa de aplicación (además de la firma/vencimiento/uso único ya
  // verificados arriba): ¿sigue siendo ESTE el intento vigente del
  // negocio, o fue cancelado/reemplazado por uno más nuevo? Nunca se
  // registra el state completo, solo el motivo de rechazo.
  const vigente = validarIntentoVigente(negocioId, state);
  if (!vigente.ok) {
    await auditar({ accion: 'integracion_embedded_signup_fallido', negocioId,
      contexto: { motivo: vigente.motivo },
    });
    return res.status(400).json({ error: MENSAJES_INTENTO_INVALIDO[vigente.motivo] || 'Conexión pendiente inválida' });
  }

  if (typeof code !== 'string' || !code.trim()) {
    // Sin code: cancelación del usuario o respuesta incompleta de Meta --
    // el state ya quedó consumido arriba (uso único), no se toca el
    // estado técnico de la integración (se deja como estaba).
    limpiarIntentoPendiente(negocioId);
    return res.status(400).json({ error: 'Conexión cancelada o incompleta' });
  }
  if (typeof phoneNumberId !== 'string' || !phoneNumberId.trim()) {
    limpiarIntentoPendiente(negocioId);
    return res.status(400).json({ error: 'phoneNumberId requerido en la respuesta de Meta' });
  }

  try {
    const dueno = await pool.query(
      `SELECT negocio_id FROM integraciones_canal WHERE canal = 'whatsapp' AND identificador = $1`,
      [phoneNumberId.trim()]
    );
    if (dueno.rows[0] && dueno.rows[0].negocio_id !== negocioId) {
      await actualizarEstadoIntegracion(negocioId, 'whatsapp', 'meta', 'error', actor).catch(() => {});
      limpiarIntentoPendiente(negocioId);
      return res.status(409).json({ error: 'Este phone_number_id ya está asociado a otro negocio' });
    }

    const { accessToken } = await intercambiarCodigoPorToken(code);
    const resultado = await guardarCredencialesCifradas(
      negocioId, 'whatsapp', 'meta',
      { phoneNumberId, wabaId, businessId, displayPhoneNumber, accessToken },
      actor
    );
    await auditar({ accion: 'integracion_embedded_signup_completado', negocioId,
      contexto: { phoneNumberId, wabaId: wabaId || null, businessId: businessId || null },
    });
    limpiarIntentoPendiente(negocioId);

    // Intento automático, una sola vez, de completar la activación real
    // (POST /register + POST /subscribed_apps) -- guardarCredencialesCifradas
    // ya NO deja la integración en 'activo' solo por tener el token, así
    // que sin este intento el número quedaría "pendiente" en Meta igual
    // que en el incidente real de Alora. Si falla aquí, el estado queda
    // en 'pendiente_activacion' y el propio Superadmin puede reintentar
    // sin repetir el Embedded Signup (ver ruta "completar-activacion").
    let activacion = null;
    try {
      activacion = await completarActivacionWhatsapp(negocioId, actor, { connectionMode });
    } catch (eActivacion) {
      console.error('[POST /api/integraciones/whatsapp/meta/callback] Error al completar activación:', eActivacion.message);
    }

    res.json({ ok: true, estado: activacion?.estado || resultado.estado, connectionMode, activacion });
  } catch (e) {
    console.error('[POST /api/integraciones/whatsapp/meta/callback] Error:', e.message);
    await actualizarEstadoIntegracion(negocioId, 'whatsapp', 'meta', 'error', actor).catch(() => {});
    await auditar({ accion: 'integracion_embedded_signup_fallido', negocioId,
      contexto: { motivo: 'error_intercambio_o_guardado' },
    });
    limpiarIntentoPendiente(negocioId);
    res.status(502).json({ error: 'No se pudo completar la conexión con Meta' });
  }
});

app.get('/api/superadmin/auditoria', requireSuperadmin, async (req, res) => {
  const { limit, offset, negocioId } = req.query;
  const auditoria = await obtenerAuditoriaPlataforma({ limit, offset, negocioId: negocioId || null });
  res.json(auditoria);
});

// ─── Central de Operaciones (Superadmin) ────────────────────────────────────
// Implementación/acompañamiento de negocios a escala: listado con pipeline,
// ficha agregada, checklist operativo, estado de onboarding, campos de
// implementación y sesiones temporales de soporte. Ver
// services/centralOperaciones.js para el contrato completo.

app.get('/api/superadmin/central/negocios', requireSuperadmin, async (req, res) => {
  const { buscar = '', onboarding = '', estado = '', responsable = '', orden = '', limit, offset } = req.query;
  res.json(await listarNegociosCentral({
    buscar: String(buscar), onboarding: String(onboarding), estado: String(estado),
    responsable: String(responsable), orden: String(orden), limit, offset,
  }));
});

app.get('/api/superadmin/negocios/:negocioId/ficha', requireSuperadmin, async (req, res) => {
  const ficha = await obtenerFichaNegocio(req.params.negocioId);
  if (!ficha) return res.status(404).json({ error: 'Negocio no encontrado' });
  res.json(ficha);
});

app.patch('/api/superadmin/negocios/:negocioId/onboarding', requireSuperadmin, async (req, res) => {
  const { estado } = req.body || {};
  if (!estado) return res.status(400).json({ error: 'estado requerido' });
  try {
    const r = await actualizarOnboardingEstado(req.params.negocioId, String(estado), req.usuarioId);
    if (!r) return res.status(404).json({ error: 'Negocio no encontrado' });
    res.json({ ok: true, ...r });
  } catch (e) {
    if (e.code === 'ESTADO_INVALIDO' || e.code === 'ESTADO_AUTOMATICO') return res.status(400).json({ error: e.message });
    console.error('[Central] onboarding:', e.message);
    res.status(500).json({ error: 'Error al actualizar el estado de onboarding' });
  }
});

app.patch('/api/superadmin/negocios/:negocioId/checklist-operativo/:paso', requireSuperadmin, async (req, res) => {
  try {
    const r = await actualizarPasoChecklistOperativo(req.params.negocioId, req.params.paso, req.body || {}, req.usuarioId);
    if (!r) return res.status(404).json({ error: 'Negocio no encontrado' });
    res.json({ ok: true, paso: r });
  } catch (e) {
    if (['PASO_INVALIDO', 'ESTADO_INVALIDO', 'PASO_AUTOMATICO'].includes(e.code)) return res.status(400).json({ error: e.message });
    console.error('[Central] checklist-operativo:', e.message);
    res.status(500).json({ error: 'Error al actualizar el paso' });
  }
});

app.patch('/api/superadmin/negocios/:negocioId/implementacion', requireSuperadmin, async (req, res) => {
  try {
    const r = await actualizarImplementacion(req.params.negocioId, req.body || {}, req.usuarioId);
    if (!r) return res.status(404).json({ error: 'Negocio no encontrado' });
    res.json({ ok: true, implementacion: r });
  } catch (e) {
    console.error('[Central] implementacion:', e.message);
    res.status(500).json({ error: 'Error al actualizar la implementación' });
  }
});

// Entrar como soporte: emite la sesión temporal (cookie httpOnly con flag
// sop) y redirige al panel del negocio. La cookie REEMPLAZA la sesión de
// superadmin en el navegador — al salir (o expirar), el superadmin vuelve a
// iniciar su sesión normal. rate limit bajo: es una acción administrativa
// puntual, no un flujo de alto volumen.
app.post('/api/superadmin/negocios/:negocioId/sesion-soporte', requireSuperadmin,
  rateLimitMiddleware(req => `soporte:${req.usuarioId}`, 20, 60 * 1000), async (req, res) => {
  const { motivo } = req.body || {};
  const r = await crearSesionSoporte(req.usuarioId, req.params.negocioId, motivo ? String(motivo).slice(0, 300) : null);
  if (!r) return res.status(404).json({ error: 'Negocio no encontrado' });
  setCookieSesion(res, r.token);
  // El token nunca viaja en el cuerpo — solo como cookie httpOnly.
  res.json({ ok: true, negocio: r.negocio, expiresAt: r.expiresAt });
});

app.get('/api/superadmin/sesiones-soporte', requireSuperadmin, async (req, res) => {
  const { negocioId, vigentes, limit } = req.query;
  res.json(await listarSesionesSoporte({
    negocioId: negocioId ? String(negocioId) : null,
    soloVigentes: vigentes === 'true' || vigentes === '1',
    limit,
  }));
});

// ─── Prospectos comerciales (Superadmin) ───────────────────────────────────
// Exclusivo de Superadmin -- un admin o staff de negocio nunca debe ver
// leads de otros negocios ni de la plataforma en general. requireSuperadmin
// ya valida esto en backend (no solo ocultando la UI).
app.get('/api/superadmin/prospectos', requireSuperadmin, async (req, res) => {
  const { estado, ciudad, tipoNegocio, busqueda, limit, offset } = req.query;
  const prospectos = await obtenerProspectosComerciales({ estado, ciudad, tipoNegocio, busqueda, limit, offset });
  res.json(prospectos);
});

app.get('/api/superadmin/prospectos/:id', requireSuperadmin, async (req, res) => {
  const prospecto = await obtenerProspectoComercialPorId(req.params.id);
  if (!prospecto) return res.status(404).json({ error: 'Prospecto no encontrado' });
  res.json(prospecto);
});

const ESTADOS_PROSPECTO_VALIDOS_API = ['nuevo', 'contactado', 'demo_agendada', 'seguimiento', 'convertido', 'descartado'];
app.patch('/api/superadmin/prospectos/:id', requireSuperadmin, async (req, res) => {
  const cambios = {};
  const body = req.body || {};
  if (body.estado !== undefined) {
    if (!ESTADOS_PROSPECTO_VALIDOS_API.includes(body.estado)) return res.status(400).json({ error: 'Estado inválido' });
    cambios.estado = body.estado;
  }
  if (body.responsable !== undefined) {
    if (body.responsable !== null && (typeof body.responsable !== 'string' || body.responsable.length > 120)) {
      return res.status(400).json({ error: 'Responsable inválido' });
    }
    cambios.responsable = body.responsable ? body.responsable.trim() : null;
  }
  if (body.notasInternas !== undefined) {
    if (body.notasInternas !== null && (typeof body.notasInternas !== 'string' || body.notasInternas.length > 4000)) {
      return res.status(400).json({ error: 'Notas inválidas' });
    }
    cambios.notas_internas = body.notasInternas ? body.notasInternas.trim() : null;
  }
  if (body.fechaUltimoSeguimiento !== undefined) {
    if (body.fechaUltimoSeguimiento !== null && !/^\d{4}-\d{2}-\d{2}$/.test(body.fechaUltimoSeguimiento)) {
      return res.status(400).json({ error: 'Fecha inválida' });
    }
    cambios.fecha_ultimo_seguimiento = body.fechaUltimoSeguimiento || null;
  }
  try {
    const actualizado = await actualizarProspectoComercial(req.params.id, cambios, req.usuarioId);
    if (!actualizado) return res.status(404).json({ error: 'Prospecto no encontrado' });
    res.json(actualizado);
  } catch (e) {
    if (e.code === 'ESTADO_INVALIDO') return res.status(400).json({ error: 'Estado inválido' });
    console.error('[PATCH /api/superadmin/prospectos/:id] Error:', e.message);
    res.status(500).json({ error: 'No se pudo actualizar el prospecto' });
  }
});

// ─── Red de Repartidores (Superadmin) ──────────────────────────────────────
// Exclusivo de Superadmin -- requireSuperadmin ya valida esto en backend.
// Todas las consultas aquí se llaman SIN negocioId a propósito: el
// Superadmin ve la red completa entre negocios (ver nota junto a
// cambiarEstadoRepartidor en database.js). El equivalente para un
// negocio-admin vive en /api/admin/repartidores/:id/estado más abajo, y ese
// SIEMPRE pasa el negocioId de su propia sesión.
app.get('/api/superadmin/red-repartidores/resumen', requireSuperadmin, async (req, res) => {
  const negocioId = req.query.negocioId || null;
  res.json(await obtenerResumenRosterRepartidores(negocioId));
});

// ─── Central de reparto (Superadmin, Frente B) ──────────────────────────────
// Vista operativa cross-negocio de los servicios de reparto: estado
// derivado (buscando/asignado/recogido/entregado/incidencia), tiempo
// transcurrido, ofertas enviadas y filtros por negocio/repartidor/estado/
// fecha. Solo lectura -- las acciones (reofertar, reasignar) siguen
// viviendo en sus flujos existentes.
app.get('/api/superadmin/red-repartidores/central', requireSuperadmin, async (req, res) => {
  const { estado, negocioId, repartidorId, desde, hasta, limit, offset } = req.query;
  try {
    res.json(await obtenerCentralReparto({
      estado: estado ? String(estado) : '', negocioId: negocioId ? String(negocioId) : '',
      repartidorId: repartidorId ? String(repartidorId) : '',
      desde: desde ? String(desde) : null, hasta: hasta ? String(hasta) : null,
      limit, offset,
    }));
  } catch (e) {
    console.error('[Central reparto] Error:', e.message);
    res.status(500).json({ error: 'Error al consultar la central de reparto' });
  }
});

// ─── Configuración de red de repartidores POR NEGOCIO (Frente B) ────────────
// Solo el admin del negocio (o una sesión de soporte) la lee y edita.
// requireModulo('repartidores'): la pantalla solo existe para negocios con
// el módulo habilitado. Un negocio sin fila = comportamiento legado.
app.get('/api/config/red-repartidores', requireAdminSeguro, requireModulo('repartidores'), async (req, res) => {
  const config = await obtenerConfigRed(req.negocioId);
  // undefined = error real de lectura (distinto de "sin configurar" = null).
  if (config === undefined) return res.status(500).json({ error: 'Error al leer la configuración de la red' });
  // camposDeclarativos: qué campos captura la API pero el motor todavía NO
  // ejecuta -- cualquier interfaz debe mostrarlos como "declarativo /
  // próximamente", nunca como plenamente funcionales.
  res.json({ config, camposDeclarativos: CAMPOS_DECLARATIVOS_RED });
});

app.put('/api/config/red-repartidores', requireAdminSeguro, requireModulo('repartidores'), async (req, res) => {
  try {
    const config = await guardarConfigRed(req.negocioId, req.body || {});
    res.json({ ok: true, config });
  } catch (e) {
    if (e.code === 'CONFIG_INVALIDA') return res.status(400).json({ error: e.message });
    console.error('[RedNegocio] Error guardando config:', e.message);
    res.status(500).json({ error: 'Error al guardar la configuración de la red' });
  }
});

// Solicitud MANUAL de repartidor para un pedido concreto (modo
// solicitud_automatica=false, o reoferta explícita). El folio se valida
// contra el negocio de la sesión (folio ajeno = 404 idéntico a
// inexistente). La respuesta confirma la SOLICITUD, no la aceptación: las
// ofertas viajan por WhatsApp y la aceptación llega por token, igual que en
// el flujo automático.
app.post('/api/pedidos/:folio/solicitar-repartidor', requireAdminSeguro, requireModulo('repartidores'),
  rateLimitMiddleware(req => `solicitar-rep:${req.negocioId}`, 30, 60 * 1000), async (req, res) => {
  const pedido = obtenerPedidoPorId(req.params.folio, req.negocioId);
  if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
  const { esPedidoElegibleParaRedRepartidores } = await import('./orders/orderManager.js');
  if (!esPedidoElegibleParaRedRepartidores(pedido)) {
    return res.status(409).json({ error: 'El pedido no es elegible para la red (canal, modalidad o estado)' });
  }
  const configRed = await obtenerConfigRed(req.negocioId);
  const evaluacion = evaluarSolicitudRed(pedido, configRed, 'manual');
  if (!evaluacion.procede) {
    return res.status(409).json({ error: `No se puede solicitar repartidor: ${evaluacion.razon}` });
  }
  const { notificarRepartidoresPorWA } = await import('./channels/whatsapp-meta.js');
  // Se espera el resultado para poder responder con la verdad (idempotencia
  // interna incluida: repartidores ya notificados para este folio no
  // reciben una segunda oferta).
  await notificarRepartidoresPorWA(pedido, { origen: 'manual' });
  res.json({ ok: true, folio: pedido.id, evaluacion: evaluacion.razon });
});

// ─────────────────────────────────────────────────────────────────────────────
// POS — Envíos / Pedidos a domicilio
// Un operador captura pedidos telefónicos / de mostrador. NO es un motor
// paralelo: reutiliza registrarPedido/emitirPedido (folio, comanda,
// impresión, tablero), pagosService (enlace con guard de duplicado),
// notificarRepartidoresPorWA (red validada) y cancelarPedidoActivo. El único
// diferencial es canal='pos' / origen='manual'. negocioId SIEMPRE de la
// sesión (req.negocioId), jamás del body.
// ─────────────────────────────────────────────────────────────────────────────

// Estados de entrega visibles, derivados del modelo real (datos.entrega_estado
// del portal del repartidor + estado del pedido). Nunca crea estados nuevos.
function estadoEntregaPOS(pedido) {
  if (pedido.estado === 'cancelado') return 'cancelado';
  if (pedido.estado === 'entregado') return 'entregado';
  const sub = pedido.datos?.entrega_estado || pedido.entrega_estado || null;
  if (sub) return sub; // asignado | recogido | en_camino | entregado
  if (pedido.datos?.repartidor_id || pedido.repartidor_id) return 'asignado';
  return 'sin_repartidor';
}

function vistaEnvioPOS(pedido) {
  const c = pedido.cliente || pedido.datos?.cliente || {};
  return {
    folio: pedido.id || pedido.folio,
    creadoAt: pedido.timestamp || pedido.created_at,
    modalidad: pedido.modalidad || pedido.datos?.modalidad,
    canal: pedido.canal || pedido.datos?.canal,
    estado: pedido.estado,
    entregaEstado: estadoEntregaPOS(pedido),
    cliente: c.nombre || null,
    telefono: c.telefono || null,
    colonia: c.colonia || null,
    total: Number(pedido.total ?? pedido.datos?.total ?? 0),
    costoEnvio: Number(pedido.costo_envio ?? pedido.datos?.costo_envio ?? 0),
    formaPago: pedido.forma_pago || pedido.datos?.forma_pago || null,
    pagoConfirmado: pedido.pago_confirmado === true || pedido.datos?.pago_confirmado === true,
    repartidorNombre: pedido.datos?.repartidor_nombre || pedido.repartidor_nombre || null,
  };
}

// POST /api/pos/pedidos — crear pedido POS (recoger | domicilio)
app.post('/api/pos/pedidos', requireAuthSeguro, requireModulo('pos'), async (req, res) => {
  if (typeof req.negocioId !== 'string' || !req.negocioId.trim()) {
    return res.status(401).json({ error: 'Sesión inválida — no se pudo determinar el negocio' });
  }
  const negocioId = req.negocioId;
  const idemKey = req.headers['idempotency-key'] || req.body?.idempotencyKey || null;

  // Idempotencia: doble clic / reintento devuelve el MISMO folio, sin crear
  // un segundo pedido. La clave se reserva antes de cualquier await, así que
  // dos clics simultáneos no pueden colarse los dos (ver reservarIdempotencia).
  const reserva = reservarIdempotencia(negocioId, idemKey);
  if (!reserva.reservado) {
    let folio = reserva.folio;
    if (!folio && reserva.enCurso) {
      // La creación del primer request sigue en vuelo: se espera su folio en
      // vez de crear un segundo pedido. Si aquella falló, se sigue de largo
      // y este request crea normalmente.
      try { folio = await reserva.enCurso; } catch { folio = null; }
    }
    const yaExiste = folio ? obtenerPedidoPorId(folio, negocioId) : null;
    if (yaExiste) return res.json({ ok: true, pedido: yaExiste, idempotente: true });
  }

  try {
    const { tipo, cliente, direccion, items, costoEnvio, descuento, formaPago, notas } = req.body || {};
    // Recalcular precios SIEMPRE desde el menú del propio negocio (rechaza
    // productos ajenos / no disponibles) — nunca se confía en el total del
    // frontend.
    const { items: itemsValidados, subtotal } = await recalcularItemsDesdeMenu(negocioId, items);
    const orden = construirOrdenPOS({
      negocioId, tipo, items: itemsValidados, subtotal,
      costoEnvio, descuento, cliente, direccion, formaPago, notas,
    });

    const pedido = await registrarPedido(orden, 'pos');
    emitirPedido(pedido).catch(e => console.error(`[Pedido] emitirPedido(${pedido.id}) fallo sin emitir efectos externos: ${e.message}`)); // comanda + impresión + tablero (no bloquea si no hay impresora)
    if (reserva.reservado) reserva.confirmar(pedido.id);
    else recordarIdempotencia(negocioId, idemKey, pedido.id);

    // Persistencia en historial (mismo patrón que presencial: upsertCliente
    // antes de guardarPedido por la FK pedidos.telefono → clientes.telefono).
    (async () => {
      try {
        const { upsertCliente, guardarPedido } = await import('./services/database.js');
        await upsertCliente(orden.cliente.telefono, orden.cliente.nombre, negocioId);
        await guardarPedido(orden.cliente.telefono, pedido, negocioId);
      } catch (e) {
        console.error('[POS] Error persistiendo pedido POS en historial:', e.message);
      }
    })();

    console.log(`[POS Audit] pedido_pos_creado negocio=${negocioId} usuario=${req.usuarioId} folio=${pedido.id} tipo=${tipo} total=${pedido.total}`);
    res.json({ ok: true, pedido });
  } catch (e) {
    // El pedido no llegó a existir: se libera la clave para que un reintento
    // del operador sí pueda crearlo (y para no dejar esperando a un request
    // gemelo que hubiera quedado en cola detrás de esta reserva).
    if (reserva.reservado) reserva.liberar(e);
    if (e instanceof POSValidacionError) return res.status(400).json({ error: e.message, codigo: e.codigo });
    // Seleccion de modificadores invalida (grupo requerido vacio, minimo,
    // maximo, opcion ajena o no disponible): es un 400 del operador, no un
    // fallo del servidor.
    if (e instanceof ModificadoresError) return res.status(400).json({ error: e.message, codigo: e.codigo });
    console.error('[POS] Error creando pedido POS:', e.message);
    res.status(500).json({ error: 'No se pudo crear el pedido' });
  }
});

// GET /api/pos/envios — envíos activos del negocio (domicilio y recoger POS)
app.get('/api/pos/envios', requireAuthSeguro, requireModulo('pos'), async (req, res) => {
  const pedidos = obtenerPedidos(req.negocioId)
    .filter(p => (p.canal === 'pos') || (p.modalidad || '').includes('domicilio'))
    .map(vistaEnvioPOS);
  res.json({ envios: pedidos });
});

// GET /api/pos/envios/:folio — detalle (tenant-checked: folio ajeno = 404)
app.get('/api/pos/envios/:folio', requireAuthSeguro, requireModulo('pos'), async (req, res) => {
  const pedido = obtenerPedidoPorId(req.params.folio, req.negocioId);
  if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
  res.json({ pedido });
});

// POST /api/pos/envios/:folio/enlace-pago — reutiliza pagosService (guard de
// enlace vigente: NO genera un segundo checkout si ya hay uno).
app.post('/api/pos/envios/:folio/enlace-pago', requireAuthSeguro, requireModulo('pos'),
  rateLimitMiddleware(req => `pos-enlace:${req.negocioId}`, 30, 60 * 1000), async (req, res) => {
  const pedido = obtenerPedidoPorId(req.params.folio, req.negocioId);
  if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
  try {
    const r = await crearEnlacePago({
      negocioId: req.negocioId, pedidoId: pedido.id, actor: req.usuarioId,
      idempotencyKey: req.headers['idempotency-key'] || null,
    });
    console.log(`[POS Audit] ${r.reutilizado ? 'pago_link_reutilizado' : 'pago_link_generado'} negocio=${req.negocioId} usuario=${req.usuarioId} folio=${pedido.id}`);
    // Nunca se loguea la URL/token; solo se devuelve al operador que la pidió.
    res.json({ ok: true, url: r.url, estado: r.estado, reutilizado: r.reutilizado,
      mensaje: r.reutilizado ? 'Este pedido ya tenía un enlace de pago vigente' : 'Enlace de pago generado' });
  } catch (e) {
    if (e instanceof PedidoInvalidoError) return res.status(409).json({ error: e.message });
    if (e instanceof SinProveedorPrincipalError) return res.status(409).json({ error: 'Este negocio no tiene un proveedor de pago principal activo' });
    console.error('[POS] Error enlace de pago:', e.message);
    res.status(500).json({ error: 'No se pudo generar el enlace de pago' });
  }
});

// POST /api/pos/envios/:folio/solicitar-repartidor — mismo flujo validado de
// la red (plantilla v2, aceptación atómica, portal). No modifica Meta.
app.post('/api/pos/envios/:folio/solicitar-repartidor', requireAdminSeguro, requireModulo('repartidores'),
  rateLimitMiddleware(req => `pos-solicitar-rep:${req.negocioId}`, 30, 60 * 1000), async (req, res) => {
  const pedido = obtenerPedidoPorId(req.params.folio, req.negocioId);
  if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
  const { esPedidoElegibleParaRedRepartidores } = await import('./orders/orderManager.js');
  if (!esPedidoElegibleParaRedRepartidores(pedido)) {
    return res.status(409).json({ error: 'El pedido no es elegible para la red (canal, modalidad o estado)' });
  }
  const configRed = await obtenerConfigRed(req.negocioId);
  const evaluacion = evaluarSolicitudRed(pedido, configRed, 'manual');
  if (!evaluacion.procede) {
    return res.status(409).json({ error: `No se puede solicitar repartidor: ${evaluacion.razon}` });
  }
  const { notificarRepartidoresPorWA } = await import('./channels/whatsapp-meta.js');
  await notificarRepartidoresPorWA(pedido, { origen: 'manual' });
  console.log(`[POS Audit] repartidor_solicitado negocio=${req.negocioId} usuario=${req.usuarioId} folio=${pedido.id}`);
  res.json({ ok: true, folio: pedido.id, evaluacion: evaluacion.razon });
});

// POST /api/pos/envios/:folio/cancelar — reutiliza cancelarPedidoActivo (no
// borra; conserva historial). Requiere admin y motivo.
app.post('/api/pos/envios/:folio/cancelar', requireAdminSeguro, requireModulo('pos'), async (req, res) => {
  const pedido = obtenerPedidoPorId(req.params.folio, req.negocioId);
  if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
  if (pedido.pago_confirmado === true) return res.status(409).json({ error: 'No se puede cancelar un pedido ya pagado sin una regla explícita' });
  if (pedido.estado === 'entregado') return res.status(409).json({ error: 'No se puede cancelar un pedido ya entregado' });
  const motivo = String(req.body?.motivo || '').trim();
  if (!motivo) return res.status(400).json({ error: 'El motivo de cancelación es obligatorio' });
  const ok = await cancelarPedidoActivo(pedido.id, motivo, req.negocioId);
  if (!ok) return res.status(409).json({ error: 'No se pudo cancelar (el pedido ya no está activo)' });
  actualizarEstadoPedido(pedido.id, 'cancelado', req.negocioId);
  console.log(`[POS Audit] pedido_pos_cancelado negocio=${req.negocioId} usuario=${req.usuarioId} folio=${pedido.id} motivo="${motivo.slice(0,80)}"`);
  res.json({ ok: true });
});

app.get('/api/superadmin/red-repartidores/roster', requireSuperadmin, async (req, res) => {
  const { negocioId, estado, actividad, busqueda, page, pageSize } = req.query;
  if (estado && !ESTADOS_REPARTIDOR_VALIDOS.includes(estado)) {
    return res.status(400).json({ error: 'Estado inválido' });
  }
  const resultado = await obtenerRosterRepartidores({
    negocioId: negocioId || null,
    estado: estado || null,
    actividad: actividad || null,
    soloDuplicados: req.query.soloDuplicados === 'true',
    busqueda: busqueda || null,
    page: page ? parseInt(page, 10) : 1,
    pageSize: pageSize ? parseInt(pageSize, 10) : 50,
  });
  res.json(resultado);
});

app.get('/api/superadmin/red-repartidores/duplicados', requireSuperadmin, async (req, res) => {
  res.json(await detectarDuplicadosRepartidor(req.query.negocioId || null));
});

app.get('/api/superadmin/red-repartidores/roster/:id', requireSuperadmin, async (req, res) => {
  const detalle = await obtenerDetalleRepartidor(req.params.id, null);
  if (!detalle) return res.status(404).json({ error: 'Repartidor no encontrado' });
  res.json(detalle);
});

app.patch('/api/superadmin/red-repartidores/roster/:id/estado', requireSuperadmin, async (req, res) => {
  const { estado } = req.body || {};
  if (!ESTADOS_REPARTIDOR_VALIDOS.includes(estado)) {
    return res.status(400).json({ error: 'Estado inválido' });
  }
  const actualizado = await cambiarEstadoRepartidor(req.params.id, estado, {});
  if (!actualizado) return res.status(404).json({ error: 'Repartidor no encontrado' });
  // Fase C: evento de tiempo real -- payload mínimo, nunca teléfono.
  try {
    broadcastSuperadmin({ tipo: 'red_repartidores_estado_cambiado', repartidorId: actualizado.id, negocioId: actualizado.negocio_id, estado: actualizado.estado });
    if (actualizado.negocio_id) broadcastNegocio(actualizado.negocio_id, { tipo: 'red_repartidores_estado_cambiado', repartidorId: actualizado.id, estado: actualizado.estado }, { soloAdmin: true });
  } catch (e) {
    console.error('[WS] Error emitiendo red_repartidores_estado_cambiado:', e.message);
  }
  res.json(actualizado);
});

app.patch('/api/superadmin/red-repartidores/roster/:id/perfil', requireSuperadmin, async (req, res) => {
  const { nombre, ciudad, zona, vehiculo } = req.body || {};
  const cambios = {};
  if (nombre !== undefined) {
    if (typeof nombre !== 'string' || !nombre.trim()) return res.status(400).json({ error: 'Nombre inválido' });
    cambios.nombre = nombre.trim();
  }
  if (ciudad !== undefined) cambios.ciudad = ciudad ? String(ciudad).trim() : null;
  if (zona !== undefined) cambios.zona = zona ? String(zona).trim() : null;
  if (vehiculo !== undefined) cambios.vehiculo = vehiculo ? String(vehiculo).trim() : null;
  const actualizado = await editarPerfilRepartidor(req.params.id, cambios, {});
  if (!actualizado) return res.status(404).json({ error: 'Repartidor no encontrado o sin cambios válidos' });
  res.json(actualizado);
});

app.get('/api/superadmin/red-repartidores/servicios', requireSuperadmin, async (req, res) => {
  const { negocioId, desde, hasta, page, pageSize } = req.query;
  const resultado = await obtenerServiciosReparto({
    negocioId: negocioId || null,
    desde: desde || null,
    hasta: hasta || null,
    page: page ? parseInt(page, 10) : 1,
    pageSize: pageSize ? parseInt(pageSize, 10) : 50,
  });
  res.json(resultado);
});

app.get('/api/superadmin/red-repartidores/servicios/:folio', requireSuperadmin, async (req, res) => {
  const detalle = await obtenerDetalleServicioReparto(req.params.folio, null);
  if (!detalle) return res.status(404).json({ error: 'Servicio no encontrado' });
  res.json(detalle);
});

// ─── Red de Repartidores — Fase D: Métricas y ranking (Superadmin) ─────────
// negocioId es OPCIONAL para Superadmin (cross-negocio por diseño, igual que
// el resto de este módulo) -- la ruta de negocio-admin equivalente vive más
// abajo y SIEMPRE usa req.negocioId de la sesión, nunca el query param.
function _parametrosMetricasDesdeQuery(req, negocioIdForzado) {
  return {
    negocioId: negocioIdForzado !== undefined ? negocioIdForzado : (req.query.negocioId || null),
    ciudad: req.query.ciudad || null,
    zona: req.query.zona || null,
    repartidorId: req.query.repartidorId || null,
    desde: req.query.desde || null,
    hasta: req.query.hasta || null,
  };
}

app.get('/api/superadmin/red-repartidores/metricas', requireSuperadmin, async (req, res) => {
  const resultado = await obtenerMetricasRedRepartidores(_parametrosMetricasDesdeQuery(req));
  if (!resultado) return res.status(500).json({ error: 'Error calculando métricas' });
  res.json(resultado);
});

app.get('/api/superadmin/red-repartidores/ranking', requireSuperadmin, async (req, res) => {
  const { negocioId, ciudad, zona, desde, hasta } = req.query;
  const resultado = await obtenerRankingRepartidores({
    negocioId: negocioId || null, ciudad: ciudad || null, zona: zona || null, desde: desde || null, hasta: hasta || null,
  });
  res.json(resultado);
});

app.get('/api/superadmin/red-repartidores/ranking/exportar.csv', requireSuperadmin, async (req, res) => {
  const { negocioId, ciudad, zona, desde, hasta } = req.query;
  const { rankingElegible, muestraInsuficiente, suspendidosOBaja } = await obtenerRankingRepartidores({
    negocioId: negocioId || null, ciudad: ciudad || null, zona: zona || null, desde: desde || null, hasta: hasta || null,
  });
  const todas = [...rankingElegible, ...muestraInsuficiente, ...suspendidosOBaja];
  const columnas = [
    { titulo: 'Repartidor', valor: (f) => f.nombre },
    // Nombre legible como etiqueta principal -- el UUID se conserva aparte
    // como identificador interno, nunca como la única referencia al negocio.
    { titulo: 'Negocio', valor: (f) => f.negocioNombre },
    { titulo: 'NegocioId', valor: (f) => f.negocioId },
    { titulo: 'Ciudad', valor: (f) => f.ciudad || '' },
    { titulo: 'Zona', valor: (f) => f.zona || '' },
    { titulo: 'Estado', valor: (f) => f.estadoRepartidor },
    { titulo: 'Ofrecidos', valor: (f) => f.serviciosOfrecidos },
    { titulo: 'Aceptados', valor: (f) => f.serviciosAceptados },
    { titulo: 'Entregados', valor: (f) => f.serviciosEntregados },
    { titulo: 'Rechazados', valor: (f) => f.serviciosRechazados === null ? 'No disponible' : f.serviciosRechazados },
    { titulo: 'Ignorados', valor: (f) => f.serviciosIgnorados },
    { titulo: 'TasaAceptacion', valor: (f) => f.tasaAceptacion == null ? '' : (f.tasaAceptacion * 100).toFixed(1) + '%' },
    { titulo: 'TasaFinalizacion', valor: (f) => f.tasaFinalizacion == null ? '' : (f.tasaFinalizacion * 100).toFixed(1) + '%' },
    { titulo: 'TiempoPromedioAceptacionSeg', valor: (f) => f.tiempoPromedioAceptacionSeg == null ? '' : Math.round(f.tiempoPromedioAceptacionSeg) },
    { titulo: 'UltimaActividad', valor: (f) => f.ultimaActividad || '' },
    { titulo: 'PosibleDuplicado', valor: (f) => f.posibleDuplicado ? 'sí' : 'no' },
  ];
  const csv = filasARegistrosCSV(todas, columnas);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="ranking-repartidores.csv"');
  res.send('﻿' + csv);
});

// ─── Integraciones (claves de API configurables desde panel) ──────────────────
const INT_CLAVES = [
  'wa_token','wa_phone_id','wa_verify_token','wa_admin_numero',
  'facturapi_key',
  'anthropic_api_key',
  'vapid_public_key','vapid_private_key','vapid_email',
];

// Fix de seguridad (aislamiento de integraciones por negocio): ambas rutas
// antes llamaban a obtenerConfiguracion()/actualizarConfiguracion() SIN
// negocioId, lo que disparaba su fallback interno a
// resolverNegocioActualId() -- hardcodeado a 'nonna-maye' -- sin importar
// qué negocio tuviera la sesión. Cualquier admin autenticado (de CUALQUIER
// negocio) leía y podía sobrescribir la configuración global de Nonna
// Maye (WhatsApp/Clip/Facturapi/Anthropic/VAPID). Ahora ambas exigen
// req.negocioId explícito -- nunca se acepta un negocio_id del body/query,
// nunca hay fallback a ningún negocio por defecto.
app.get('/api/admin/integraciones', requireAdminSeguro, async (req, res) => {
  if (!(await negocioEstaActivo(req.negocioId))) {
    return res.status(403).json({ error: 'Negocio suspendido o inactivo' });
  }
  const cfg = await obtenerConfiguracion(req.negocioId);
  const result = {};
  INT_CLAVES.forEach(k => {
    const val = cfg['int_' + k] || '';
    // Enmascarar: mostrar solo últimos 4 caracteres. Vacío = "pendiente de
    // configuración" para ESTE negocio -- nunca se copia ni se infiere del
    // valor de otro negocio.
    result[k] = val.length > 8 ? '••••••••' + val.slice(-4) : (val ? '••••' : '');
  });
  res.json(result);
});

app.put('/api/admin/integraciones', requireAdminSeguro, async (req, res) => {
  if (!(await negocioEstaActivo(req.negocioId))) {
    return res.status(403).json({ error: 'Negocio suspendido o inactivo' });
  }
  const cambios = {};
  for (const [k, v] of Object.entries(req.body)) {
    if (!INT_CLAVES.includes(k)) continue;
    if (!v || v.startsWith('••••')) continue; // no sobreescribir con máscara
    cambios['int_' + k] = v.trim();
  }
  const ok = await actualizarConfiguracion(cambios, req.negocioId);
  if (!ok) return res.status(500).json({ error: 'Error al guardar' });
  // cargarIntegraciones() recarga el caché global EN MEMORIA que usa el
  // motor del bot (getIntegracion/enviarMensaje automático) -- ese caché
  // sigue leyendo exclusivamente el negocio hardcodeado en
  // NEGOCIO_ACTUAL_SLUG ('nonna-maye'), sin importar qué negocio acaba de
  // guardar aquí. Si guardó Nonna Maye, su bot recoge el cambio de
  // inmediato (comportamiento sin cambios). Si guardó cualquier OTRO
  // negocio, esta recarga es un no-op sobre los datos de Nonna Maye --
  // nunca copia, mezcla ni expone nada del negocio que acaba de guardar.
  // Migrar el motor del bot a credenciales por negocio es un cambio mayor,
  // fuera de alcance de este ciclo (ver reporte).
  await cargarIntegraciones();
  res.json({ ok: true });
});

// Interruptor global de bot de WhatsApp por negocio (migración 019) --
// vista del administrador del propio negocio. req.negocioId viene
// EXCLUSIVAMENTE de la sesión ya validada por requireAdminSeguro --
// nunca de un parámetro que el cliente pudiera manipular, así que un
// admin de OTRO negocio no puede alcanzar este recurso (ni con 403 ni
// con éxito accidental: estructuralmente no hay forma de dirigirlo a
// otro negocio). Staff queda fuera por el rol mínimo 'admin'.
// La lectura sí está disponible para todo el staff autenticado porque el
// estado general determina el estado visible de cada conversación.
app.get('/api/bot-whatsapp', requireAuthSeguro, requireModulo('whatsapp'), async (req, res) => {
  res.json({ botWhatsappActivo: await obtenerBotWhatsappActivoNegocio(req.negocioId) });
});

app.get('/api/admin/bot-whatsapp', requireAdminSeguro, async (req, res) => {
  res.json({ botWhatsappActivo: await obtenerBotWhatsappActivoNegocio(req.negocioId) });
});

app.patch('/api/admin/bot-whatsapp', requireAdminSeguro, async (req, res) => {
  const { activo } = req.body || {};
  if (typeof activo !== 'boolean') return res.status(400).json({ error: 'activo debe ser boolean' });
  // Ver nota equivalente en PATCH /api/superadmin/.../bot-whatsapp: el
  // checklist gatea el botón en el panel, no esta API.
  try {
    const resultado = await actualizarBotWhatsappActivoNegocio(req.negocioId, activo, { actorUsuarioId: req.usuarioId });
    if (!resultado) return res.status(404).json({ error: 'Negocio no encontrado' });
    res.json(resultado);
  } catch (e) {
    console.error('[PATCH /api/admin/bot-whatsapp] Error:', e.message);
    res.status(500).json({ error: 'Error al actualizar el interruptor del bot' });
  }
});

// ─── Pagos multiempresa (Fase 5/6) — panel del negocio ───────────────────────
// A diferencia de Superadmin, el panel del negocio NUNCA ve ni edita
// credenciales de proveedor -- solo puede ver el estado general (nombre,
// activo/principal, sin ningún campo cifrado) y administrar sus propios
// métodos de pago (habilitar/deshabilitar, instrucciones de transferencia,
// orden). Configurar/objetivo un proveedor nuevo sigue siendo exclusivo de
// Superadmin (ver rutas /api/superadmin/negocios/:id/integraciones/pagos*).
app.get('/api/config/pagos', requireAuthSeguro, async (req, res) => {
  try {
    const [metodos, principal] = await Promise.all([
      obtenerMetodosPagoDisponibles(req.negocioId),
      obtenerProveedorPrincipal(req.negocioId),
    ]);
    res.json({
      metodosDisponibles: metodos,
      proveedorPrincipal: principal ? { proveedor: principal.proveedor, ambiente: principal.ambiente } : null,
    });
  } catch (e) {
    console.error('[GET /api/config/pagos] Error:', e.message);
    res.status(500).json({ error: 'Error al obtener la configuración de pagos' });
  }
});

app.get('/api/admin/integraciones/pagos', requireAdminSeguro, async (req, res) => {
  try {
    res.json({ integraciones: await listarIntegracionesPago(req.negocioId) });
  } catch (e) {
    console.error('[GET /api/admin/integraciones/pagos] Error:', e.message);
    res.status(500).json({ error: 'Error al obtener las integraciones de pago' });
  }
});

app.get('/api/admin/metodos-pago', requireAdminSeguro, async (req, res) => {
  try {
    res.json({ metodos: await listarMetodosPagoNegocio(req.negocioId) });
  } catch (e) {
    console.error('[GET /api/admin/metodos-pago] Error:', e.message);
    res.status(500).json({ error: 'Error al obtener los métodos de pago' });
  }
});

// habilitar/deshabilitar y editar instrucciones -- nunca elige proveedor ni
// toca integracion_id aquí (eso es consecuencia de marcar principal en
// Superadmin, no una edición manual del panel del negocio).
app.put('/api/admin/metodos-pago/:tipo', requireAdminSeguro, async (req, res) => {
  const { tipo } = req.params;
  const { habilitado, instrucciones, orden, disponibleParaBot, disponibleParaOperador } = req.body || {};
  if (typeof habilitado !== 'boolean') return res.status(400).json({ error: 'habilitado debe ser boolean' });
  if (tipo === 'enlace_pago') {
    return res.status(400).json({ error: 'enlace_pago se activa automáticamente al marcar un proveedor como principal en Superadmin, no se edita aquí' });
  }
  try {
    const existentes = await listarMetodosPagoNegocio(req.negocioId);
    const actual = existentes.find(m => m.tipo === tipo) || {};
    const resultado = await guardarMetodoPagoNegocio(req.negocioId, tipo, {
      habilitado,
      integracionId: actual.integracion_id || null,
      instrucciones: instrucciones && typeof instrucciones === 'object' ? instrucciones : (actual.instrucciones || {}),
      orden: Number.isFinite(orden) ? orden : (actual.orden ?? 0),
      disponibleParaBot: typeof disponibleParaBot === 'boolean' ? disponibleParaBot : (actual.disponible_para_bot ?? true),
      disponibleParaOperador: typeof disponibleParaOperador === 'boolean' ? disponibleParaOperador : (actual.disponible_para_operador ?? true),
    });
    res.json(resultado);
  } catch (e) {
    console.error('[PUT /api/admin/metodos-pago/:tipo] Error:', e.message);
    res.status(400).json({ error: e.message });
  }
});

// ─── Enlace de pago manual (Fase 8) ──────────────────────────────────────────
// Vía genérica para que un operador/admin genere el enlace desde un pedido
// del panel (no solo el agente de WhatsApp) -- misma función idempotente
// pagosService.crearEnlacePago, así que un doble clic nunca duplica cobros.
app.post('/api/admin/pedido/:folio/enlace-pago', requireAuthSeguro, requireModulo('pos'), async (req, res) => {
  try {
    const resultado = await crearEnlacePago({
      negocioId: req.negocioId, pedidoId: req.params.folio, actor: req.usuarioId,
    });
    res.json(resultado);
  } catch (e) {
    if (e instanceof SinProveedorPrincipalError) return res.status(409).json({ error: e.message, code: e.code });
    if (e instanceof PedidoInvalidoError) return res.status(404).json({ error: e.message, code: e.code });
    console.error('[POST /api/admin/pedido/:folio/enlace-pago] Error:', e.message);
    res.status(500).json({ error: 'Error al generar el enlace de pago' });
  }
});

app.get('/api/admin/pedido/:folio/pagos', requireAuthSeguro, requireModulo('pos'), async (req, res) => {
  try {
    res.json({ pagos: await listarPagosPorPedido(req.negocioId, req.params.folio) });
  } catch (e) {
    console.error('[GET /api/admin/pedido/:folio/pagos] Error:', e.message);
    res.status(500).json({ error: 'Error al obtener los pagos del pedido' });
  }
});

// ─── Conciliación manual de transferencia (Fase 12/13) ───────────────────────
// Transferencia manual no tiene webhook ni API que confirme el pago solo --
// un admin verifica el depósito en el banco por fuera de Xabor y aquí
// registra esa confirmación. Solo admin (nunca staff/operador): es la
// acción que efectivamente marca un pedido como pagado sin evidencia
// verificable por el sistema, a diferencia de Clip (re-verificado vía API).
// pagoId llega como texto libre en la URL -- sin este guard, un valor no
// UUID (p. ej. "undefined" por un bug de cliente) provoca un error de cast
// de Postgres sin capturar, que tumba TODO el proceso (no hay
// unhandledRejection global en este código) para TODOS los negocios, no
// solo el que hizo la request.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

app.post('/api/admin/pagos/:pagoId/confirmar-manual', requireAdminSeguro, async (req, res) => {
  if (!UUID_RE.test(req.params.pagoId)) return res.status(404).json({ error: 'Pago no encontrado' });
  try {
    const transicion = await confirmarPagoManual(req.negocioId, req.params.pagoId, req.usuarioId);
    if (!transicion) return res.status(409).json({ error: 'No se pudo confirmar: el pago no existe, no es de transferencia manual, o ya no está pendiente de revisión' });
    // Un humano autorizado es otra FUENTE de confirmación, no otro juego de
    // invariantes: el asiento pasó por la misma transición financiera, y la
    // derivación solo ocurre si ella lo confirmó.
    if (!transicion.ok) {
      return res.status(409).json({
        error: 'El pago quedó registrado pero requiere revisión antes de liberar el pedido',
        resultado: transicion.resultado, pagoId: req.params.pagoId,
      });
    }
    await derivarPedidoPorPagoAsentado({
      pagoId: transicion.pago.id, negocioId: req.negocioId, folio: transicion.folio });
    broadcastNegocio(req.negocioId, { tipo: 'pago_confirmado', pedidoId: transicion.folio, proveedor: 'transferencia' });
    // Misma forma de respuesta de siempre -- la fila del pago --, mas el
    // veredicto de la transicion. El panel ya lee `estado` de aqui.
    res.json({ ...transicion.pago, transicion: transicion.resultado });
  } catch (e) {
    console.error('[POST /api/admin/pagos/:pagoId/confirmar-manual] Error:', e.message);
    res.status(500).json({ error: 'Error al confirmar el pago' });
  }
});

app.post('/api/admin/pagos/:pagoId/rechazar-manual', requireAdminSeguro, async (req, res) => {
  if (!UUID_RE.test(req.params.pagoId)) return res.status(404).json({ error: 'Pago no encontrado' });
  try {
    const { motivo } = req.body || {};
    const resultado = await rechazarPagoManual(req.negocioId, req.params.pagoId, motivo, req.usuarioId);
    if (!resultado) return res.status(409).json({ error: 'No se pudo rechazar: el pago no existe, no es de transferencia manual, o ya no está pendiente de revisión' });
    res.json(resultado);
  } catch (e) {
    console.error('[POST /api/admin/pagos/:pagoId/rechazar-manual] Error:', e.message);
    res.status(500).json({ error: 'Error al rechazar el pago' });
  }
});

// ─── Simulador del bot (Fase 4 -- centro de entrenamiento) ───────────────────
// Admin-only, nunca WhatsApp/voz real: usa exactamente la configuración real
// del negocio (menú, reglas_atencion, entrenamiento) a través de
// simularMensaje(), pero esa función nunca registra pedidos, envía mensajes
// ni persiste nada en `mensajes`. El sessionId siempre lo genera el
// servidor con el negocioId embebido y cada request re-valida que el
// sessionId pertenezca al negocio de la sesión -- un admin de otro negocio
// nunca puede leer ni limpiar la conversación de prueba de otro.
app.post('/api/admin/bot-simulador/sesion', requireAdminSeguro, (req, res) => {
  const sessionId = `sim-${req.negocioId}-${crearHashAleatorio()}`;
  res.json({ sessionId });
});

function crearHashAleatorio() {
  return createHash('sha256').update(`${Date.now()}-${Math.random()}`).digest('hex').slice(0, 16);
}

function sessionIdPerteneceANegocio(sessionId, negocioId) {
  return typeof sessionId === 'string' && sessionId.startsWith(`sim-${negocioId}-`);
}

app.post('/api/admin/bot-simulador/mensaje', requireAdminSeguro, async (req, res) => {
  const { sessionId, mensaje } = req.body || {};
  if (!mensaje || typeof mensaje !== 'string' || !mensaje.trim()) return res.status(400).json({ error: 'Se requiere mensaje' });
  if (!sessionIdPerteneceANegocio(sessionId, req.negocioId)) return res.status(400).json({ error: 'sessionId inválido para este negocio' });
  try {
    const resultado = await simularMensaje(sessionId, mensaje.trim(), req.negocioId);
    res.json(resultado);
  } catch (e) {
    console.error('[POST /api/admin/bot-simulador/mensaje] Error:', e.message);
    res.status(502).json({ error: 'El simulador no pudo generar una respuesta. Intenta de nuevo.' });
  }
});

app.delete('/api/admin/bot-simulador/:sessionId', requireAdminSeguro, (req, res) => {
  if (!sessionIdPerteneceANegocio(req.params.sessionId, req.negocioId)) return res.status(400).json({ error: 'sessionId inválido para este negocio' });
  deleteSession(req.params.sessionId);
  res.json({ ok: true });
});

// ─── Aceptación de servicio de reparto vía token de un solo uso ────────────────
// Pública a propósito: el token en sí (aleatorio, de un solo uso, con
// vencimiento) es la credencial -- ver migración 033 y
// procesarAceptacionTokenRepartidor en whatsapp-meta.js. No usa
// requireRepartidor porque este enlace se abre directo desde WhatsApp, sin
// sesión previa del repartidor en el navegador.
// Hotfix oferta-repartidor: abrir el enlace YA NO acepta el pedido. El GET
// solo pinta la pantalla de revisión (recargable, multi-dispositivo, y a
// prueba de los bots de vista previa de WhatsApp que antes podían quemar el
// token con un GET); la aceptación real es el POST del botón. El backend
// sigue siendo la única fuente de verdad de la carrera (token de un solo
// uso + asignación atómica, sin cambios).
app.get('/api/repartidor/oferta/:token', async (req, res) => {
  try {
    res.json(await consultarOfertaRepartidor(req.params.token));
  } catch (e) {
    console.error('[Repartidor Oferta] Error consultando oferta:', e.message);
    res.status(500).json({ estado: 'error' });
  }
});

app.post('/api/repartidor/oferta/:token/aceptar', async (req, res) => {
  try {
    const resultado = await procesarAceptacionTokenRepartidor(req.params.token);
    if (resultado.ok) {
      // Re-consulta para devolver el detalle completo ya como asignado.
      return res.json(await consultarOfertaRepartidor(req.params.token));
    }
    // Perdió la carrera o el token ya no sirve: el estado REAL (quién ganó,
    // cancelado, expirado...) sale de la consulta, nunca de un genérico.
    const estadoReal = await consultarOfertaRepartidor(req.params.token);
    // Doble clic del GANADOR: su token ya está consumido pero el pedido es
    // suyo -- idempotente, jamás un error.
    if (estadoReal.estado === 'asignado_a_mi') return res.json(estadoReal);
    return res.status(409).json(estadoReal.estado === 'disponible' ? { estado: 'expirado' } : estadoReal);
  } catch (e) {
    console.error('[Repartidor Oferta] Error aceptando oferta:', e.message);
    res.status(500).json({ estado: 'error' });
  }
});

app.get('/repartidor/aceptar/:token', (req, res) => {
  res.send(`<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Oferta de reparto · Xabor</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;background:#111;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;text-align:center}
.tarjeta{max-width:420px;width:100%}.emoji{font-size:56px;margin-bottom:16px}h1{font-size:1.3rem;margin:0 0 12px}p{color:#ccc;line-height:1.5;margin:6px 0}
.dato{display:flex;justify-content:space-between;gap:12px;background:#1c1c1c;border:1px solid #333;border-radius:10px;padding:10px 14px;margin:8px 0;text-align:left;font-size:0.95rem}
.dato span:first-child{color:#888}.dato span:last-child{font-weight:700;text-align:right}
button{background:#22c55e;color:#111;border:none;border-radius:12px;padding:14px 28px;font-size:1.05rem;font-weight:800;cursor:pointer;width:100%;margin-top:14px}
button:disabled{opacity:.5;cursor:wait}
.sec{background:#333;color:#fff;font-weight:600}
</style></head><body><div class="tarjeta" id="app"><div class="emoji">⏳</div><h1>Consultando oferta…</h1></div>
<script>
const app = document.getElementById('app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const token = location.pathname.split('/').pop();
function pantalla(emoji, titulo, cuerpo) { app.innerHTML = '<div class="emoji">'+emoji+'</div><h1>'+titulo+'</h1>'+cuerpo; }
function pintar(r) {
  if (r.estado === 'disponible') {
    const o = r.oferta || {};
    const hora = o.ofertadaAt ? new Date(o.ofertadaAt).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }) : null;
    pantalla('🛵', 'Pedido disponible',
      '<div class="dato"><span>Recoge en</span><span>'+esc(o.negocio)+'</span></div>'
      + '<div class="dato"><span>Entrega en</span><span>'+esc(o.entregaEn)+'</span></div>'
      + (o.pago ? '<div class="dato"><span>Pago por entrega</span><span>'+esc(o.pago)+'</span></div>' : '')
      + (hora ? '<div class="dato"><span>Ofertado a las</span><span>'+esc(hora)+'</span></div>' : '')
      + '<p>La asignación se confirma al primer repartidor que lo acepte.</p>'
      + '<button id="btn-aceptar">Aceptar pedido</button>');
    document.getElementById('btn-aceptar').onclick = aceptar;
  } else if (r.estado === 'asignado_a_mi') {
    const p = r.pedido || {};
    pantalla('✅', 'Pedido asignado a ti',
      (p.folio ? '<div class="dato"><span>Folio</span><span>'+esc(p.folio)+'</span></div>' : '')
      + (p.negocio ? '<div class="dato"><span>Recoge en</span><span>'+esc(p.negocio)+'</span></div>' : '')
      + (p.direccion ? '<div class="dato"><span>Dirección</span><span>'+esc(p.direccion)+'</span></div>' : '')
      + (p.nombreCliente ? '<div class="dato"><span>Cliente</span><span>'+esc(p.nombreCliente)+'</span></div>' : '')
      + (p.telefonoCliente ? '<div class="dato"><span>Teléfono</span><span>'+esc(p.telefonoCliente)+'</span></div>' : '')
      + (p.observaciones ? '<div class="dato"><span>Notas</span><span>'+esc(p.observaciones)+'</span></div>' : '')
      + (p.pago ? '<div class="dato"><span>Cobro</span><span>'+esc(p.pago)+'</span></div>' : '')
      + '<p>Consulta y gestiona tu entrega en el portal — también puedes entrar después en /repartidor.html con tu teléfono.</p>'
      + '<a href="/repartidor.html" style="display:block;background:#22c55e;color:#111;border-radius:12px;padding:14px;font-weight:800;text-decoration:none;margin-top:12px;">Ver mi entrega</a>');
  } else if (r.estado === 'cubierto_por_otro') {
    const nombre = r.repartidorAsignado && r.repartidorAsignado.nombre;
    pantalla('🤝', 'Este pedido ya fue cubierto',
      '<div class="dato sec"><span>' + (nombre ? 'Asignado a' : '') + '</span><span>'+esc(nombre || 'Asignado a otro repartidor')+'</span></div>'
      + '<p>Otro repartidor confirmó la entrega antes. Gracias por tu disponibilidad.</p>');
  } else if (r.estado === 'cancelado') {
    pantalla('🚫', 'Pedido cancelado', '<p>Este pedido fue cancelado y ya no requiere repartidor.</p>');
  } else if (r.estado === 'expirado') {
    pantalla('⌛', 'Oferta vencida', '<p>La oferta ya venció.</p>');
  } else if (r.estado === 'completado') {
    pantalla('📦', 'Pedido completado', '<p>Este pedido ya fue completado.</p>');
  } else if (r.estado === 'invalido') {
    pantalla('⚠️', 'Enlace no válido', '<p>Este enlace no es válido. Si crees que es un error, contacta al negocio.</p>');
  } else {
    pantalla('❌', 'Error temporal', '<p>Ocurrió un error del servidor. Intenta de nuevo.</p><button onclick="cargar()">Reintentar</button>');
  }
}
async function cargar() {
  try {
    const r = await fetch('/api/repartidor/oferta/' + encodeURIComponent(token));
    pintar(await r.json());
  } catch { pintar({ estado: 'error' }); }
}
async function aceptar() {
  const btn = document.getElementById('btn-aceptar');
  btn.disabled = true; btn.textContent = 'Confirmando…';
  try {
    const r = await fetch('/api/repartidor/oferta/' + encodeURIComponent(token) + '/aceptar', { method: 'POST' });
    pintar(await r.json());
  } catch { pintar({ estado: 'error' }); }
}
cargar();
</script></body></html>`);
});

// ─── Repartidores ─────────────────────────────────────────────────────────────
// Registro público (el repartidor accede al link y llena nombre+teléfono)
// Registro con NEGOCIO obligatorio (causa raíz de la regresión del portal:
// el alta pública sin negocio creaba repartidores con negocio_id NULL que
// el refactor P0 bloquea con 403 en todos los endpoints). El negocio llega
// por slug en el enlace que el propio negocio comparte
// (/repartidor.html?negocio=<slug>); sin slug válido no hay alta.
app.post('/api/repartidor/registro',
  rateLimitMiddleware(req => `rep-reg:${req.ip}`, 5, 10 * 60 * 1000),
  async (req, res) => {
  const { nombre, telefono, negocioSlug } = req.body;
  if (!nombre || !telefono) return res.status(400).json({ error: 'nombre y telefono requeridos' });
  const negocioId = typeof negocioSlug === 'string' && negocioSlug.trim()
    ? await obtenerNegocioIdPorSlug(negocioSlug.trim().toLowerCase()) : null;
  if (!negocioId) {
    return res.status(400).json({ error: 'Falta el negocio. Pide a tu negocio el enlace de registro (incluye ?negocio=...).' });
  }
  const rep = await registrarRepartidor(nombre.trim(), telefono.trim(), negocioId);
  if (!rep) return res.status(500).json({ error: 'Error al registrar' });
  res.json({ ok: true, token: rep.token, nombre: rep.nombre });
});

// Login por teléfono — devuelve token
// Rate limit: el login por teléfono es la credencial más débil del sistema
// (pendiente documentado: código de verificación por WhatsApp) -- al menos
// no debe permitir enumerar/adivinar números en ráfaga.
app.post('/api/repartidor/login',
  rateLimitMiddleware(req => `rep-login:${req.ip}`, 10, 10 * 60 * 1000),
  async (req, res) => {
  const { telefono } = req.body;
  if (!telefono) return res.status(400).json({ error: 'telefono requerido' });
  const rep = await obtenerRepartidorPorTelefono(telefono.trim());
  if (!rep) return res.status(404).json({ error: 'No registrado' });
  const negocioNombre = rep.negocio_id ? await obtenerNombreNegocio(rep.negocio_id) : null;
  res.json({ ok: true, token: rep.token, nombre: rep.nombre, negocio: negocioNombre });
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
// negocioId sale del propio repartidor autenticado (Auditoría P0, Categoría
// A) -- nunca de un valor enviado aparte. Sin negocio_id resuelto en el
// repartidor, no se listan pedidos disponibles (fail closed).
app.get('/api/repartidor/pedidos', requireRepartidor, async (req, res) => {
  if (!req.repartidor.negocio_id) return res.status(403).json({ error: 'Repartidor sin negocio resuelto' });
  const [disponibles, misPedidos] = await Promise.all([
    obtenerPedidosParaRepartidor(req.repartidor.negocio_id),
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
// negocioId (Incidente P0): requireRepartidor autentica por token individual
// del repartidor, no por sesión de negocio, pero el pedido en sí ya trae
// pedido.negocioId (resuelto por registrarPedido) -- se usa ese para aislar
// el broadcast en vez de mandarlo global. Si no se puede resolver (pedido
// ya no está en memoria), se omite el broadcast en vez de mandarlo global.
app.post('/api/repartidor/pedido/:folio/aceptar', requireRepartidor, async (req, res) => {
  const { folio } = req.params;
  if (!req.repartidor.negocio_id) return res.status(403).json({ error: 'Repartidor sin negocio resuelto' });
  const asignado = await asignarRepartidor(folio, req.repartidor.id, req.repartidor.nombre, req.repartidor.negocio_id);
  if (!asignado) return res.status(409).json({ error: 'Este pedido ya fue tomado por otro repartidor' });
  const pedido = obtenerPedidoPorId(folio, req.repartidor.negocio_id);
  if (pedido?.negocioId) {
    broadcastNegocio(pedido.negocioId, { tipo: 'repartidor_asignado', folio, repartidor: req.repartidor.nombre });
  } else {
    console.warn(`[Repartidor] repartidor_asignado: no se pudo resolver negocioId para ${folio} — broadcast omitido`);
  }
  console.log(`[Repartidor] ${req.repartidor.nombre} tomó el pedido ${folio}`);

  // WA "en camino" al cliente — Fase A: credenciales propias del negocio
  // del repartidor, nunca caché global.
  try {
    const tel = pedido?.cliente?.telefono;
    if (tel && tel !== '—' && !tel.startsWith('rappi-')) {
      const nombre = pedido?.cliente?.nombre?.split(' ')[0] || 'cliente';
      const credenciales = await obtenerCredencialesWhatsappNegocio(req.repartidor.negocio_id);
      if (credenciales) {
        await enviarMensaje(tel,
          `¡Hola ${nombre}! 🛵 Tu pedido *${folio}* ya está en camino. ` +
          `Lo lleva ${req.repartidor.nombre}. ¡Llegará en breve!`,
          credenciales
        );
      }
    }
  } catch (e) {
    console.error('[Repartidor] Error enviando WA en camino:', e.message);
  }

  res.json({ ok: true, folio });
});

// Repartidor marca pedido como entregado desde su celular
// negocioId (Auditoría P0, Categoría B): repartidores.negocio_id ya se
// puebla al registrar (incidente P0 principal), así que este endpoint
// pasó de actualizarEstadoPedidoLegacySinNegocio (sin verificar dueño) a
// la función segura actualizarEstadoPedido, que rechaza un folio de otro
// negocio exactamente igual que uno inexistente. Sin negocio_id resuelto
// en el repartidor (registro público sin sesión, caso residual), se
// falla cerrado en vez de usar la función insegura.
app.post('/api/repartidor/pedido/:folio/entregado', requireRepartidor, async (req, res) => {
  const { folio } = req.params;
  if (!req.repartidor.negocio_id) return res.status(403).json({ error: 'Repartidor sin negocio resuelto' });
  // Transición terminal ATÓMICA en DB (dueño + no terminal en el mismo
  // UPDATE) -- la memoria del OrderManager se sincroniza después y el
  // broadcast al panel sale igual aunque el proceso se haya reiniciado.
  const datosEntregado = await marcarEntregadoRepartidor(folio, req.repartidor.negocio_id, req.repartidor.id);
  if (!datosEntregado) {
    const { rows: [row] } = await pool.query(
      `SELECT estado, datos->>'repartidor_id' AS rid FROM pedidos_activos WHERE folio = $1 AND negocio_id = $2`,
      [folio, req.repartidor.negocio_id]
    );
    if (!row) return res.status(404).json({ error: 'Pedido no encontrado' });
    if (String(row.rid) !== String(req.repartidor.id)) return res.status(403).json({ error: 'Este pedido está asignado a otro repartidor' });
    if (row.estado === 'cancelado') return res.status(409).json({ error: 'El pedido fue cancelado por el negocio' });
    if (row.estado === 'entregado') return res.json({ ok: true, ya: true });
    return res.status(409).json({ error: 'El pedido no se pudo marcar entregado' });
  }
  // El invariante de tienda_online (PAGO_PENDIENTE) es inalcanzable aquí — un
  // pedido sin pagar jamás se ofrece a repartidores — pero si llegara a
  // lanzarse, la fila durable ya quedó entregada arriba: se degrada al
  // fallback en vez de tirar la ruta.
  let pedido;
  try {
    pedido = actualizarEstadoPedido(folio, 'entregado', req.repartidor.negocio_id) || { ...datosEntregado, id: folio };
  } catch (e) {
    if (e.codigo !== 'PAGO_PENDIENTE') throw e;
    pedido = { ...datosEntregado, id: folio };
  }
  broadcastNegocio(req.repartidor.negocio_id, { tipo: 'actualizar_estado', id: folio, estado: 'entregado' });
  // Este broadcast() directo se queda legado a propósito (misma razón que
  // el comentario de arriba: sin req.negocioId real). No es una fuga real:
  // _persistirCambioEstado (orderManager.js) YA emitió este mismo
  // actualizar_estado vía broadcastNegocio(pedido.negocioId, ...) al
  // actualizar el estado unas líneas arriba -- el panel del negocio
  // correcto ya lo recibió aislado. Este es un envío redundante heredado,
  // documentado, no una segunda fuente de verdad.
  broadcast({ tipo: 'actualizar_estado', id: folio, estado: 'entregado' });
  console.log(`[Repartidor] ${req.repartidor.nombre} marcó ${folio} como entregado`);

  // WA confirmación de entrega al cliente — Fase A: credenciales propias
  // del negocio del repartidor, nunca caché global.
  try {
    const tel = pedido?.cliente?.telefono;
    if (tel && tel !== '—' && !tel.startsWith('rappi-')) {
      const nombre = pedido?.cliente?.nombre?.split(' ')[0] || 'cliente';
      const credenciales = await obtenerCredencialesWhatsappNegocio(req.repartidor.negocio_id);
      if (credenciales) {
        await enviarMensaje(tel,
          `¡Listo ${nombre}! ✅ Tu pedido *${folio}* fue entregado. ` +
          `¡Gracias por tu preferencia! Esperamos verte pronto. 🙏`,
          credenciales
        );
      }
    }
  } catch (e) {
    console.error('[Repartidor] Error enviando WA entregado:', e.message);
  }

  res.json({ ok: true });
});

// Guardar push subscription del repartidor -- negocioId sale del propio
// repartidor autenticado (req.repartidor.negocio_id), nunca del body.
app.post('/api/repartidor/push/subscribe', requireRepartidor, async (req, res) => {
  const { subscription } = req.body;
  if (!subscription) return res.status(400).json({ error: 'subscription requerida' });
  if (!req.repartidor.negocio_id) return res.status(403).json({ error: 'Repartidor sin negocio resuelto' });
  await guardarPushRepartidor(req.repartidor.id, subscription, req.repartidor.negocio_id);
  res.json({ ok: true });
});

// ─── Portal operativo del repartidor (restauración) ─────────────────────────
// Todas estas rutas derivan repartidor y negocio del TOKEN autenticado
// (req.repartidor) -- jamás de ids del navegador.
app.get('/api/repartidor/me', requireRepartidor, async (req, res) => {
  const negocio = req.repartidor.negocio_id ? await obtenerNombreNegocio(req.repartidor.negocio_id) : null;
  res.json({
    nombre: req.repartidor.nombre,
    negocio,
    estado: req.repartidor.estado || (req.repartidor.activo ? 'disponible' : 'suspendido'),
  });
});

// Pedido(s) actual(es) con el detalle COMPLETO -- solo del repartidor
// asignado (política de privacidad: la dirección completa y el teléfono
// del cliente existen únicamente aquí y solo mientras la entrega está viva).
app.get('/api/repartidor/pedido-actual', requireRepartidor, async (req, res) => {
  if (!req.repartidor.negocio_id) return res.status(403).json({ error: 'Repartidor sin negocio resuelto' });
  const filas = await obtenerPedidosAsignadosARepartidor(req.repartidor.id);
  const propios = filas.filter(f => true); // ya filtradas por repartidor_id
  const cfg = await obtenerConfiguracion(req.repartidor.negocio_id);
  const negocioNombre = await obtenerNombreNegocio(req.repartidor.negocio_id);
  res.json({
    negocio: { nombre: negocioNombre, direccion: cfg?.direccion || null },
    pedidos: propios.map(f => {
      const d = f.datos || {};
      const c = d.cliente || {};
      const tel = c.telefono && c.telefono !== '—' && !String(c.telefono).startsWith('rappi-') ? c.telefono : null;
      return {
        folio: f.folio,
        estado: f.estado,
        entregaEstado: d.entrega_estado || 'asignado',
        creadoAt: f.created_at,
        cliente: c.nombre || null,
        telefono: tel,
        calle: c.calle || null,
        colonia: c.colonia || null,
        entreCalles: c.entre_calles || null,
        referencia: c.referencia || c.referencias || null,
        lat: (typeof c.lat === 'number' ? c.lat : null),
        lng: (typeof c.lng === 'number' ? c.lng : null),
        total: d.total,
        costoEnvio: d.costo_envio || 0,
        formaPago: d.forma_pago || null,
        pagoConfirmado: d.pago_confirmado === true || d.pago_confirmado === 'true',
        notas: d.notas || null,
        items: Array.isArray(d.items) ? d.items.length : 0,
      };
    }),
  });
});

// Historial "Mis entregas": terminales propios, paginado, con campos
// reducidos por privacidad (sin teléfono ni calle/número/referencias).
app.get('/api/repartidor/entregas', requireRepartidor, async (req, res) => {
  if (!req.repartidor.negocio_id) return res.status(403).json({ error: 'Repartidor sin negocio resuelto' });
  const { rango, estado, pagina } = req.query;
  const r = await obtenerEntregasRepartidor(req.repartidor.id, req.repartidor.negocio_id, {
    rango: ['hoy', '7d', '30d'].includes(rango) ? rango : '7d',
    filtroEstado: ['entregados', 'cancelados', 'todos'].includes(estado) ? estado : 'todos',
    pagina: pagina,
  });
  res.json({
    total: r.total,
    entregas: r.entregas.map(e => ({
      folio: e.folio,
      estado: e.estado,
      colonia: e.colonia || null,
      total: e.total,
      creadoAt: e.created_at,
      aceptadoAt: e.hora_aceptacion || null,
      entregadoAt: e.entregado_at || null,
      cancelacionMotivo: e.cancelacion_motivo || null,
    })),
  });
});

// Sub-estados de la entrega (recogido / en_camino): validados en DB con
// dueño + no terminal, idempotentes, y anunciados al panel del negocio.
async function marcarSubEstadoEntrega(req, res, nuevo) {
  if (!req.repartidor.negocio_id) return res.status(403).json({ error: 'Repartidor sin negocio resuelto' });
  const r = await marcarEstadoEntrega(req.params.folio, req.repartidor.negocio_id, req.repartidor.id, nuevo);
  if (!r.ok) {
    return res.status(r.motivo === 'no_elegible' ? 409 : 400).json({ error: 'No se pudo actualizar la entrega (verifica que el pedido siga activo y asignado a ti)' });
  }
  broadcastNegocio(req.repartidor.negocio_id, { tipo: 'entrega_estado', folio: req.params.folio, entregaEstado: nuevo, repartidor: req.repartidor.nombre });
  res.json({ ok: true, entregaEstado: nuevo });
}
app.post('/api/repartidor/pedido/:folio/recogido', requireRepartidor, (req, res) => marcarSubEstadoEntrega(req, res, 'recogido'));
app.post('/api/repartidor/pedido/:folio/en-camino', requireRepartidor, (req, res) => marcarSubEstadoEntrega(req, res, 'en_camino'));

// Incidencia operativa: se registra en el pedido (auditoría) y se avisa a
// la Central del negocio y a Superadmin. Jamás cambia estados ni reasigna.
app.post('/api/repartidor/pedido/:folio/incidencia', requireRepartidor, async (req, res) => {
  if (!req.repartidor.negocio_id) return res.status(403).json({ error: 'Repartidor sin negocio resuelto' });
  const { tipo, detalle } = req.body || {};
  if (!TIPOS_INCIDENCIA.includes(tipo)) return res.status(400).json({ error: 'Tipo de incidencia inválido', tipos: TIPOS_INCIDENCIA });
  const r = await registrarIncidenciaEntrega(req.params.folio, req.repartidor.negocio_id, req.repartidor.id, tipo, detalle);
  if (!r.ok) return res.status(409).json({ error: 'No se pudo registrar la incidencia (el pedido debe estar asignado a ti)' });
  broadcastNegocio(req.repartidor.negocio_id, { tipo: 'repartidor_incidencia', folio: req.params.folio, tipoIncidencia: tipo, repartidor: req.repartidor.nombre }, { soloAdmin: true });
  try { broadcastSuperadmin({ tipo: 'repartidor_incidencia', folio: req.params.folio, negocioId: req.repartidor.negocio_id, tipoIncidencia: tipo }); } catch {}
  console.log(`[Repartidor] Incidencia '${tipo}' en ${req.params.folio} por ${req.repartidor.nombre}`);
  res.json({ ok: true });
});

// Lista de repartidores (admin)
app.get('/api/admin/repartidores', requireAdminSeguro, requireModulo('pos'), async (req, res) => {
  res.json(await obtenerRepartidores(req.negocioId));
});

// Actividad de repartidores por período — hoy / ayer / antier / semana
// negocioId OBLIGATORIO — falla cerrado (Auditoría P0, Categoría A). Antes
// consultaba pedidos_activos sin filtrar por negocio en absoluto -- fuga
// confirmada (cualquier sesión veía folios, clientes, direcciones y
// montos reales de todos los negocios). Payload recortado: el frontend
// (panel/index.html) nunca lee el teléfono en esta vista, así que se deja
// de mandar.
app.get('/api/admin/repartidores/estado', requireAdminSeguro, requireModulo('pos'), async (req, res) => {
  if (typeof req.negocioId !== 'string' || !req.negocioId.trim()) {
    return res.status(403).json({ error: 'Sesión inválida — no se pudo determinar el negocio' });
  }
  if (!(await negocioEstaActivo(req.negocioId))) {
    return res.status(403).json({ error: 'Negocio suspendido o inactivo' });
  }
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
        AND negocio_id = $1
      ORDER BY created_at DESC
    `, [req.negocioId]);

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

// Cambia disponible/pausado/suspendido/baja — reusa la MISMA función que la
// ruta de Superadmin (cambiarEstadoRepartidor), pasando siempre el
// negocioId de la sesión del propio admin. Nunca puede tocar un repartidor
// de otro negocio (el WHERE de la función lo garantiza). "Baja" es un
// estado, no un DELETE — el historial nunca se pierde. Distinto del
// endpoint DELETE de abajo, que sigue siendo el hard-delete legado y no se
// reutiliza para esto.
app.patch('/api/admin/repartidores/:id/estado', requireAdminSeguro, requireModulo('pos'), async (req, res) => {
  const { estado } = req.body || {};
  if (!ESTADOS_REPARTIDOR_VALIDOS.includes(estado)) {
    return res.status(400).json({ error: 'Estado inválido' });
  }
  const actualizado = await cambiarEstadoRepartidor(req.params.id, estado, { negocioId: req.negocioId });
  if (!actualizado) return res.status(404).json({ error: 'Repartidor no encontrado en este negocio' });
  // Fase C: mismo evento que la ruta de Superadmin -- payload mínimo.
  try {
    broadcastSuperadmin({ tipo: 'red_repartidores_estado_cambiado', repartidorId: actualizado.id, negocioId: req.negocioId, estado: actualizado.estado });
    broadcastNegocio(req.negocioId, { tipo: 'red_repartidores_estado_cambiado', repartidorId: actualizado.id, estado: actualizado.estado }, { soloAdmin: true });
  } catch (e) {
    console.error('[WS] Error emitiendo red_repartidores_estado_cambiado:', e.message);
  }
  res.json(actualizado);
});

app.delete('/api/admin/repartidores/:id', requireAdminSeguro, requireModulo('pos'), async (req, res) => {
  const ok = await eliminarRepartidor(req.params.id, req.negocioId);
  if (!ok) return res.status(404).json({ error: 'Repartidor no encontrado en este negocio' });
  res.json({ ok: true });
});

// Candidatos a repartidor — mensajes con "repartidor" en las últimas 72h
app.get('/api/admin/repartidores/candidatos', requireAdminSeguro, requireModulo('pos'), async (req, res) => {
  try {
    const rows = await obtenerCandidatosRepartidor(req.negocioId);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Red de Repartidores — Fase D: Métricas y ranking (negocio-admin) ──────
// negocioId SIEMPRE viene de req.negocioId (sesión) -- nunca de
// req.query.negocioId, aunque el cliente lo mande. Esto es lo que garantiza
// que un negocio-admin jamás vea agregados de otro negocio, sin importar lo
// que envíe el navegador. requireAdminSeguro ya bloquea a staff (403).
app.get('/api/admin/repartidores/metricas', requireAdminSeguro, requireModulo('pos'), async (req, res) => {
  const resultado = await obtenerMetricasRedRepartidores({
    negocioId: req.negocioId,
    ciudad: req.query.ciudad || null,
    zona: req.query.zona || null,
    repartidorId: req.query.repartidorId || null,
    desde: req.query.desde || null,
    hasta: req.query.hasta || null,
  });
  if (!resultado) return res.status(500).json({ error: 'Error calculando métricas' });
  res.json(resultado);
});

app.get('/api/admin/repartidores/ranking', requireAdminSeguro, requireModulo('pos'), async (req, res) => {
  const resultado = await obtenerRankingRepartidores({
    negocioId: req.negocioId,
    ciudad: req.query.ciudad || null,
    zona: req.query.zona || null,
    desde: req.query.desde || null,
    hasta: req.query.hasta || null,
  });
  res.json(resultado);
});

app.get('/api/admin/repartidores/ranking/exportar.csv', requireAdminSeguro, requireModulo('pos'), async (req, res) => {
  const { rankingElegible, muestraInsuficiente, suspendidosOBaja } = await obtenerRankingRepartidores({
    negocioId: req.negocioId,
    ciudad: req.query.ciudad || null,
    zona: req.query.zona || null,
    desde: req.query.desde || null,
    hasta: req.query.hasta || null,
  });
  const todas = [...rankingElegible, ...muestraInsuficiente, ...suspendidosOBaja];
  const columnas = [
    { titulo: 'Repartidor', valor: (f) => f.nombre },
    { titulo: 'Ciudad', valor: (f) => f.ciudad || '' },
    { titulo: 'Zona', valor: (f) => f.zona || '' },
    { titulo: 'Estado', valor: (f) => f.estadoRepartidor },
    { titulo: 'Ofrecidos', valor: (f) => f.serviciosOfrecidos },
    { titulo: 'Aceptados', valor: (f) => f.serviciosAceptados },
    { titulo: 'Entregados', valor: (f) => f.serviciosEntregados },
    { titulo: 'Rechazados', valor: (f) => f.serviciosRechazados === null ? 'No disponible' : f.serviciosRechazados },
    { titulo: 'Ignorados', valor: (f) => f.serviciosIgnorados },
    { titulo: 'TasaAceptacion', valor: (f) => f.tasaAceptacion == null ? '' : (f.tasaAceptacion * 100).toFixed(1) + '%' },
    { titulo: 'TasaFinalizacion', valor: (f) => f.tasaFinalizacion == null ? '' : (f.tasaFinalizacion * 100).toFixed(1) + '%' },
    { titulo: 'TiempoPromedioAceptacionSeg', valor: (f) => f.tiempoPromedioAceptacionSeg == null ? '' : Math.round(f.tiempoPromedioAceptacionSeg) },
    { titulo: 'UltimaActividad', valor: (f) => f.ultimaActividad || '' },
    { titulo: 'PosibleDuplicado', valor: (f) => f.posibleDuplicado ? 'sí' : 'no' },
  ];
  const csv = filasARegistrosCSV(todas, columnas);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="ranking-repartidores.csv"');
  res.send('﻿' + csv);
});

// DEBUG TEMPORAL — diagnóstico de un pedido en pedidos_activos
// negocioId OBLIGATORIO (Auditoría P0, Categoría B): mismo criterio que
// las demás rutas por folio — un folio de otro negocio responde 404.
app.get('/api/admin/debug/pedido/:folio', requireAdminSeguro, requireModulo('pos'), async (req, res) => {
  const { rows } = await pool.query(`
    SELECT folio, estado, created_at,
           datos->>'modalidad' AS modalidad,
           datos->>'repartidor_id' AS repartidor_id,
           datos->>'repartidor_nombre' AS repartidor_nombre,
           DATE(created_at AT TIME ZONE 'America/Matamoros') AS fecha_mx,
           (NOW() AT TIME ZONE 'America/Matamoros')::date AS hoy_mx
    FROM pedidos_activos WHERE folio = $1 AND negocio_id = $2
  `, [req.params.folio, req.negocioId]).catch(e => ({ rows: [], error: e.message }));
  if (!rows[0]) return res.status(404).json({ error: 'no encontrado' });
  res.json(rows[0]);
});

app.post('/api/admin/reporte-diario/enviar', requireAdminSeguro, requireModulo('pos'), async (req, res) => {
  await enviarReporteDiario();
  res.json({ ok: true });
});

// Endpoint — forzar enriquecimiento de perfiles manualmente
app.post('/api/admin/memory/enriquecer', requireAdminSeguro, async (req, res) => {
  const n = await enriquecerTodosLosPerfiles();
  res.json({ ok: true, perfiles_actualizados: n });
});

// ─── Clientes CRM ─────────────────────────────────────────────────────────────
// negocio_id OBLIGATORIO en todas las rutas de este bloque (Incidente P0) —
// antes consultaban clientes/perfiles_clientes/eventos sin filtrar, fuga
// confirmada en producción. Compatibilidad NULL limitada a Nonna Maye, mismo
// criterio que database.js (los 2 clientes con negocio_id NULL).
app.get('/api/admin/clientes', requireAdminSeguro, async (req, res) => {
  try {
    const nonnaMayeId = await obtenerNegocioIdPorSlug('nonna-maye');
    const incluirNull = !!nonnaMayeId && req.negocioId === nonnaMayeId;
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
        AND (c.negocio_id = $1 OR ($2::boolean AND c.negocio_id IS NULL))
      ORDER BY COALESCE(p.total_gastado, 0) DESC
      LIMIT 500
    `, [req.negocioId, incluirNull]);
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
    const ok = await toggleClienteInterno(req.params.telefono, !!es_interno, req.negocioId);
    if (!ok) return res.status(404).json({ error: 'Cliente no encontrado en este negocio' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Resumen de segmentos para el tab Clientes
app.get('/api/admin/clientes/segmentos', requireAdminSeguro, async (req, res) => {
  try {
    const nonnaMayeId = await obtenerNegocioIdPorSlug('nonna-maye');
    const incluirNull = !!nonnaMayeId && req.negocioId === nonnaMayeId;
    const { rows } = await pool.query(`
      SELECT segmento, COUNT(*) AS total
      FROM perfiles_clientes
      WHERE negocio_id = $1 OR ($2::boolean AND negocio_id IS NULL)
      GROUP BY segmento
      ORDER BY total DESC
    `, [req.negocioId, incluirNull]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Oportunidades pendientes (conversaciones con intención sin pedido)
app.get('/api/admin/clientes/oportunidades', requireAdminSeguro, async (req, res) => {
  try {
    const rows = await obtenerOportunidadesPendientes(req.negocioId);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Métricas de conversión: chats totales vs pedidos
app.get('/api/admin/clientes/conversion', requireAdminSeguro, async (req, res) => {
  try {
    const nonnaMayeId = await obtenerNegocioIdPorSlug('nonna-maye');
    const incluirNull = !!nonnaMayeId && req.negocioId === nonnaMayeId;
    const { rows: [conv] } = await pool.query(`
      SELECT
        COUNT(DISTINCT sesion_id) FILTER (WHERE tipo_evento = 'mensaje_recibido') AS chats_unicos,
        COUNT(DISTINCT sesion_id) FILTER (WHERE tipo_evento = 'pedido_confirmado') AS chats_con_pedido,
        COUNT(*) FILTER (WHERE tipo_evento = 'menu_solicitado') AS menus_enviados,
        COUNT(*) FILTER (WHERE tipo_evento = 'pedido_iniciado') AS pedidos_iniciados,
        COUNT(*) FILTER (WHERE tipo_evento = 'pedido_confirmado') AS pedidos_confirmados
      FROM eventos
      WHERE ocurrido_at > NOW() - INTERVAL '30 days'
        AND (negocio_id = $1 OR ($2::boolean AND negocio_id IS NULL))
    `, [req.negocioId, incluirNull]);
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
  obtenerCanjeDeFolio,
  revertirMovimientosFolio,
  ajustarPuntosManual,
} from './services/rewardsService.js';

// negocioId (Incidente P0): rewardsService usa un parámetro tenantId legado
// (default 'xabor-principal', ver rewardsService.js) desconectado del
// sistema de negocios. Aquí se pasa siempre req.negocioId como tenantId —
// nunca el literal hardcodeado — para que cada negocio solo vea y modifique
// su propio programa de puntos (migración 013 reetiquetó los datos
// existentes de Nonna Maye a su negocio_id real).

// Configuración del programa
app.get('/api/rewards/config', requireAdminSeguro, requireModulo('rewards'), async (req, res) => {
  try {
    const config = await obtenerConfigRewards(req.negocioId);
    res.json(config);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/rewards/config', requireAdminSeguro, requireModulo('rewards'), async (req, res) => {
  try {
    await actualizarConfigRewards(req.negocioId, req.body);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Resumen estadístico
app.get('/api/rewards/resumen', requireAdminSeguro, requireModulo('rewards'), async (req, res) => {
  try {
    const resumen = await obtenerResumenRewards(req.negocioId);
    res.json(resumen);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Lista de clientes inscritos
app.get('/api/rewards/clientes', requireAdminSeguro, requireModulo('rewards'), async (req, res) => {
  try {
    const lista = await listarClientesRewards(req.negocioId);
    res.json(lista);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Búsqueda de clientes (admin y staff — para asignar en POS)
app.get('/api/rewards/clientes/buscar', requireAuthSeguro, requireModulo('rewards'), async (req, res) => {
  const { q = '' } = req.query;
  if (!q.trim()) return res.json([]);
  try {
    const lista = await buscarClientesRewards(q, req.negocioId);
    res.json(lista);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Perfil de un cliente + estimación de puntos
app.get('/api/rewards/cliente/:telefono', requireAuthSeguro, requireModulo('rewards'), async (req, res) => {
  try {
    const perfil = await obtenerPerfilRewards(req.params.telefono, req.negocioId);
    if (!perfil) return res.status(404).json({ error: 'No encontrado' });
    // Calcular estimación de puntos según total query param
    const total = parseFloat(req.query.total) || 0;
    if (total > 0) {
      const config = await obtenerConfigRewards(req.negocioId);
      perfil.puntos_estimados = calcularPuntos(total, config);
    }
    res.json(perfil);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Movimientos de un cliente
app.get('/api/rewards/cliente/:telefono/movimientos', requireAdminSeguro, requireModulo('rewards'), async (req, res) => {
  try {
    const perfil = await obtenerPerfilRewards(req.params.telefono, req.negocioId);
    if (!perfil?.account_id) return res.json([]);
    // tenantId como defensa en profundidad -- perfil.account_id ya viene de
    // una consulta filtrada por negocioId, pero obtenerMovimientosCliente
    // vuelve a filtrar por tenant_id en la propia consulta, para no
    // depender únicamente de que el account_id llegue ya validado.
    const movimientos = await obtenerMovimientosCliente(perfil.account_id, req.negocioId);
    res.json(movimientos);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Movimientos recientes globales
app.get('/api/rewards/movimientos', requireAdminSeguro, requireModulo('rewards'), async (req, res) => {
  try {
    const movimientos = await obtenerMovimientosRecientes(req.negocioId);
    res.json(movimientos);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Crear o recuperar cliente para Rewards (staff + admin)
// La identidad de Rewards vive en rewards_accounts (nombre incluido,
// aislada por tenant_id) -- `clientes` solo se toca para garantizar que
// la fila exista (lo exige la FK de rewards_accounts.telefono), NUNCA
// para leer o escribir nombre/ultima_visita de un negocio ajeno.
app.post('/api/rewards/cliente', requireAuthSeguro, requireModulo('rewards'), async (req, res) => {
  const { telefono, nombre } = req.body;
  if (!telefono?.trim() || !nombre?.trim()) {
    return res.status(400).json({ error: 'Nombre y teléfono requeridos' });
  }
  const tel = telefono.trim().replace(/\D/g, '').slice(-10);
  if (tel.length < 7) return res.status(400).json({ error: 'Teléfono inválido' });
  try {
    // Solo crea la fila en `clientes` si NO existe todavía (satisface la
    // FK). Si ya existe -- sea de este negocio o de otro -- nunca se
    // reescribe nombre/ultima_visita desde aquí; esa reescritura pisaba
    // silenciosamente el nombre de un cliente ajeno cuando el teléfono ya
    // pertenecía a otro negocio.
    await pool.query(
      `INSERT INTO clientes (telefono, nombre, ultima_visita, negocio_id)
       VALUES ($1, $2, NOW(), $3)
       ON CONFLICT (telefono) DO NOTHING`,
      [tel, nombre.trim(), req.negocioId]
    );
    const cuenta = await obtenerOCrearCuenta(tel, nombre.trim(), req.negocioId);
    const perfil = await obtenerPerfilRewards(tel, req.negocioId);
    res.json({ ok: true, perfil });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Consultar bloques de canje disponibles para un cliente en POS
app.get('/api/rewards/cliente/:telefono/canje-disponible', requireAuthSeguro, requireModulo('rewards'), async (req, res) => {
  const { telefono } = req.params;
  const { total } = req.query;
  try {
    const [cuenta, config] = await Promise.all([
      obtenerCuentaPorTelefono(telefono, req.negocioId),
      obtenerConfigRewards(req.negocioId)
    ]);
    if (!cuenta || !config) return res.json({ puntos_balance: 0, bloques: 0, puntos: 0, valor: 0 });
    const totalVenta = parseFloat(total) || 0;
    const result = calcularBloquesDisponibles(cuenta.puntos_balance, totalVenta, config);
    res.json({ puntos_balance: cuenta.puntos_balance, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Ajuste manual de puntos — solo admin
app.post('/api/rewards/cliente/:telefono/ajustar', requireAdminSeguro, requireModulo('rewards'), async (req, res) => {
  const { telefono } = req.params;
  const { puntos, tipo, motivo } = req.body;
  try {
    const usuario = req.user || 'admin';
    const result = await ajustarPuntosManual(telefono, puntos, tipo, motivo, usuario, req.negocioId);
    res.json({ ok: true, ...result });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ─── Campañas WA ──────────────────────────────────────────────────────────────

// Preview: cuántos destinatarios tiene un segmento
app.get('/api/admin/campanas/preview', requireAdminSeguro, requireModulo('whatsapp'), async (req, res) => {
  const { segmento = 'todos' } = req.query;
  try {
    const destinatarios = await obtenerDestinatariosCampana(segmento, req.negocioId);
    res.json({ total: destinatarios.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Historial de campañas
app.get('/api/admin/campanas', requireAdminSeguro, requireModulo('whatsapp'), async (req, res) => {
  try {
    res.json(await obtenerCampanas(req.negocioId));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Crear y enviar campaña (background — responde inmediato)
// negocioId OBLIGATORIO en la selección de destinatarios (Incidente P0) —
// antes obtenerDestinatariosCampana no filtraba por negocio en absoluto.
app.post('/api/admin/campanas', requireAdminSeguro, requireModulo('whatsapp'), async (req, res) => {
  const { nombre, segmento = 'todos', mensaje } = req.body;
  if (!nombre || !mensaje) return res.status(400).json({ error: 'nombre y mensaje requeridos' });

  try {
    const destinatarios = await obtenerDestinatariosCampana(segmento, req.negocioId);
    if (destinatarios.length === 0) return res.status(400).json({ error: 'Sin destinatarios para ese segmento' });

    const campanaId = await crearCampana({ nombre, segmento, mensaje, totalDestinatarios: destinatarios.length, negocioId: req.negocioId });
    res.json({ ok: true, campanaId, total: destinatarios.length });

    // Envío en background (1 msg/seg para no saturar la API de Meta)
    // Fase A: credenciales propias del negocio resueltas una vez, antes
    // del loop -- nunca caché global. Si el negocio no tiene integración
    // propia, la campaña completa se omite (se loguea una sola vez, no
    // por cada destinatario).
    const negocioIdCampana = req.negocioId;
    setImmediate(async () => {
      const credenciales = await obtenerCredencialesWhatsappNegocio(negocioIdCampana);
      if (!credenciales) {
        console.log(`[Campaña ${campanaId}] Omitida por completo — sin integración propia verificada para negocio ${negocioIdCampana}`);
        return;
      }
      for (const { telefono, nombre: nomCliente } of destinatarios) {
        const primerNombre = nomCliente?.split(' ')[0] || '';
        const msgPersonalizado = primerNombre
          ? mensaje.replace(/\{nombre\}/gi, primerNombre)
          : mensaje.replace(/,?\s*\{nombre\}/gi, '');
        let ok = false;
        try {
          await enviarMensaje(telefono, msgPersonalizado, credenciales);
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

app.get('/api/admin/rappi/menu-status', requireAdminSeguro, requireModulo('rappi'), async (req, res) => {
  try {
    const result = await consultarAprobacionMenu();
    res.json({ ok: true, result });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/rappi/subir-menu', requireAdminSeguro, requireModulo('rappi'), async (req, res) => {
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

// ⚠ CONFIRMA UN PAGO SIN PROVEEDOR, SIN WEBHOOK Y SIN DINERO REAL.
//
// Por eso NO SE REGISTRA salvo en un entorno de pruebas declarado a proposito:
// en produccion la ruta no existe y el servidor responde 404 porque no hay nada
// que responder. Ser admin no basta -- una credencial filtrada podria marcar
// pedidos como pagados. Esconderla en la UI tampoco basta.
//
// Requiere las DOS condiciones: bandera explicita Y no estar en produccion.
const RUTAS_PRUEBA = process.env.XABOR_RUTAS_PRUEBA === '1' && process.env.NODE_ENV !== 'production';
if (RUTAS_PRUEBA) {
  console.warn('[server] ⚠ RUTAS DE PRUEBA ACTIVAS (XABOR_RUTAS_PRUEBA=1) — jamas en produccion');
// Dispara la MISMA transicion autorizada que usa el webhook verificado
// (confirmarPedidoPendientePago): si esta ruta confirmara por su cuenta, las
// pruebas no probarian el camino real.
app.post('/test/confirmar-pago-tienda', requireAdminSeguro, async (req, res) => {
  const folio = String(req.body?.folio || '').trim();
  if (!folio) return res.status(400).json({ error: 'folio requerido' });
  try {
    await confirmarPagoPedido(folio, req.negocioId);
    await confirmarPedidoPendientePago(folio, req.negocioId);
    res.json({ ok: true });
  } catch (e) {
    console.error('[test/confirmar-pago-tienda]', e.message);
    res.status(500).json({ error: 'no se pudo confirmar' });
  }
});
// Dispara la MISMA funcion que usan los canales reales (whatsapp-meta.js,
// voice.js) para convertir un pedido activo en reserva programada: la
// transicion DB atomica (062, P0-15E) Y el retiro de la proyeccion en
// memoria (P0-16) -- para que el arnes de muerte de proceso mate al binario
// en el punto exacto que ya prueba xabor_activo_a_programado, y para poder
// probar memoria/panel, sin tener que simular la conversacion con el modelo.
app.post('/test/pedido-programar', requireAdminSeguro, async (req, res) => {
  const folio = String(req.body?.folio || '').trim();
  const programadoPara = req.body?.programadoPara ? new Date(req.body.programadoPara) : null;
  if (!folio || !programadoPara || Number.isNaN(programadoPara.getTime())) {
    return res.status(400).json({ error: 'folio y programadoPara (ISO) requeridos' });
  }
  try {
    // MISMA funcion que llaman whatsapp-meta.js/voice.js (P0-16): la
    // transicion DB atomica Y el retiro de la proyeccion en memoria, nunca
    // solo la primera -- si esta ruta llamara a guardarPedidoProgramado
    // directo, la prueba estaria verificando un camino que ningun canal real
    // usa.
    const r = await convertirPedidoAProgramado({ id: folio, negocioId: req.negocioId }, programadoPara);
    res.json(r);
  } catch (e) {
    console.error('[test/pedido-programar]', e.message);
    res.status(500).json({ error: 'no se pudo programar' });
  }
});
}

app.post('/test/pedido', requireAdminSeguro, requireModulo('pos'), async (req, res) => {
  // Overrides opcionales SOLO de esta ruta de prueba (ya protegida con
  // admin): las suites del primer mensaje a repartidores necesitan crear
  // pedidos con calle/colonia controladas por el flujo real completo.
  const clienteOverride = (req.body && typeof req.body.cliente === 'object' && req.body.cliente !== null) ? req.body.cliente : {};
  const ordenPrueba = {
    cliente: { nombre: 'Cliente Prueba', telefono: '8781234567', calle: 'Av. Tecnológico 123', colonia: 'Centro', entre_calles: 'Juárez y Morelos', ...clienteOverride },
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
    canal: 'prueba_admin',
    negocioId: req.negocioId
  };
  try {
    // P0: canal 'prueba_admin', NO 'test'. 'test' es un canal cuyo JSON lo
    // redacta un LLM y pasa por el validador transaccional; esta ruta es
    // una herramienta interna YA autenticada como admin con items fijos
    // sintéticos -- no es una propuesta del modelo y no debe (ni puede)
    // resolverse contra el menú de cada negocio.
    const pedido = await registrarPedido(ordenPrueba, 'prueba_admin');
    emitirPedido(pedido).catch(e => console.error(`[Pedido] emitirPedido(${pedido.id}) fallo sin emitir efectos externos: ${e.message}`));
    res.json({ ok: true, pedido });
  } catch (e) {
    console.error('[server] Error en /test/pedido:', e.message);
    res.status(500).json({ error: 'No se pudo registrar el pedido de prueba' });
  }
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

      // Persistir en DB (reinsertar en pedidos_activos) y agregar a memoria.
      // negocioId explícito: sin esto, pedidos_activos.negocio_id quedaba
      // NULL para siempre (única escritura de esta fila -- ON CONFLICT
      // DO UPDATE nunca corrige negocio_id después). pedido.negocioId ya
      // fue validado como string no vacío arriba, nunca inventado aquí.
      // EL RETORNO YA NO SE IGNORA.
      //
      // Antes decía que "un conflicto aquí solo puede ser la misma fila
      // re-insertada". Esa premisa cayó con los folios reciclados: mientras el
      // binario viejo estuvo vivo, otro pedido cualquiera podía haber ocupado
      // este número. Si eso pasa y se sigue adelante, la base guarda el pedido
      // AJENO mientras la memoria, el panel y el papel muestran el programado
      // -- el mismo folio nombrando dos cosas distintas.
      const { guardarPedidoActivo, pool: _poolProg } = await import('./services/database.js');
      const { agregarPedidoAMemoria } = await import('./orders/orderManager.js');
      const guardado = await guardarPedidoActivo(pedido, pedido.negocioId);

      if (!guardado.ok) {
        // Error real de base: se deja PENDIENTE para el siguiente ciclo. No se
        // marca activado, así que el retry lo recupera.
        console.error(`[Programados] No se pudo persistir ${row.folio}: se reintentara en el proximo ciclo`);
        continue;
      }

      if (!guardado.insertado) {
        // Conflicto. Hay que averiguar QUIÉN ocupa el folio antes de decidir.
        const { rows: [ocupante] } = await _poolProg.query(
          `SELECT negocio_id, datos FROM pedidos_activos WHERE folio = $1`, [row.folio]);
        const mismoProgramado = ocupante
          && ocupante.negocio_id === pedido.negocioId
          && pedido.programado_id
          && ocupante.datos?.programado_id === pedido.programado_id;

        if (!mismoProgramado) {
          // El folio es de OTRO pedido. Nada de memoria, Edge, panel ni papel, y
          // NO se marca activado: la reserva sigue viva para que alguien la mire.
          console.error(
            `[Programados] ANOMALIA: el folio ${row.folio} ya pertenece a otro pedido ` +
            `(negocio=${ocupante?.negocio_id || 'desconocido'}). El programado NO se activa: ` +
            `requiere reemision manual de folio.`);
          console.warn(`[TXN] evento=programado_folio_ocupado negocio=${pedido.negocioId} folio=${row.folio}`);
          continue;
        }
        // Es la misma reserva re-insertada: retry idempotente, se continua.
        console.log(`[Programados] ${row.folio} ya estaba activo con la misma identidad: retry idempotente`);
      }

      agregarPedidoAMemoria(pedido); // ← sin esto, el panel pierde el pedido al recargar

      // P0-11: mismo nucleo que cualquier otro pedido operacional -- NUNCA
      // una segunda implementacion de Edge/panel/impresion aqui. La deuda ya
      // la aseguro el trigger de la 063 en el guardarPedidoActivo() de
      // arriba (el INSERT trae `programado_id`, asi que no es el insert
      // temporal previo a la reserva); emitirPedido() reclama esa deuda,
      // relee el pedido bajo el lock y ejecuta -- incluye el mismo gate de
      // pendiente_pago que antes vivia duplicado aqui. Fire-and-forget con
      // `.catch()`, igual que el resto de los llamadores de este archivo: un
      // fallo en ESTE pedido no debe abortar el resto del lote.
      emitirPedido(pedido).catch(e => console.error(`[Scheduler] emitirPedido(${pedido.id}) fallo sin emitir efectos externos: ${e.message}`));
      // La activacion de la RESERVA es independiente del resultado de la
      // emision operacional: el pedido ya es un activo normal cualquiera, y
      // si la emision falla, la deuda durable (no `activado`) es lo que
      // garantiza el reintento -- ver reconciliarEmisionesOperacionalesPendientes.
      await marcarPedidoProgramadoActivado(row.folio);
      console.log(`[Scheduler] Pedido ${row.folio} activado`);
    }
  } catch (e) {
    console.error('[Scheduler] Error activando pedidos programados:', e.message);
  }
}

// Endpoint para que el panel liste los pedidos programados pendientes
app.get('/api/pedidos-programados', requireAuthSeguro, requireModulo('pos'), async (req, res) => {
  const lista = await obtenerPedidosProgramadosPendientes(req.negocioId);
  res.json(lista.map(r => ({
    folio: r.folio,
    programado_para: r.programado_para,
    cliente: r.datos?.cliente?.nombre || '—',
    total: r.datos?.total || 0,
    items: r.datos?.items || []
  })));
});

// ─── Transcripciones de llamadas ─────────────────────────────────────────────
app.get('/api/llamadas', requireAuthSeguro, requireModulo('voz'), async (req, res) => {
  const lista = await obtenerLlamadasRecientes(req.negocioId, 30);
  res.json(lista);
});

app.get('/api/llamadas/:callSid', requireAuthSeguro, requireModulo('voz'), async (req, res) => {
  const mensajes = await obtenerTranscripcionPorLlamada(req.params.callSid, req.negocioId);
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
    // Fase A: credenciales propias del mismo negocio del reporte -- nunca
    // caché global. Job de un solo negocio por diseño (ver nota arriba).
    const credenciales = await obtenerCredencialesWhatsappNegocio(negocioIdReporte);
    if (!credenciales) {
      console.log(`[Reporte] Corte diario no enviado — sin integración propia verificada para negocio ${negocioIdReporte}`);
      return;
    }
    await enviarMensaje(WHATSAPP_ADMIN_NUMERO, msg, credenciales);
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
// negocioId (Incidente P0): obtenerPagosPendientesConLink ya trae
// negocio_id de la propia tabla (nunca del webhook ni de una sesión) --
// se usa ESE para consultar Clip con las credenciales de ESE negocio
// (nunca una cuenta global) y para verificar dueño al confirmar el pago.
async function reconciliarPagosPendientes() {
  // CLIP-G: antes de barrer, marcar con RUIDO DURABLE las filas que llegaron
  // al limite de la ventana operativa sin evidencia terminal del proveedor
  // -- una frontera temporal jamas convierte dinero desconocido en silencio.
  try { await marcarEnvejecidosSinTerminalClip(); } catch (e) {
    console.error('[Clip Reconciliación] Error marcando envejecidos:', e.message);
  }
  // ── 1. Por FILA del ledger ────────────────────────────────────────────────
  //
  // Antes esto recorría `pedidos_activos.datos->>'clip_link_id'`, que guarda UN
  // solo id por pedido y se sobrescribe: de dos checkouts de Clip sobre el
  // mismo pedido, el primero se volvía invisible para la reconciliación. Y el
  // filtro `estado != 'entregado'` perdía de vista los pedidos ya entregados
  // que seguían sin pagar -- justo los que más importa cobrar.
  //
  // Ahora se recorre `pagos`: cada checkout tiene su fila, su referencia
  // externa y su propio destino. Incluye los superseded ('invalidado'), que
  // siguen siendo pagables porque Clip no ofrece cancelación real.
  try {
    const reconciliables = await pagosReconciliablesDeProveedor('clip', 50);
    for (const pago of reconciliables) {
      if (!pago.referencia_externa) continue;      // nunca llegó a haber checkout
      try {
        // MISMO camino que el webhook: una sola implementación de la
        // verificación, o serían dos sitios donde relajar una validación.
        const r = await verificarYAsentarClip({ pago, checkoutId: pago.referencia_externa });
        if (!r.ok) {
          // CLIP expires_at: un requery que devuelve CHECKOUT_EXPIRED se mapea
          // a la transicion COMUN de vencimiento -- nunca a fallido generico,
          // cancelado arbitrario ni (jamas) pagado. procesarExpiracionProveedorClip
          // re-verifica el estado real y solo entonces vence, idempotente. Si
          // la fila ya estaba vencida por el reloj local, devuelve
          // `ya_no_vencible` y no toca nada.
          // CLIP-E: SIN gate de estado -- tambien una fila ya 'vencido' (o
          // 'invalidado'/'fallido') necesita su marca TERMINAL verificada
          // para poder salir del barrido; procesarExpiracionProveedorClip
          // re-verifica, marca el terminal durable y aplica (idempotente) la
          // transicion comun si la fila aun era vencible.
          if (r.razon === 'estado_no_pagado:CHECKOUT_EXPIRED') {
            const rExp = await procesarExpiracionProveedorClip({ pago, checkoutId: pago.referencia_externa });
            console.log(`[Clip Reconciliación] ${pago.pedido_folio} vencido en el proveedor: ${rExp.razon}`);
            continue;
          }
          if (r.razon !== 'estado_no_pagado:CHECKOUT_PENDING') {
            console.warn(`[Clip Reconciliación] ${pago.id}: ${r.razon}`);
          }
          continue;
        }
        await derivarPedidoPorPagoAsentado({
          pagoId: pago.id, negocioId: pago.negocio_id, folio: pago.pedido_folio });
        broadcastNegocio(pago.negocio_id, { tipo: 'pago_confirmado', pedidoId: pago.pedido_folio, proveedor: 'clip' });
        console.log(`[Clip Reconciliación] ✅ Pago ${r.razon} para ${pago.pedido_folio}`);
      } catch (e) {
        console.error(`[Clip Reconciliación] Error en pago ${pago.id}: ${e.message}`);
      }
    }
  } catch (e) {
    console.error('[Clip Reconciliación] Error recorriendo el ledger:', e.message);
  }

  // ── 2. Camino verdaderamente legacy ───────────────────────────────────────
  // Extraido a webhookPagos.reconciliarLegacyClip (CLIP-G): corre bajo la
  // MISMA obligacion financiera por pedido que la creacion/settlement, con
  // re-chequeo del ledger DENTRO del lock (cierra la carrera TOCTOU con el
  // camino moderno) y granularidad por checkout (un enlace legacy con
  // dinero en un folio que ya tiene ledger se registra con anomalia y sin
  // liberar cocina -- nunca en silencio).
  try {
    await reconciliarLegacyClip({ broadcast: broadcastNegocio });
  } catch (e) {
    console.error('[Clip Reconciliación] Error en el camino legacy:', e.message);
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
        o.id, o.telefono, o.negocio_id, o.intents_detectados, o.ultima_actividad_at,
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

    // Fase A: credenciales resueltas por negocio_id, cacheadas dentro de
    // esta corrida del job -- nunca caché global, nunca se usa la
    // integración de un negocio para el seguimiento de otro.
    const credencialesPorNegocio = new Map();
    async function resolverCredencialesCacheadas(negocioId) {
      if (!negocioId) return null;
      if (!credencialesPorNegocio.has(negocioId)) {
        credencialesPorNegocio.set(negocioId, await obtenerCredencialesWhatsappNegocio(negocioId));
      }
      return credencialesPorNegocio.get(negocioId);
    }

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

      const credenciales = await resolverCredencialesCacheadas(op.negocio_id);
      if (!credenciales) {
        console.log(`[Memory] Seguimiento omitido — sin integración propia verificada para negocio ${op.negocio_id || '(sin resolver)'} (op #${op.id})`);
        continue;
      }

      try {
        await enviarMensaje(op.telefono, msg, credenciales);
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
// El servidor NO abre el puerto hasta terminar el bootstrap. Antes,
// server.listen corría EN PARALELO a esta cadena: /health ya respondía y
// podían entrar pedidos (POS, WhatsApp, Rappi) mientras cargarPedidosDesdeDB()
// seguía leyendo. Esa carga reemplazaba el estado en memoria con la
// fotografía previa, así que el pedido recién creado quedaba persistido en
// pedidos_activos pero desaparecía de memoria, y la API respondía después
// "Pedido no encontrado" sobre una fila que sí existía. Lo mismo aplicaba a
// la configuración y a las integraciones, que también se cargan aquí.
//
// Con listen al final, la ventana no existe: mientras el bootstrap corre, el
// puerto está cerrado (Railway reintenta el healthcheck hasta
// healthcheckTimeout = 60s, ver railway.toml; el bootstrap tarda ~1s). Si el
// bootstrap falla, el proceso NO se queda escuchando como si estuviera sano:
// loguea y sale con código 1 para que Railway conserve el deployment previo.
let appReady = false;
export function aplicacionLista() { return appReady; }

async function arrancar() {
  console.log('[Startup] Inicializando base...');
  await initDB();
  const negocioId = await resolverNegocioActualPorDefecto();
  await seedMenuDesdeJSON(menuJSON, negocioId);
  console.log('[Startup] Cargando pedidos...');
  const cargados = await cargarPedidosDesdeDB();
  console.log(`[Startup] Pedidos cargados: ${cargados}`);
  await cargarConfig();
  await cargarIntegraciones();

  appReady = true;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, () => {
      console.log(`
🌮 =============================================
   Agente Xabor corriendo en puerto ${PORT}
   Panel: http://localhost:${PORT}
   API:   http://localhost:${PORT}/health
🌮 =============================================
  `);
      resolve();
    });
  });
  console.log('[Startup] Aplicación lista para tráfico');


  // Trabajos periódicos: después de escuchar, para que nada de esto pueda
  // retrasar la disponibilidad del servicio.
  // Activar pedidos programados cada 5 minutos
  activarPedidosProgramados();
  setInterval(activarPedidosProgramados, 5 * 60 * 1000);

  // Red de seguridad de los pagos: recoge las emisiones que un crash dejo a
  // medias entre "el dinero esta confirmado" y "la comanda salio". Sin esto un
  // pedido pagado podia quedarse sin papel para siempre, porque su estado ya
  // no era pendiente_pago y nadie lo reintentaba.
  reconciliarEmisionesPendientes().catch(e =>
    console.error('[Pagos] Reconciliacion inicial de emisiones fallo:', e.message));

  // Reconciliacion de Mercado Pago: recupera cobros cuyo webhook se perdio o
  // cuya reconsulta fallo. Sin esto, "se dependera de la reconciliacion" era
  // una promesa sin respaldo -- el reconciliador existente es solo de Clip.
  setInterval(() => {
    reconciliarPagosMercadoPago().catch(e =>
      console.error('[Pagos] Reconciliacion MP fallo:', e.message));
  }, 3 * 60 * 1000);

  // Deudas de derivacion: pagos con el dinero ya asentado cuyo pedido no se
  // libero porque el proceso murio en esa ventana. Se corre al arrancar --
  // arrancar ES el momento en que puede haber quedado una -- y despues cada
  // minuto, que es barato: el indice parcial no ve nada cuando no hay deuda.
  reconciliarDerivacionesPendientes().catch(e =>
    console.error('[Pagos] Recuperacion inicial de derivaciones fallo:', e.message));

  // Candidatos de Clip pendientes de verificar: el aviso llegó, el id quedó
  // guardado y la verificación no llegó a completarse. Al arrancar y cada
  // minuto, porque ahí puede haber dinero real esperando.
  reconciliarCandidatosClip().catch(e =>
    console.error('[Pagos] Recuperacion inicial de candidatos Clip fallo:', e.message));
  setInterval(() => {
    reconciliarCandidatosClip().catch(e =>
      console.error('[Pagos] Recuperacion de candidatos Clip fallo:', e.message));
  }, 60 * 1000);

  // Expiracion de esperas de pago. El intervalo solo dispara; la exclusividad
  // esta en la base, asi que varias instancias pueden correrlo a la vez.
  expirarPagosVencidos().catch(e =>
    console.error('[Pagos] Expiracion inicial fallo:', e.message));
  setInterval(() => {
    expirarPagosVencidos().catch(e =>
      console.error('[Pagos] Expiracion fallo:', e.message));
  }, 60 * 1000);
  setInterval(() => {
    reconciliarDerivacionesPendientes().catch(e =>
      console.error('[Pagos] Recuperacion de derivaciones fallo:', e.message));
  }, 60 * 1000);
  setInterval(() => {
    reconciliarEmisionesPendientes().catch(e =>
      console.error('[Pagos] Reconciliacion de emisiones fallo:', e.message));
  }, 60 * 1000);

  // P0-11: deuda durable de emision OPERACIONAL (nunca depende de memoria).
  // Recoge lo que un crash dejo a medias entre "el pedido existe" y "la
  // comanda salio", para CUALQUIER pedido operacional -- pagado en linea o
  // no. Al arrancar (arrancar ES el momento en que puede haber quedado una)
  // y cada 45s despues: la exclusividad la da el advisory lock en DB, asi
  // que varias instancias pueden correrlo a la vez sin duplicar efectos.
  reconciliarEmisionesOperacionalesPendientes().catch(e =>
    console.error('[Emision] Reconciliacion inicial de emision operacional fallo:', e.message));
  setInterval(() => {
    reconciliarEmisionesOperacionalesPendientes().catch(e =>
      console.error('[Emision] Reconciliacion de emision operacional fallo:', e.message));
  }, 45 * 1000);

  // Sincronizar horario de Rappi al arrancar y cada 5 minutos
  sincronizarRappi();
  setInterval(sincronizarRappi, 5 * 60 * 1000);
  // Reconciliar pagos Clip pendientes al arrancar y cada 5 minutos
  reconciliarPagosPendientes();
  // Intervalo del reconciliador de pagos: 5 min en produccion, SIEMPRE.
  // El override por variable es EXCLUSIVO de pruebas (candado NODE_ENV):
  // permite demostrar que un webhook perdido HORAS despues del arranque se
  // recupera en un ciclo normal, sin reiniciar nada (CLIP-G).
  const intervaloPagosMs = (process.env.NODE_ENV !== 'production'
      && Number(process.env.XABOR_PAGOS_RECONCILIACION_INTERVALO_MS) > 0)
    ? Number(process.env.XABOR_PAGOS_RECONCILIACION_INTERVALO_MS)
    : 5 * 60 * 1000;
  setInterval(reconciliarPagosPendientes, intervaloPagosMs);
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
}

arrancar().catch(e => {
  // Sin estado inicial completo no se acepta tráfico: nunca se sirve un
  // servicio "sano" que perdería o duplicaría pedidos. Solo el mensaje del
  // error, jamás credenciales ni la URL de conexión.
  console.error('[Startup] ERROR durante el arranque — la aplicación no acepta tráfico:', e.message);
  process.exit(1);
});
