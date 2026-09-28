// El upgrade autenticado de /ws/panel y /ws/superadmin no tumba el proceso,
// con el servidor REAL. Mientras la autenticación esperaba a la base, el socket
// TCP crudo no tenía escucha de 'error' y la promesa no tenía catch: un reset
// del cliente, una excepción o una cookie mal codificada terminaban Node
// entero (panel, WhatsApp e impresión de todos los negocios).
//
// La espera se sostiene de forma DETERMINISTA: la prueba bloquea la tabla que
// consulta la autenticación (LOCK TABLE ... ACCESS EXCLUSIVE) y espera a ver la
// consulta del servidor detenida en pg_stat_activity antes de resetear.
//
//   E0  controles: la autorización no cambió (sin cookie 401, panel con sesión
//       abre, admin → Superadmin 403, Superadmin abre, «/» y rutas
//       desconocidas 404) y una cookie mal codificada da 401 por HTTP y por los
//       dos upgrades sin tumbar nada (antes: exit 1, sin credencial).
//   E1  reset TCP mientras /ws/panel espera la consulta de membresía.
//   E2  reset TCP mientras /ws/superadmin espera la consulta de privilegio.
//   E3  fallo inyectado de base en cada autenticación: el error normal falla
//       cerrado (403) y el que escapa de la capa de datos da 503 genérico.
//   E4  el cliente se va antes de que se le escriba 401, 403 o 503: no se
//       escribe sobre el socket cerrado ni se responde dos veces.
//   Después de CADA caso: proceso vivo, /health 200, WhatsApp simulado
//   responde, un panel y un Superadmin válidos abren, sin rechazos ni 'error'
//   sin manejar, ningún upgrade fallido llegó a conectarse.
//   E5  al final: sin fuga de pedidos, sin cookies ni tokens en el log, cero
//       rechazos sin manejar; E6 barreras estáticas.
//
// Uso: DATABASE_URL=<local, sembrada> node test/fase-upgrade-errores.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import net from 'node:net';
import pg from 'pg';
import WebSocket from 'ws';
import { arrancarServidor } from './lib-servidor.mjs';
import { arrancarMetaMock } from './lib-meta-mock.mjs';
import { publicarCartaWhatsapp } from './lib-carta-whatsapp.mjs';

const host = new URL(process.env.DATABASE_URL).hostname;
assert(['localhost', '127.0.0.1', '::1'].includes(host), 'solo corre contra Postgres local');

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT_UPGRADE_ERRORES || '4098';
const A = SEED.negocioA;
const SONDA = join(__dirname, 'lib-sonda-upgrade.mjs');
// Los mismos usuarios de la sonda. Importarla de allí la instalaría en ESTE
// proceso (y haría fallar sus propias consultas), así que se repiten y se
// comprueban.
const USUARIO_FALLA_BASE = '00000000-0000-4000-8000-00000000db01';
const USUARIO_FALLA_ESCAPA = '00000000-0000-4000-8000-00000000db02';
const fuenteSonda = readFileSync(SONDA, 'utf8');
assert.ok(fuenteSonda.includes(`'${USUARIO_FALLA_BASE}'`) && fuenteSonda.includes(`'${USUARIO_FALLA_ESCAPA}'`), 'los usuarios de lib-sonda-upgrade.mjs cambiaron');

