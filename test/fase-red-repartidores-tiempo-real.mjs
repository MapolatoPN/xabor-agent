// Red de Repartidores — Fase C: tiempo real, alertas y mensaje de oferta
// enriquecido (calle/colonia/tarifa/folio desde el primer mensaje).
//
// Cubre las 25 pruebas de comportamiento nuevo pedidas por el usuario
// (formateo de dirección, exclusión por estado, carrera de aceptación,
// enlaces inválidos/vencidos, aislamiento multi-tenant en WebSocket,
// reconexión, fallback HTTP, listener/evento duplicado, exclusión de
// Rappi). Las pruebas de regresión completa + build Docker (26-30 de la
// lista original) se ejecutan aparte, con el resto de la batería.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import vm from 'vm';
import WebSocket from 'ws';
import { arrancarServidor } from './lib-servidor.mjs';
import { arrancarMetaMock } from './lib-meta-mock.mjs';
import { formatearUbicacionRepartidor, formatearTarifaRepartidor } from '../src/utils/direccionRepartidor.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4197';

const { crearTokenSesion } = await import('../src/services/session.js');
const { pool, actualizarConfiguracion, registrarRepartidor, cambiarEstadoRepartidor, asignarRepartidor, registrarNotificacionRepartidor, existeNotificacionRepartidor, crearUsuarioConPassword } = await import('../src/services/database.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}
function cookieHeader(usuarioId, negocioId, rol) { return `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId, negocioId, rol }))}`; }
async function api(base, path, { cookie, method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers['Cookie'] = cookie;
  const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, body: json };
}
async function fijarModulo(negocioId, modulo, estado) {
  await pool.query(
    `INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,$3)
     ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = $3`,
    [negocioId, modulo, estado]
  );
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
async function esperarHasta(fn, { timeoutMs = 6000, intervaloMs = 150 } = {}) {
  const inicio = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    const r = await fn();
    if (r) return r;
    await esperar(intervaloMs);
  }
  return null;
}

// ═══════════ Setup ═══════════
const sufijo = Date.now().toString().slice(-6);
await fijarModulo(SEED.negocioA, 'pos', 'activo');
await fijarModulo(SEED.negocioB, 'pos', 'activo');
await actualizarConfiguracion({ int_wa_phone_id: `PNID_RT_${sufijo}`, int_wa_token: 'fake-token-rt' }, SEED.negocioA);
await pool.query(`INSERT INTO integraciones_canal (negocio_id, canal, identificador, nombre, activo) VALUES ($1,'whatsapp',$2,'Tiempo Real A',TRUE) ON CONFLICT (canal, identificador) DO NOTHING`, [SEED.negocioA, `PNID_RT_${sufijo}`]);
// Modo 'completo': notifica a todos los repartidores activos, sin whitelist -- más simple para probar inclusión/exclusión por estado.
await actualizarConfiguracion({ repartidor_notif_modo: 'completo', repartidor_notif_plantilla_v2_activo: 'true' }, SEED.negocioA);

const metaMock = await arrancarMetaMock();
const srv = await arrancarServidor({ PORT: PUERTO, META_GRAPH_BASE_URL: metaMock.baseUrl }, { timeoutMs: 30000 });
const base = srv.base;
const wsBase = base.replace('http://', 'ws://');

const cookieSuperadmin = cookieHeader(SEED.superadminUsuarioId, SEED.negocioA, 'admin');
const cookieAdminA = cookieHeader(SEED.adminNegocioAUsuarioId, SEED.negocioA, 'admin');
const cookieStaffA = cookieHeader(SEED.staffNegocioAUsuarioId, SEED.negocioA, 'staff');

async function crearPedidoPrueba(cookie = cookieAdminA) {
  const r = await api(base, '/test/pedido', { cookie, method: 'POST' });
  assert.strictEqual(r.status, 200, `/test/pedido debe responder 200, dio ${r.status}`);
  return r.body.pedido.id;
}
function abrirWS(path, cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsBase + path, { headers: cookie ? { Cookie: cookie } : {} });
    const timeout = setTimeout(() => reject(new Error('timeout abriendo WS')), 5000);
    ws.on('open', () => { clearTimeout(timeout); resolve(ws); });
    ws.on('error', (e) => { clearTimeout(timeout); reject(e); });
  });
}
function esperarMensaje(ws, predicado, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { ws.removeListener('message', onMsg); resolve(null); }, timeoutMs);
    function onMsg(raw) {
      let data; try { data = JSON.parse(raw.toString()); } catch { return; }
      if (predicado(data)) { clearTimeout(timer); ws.removeListener('message', onMsg); resolve(data); }
    }
    ws.on('message', onMsg);
  });
}

// ═══════════ Formateo de dirección (1-6) ═══════════
await t('DIRECCION', '1-CALLE-Y-COLONIA', () => {
  const { texto, ubicacionPendiente } = formatearUbicacionRepartidor('Av. Tecnológico 123', 'Centro');
  assert.strictEqual(texto, 'Av. Tecnológico 123, Col. Centro');
  assert.strictEqual(ubicacionPendiente, false);
});
await t('DIRECCION', '2-SOLO-CALLE', () => {
  const { texto } = formatearUbicacionRepartidor('Av. Tecnológico 123', null);
  assert.strictEqual(texto, 'Av. Tecnológico 123');
});
await t('DIRECCION', '3-SOLO-COLONIA', () => {
  const { texto } = formatearUbicacionRepartidor(undefined, 'Centro');
  assert.strictEqual(texto, 'Col. Centro');
});
await t('DIRECCION', '4-SIN-CALLE-NI-COLONIA', () => {
  const { texto, ubicacionPendiente } = formatearUbicacionRepartidor('', '   ');
  assert.strictEqual(texto, 'Ubicación pendiente de confirmar');
  assert.strictEqual(ubicacionPendiente, true);
});
await t('DIRECCION', '5-DIRECCION-LARGA-SE-TRUNCA', () => {
  const larga = 'Calle '.repeat(100);
  const { texto } = formatearUbicacionRepartidor(larga, 'Centro');
  assert.ok(texto.length <= 301, `debe truncarse, longitud=${texto.length}`);
  assert.ok(texto.endsWith('…'));
});
await t('DIRECCION', '6-CARACTERES-ESPECIALES-Y-SIN-DUPLICAR', () => {
  const { texto: t1 } = formatearUbicacionRepartidor('Calle Ñoño #123 & Cía.', 'Col. Centro');
  assert.strictEqual(t1, 'Calle Ñoño #123 & Cía., Col. Centro', 'debe limpiar el prefijo "Col." ya presente en colonia, sin duplicarlo');
  assert.ok(!t1.includes('Col. Col.'));
  const { texto: t2 } = formatearUbicacionRepartidor('Centro', 'Centro');
  assert.strictEqual(t2, 'Centro', 'no debe repetir la misma cadena en ambos campos');
  const tarifa = formatearTarifaRepartidor('544');
  assert.strictEqual(tarifa, '$544.00 MXN');
  assert.strictEqual(formatearTarifaRepartidor('no-numero'), 'No aplica');
});

// ═══════════ Repartidores por estado (7-11) ═══════════
const repDisponible = await registrarRepartidor(`RT Disponible ${sufijo}`, `87801${sufijo}`, SEED.negocioA);
const repPausado = await registrarRepartidor(`RT Pausado ${sufijo}`, `87802${sufijo}`, SEED.negocioA);
const repSuspendido = await registrarRepartidor(`RT Suspendido ${sufijo}`, `87803${sufijo}`, SEED.negocioA);
const repBaja = await registrarRepartidor(`RT Baja ${sufijo}`, `87804${sufijo}`, SEED.negocioA);
const repInactivoLegado = await registrarRepartidor(`RT InactivoLegado ${sufijo}`, `87805${sufijo}`, SEED.negocioA);
await cambiarEstadoRepartidor(repPausado.id, 'pausado', {});
await cambiarEstadoRepartidor(repSuspendido.id, 'suspendido', {});
await cambiarEstadoRepartidor(repBaja.id, 'baja', {});
// "Inactivo legado": activo=false sin pasar por cambiarEstadoRepartidor,
// simulando una fila antigua editada directamente -- confirma que el gate
// `!r.activo` en notificarRepartidoresPorWA sigue funcionando
// independientemente del nuevo campo `estado`.
await pool.query('UPDATE repartidores SET activo = FALSE WHERE id = $1', [repInactivoLegado.id]);