const { pool, actualizarConfiguracion } = await import('../src/services/database.js');
const { crearTokenSesion } = await import('../src/services/session.js');
const { validarEstructuraReglas } = await import('../src/agent/prompts.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
async function hasta(cond, ms = 8000) {
  const fin = Date.now() + ms;
  while (Date.now() < fin) { if (await cond()) return true; await esperar(60); }
  return false;
}
const q1 = async (s, p) => (await pool.query(s, p)).rows[0];
const tokenDe = (usuarioId, rol = 'admin') => crearTokenSesion({ usuarioId, negocioId: A, rol });
const cookieDe = (token) => `xabor_sesion=${encodeURIComponent(token)}`;
const TOKENS = {
  admin: tokenDe(SEED.adminNegocioAUsuarioId),
  staff: tokenDe(SEED.staffNegocioAUsuarioId, 'staff'),
  super: tokenDe(SEED.superadminUsuarioId),
  fallaBase: tokenDe(USUARIO_FALLA_BASE),
  fallaEscapa: tokenDe(USUARIO_FALLA_ESCAPA),
};
const CK = Object.fromEntries(Object.entries(TOKENS).map(([k, v]) => [k, cookieDe(v)]));
// Cookie con codificación % inválida y una marca que NUNCA debe llegar al log.
// «%ZZ» no es hex: decodeURIComponent lanza URIError (se comprueba abajo; una
// secuencia como «%E0%A4%Ac…» sí se decodifica y no probaría nada).
const MARCA_COOKIE = 'cookie-secreta-de-prueba-7f3a';
const CK_MAL_CODIFICADA = `xabor_sesion=%ZZ-${MARCA_COOKIE}`;
assert.throws(() => decodeURIComponent(CK_MAL_CODIFICADA.split('=')[1]), URIError, 'la cookie de prueba no está mal codificada');
const sufijo = Math.floor(Math.random() * 1e6).toString().padStart(6, '0');

// ── Modelo contado (JSON y streaming) ──────────────────────────────────────
const llamadasModelo = [];
const modelo = createServer((req, res) => {
  let cuerpo = '';
  req.on('data', (c) => { cuerpo += c; });
  req.on('end', () => {
    let p = {};
    try { p = JSON.parse(cuerpo); } catch { /* sin JSON */ }
    llamadasModelo.push({ ruta: req.url });
    const texto = '¡Hola! Con gusto. ¿Qué te gustaría pedir?';
    const id = `msg_${llamadasModelo.length}`;
    const model = p.model || 'claude-haiku-4-5-20251001';
    if (!p.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model, content: [{ type: 'text', text: texto }],
        stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }));
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const ev = (tipo, data) => res.write(`event: ${tipo}\ndata: ${JSON.stringify({ type: tipo, ...data })}\n\n`);
    ev('message_start', { message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: texto } });
    ev('content_block_stop', { index: 0 });
    ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
    ev('message_stop', {});
    res.end();
  });
});
await new Promise((r) => modelo.listen(0, '127.0.0.1', r));
const MODELO_URL = `http://127.0.0.1:${modelo.address().port}`;

// ── Upgrade crudo por TCP ──────────────────────────────────────────────────
// Devuelve el status, los bytes que llegaron DESPUÉS de las cabeceras (un
// upgrade que se completara mandaría frames) y el socket para resetearlo.
function upgradeCrudo(ruta, { ck, esperaMs = 600, soloAbrir = false } = {}) {
  return new Promise((resolve) => {
    const s = net.connect(Number(PUERTO), '127.0.0.1');
    let datos = Buffer.alloc(0);
    let listo = false;
    const fin = (motivo) => {
      if (listo) return; listo = true;
      clearTimeout(tope);
      const texto = datos.toString('latin1');
      const status = Number((/^HTTP\/1\.1 (\d{3})/.exec(texto) || [])[1]) || null;
      const iCab = texto.indexOf('\r\n\r\n');
      const bytesDespues = iCab >= 0 ? datos.length - (iCab + 4) : 0;
      try { s.destroy(); } catch { /* ya cerrado */ }
      resolve({ status, bytesDespues, motivo });
    };
    const tope = setTimeout(() => fin('tiempo'), 5000);
    s.on('connect', () => {
      s.write(`GET ${ruta} HTTP/1.1\r\nHost: localhost:${PUERTO}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
        + `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n`
        + (ck ? `Cookie: ${ck}\r\n` : '') + '\r\n');
      if (soloAbrir) { clearTimeout(tope); listo = true; resolve({ s }); }
    });
    s.on('data', (d) => {
      datos = Buffer.concat([datos, d]);
      if (/^HTTP\/1\.1 101/.test(datos.toString('latin1'))) setTimeout(() => fin('abierto'), esperaMs);
    });
    s.on('close', () => fin('cerrado'));
    s.on('error', () => fin('error'));
  });
}
function abrirWS(ruta, ck) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PUERTO}${ruta}`, ck ? { headers: { Cookie: ck } } : undefined);
    const tope = setTimeout(() => { resolve({ abierto: false, motivo: 'timeout' }); ws.terminate(); }, 5000);
    ws.on('open', () => { clearTimeout(tope); resolve({ abierto: true, ws }); });
    ws.on('unexpected-response', (req, res) => { clearTimeout(tope); resolve({ abierto: false, status: res.statusCode }); req.destroy(); });
    ws.on('error', (e) => { clearTimeout(tope); resolve({ abierto: false, error: e.message }); });
  });
}

// ── Espera sostenida por un bloqueo de la prueba ───────────────────────────
async function bloquear(tabla) {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query('BEGIN');
  await c.query(`LOCK TABLE ${tabla} IN ACCESS EXCLUSIVE MODE`);
  let suelto = false;
  return {
    soltar: async () => { if (suelto) return; suelto = true; await c.query('COMMIT').catch(() => {}); await c.end().catch(() => {}); },
  };
}
const consultaDetenidaEn = (tabla) => hasta(async () => (await q1(
  `SELECT count(*)::int AS n FROM pg_stat_activity
    WHERE wait_event_type = 'Lock' AND state = 'active' AND query ILIKE $1 AND pid <> pg_backend_pid()`, [`%${tabla}%`])).n > 0, 8000);

// ── Negocio de WhatsApp para el control positivo (webhook firmado) ─────────
const CLIENTE_WA = `5287866${sufijo}`;
const identificador = `upgrade-errores-${randomUUID()}`;
const secreto = 'firma-local-upgrade-errores';
const NEG_WA = (await q1('INSERT INTO negocios (nombre, slug) VALUES ($1,$2) RETURNING id', ['Upgrade Errores', `upgrade-errores-${randomUUID()}`])).id;
const catWa = (await q1(`INSERT INTO menu_categorias (negocio_id,nombre,orden,activa) VALUES ($1,'Cafés',0,TRUE) RETURNING id`, [NEG_WA])).id;
const cafeWa = (await q1(`INSERT INTO menu_productos (negocio_id,categoria_id,nombre,precio,disponible) VALUES ($1,$2,'Café Upgrade',35,TRUE) RETURNING id`, [NEG_WA, catWa])).id;
await publicarCartaWhatsapp(pool, NEG_WA, [cafeWa]);
await pool.query(`INSERT INTO integraciones_canal(negocio_id,canal,identificador,activo) VALUES($1,'whatsapp',$2,TRUE)`, [NEG_WA, identificador]);
await actualizarConfiguracion({ int_wa_phone_id: identificador, int_wa_token: 'token-mock-upgrade', wa_admin_numero: `5287877${sufijo}` }, NEG_WA);
await pool.query('UPDATE negocios SET bot_whatsapp_activo=TRUE WHERE id=$1', [NEG_WA]);
const abiertas = {
  restaurante: 'Upgrade errores', cierres_especiales: [], promociones: [], politicas: [],
  pedidos: { modalidades: ['recoger en tienda'], tiempo_preparacion_minutos: 20, pedido_minimo_entrega: 0, costo_envio: 0, pago_aceptado: ['efectivo'] },
  horarios: Object.fromEntries(['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'].map((d) => [d, { abierto: true, apertura: '00:00', cierre: '24:00' }])),
};
assert.ok(validarEstructuraReglas(abiertas), 'las reglas de atención de prueba no son válidas');
await actualizarConfiguracion({ reglas_atencion: JSON.stringify(abiertas) }, NEG_WA);
const marcaStaffOriginal = (await q1('SELECT sesiones_invalidas_antes FROM usuarios WHERE id = $1', [SEED.staffNegocioAUsuarioId]))?.sesiones_invalidas_antes ?? null;

let srv = null;
let meta = null;
const marca = () => srv.obtenerSalida().length;
const desde = (m) => srv.obtenerSalida().slice(m);
const procesoVivo = () => srv.proc.exitCode === null && srv.proc.signalCode === null;
const SIN_MANEJAR = /UnhandledPromiseRejection|unhandledRejection|Unhandled 'error' event|triggerUncaughtException|ERR_UNHANDLED_REJECTION/;
let conexionesValidas = { panel: 0, superadmin: 0 };
let mensajeWa = 0;

// Lo que se exige después de CADA caso.
async function sano(etiqueta) {
  assert.ok(procesoVivo(), `${etiqueta}: el proceso del servidor TERMINÓ (exit=${srv.proc.exitCode}): ${srv.obtenerSalida().slice(-600)}`);
  const salud = await fetch(`${srv.base}/health`).then((r) => r.status).catch((e) => `sin respuesta (${e.message})`);
  assert.equal(salud, 200, `${etiqueta}: /health ${salud}`);
  const enviadosAntes = meta.obtenerMensajesEnviados().filter((m) => m.to === CLIENTE_WA).length;
  mensajeWa += 1;
  const cuerpo = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
    metadata: { phone_number_id: identificador },
    messages: [{ id: `wamid.upg-${sufijo}-${mensajeWa}`, from: CLIENTE_WA, type: 'text', text: { body: `Hola, ¿qué tienen? (${mensajeWa})` } }],
    contacts: [{ profile: { name: 'Cliente Upgrade' } }] } }] }] });
  const r = await fetch(`${srv.base}/webhook/whatsapp`, { method: 'POST', body: cuerpo, headers: {
    'Content-Type': 'application/json', 'X-Hub-Signature-256': `sha256=${createHmac('sha256', secreto).update(cuerpo).digest('hex')}` } });
  assert.equal(r.status, 200, `${etiqueta}: webhook de WhatsApp ${r.status}`);
  assert.ok(await hasta(() => meta.obtenerMensajesEnviados().filter((m) => m.to === CLIENTE_WA).length > enviadosAntes, 20000),
    `${etiqueta}: WhatsApp simulado no respondió`);
  for (const [ruta, ck, clave] of [['/ws/panel', CK.admin, 'panel'], ['/ws/superadmin', CK.super, 'superadmin']]) {
    const c = await abrirWS(ruta, ck);
    assert.ok(c.abierto, `${etiqueta}: una conexión válida posterior a ${ruta} no abrió (${c.status ?? c.error ?? c.motivo})`);
    conexionesValidas[clave] += 1;
    c.ws.close();
  }
  assert.ok(!SIN_MANEJAR.test(srv.obtenerSalida()), `${etiqueta}: hubo un rechazo o un 'error' sin manejar`);
}
// Un upgrade que NO debía conectarse no dejó conexión: cada «conectado» del log
// corresponde a una conexión válida abierta por la prueba. La línea llega por
// la salida del servidor un instante después de que la prueba ya cerró: se
// espera a las esperadas y se deja asentar antes de exigir igualdad.
async function sinConexionesDeMas(etiqueta) {
  const contar = () => {
    const salida = srv.obtenerSalida();
    return {
      panel: (salida.match(/\[WS\] Panel autenticado conectado/g) || []).length,
      superadmin: (salida.match(/\[WS\] Superadmin conectado/g) || []).length,
    };
  };
  await hasta(() => { const c = contar(); return c.panel >= conexionesValidas.panel && c.superadmin >= conexionesValidas.superadmin; }, 3000);
  await esperar(300);
  assert.deepEqual(contar(), conexionesValidas, `${etiqueta}: se conectó un upgrade que debía fallar`);
}
// Reset TCP mientras la autenticación espera a la base.
async function resetDuranteLaEspera({ ruta, ck, tabla }) {
  const bloqueo = await bloquear(tabla);
  try {
    const m = marca();
    const { s } = await upgradeCrudo(ruta, { ck, soloAbrir: true });
    assert.ok(s, `no se pudo abrir la conexión a ${ruta}: ¿el servidor ya había terminado?`);
    s.on('error', () => {});
    assert.ok(await consultaDetenidaEn(tabla), `la consulta de ${ruta} no quedó esperando el bloqueo de ${tabla}`);
    s.resetAndDestroy();
    // El servidor ve el reset MIENTRAS espera (el socket sigue leyendo): es
    // justo el 'error' que antes no tenía escucha y terminaba el proceso.
    const visto = await hasta(() => desde(m).includes(`[WS] upgrade ${ruta}: el socket falló mientras se autenticaba`) || !procesoVivo(), 3000);
    assert.ok(procesoVivo(), `el reset durante la espera de ${ruta} TERMINÓ el proceso: ${desde(m).slice(-500)}`);
    assert.ok(visto, `el servidor no vio el reset de ${ruta} mientras esperaba a la base`);
    await bloqueo.soltar();
    return m;
  } finally {
    await bloqueo.soltar();
  }
}