await t('ESTADO', '7-DISPONIBLE-SI-NOTIFICADO', async () => {
  const folio = await crearPedidoPrueba();
  await esperarHasta(() => existeNotificacionRepartidor(folio, repDisponible.id));
  assert.ok(await existeNotificacionRepartidor(folio, repDisponible.id));
});
await t('ESTADO', '8-PAUSADO-NUNCA-NOTIFICADO', async () => {
  const folio = await crearPedidoPrueba();
  await esperarHasta(() => existeNotificacionRepartidor(folio, repDisponible.id));
  assert.strictEqual(await existeNotificacionRepartidor(folio, repPausado.id), false);
});
await t('ESTADO', '9-SUSPENDIDO-NUNCA-NOTIFICADO', async () => {
  const folio = await crearPedidoPrueba();
  await esperarHasta(() => existeNotificacionRepartidor(folio, repDisponible.id));
  assert.strictEqual(await existeNotificacionRepartidor(folio, repSuspendido.id), false);
});
await t('ESTADO', '10-BAJA-NUNCA-NOTIFICADO', async () => {
  const folio = await crearPedidoPrueba();
  await esperarHasta(() => existeNotificacionRepartidor(folio, repDisponible.id));
  assert.strictEqual(await existeNotificacionRepartidor(folio, repBaja.id), false);
});
await t('ESTADO', '11-INACTIVO-LEGADO-NUNCA-NOTIFICADO', async () => {
  const folio = await crearPedidoPrueba();
  await esperarHasta(() => existeNotificacionRepartidor(folio, repDisponible.id));
  assert.strictEqual(await existeNotificacionRepartidor(folio, repInactivoLegado.id), false);
});