try {
  meta = await arrancarMetaMock();
  srv = await arrancarServidor({
    PORT: PUERTO, META_GRAPH_BASE_URL: meta.baseUrl, META_APP_SECRET: secreto,
    ANTHROPIC_BASE_URL: MODELO_URL, ANTHROPIC_API_KEY: 'sk-ant-prueba-local-no-es-real',
    OPENAI_BASE_URL: MODELO_URL, OPENAI_API_KEY: 'sk-prueba-local-no-es-real',
    // La sonda va SOLO al proceso del servidor, detrás de lo que ya hubiera.
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(SONDA).href}`.trim(),
  }, { timeoutMs: 60000, omitir: ['MESERO_AGENTE_MODE', 'MESERO_SHADOW_MODE', 'PEDIDO_SHADOW_MODE'] });
  assert.ok(srv.obtenerSalida().includes('[SONDA-UPGRADE] cargada en el servidor'), 'la sonda no se cargó en el servidor: E3 y E4 no probarían nada');
  const pedidosAntes = (await q1('SELECT count(*)::int AS n FROM pedidos_activos')).n;

  await t('E0 la autorización no cambió y una cookie mal codificada da 401 (HTTP y los dos upgrades) sin tumbar nada', async () => {
    const r = {
      panelSin: await upgradeCrudo('/ws/panel'),
      panelAdmin: await upgradeCrudo('/ws/panel', { ck: CK.admin }),
      superSin: await upgradeCrudo('/ws/superadmin'),
      superAdmin: await upgradeCrudo('/ws/superadmin', { ck: CK.admin }),
      superSuper: await upgradeCrudo('/ws/superadmin', { ck: CK.super }),
      raiz: await upgradeCrudo('/', { ck: CK.admin }),
      otra: await upgradeCrudo('/ws/otra', { ck: CK.super }),
      panelMal: await upgradeCrudo('/ws/panel', { ck: CK_MAL_CODIFICADA }),
      superMal: await upgradeCrudo('/ws/superadmin', { ck: CK_MAL_CODIFICADA }),
    };
    conexionesValidas.panel += 1; conexionesValidas.superadmin += 1; // panelAdmin y superSuper abren
    const ver = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, `${v.status}+${v.bytesDespues}B`]));
    assert.equal(r.panelSin.status, 401, JSON.stringify(ver));
    assert.equal(r.panelAdmin.status, 101, JSON.stringify(ver));
    assert.equal(r.superSin.status, 401, JSON.stringify(ver));
    assert.equal(r.superAdmin.status, 403, JSON.stringify(ver));
    assert.equal(r.superSuper.status, 101, JSON.stringify(ver));
    assert.equal(r.raiz.status, 404, JSON.stringify(ver));
    assert.equal(r.otra.status, 404, JSON.stringify(ver));
    assert.equal(r.panelMal.status, 401, `panel con cookie mal codificada: ${JSON.stringify(ver)}`);
    assert.equal(r.superMal.status, 401, `Superadmin con cookie mal codificada: ${JSON.stringify(ver)}`);
    for (const k of ['panelSin', 'superSin', 'superAdmin', 'raiz', 'otra', 'panelMal', 'superMal']) assert.equal(r[k].bytesDespues, 0, `${k} recibió datos`);
    const http = await fetch(`${srv.base}/api/impresion/self-service`, { headers: { Cookie: CK_MAL_CODIFICADA } })
      .then((x) => x.status).catch((e) => `sin respuesta (${e.message})`);
    assert.equal(http, 401, `HTTP con cookie mal codificada: ${http}`);
    await sano('E0');
    await sinConexionesDeMas('E0');
  });

  await t('E1 reset TCP mientras /ws/panel espera la consulta de membresía: el proceso sigue y nada se conecta', async () => {
    const m = await resetDuranteLaEspera({ ruta: '/ws/panel', ck: CK.admin, tabla: 'usuario_negocios' });
    assert.ok(await hasta(() => desde(m).includes('[WS] upgrade /ws/panel: el cliente se fue antes de completar el upgrade') || !procesoVivo(), 8000)
      && desde(m).includes('[WS] upgrade /ws/panel: el cliente se fue antes de completar el upgrade'),
      `no se registró que el cliente se fue antes del upgrade: ${desde(m).slice(-500)}`);
    await sano('E1');
    await sinConexionesDeMas('E1');
  });

  await t('E2 reset TCP mientras /ws/superadmin espera la consulta de privilegio: el proceso sigue y nada se conecta', async () => {
    const m = await resetDuranteLaEspera({ ruta: '/ws/superadmin', ck: CK.super, tabla: 'administradores_plataforma' });
    assert.ok(await hasta(() => desde(m).includes('[WS] upgrade /ws/superadmin: el cliente se fue antes de completar el upgrade') || !procesoVivo(), 8000)
      && desde(m).includes('[WS] upgrade /ws/superadmin: el cliente se fue antes de completar el upgrade'),
      `no se registró que el cliente se fue antes del upgrade: ${desde(m).slice(-500)}`);
    await sano('E2');
    await sinConexionesDeMas('E2');
  });

  await t('E3 fallo inyectado de base en cada autenticación: el error normal falla cerrado (403); el que escapa, 503 genérico', async () => {
    const casos = [
      ['panel, error de base', '/ws/panel', CK.fallaBase, 403, null],
      ['Superadmin, error de base', '/ws/superadmin', CK.fallaBase, 403, null],
      ['panel, error que escapa', '/ws/panel', CK.fallaEscapa, 503, '[WS] upgrade /ws/panel: error inesperado al autenticar (TypeError); rechazo genérico 503'],
      ['Superadmin, error que escapa', '/ws/superadmin', CK.fallaEscapa, 503, '[WS] upgrade /ws/superadmin: error inesperado al autenticar (TypeError); rechazo genérico 503'],
    ];
    for (const [nombre, ruta, ck, esperado, linea] of casos) {
      const m = marca();
      const r = await upgradeCrudo(ruta, { ck });
      assert.ok(procesoVivo(), `${nombre}: el proceso TERMINÓ: ${desde(m).slice(-500)}`);
      assert.equal(r.status, esperado, `${nombre}: respondió ${r.status} (${r.motivo})`);
      assert.equal(r.bytesDespues, 0, `${nombre}: recibió datos`);
      if (linea) assert.ok(desde(m).includes(linea), `${nombre}: sin «${linea}» en el log: ${desde(m).slice(-400)}`);
      else assert.ok(/\[DB\] Error (obtenerMembresiaUsuarioNegocio|esSuperadmin): falla de base inyectada/.test(desde(m)), `${nombre}: la sonda no inyectó el fallo`);
      await sano(`E3 ${nombre}`);
    }
    await sinConexionesDeMas('E3');
  });

  await t('E4 el cliente se va antes de que se le escriba 401, 403 o 503: no se escribe sobre el socket cerrado y el proceso sigue', async () => {
    // 401 DESPUÉS de consultar: sesión emitida antes de un cambio de contraseña.
    await pool.query(`UPDATE usuarios SET sesiones_invalidas_antes = now() + interval '1 hour' WHERE id = $1`, [SEED.staffNegocioAUsuarioId]);
    try {
      const casos = [
        [401, '/ws/panel', CK.staff, 'usuario_negocios'],
        [403, '/ws/superadmin', CK.admin, 'administradores_plataforma'],
        [503, '/ws/panel', CK.fallaEscapa, 'usuario_negocios'],
      ];
      for (const [status, ruta, ck, tabla] of casos) {
        const m = await resetDuranteLaEspera({ ruta, ck, tabla });
        const linea = `[WS] upgrade ${ruta}: el cliente se fue antes de la respuesta ${status}`;
        assert.ok(await hasta(() => desde(m).includes(linea) || !procesoVivo(), 8000) && desde(m).includes(linea),
          `${status}: no se registró que el cliente se fue antes de la respuesta: ${desde(m).slice(-500)}`);
        assert.ok(!/ERR_STREAM_DESTROYED|ERR_STREAM_WRITE_AFTER_END|EPIPE/.test(desde(m)), `${status}: se intentó escribir sobre el socket cerrado`);
        assert.equal((desde(m).match(new RegExp(`\\[WS\\] upgrade ${ruta.replace(/\//g, '\\/')}: el cliente se fue antes`, 'g')) || []).length, 1, `${status}: se respondió o se cerró dos veces`);
        await sano(`E4 ${status}`);
      }
    } finally {
      await pool.query('UPDATE usuarios SET sesiones_invalidas_antes = $2 WHERE id = $1', [SEED.staffNegocioAUsuarioId, marcaStaffOriginal]);
    }
    await sinConexionesDeMas('E4');
  });

  await t('E5 al final: sin fuga de pedidos, sin cookies ni tokens en el log, ningún rechazo ni error sin manejar', async () => {
    assert.ok(procesoVivo(), 'el proceso terminó');
    assert.equal((await q1('SELECT count(*)::int AS n FROM pedidos_activos')).n, pedidosAntes, 'cambiaron los pedidos');
    const salida = srv.obtenerSalida();
    assert.ok(!salida.includes(MARCA_COOKIE), 'la cookie mal codificada llegó al log');
    for (const [nombre, token] of Object.entries(TOKENS)) assert.ok(!salida.includes(token), `el token ${nombre} llegó al log`);
    assert.ok(!SIN_MANEJAR.test(salida), `hubo un rechazo o un 'error' sin manejar: ${salida.match(/.*(Unhandled|unhandled|triggerUncaught).*/)?.[0]}`);
    await sinConexionesDeMas('E5');
  });
} finally {
  if (srv) {
    const salida = new Promise((ok) => { srv.proc.once('exit', ok); setTimeout(ok, 3000); });
    srv.detener();
    await salida;
  }
  meta?.detener();
  modelo.close();
}

await t('E6 las barreras estáticas del predeploy pasan', async () => {
  await import('../scripts/check-websocket-lista-cerrada.mjs');
  await import('../scripts/check-voz-retirada.mjs');
});

// ── Limpieza ───────────────────────────────────────────────────────────────
const limpiar = async (sql, p) => pool.query(sql, p).catch(() => {});
await limpiar('UPDATE usuarios SET sesiones_invalidas_antes = $2 WHERE id = $1', [SEED.staffNegocioAUsuarioId, marcaStaffOriginal]);
for (const tabla of ['whatsapp_entradas', 'whatsapp_conversaciones', 'conversaciones_control', 'conversacion_estado', 'agente_outbox',
  'agente_turnos', 'agente_operaciones', 'mensajes', 'whatsapp_productos', 'integraciones_canal', 'configuracion', 'menu_productos', 'menu_categorias', 'clientes']) {
  await limpiar(`DELETE FROM ${tabla} WHERE negocio_id=$1`, [NEG_WA]);
}
await limpiar('DELETE FROM negocios WHERE id=$1', [NEG_WA]);

console.log(`RESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallos.length) for (const f of fallos) console.log(`  - ${f}`);
await pool.end();
process.exit(fallidas ? 1 : 0);