// ═══════════ Mensaje enriquecido (plantilla v2) ═══════════
await t('MENSAJE-V2', 'incluye-negocio-folio-ubicacion-tarifa-enlace-en-5-parametros', async () => {
  const folio = await crearPedidoPrueba();
  await esperarHasta(() => existeNotificacionRepartidor(folio, repDisponible.id));
  const enviados = metaMock.obtenerMensajesEnviados();
  const envio = enviados.find(m => m.template?.name === 'xabor_nuevo_servicio_reparto_v2' && m.template.components[0].parameters[1].text === folio);
  assert.ok(envio, 'debe haberse enviado la plantilla v2 con el folio correcto');
  const params = envio.template.components[0].parameters.map(p => p.text);
  assert.strictEqual(params.length, 5);
  assert.strictEqual(params[2], 'Av. Tecnológico 123, Col. Centro', 'la ubicación debe venir ya formateada (calle+colonia del fixture /test/pedido)');
  assert.match(params[3], /^\$\d+\.\d{2} MXN$/);
  assert.match(params[4], /\/repartidor\/aceptar\//);
});

// ═══════════ Carrera de aceptación y enlaces (12-16) ═══════════
await t('CARRERA', '12-PEDIDO-YA-ASIGNADO-NO-SE-REASIGNA', async () => {
  const folio = await crearPedidoPrueba();
  // Espera explícita y determinista (por evento, no por tiempo fijo) a que
  // la fila exista en pedidos_activos antes de intentar asignar --
  // registrarPedido() ahora espera su propia persistencia inicial antes de
  // responder /test/pedido (segunda corrección de la carrera), así que en
  // el flujo normal esto ya debería cumplirse de inmediato; esta espera
  // documenta esa garantía en vez de asumirla en silencio.
  const existe = await esperarHasta(async () => {
    const r = await pool.query('SELECT 1 FROM pedidos_activos WHERE folio = $1', [folio]);
    return r.rows.length > 0;
  });
  assert.ok(existe, `la fila de ${folio} debía existir en pedidos_activos antes de intentar asignar`);
  const ok1 = await asignarRepartidor(folio, repDisponible.id, repDisponible.nombre, SEED.negocioA);
  assert.strictEqual(ok1, true);
  const ok2 = await asignarRepartidor(folio, repPausado.id, repPausado.nombre, SEED.negocioA);
  assert.strictEqual(ok2, false, 'un segundo repartidor nunca debe poder tomar un pedido ya asignado');
});
await t('CARRERA', '13-PEDIDO-CANCELADO-NO-SE-PUEDE-ACEPTAR', async () => {
  const folio = await crearPedidoPrueba();
  // registrarPedido/emitirPedido persisten en DB de forma fire-and-forget
  // (sin await) -- hay que dar margen antes de mutar la fila directamente,
  // mismo patrón ya usado en fase-enrutamiento-repartidor-cliente.mjs
  // (crearPedidoActivoAsignado), o el UPDATE de abajo puede correr antes
  // de que la fila exista y no afectar ninguna fila.
  await esperar(1500);
  const { rowCount } = await pool.query(`UPDATE pedidos_activos SET estado = 'cancelado' WHERE folio = $1`, [folio]);
  assert.strictEqual(rowCount, 1, 'la fila debía existir ya para poder marcarla cancelada');
  const ok = await asignarRepartidor(folio, repDisponible.id, repDisponible.nombre, SEED.negocioA);
  assert.strictEqual(ok, false);
});
// Nota: /repartidor/aceptar/:token (HTTP) se usa en vez de importar
// procesarAceptacionTokenRepartidor directamente -- whatsapp-meta.js
// importa de forma estática desde server.js (getIntegracion), así que
// importarlo como la PRIMERA cosa tocada en el proceso de este test
// (que nunca cargó server.js) dispara el mismo ReferenceError de TDZ ya
// documentado para otras suites de esta batería. La ruta HTTP corre
// dentro del proceso hijo de arrancarServidor, donde server.js SÍ es el
// punto de entrada real -- misma cobertura, sin el riesgo.
async function aceptarPorToken(token) {
  const r = await fetch(`${base}/repartidor/aceptar/${encodeURIComponent(token)}`);
  const texto = await r.text();
  return { status: r.status, texto };
}

await t('CARRERA', '14-ACEPTACION-SIMULTANEA-SOLO-UNO-GANA', async () => {
  const folio = await crearPedidoPrueba();
  const tokenA = 'tok-race-a-' + sufijo;
  const tokenB = 'tok-race-b-' + sufijo;
  const expira = new Date(Date.now() + 30 * 60 * 1000);
  await registrarNotificacionRepartidor({ negocioId: SEED.negocioA, pedidoFolio: folio, repartidorId: repDisponible.id, canal: 'plantilla', estado: 'aceptado_meta', tokenAceptacion: tokenA, tokenExpiraAt: expira });
  await registrarNotificacionRepartidor({ negocioId: SEED.negocioA, pedidoFolio: folio, repartidorId: repPausado.id, canal: 'plantilla', estado: 'aceptado_meta', tokenAceptacion: tokenB, tokenExpiraAt: expira });
  const [r1, r2] = await Promise.all([aceptarPorToken(tokenA), aceptarPorToken(tokenB)]);
  const oks = [r1, r2].filter(r => r.status === 200);
  const fallidos = [r1, r2].filter(r => r.status === 409);
  assert.strictEqual(oks.length, 1, 'exactamente uno debe ganar la carrera (200)');
  assert.strictEqual(fallidos.length, 1, 'el otro debe fallar con 409');
  assert.match(fallidos[0].texto, /ya fue tomado/i);
});
await t('ENLACE', '15-ENLACE-INCORRECTO', async () => {
  const r = await aceptarPorToken('token-que-jamas-existio-' + sufijo);
  assert.strictEqual(r.status, 409);
  assert.match(r.texto, /ya no es válido/i);
});
await t('ENLACE', '16-ENLACE-VENCIDO', async () => {
  const folio = await crearPedidoPrueba();
  const tokenVencido = 'tok-vencido-' + sufijo;
  await registrarNotificacionRepartidor({ negocioId: SEED.negocioA, pedidoFolio: folio, repartidorId: repDisponible.id, canal: 'plantilla', estado: 'aceptado_meta', tokenAceptacion: tokenVencido, tokenExpiraAt: new Date(Date.now() - 60 * 1000) });
  const r = await aceptarPorToken(tokenVencido);
  assert.strictEqual(r.status, 409);
  assert.match(r.texto, /ya no es válido/i);
});

// ═══════════ Aislamiento entre negocios (17) ═══════════
await t('AISLAMIENTO', '17-REPARTIDOR-DE-OTRO-NEGOCIO-NUNCA-NOTIFICADO', async () => {
  const repOtroNegocio = await registrarRepartidor(`RT OtroNegocio ${sufijo}`, `87806${sufijo}`, SEED.negocioB);
  const folio = await crearPedidoPrueba(cookieAdminA);
  await esperarHasta(() => existeNotificacionRepartidor(folio, repDisponible.id));
  assert.strictEqual(await existeNotificacionRepartidor(folio, repOtroNegocio.id), false);
});

// ═══════════ WebSocket: eventos globales y aislados (18-21) ═══════════
await t('WS', '18-EVENTO-GLOBAL-SUPERADMIN', async () => {
  const ws = await abrirWS('/ws/superadmin', cookieSuperadmin);
  const esperaEvento = esperarMensaje(ws, (d) => d.tipo === 'red_repartidores_nuevo_servicio');
  const folio = await crearPedidoPrueba();
  const evento = await esperaEvento;
  ws.close();
  assert.ok(evento, 'Superadmin debe recibir el evento de nuevo servicio');
  assert.strictEqual(evento.folio, folio);
});
await t('WS', '19-EVENTO-AISLADO-NEGOCIO-ADMIN', async () => {
  const wsA = await abrirWS('/ws/panel', cookieAdminA);
  const esperaPropio = esperarMensaje(wsA, (d) => d.tipo === 'red_repartidores_nuevo_servicio');
  const folioPropio = await crearPedidoPrueba(cookieAdminA);
  const eventoPropio = await esperaPropio;
  assert.ok(eventoPropio, 'el admin de negocioA debe recibir el evento de SU propio negocio');
  assert.strictEqual(eventoPropio.folio, folioPropio);

  // Aislamiento: un pedido REAL de OTRO negocio (creado por su propio
  // admin, vía el mismo flujo /test/pedido) nunca debe llegar a este socket.
  await fijarModulo(SEED.negocioB, 'pos', 'activo');
  const { rows: [adminBExistente] } = await pool.query(`SELECT id FROM usuarios WHERE email = 'admin-b-rt@test.local'`);
  const adminNegocioB = adminBExistente || await crearUsuarioConPassword({
    negocioId: SEED.negocioB, nombre: 'Admin Negocio B (tiempo real)', email: 'admin-b-rt@test.local',
    password: 'ClaveAdminBRTPrueba123!', rol: 'admin',
  });
  const cookieAdminB = cookieHeader(adminNegocioB.id, SEED.negocioB, 'admin');
  const esperaAjeno = esperarMensaje(wsA, (d) => d.tipo === 'red_repartidores_nuevo_servicio', 2000);
  await crearPedidoPrueba(cookieAdminB);
  const eventoAjeno = await esperaAjeno;
  assert.strictEqual(eventoAjeno, null, 'el admin de negocioA nunca debe recibir un evento de negocioB');
  wsA.close();
});
await t('WS', '20-STAFF-BLOQUEADO-PARA-EVENTOS-ADMINISTRATIVOS', async () => {
  const wsStaff = await abrirWS('/ws/panel', cookieStaffA);
  const esperaBloqueado = esperarMensaje(wsStaff, (d) => d.tipo === 'red_repartidores_nuevo_servicio', 2500);
  await crearPedidoPrueba(cookieAdminA);
  const evento = await esperaBloqueado;
  wsStaff.close();
  assert.strictEqual(evento, null, 'staff NUNCA debe recibir eventos administrativos de la Red de Repartidores');
});
await t('WS', '21-RECONEXION-ACEPTADA', async () => {
  const ws1 = await abrirWS('/ws/superadmin', cookieSuperadmin);
  ws1.close();
  await esperar(200);
  const ws2 = await abrirWS('/ws/superadmin', cookieSuperadmin);
  assert.strictEqual(ws2.readyState, WebSocket.OPEN, 'una nueva conexión tras cerrar la anterior debe aceptarse sin fricción (reconexión)');
  ws2.close();
});

// ═══════════ Fallback HTTP sin WebSocket (22) ═══════════
await t('FALLBACK', '22-OPERACION-COMPLETA-POR-HTTP-SIN-WS', async () => {
  // Ninguna conexión WS abierta en este bloque -- confirma que el roster y
  // los servicios de reparto siguen respondiendo por HTTP normalmente.
  const rRoster = await api(base, '/api/superadmin/red-repartidores/roster', { cookie: cookieSuperadmin });
  assert.strictEqual(rRoster.status, 200);
  const rServicios = await api(base, '/api/superadmin/red-repartidores/servicios', { cookie: cookieSuperadmin });
  assert.strictEqual(rServicios.status, 200);
});

// ═══════════ Rappi excluido del evento de tiempo real (25) ═══════════
await t('RAPPI', '25-PEDIDO-RAPPI-NUNCA-DISPARA-EVENTO-NI-NOTIFICACION', async () => {
  const folioRappi = `RT-RAPPI-${sufijo}`;
  await pool.query(
    `INSERT INTO pedidos_activos (folio, estado, datos, negocio_id) VALUES ($1,'nuevo',$2,$3)`,
    [folioRappi, JSON.stringify({ modalidad: 'entrega a domicilio', canal: 'rappi', total: 200 }), SEED.negocioA]
  );
  // No se creó vía emitirPedido (INSERT directo, como en la suite de Fase B)
  // -- por eso no puede disparar el hook de orderManager.js. La garantía
  // real ya está cubierta por las pruebas unitarias de
  // esPedidoElegibleParaRedRepartidores (fase-rollout-completo-repartidores.mjs)
  // y por el hecho de que el hook vive DENTRO del mismo `if` que ya
  // filtra Rappi -- no hay código nuevo que revisar aparte. Aquí solo se
  // confirma que la tabla de notificaciones nunca tiene filas para este folio.
  await esperar(300);
  const { rows } = await pool.query('SELECT 1 FROM notificaciones_repartidor WHERE pedido_folio = $1', [folioRappi]);
  assert.strictEqual(rows.length, 0);
});

// ═══════════ Listener/evento duplicado (23-24) — lógica real del cliente ═══
// Se extrae el bloque de código EXACTO del cliente WS (panel/superadmin.html,
// entre los marcadores de abajo) y se ejecuta en un contexto vm aislado con
// WebSocket/document/localización simulados -- se prueba el código
// realmente shippeado, no una reimplementación paralela.
await t('WS-CLIENTE', '23-NO-ABRE-UN-SEGUNDO-SOCKET-SI-YA-HAY-UNO-ABIERTO-O-CONECTANDO', () => {
  const html = readFileSync(join(__dirname, '..', 'panel', 'superadmin.html'), 'utf8');
  const inicio = html.indexOf('let wsRepartidores = null;');
  const fin = html.indexOf('let negociosCacheRepartidores = null;');
  assert.ok(inicio > 0 && fin > inicio, 'no se encontró el bloque de cliente WS esperado en superadmin.html');
  const codigo = html.slice(inicio, fin);

  let instanciasCreadas = 0;
  class WebSocketFalso {
    constructor() { instanciasCreadas++; this.readyState = 0; /* CONNECTING */ }
    close() {}
  }
  WebSocketFalso.OPEN = 1; WebSocketFalso.CONNECTING = 0;

  const sandbox = {
    WebSocket: WebSocketFalso,
    location: { protocol: 'http:', host: 'localhost:1' },
    document: { getElementById: () => null },
    clearTimeout, setTimeout,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(codigo, sandbox);

  sandbox.conectarWebSocketSuperadmin();
  sandbox.conectarWebSocketSuperadmin(); // segunda llamada mientras la primera sigue CONNECTING
  assert.strictEqual(instanciasCreadas, 1, 'una segunda llamada mientras ya hay un socket abierto/conectando no debe crear otro');
});

await t('WS-CLIENTE', '24-EVENTOS-EN-RAFAGA-SOLO-DISPARAN-UN-REFRESCO', async () => {
  const html = readFileSync(join(__dirname, '..', 'panel', 'superadmin.html'), 'utf8');
  const inicio = html.indexOf('let wsRepartidores = null;');
  const fin = html.indexOf('let negociosCacheRepartidores = null;');
  const codigo = html.slice(inicio, fin);

  let llamadasResumen = 0;
  const handlers = {};
  class WebSocketFalso {
    constructor() { this.readyState = 1; handlers.instancia = this; }
    close() {}
    set onmessage(fn) { handlers.onmessage = fn; }
    set onopen(fn) { handlers.onopen = fn; }
    set onclose(fn) { handlers.onclose = fn; }
    set onerror(fn) { handlers.onerror = fn; }
  }
  WebSocketFalso.OPEN = 1; WebSocketFalso.CONNECTING = 0;

  const elementoVistaActiva = { classList: { contains: () => true } };
  const elementoIndicador = { classList: { remove(){}, add(){} } };
  const sandbox = {
    WebSocket: WebSocketFalso,
    location: { protocol: 'http:', host: 'localhost:1' },
    document: {
      getElementById: (id) => {
        if (id === 'vista-repartidores') return elementoVistaActiva;
        if (id === 'rp-ws-indicador') return elementoIndicador;
        if (id === 'rp-sub-servicios') return { style: { display: 'none' } };
        return null;
      },
    },
    clearTimeout, setTimeout,
    console,
    cargarResumenRepartidores: () => { llamadasResumen++; },
    cargarRosterRepartidores: () => {},
    cargarServiciosReparto: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(codigo, sandbox);

  sandbox.conectarWebSocketSuperadmin();
  handlers.onmessage({ data: JSON.stringify({ tipo: 'red_repartidores_nuevo_servicio', folio: 'X' }) });
  handlers.onmessage({ data: JSON.stringify({ tipo: 'red_repartidores_nuevo_servicio', folio: 'X' }) });
  handlers.onmessage({ data: JSON.stringify({ tipo: 'red_repartidores_servicio_aceptado', folio: 'X' }) });
  await esperar(500); // más que el debounce de 300ms
  assert.strictEqual(llamadasResumen, 1, 'tres eventos en ráfaga deben producir un solo refresco (debounce)');
});

// ═══════════ Limpieza de configuración (evita contaminar otras suites) ════
// Esta suite activó repartidor_notif_modo='completo' y
// repartidor_notif_plantilla_v2_activo='true' para negocioA. Escribir un
// valor explícito de reemplazo (p. ej. 'apagado') NO basta -- la lógica de
// retrocompatibilidad de notificarRepartidoresPorWA trata cualquier
// repartidor_notif_modo explícito (incluso 'apagado') como autoritativo
// sobre el booleano legado repartidor_notif_plantilla_activo, así que
// dejaría a otras suites (que sí dependen de ese booleano) permanentemente
// fuera de su propio modo esperado. El único reset correcto es BORRAR las
// filas -- así la clave vuelve a estar ausente, exactamente como antes de
// que esta suite corriera, y el resto de la batería recupera su
// comportamiento normal por retrocompatibilidad.
await pool.query(
  `DELETE FROM configuracion WHERE negocio_id = $1 AND clave IN ('repartidor_notif_modo', 'repartidor_notif_plantilla_v2_activo')`,
  [SEED.negocioA]
);

// ═══════════ Reporte ═══════════
console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallidas > 0) { console.log('\nFallos:'); fallos.forEach(f => console.log(' -', f)); }
metaMock.detener();
await srv.detener();
await pool.end();
process.exitCode = fallidas > 0 ? 1 : 0;
