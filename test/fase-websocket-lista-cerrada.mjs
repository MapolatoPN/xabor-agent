// El upgrade WebSocket es una LISTA CERRADA: con el servidor REAL, una
// conexión anónima no puede quedarse con las comandas de nadie.
//
// Antes, toda ruta desconocida caía en la «raíz legado»: sin credencial, se
// asignaba al único negocio con print_agent_legacy_activo = 'true' y reclamaba
// sus comandas pendientes. Aquí se ARMA a propósito ese escenario —un único
// negocio legado, comandas pendientes en su cola, un Edge válido y credenciales
// inválidas— y se exige:
//
//   L1-L3  «/», rutas desconocidas y variantes (mayúsculas, barras, %xx, «..»,
//          voz, forma absoluta), con o sin cookie válida: 404, sin upgrade, sin
//          un solo byte de datos.
//   L4     lo rechazado no reclama ni cambia ninguna comanda, no entrega
//          trabajos, no llama al modelo y no deja pedidos, mensajes, pagos,
//          outbox ni impresión.
//   L5     /ws/print-agent sin credencial válida (nada, basura, token malo,
//          terminal inactiva, terminal inexistente) no recibe nada y se cierra.
//   L6-L8  un Edge válido recibe SOLO lo de su negocio, confirma, no se puede
//          re-autenticar como otro en el mismo socket y no recibe dos veces lo
//          confirmado.
//   L9     /ws/panel y /ws/superadmin conservan su autenticación.
//   L10    controles positivos: WhatsApp y el simulador llegan al modelo.
//   L11    al final la cola legado sigue intacta y las barreras pasan.
//
// Las peticiones de upgrade van CRUDAS por TCP: un cliente WebSocket normal
// normaliza «/ws/../ws/panel» antes de mandarlo y la prueba no probaría nada.
//
// Uso: DATABASE_URL=<local, sembrada> node test/fase-websocket-lista-cerrada.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import net from 'node:net';
import WebSocket from 'ws';
import { arrancarServidor } from './lib-servidor.mjs';
import { arrancarMetaMock } from './lib-meta-mock.mjs';
import { publicarCartaWhatsapp } from './lib-carta-whatsapp.mjs';

const host = new URL(process.env.DATABASE_URL).hostname;
assert(['localhost', '127.0.0.1', '::1'].includes(host), 'solo corre contra Postgres local');

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT_WS_LISTA || '4096';
const A = SEED.negocioA;
const B = SEED.negocioB;

const { pool, obtenerConfiguracion, actualizarConfiguracion } = await import('../src/services/database.js');
const { crearTokenSesion } = await import('../src/services/session.js');
const { validarEstructuraReglas } = await import('../src/agent/prompts.js');
const { crearEdge, generarEmparejamiento, canjearEmparejamiento } = await import('../src/services/edgeService.js');
const { crearImpresora, crearRuta, crearTrabajosDePedido } = await import('../src/services/impresionService.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const q1 = async (s, p) => (await pool.query(s, p)).rows[0];
const cookie = (usuarioId, negocioId, rol) =>
  `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId, negocioId, rol }))}`;
const CK_ADMIN = cookie(SEED.adminNegocioAUsuarioId, A, 'admin');
const CK_STAFF = cookie(SEED.staffNegocioAUsuarioId, A, 'staff');
const CK_SUPER = cookie(SEED.superadminUsuarioId, A, 'admin');
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

// ── Efectos ────────────────────────────────────────────────────────────────
const TABLAS_EFECTO = ['pedidos_activos', 'pedidos', 'pedidos_programados', 'folios_pedido_usados',
  'impresion_trabajos', 'pedido_emisiones', 'pagos', 'mensajes', 'agente_outbox', 'clientes', 'transcripciones_voz'];
async function contarEfectos() {
  const c = {};
  for (const tabla of TABLAS_EFECTO) {
    const r = await q1('SELECT to_regclass($1) IS NULL AS falta', [`public.${tabla}`]);
    c[tabla] = r.falta ? 'sin tabla' : (await q1(`SELECT count(*)::int AS n FROM ${tabla}`)).n;
  }
  return c;
}
const colaLegado = async () => (await pool.query(
  `SELECT print_job_id, estado, entregado_at IS NOT NULL AS entregado FROM impresion_legacy_emitida
    WHERE negocio_id = $1 ORDER BY print_job_id`, [A])).rows;
// Todo lo que la impresora de esa terminal tiene en cola (incluye lo que el
// servidor emite al arrancar para los pedidos sembrados).
const trabajosDe = async (terminalId) => (await pool.query(
  `SELECT id::text, estado, negocio_id::text AS negocio FROM impresion_trabajos WHERE terminal_id = $1 ORDER BY id`,
  [terminalId])).rows;

// ── Upgrade crudo por TCP ──────────────────────────────────────────────────
// Devuelve el status y cuántos bytes llegaron DESPUÉS de las cabeceras (un
// upgrade que abriera y mandara una comanda los tendría).
function upgradeCrudo(ruta, { ck, esperaMs = 700 } = {}) {
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
      resolve({ status, bytesDespues, motivo, cabecera: texto.slice(0, 60) });
    };
    const tope = setTimeout(() => fin('tiempo'), 4000);
    s.on('connect', () => {
      s.write(`GET ${ruta} HTTP/1.1\r\nHost: localhost:${PUERTO}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
        + `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n`
        + (ck ? `Cookie: ${ck}\r\n` : '') + '\r\n');
    });
    s.on('data', (d) => {
      datos = Buffer.concat([datos, d]);
      // Si abrió (101), se queda un momento escuchando: ahí llegarían comandas.
      if (/^HTTP\/1\.1 101/.test(datos.toString('latin1'))) setTimeout(() => fin('abierto'), esperaMs);
    });
    s.on('close', () => fin('cerrado'));
    s.on('error', () => fin('error'));
  });
}

// ── Clientes WebSocket ─────────────────────────────────────────────────────
function abrirWS(ruta, { ck, timeoutMs = 4000 } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PUERTO}${ruta}`, ck ? { headers: { Cookie: ck } } : undefined);
    const tope = setTimeout(() => { resolve({ abierto: false, motivo: 'timeout' }); ws.terminate(); }, timeoutMs);
    ws.on('open', () => { clearTimeout(tope); resolve({ abierto: true, ws }); });
    ws.on('unexpected-response', (req, res) => { clearTimeout(tope); resolve({ abierto: false, status: res.statusCode }); req.destroy(); });
    ws.on('error', (e) => { clearTimeout(tope); resolve({ abierto: false, error: e.message }); });
  });
}
// Un print-agent: manda (o no) su primer mensaje y anota TODO lo que recibe;
// confirma cada trabajo como lo hace edge/connection.js.
function printAgent(primerMensaje, { confirmar = true } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PUERTO}/ws/print-agent`);
    const recibidos = [];
    let cierre = null;
    const cerrado = new Promise((r) => ws.on('close', (code) => { cierre = code; r(code); }));
    ws.on('open', () => { if (primerMensaje !== undefined) ws.send(typeof primerMensaje === 'string' ? primerMensaje : JSON.stringify(primerMensaje)); });
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      recibidos.push(m);
      if (confirmar && m.tipo === 'trabajo_impresion' && m.trabajo?.id) {
        ws.send(JSON.stringify({ tipo: 'ack_impresion', trabajoId: m.trabajo.id, resultado: 'enviado' }));
      }
    });
    ws.on('error', () => {});
    resolve({ ws, recibidos, cerrado, codigo: () => cierre,
      autenticado: () => recibidos.some((m) => m.tipo === 'terminal_autenticada'),
      trabajos: () => recibidos.filter((m) => m.tipo === 'trabajo_impresion').map((m) => m.trabajo.id) });
  });
}
async function hasta(cond, ms = 8000) {
  const fin = Date.now() + ms;
  while (Date.now() < fin) { if (await cond()) return true; await esperar(60); }
  return false;
}
const auth = (cred, extra = {}) => ({ tipo: 'autenticar_terminal', terminalId: cred.terminalId, token: cred.token, instalacionId: `inst-${cred.terminalId.slice(0, 8)}`, ...extra });

// ── Fixture: Edge de A, de B, uno inactivo; comandas pendientes ────────────
async function montarEdge(neg, nombre) {
  await pool.query(`INSERT INTO sucursales (negocio_id, nombre) VALUES ($1,'Principal') ON CONFLICT (negocio_id, nombre) DO UPDATE SET activo = true`, [neg]);
  const edge = await crearEdge(neg, { nombre });
  const { codigo } = await generarEmparejamiento(neg, edge.id);
  const cred = await canjearEmparejamiento(codigo);
  const imp = await crearImpresora(neg, { terminalId: edge.id, nombre: `${nombre} impresora`, transporte: 'mock', anchoColumnas: 42 });
  await crearRuta(neg, { impresoraId: imp.id, ambito: 'documento', clave: 'comanda' });
  return { edge, cred, imp };
}
const pedidoPrueba = (neg, n) => ({ id: `WSL-${n}-${sufijo}`, negocioId: neg, items: [{ nombre: 'Café lista cerrada', cantidad: 1 }], canal: 'test' });

const EDGE_A = await montarEdge(A, `Edge A ${sufijo}`);
const EDGE_B = await montarEdge(B, `Edge B ${sufijo}`);
const inactivo = await crearEdge(A, { nombre: `Edge inactivo ${sufijo}` });
const credInactivo = await canjearEmparejamiento((await generarEmparejamiento(A, inactivo.id)).codigo);
await pool.query('UPDATE terminales SET activo = FALSE WHERE id = $1', [inactivo.id]);
for (const n of [1, 2]) await crearTrabajosDePedido({ negocioId: A, pedido: pedidoPrueba(A, `A${n}`) });
await crearTrabajosDePedido({ negocioId: B, pedido: pedidoPrueba(B, 'B1') });

// Comandas legado pendientes de A, con su pedido si los triggers lo permiten
// (así, un legado restaurado tendría algo que ROBAR, no solo que marcar).
const foliosLegado = [`WSLL1${sufijo}`, `WSLL2${sufijo}`];
let pedidosLegadoSembrados = 0;
for (const folio of foliosLegado) {
  try {
    await pool.query(`INSERT INTO pedidos_activos (folio, negocio_id, estado, datos) VALUES ($1,$2,'nuevo',$3)`,
      [folio, A, JSON.stringify({ id: folio, negocioId: A, items: [{ nombre: 'Comanda legado', cantidad: 1 }], cliente: { nombre: 'Cliente legado' } })]);
    pedidosLegadoSembrados++;
  } catch { /* un trigger lo impide: la cola sola ya delata cualquier reclamo */ }
  await pool.query(`INSERT INTO impresion_legacy_emitida (negocio_id, print_job_id, destinatarios, estado) VALUES ($1,$2,0,'pendiente')`, [A, `${folio}:comanda`]);
}

// Negocio propio para el control de WhatsApp (webhook firmado).
const CLIENTE_WA = `5287866${sufijo}`;
const identificador = `ws-lista-${randomUUID()}`;
const secreto = 'firma-local-ws-lista';
const NEG_WA = (await q1('INSERT INTO negocios (nombre, slug) VALUES ($1,$2) RETURNING id', ['WS Lista', `ws-lista-${randomUUID()}`])).id;
const catWa = (await q1(`INSERT INTO menu_categorias (negocio_id,nombre,orden,activa) VALUES ($1,'Cafés',0,TRUE) RETURNING id`, [NEG_WA])).id;
const cafeWa = (await q1(`INSERT INTO menu_productos (negocio_id,categoria_id,nombre,precio,disponible) VALUES ($1,$2,'Café WS',35,TRUE) RETURNING id`, [NEG_WA, catWa])).id;
await publicarCartaWhatsapp(pool, NEG_WA, [cafeWa]);
await pool.query(`INSERT INTO integraciones_canal(negocio_id,canal,identificador,activo) VALUES($1,'whatsapp',$2,TRUE)`, [NEG_WA, identificador]);
await actualizarConfiguracion({ int_wa_phone_id: identificador, int_wa_token: 'token-mock-ws-lista', wa_admin_numero: `5287877${sufijo}` }, NEG_WA);
await pool.query('UPDATE negocios SET bot_whatsapp_activo=TRUE WHERE id=$1', [NEG_WA]);
// Carta y horario abiertos de A para el simulador (se restaura al final).
const catA = (await q1(`INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,'WS Lista Carta',TRUE,994) RETURNING id`, [A])).id;
const prodA = (await q1(`INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio, disponible, orden) VALUES ($1,$2,'WS Lista Té',30,TRUE,0) RETURNING id`, [A, catA])).id;
await publicarCartaWhatsapp(pool, A, [prodA]);
const reglasOriginalesA = (await obtenerConfiguracion(A)).reglas_atencion ?? null;
let reglasBase = null;
try { reglasBase = reglasOriginalesA ? JSON.parse(reglasOriginalesA) : null; } catch { reglasBase = null; }
const abiertas = validarEstructuraReglas(reglasBase) ? structuredClone(reglasBase) : {
  restaurante: 'WS lista', cierres_especiales: [], promociones: [], politicas: [],
  pedidos: { modalidades: ['recoger en tienda'], tiempo_preparacion_minutos: 20, pedido_minimo_entrega: 0, costo_envio: 0, pago_aceptado: ['efectivo'] },
};
abiertas.horarios = Object.fromEntries(['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'].map((d) => [d, { abierto: true, apertura: '00:00', cierre: '24:00' }]));
abiertas.cierres_especiales = [];
for (const n of [A, NEG_WA]) await actualizarConfiguracion({ reglas_atencion: JSON.stringify(abiertas) }, n);

let srv = null;
let meta = null;
let legadoOriginal = [];
try {
  meta = await arrancarMetaMock();
  srv = await arrancarServidor({
    PORT: PUERTO, META_GRAPH_BASE_URL: meta.baseUrl, META_APP_SECRET: secreto,
    ANTHROPIC_BASE_URL: MODELO_URL, ANTHROPIC_API_KEY: 'sk-ant-prueba-local-no-es-real',
    OPENAI_BASE_URL: MODELO_URL, OPENAI_API_KEY: 'sk-prueba-local-no-es-real',
  }, { timeoutMs: 60000, omitir: ['MESERO_AGENTE_MODE', 'MESERO_SHADOW_MODE', 'PEDIDO_SHADOW_MODE'] });

  // Arma el legado DESPUÉS del arranque (initDB deja a Nonna Maye en modo
  // legado): A queda como el ÚNICO negocio legado, justo lo que la raíz vieja
  // habría aceptado.
  legadoOriginal = (await pool.query(`SELECT negocio_id, valor FROM configuracion WHERE clave = 'print_agent_legacy_activo'`)).rows;
  await pool.query(`DELETE FROM configuracion WHERE clave = 'print_agent_legacy_activo' AND negocio_id <> $1`, [A]);
  await actualizarConfiguracion({ print_agent_legacy_activo: 'true' }, A);
  const armados = (await q1(`SELECT count(*)::int AS n FROM configuracion WHERE clave = 'print_agent_legacy_activo' AND valor = 'true'`)).n;
  assert.equal(armados, 1, 'el escenario exige UN solo negocio legado');

  // Al arrancar, el servidor emite en segundo plano los pedidos sembrados sin
  // emisión (y sus trabajos de Edge aparecen en la cola de A). La foto de
  // «antes» se toma cuando esa cola dejó de moverse, no a mitad.
  let previo = -1;
  const finEspera = Date.now() + 20000;
  while (Date.now() < finEspera) {
    const n = (await trabajosDe(EDGE_A.edge.id)).length;
    if (n === previo && n >= 2 + pedidosLegadoSembrados) break;
    previo = n;
    await esperar(1500);
  }

  const efectosAntes = await contarEfectos();
  const colaAntes = await colaLegado();
  const trabajosAntesA = await trabajosDe(EDGE_A.edge.id);
  const metaAntes = meta.obtenerMensajesEnviados().length;

  const probar = async (rutas, ck) => {
    const malas = [];
    for (const ruta of rutas) {
      const r = await upgradeCrudo(ruta, { ck });
      if (r.status !== 404 || r.bytesDespues !== 0) malas.push(`${ruta}${ck ? ' (con cookie)' : ''} → ${r.status} +${r.bytesDespues}B ${r.motivo}`);
    }
    assert.deepEqual(malas, []);
  };

  await t('L1 «/» responde 404 y no completa el upgrade, con o sin cookie, aunque haya un negocio legado con comandas pendientes', async () => {
    assert.equal(colaAntes.filter((f) => f.estado === 'pendiente').length, 2, 'el escenario no tiene las comandas pendientes');
    for (const ck of [undefined, CK_ADMIN, CK_SUPER]) await probar(['/', '/?x=1'], ck);
  });

  await t('L1b «/» da 404 igual con CERO y con DOS negocios legado (lo que antes decidía la raíz)', async () => {
    await pool.query(`DELETE FROM configuracion WHERE clave = 'print_agent_legacy_activo'`);
    await probar(['/'], CK_ADMIN);
    await actualizarConfiguracion({ print_agent_legacy_activo: 'true' }, A);
    await actualizarConfiguracion({ print_agent_legacy_activo: 'true' }, B);
    await probar(['/'], CK_ADMIN);
    await pool.query(`DELETE FROM configuracion WHERE clave = 'print_agent_legacy_activo' AND negocio_id = $1`, [B]);
    const armados = (await q1(`SELECT count(*)::int AS n FROM configuracion WHERE clave = 'print_agent_legacy_activo' AND valor = 'true'`)).n;
    assert.equal(armados, 1, 'no se restauró el escenario de un solo negocio legado');
  });

  await t('L2 rutas desconocidas (con query o con cookie válida) responden 404', async () => {
    for (const ck of [undefined, CK_ADMIN, CK_STAFF]) await probar(['/cualquier-ruta', '/cualquier-ruta?x=1', '/ws', '/ws/', '/ws/otra'], ck);
  });

  await t('L3 variantes de las rutas permitidas no se normalizan: 404', async () => {
    const variantes = ['//', '/WS/PANEL', '/Ws/Panel', '/ws/panel/', '/ws//panel', '//ws/panel', '/ws/%70anel', '/ws/panel%2F',
      '/ws/../ws/panel', '/ws/panel/..', '/./ws/panel', '/ws/./panel', '/ws/voice', '/ws/voice%3Fx=1', '/ws/voice/abc',
      '/WS/PRINT-AGENT', '/ws/print-agent/', '/ws/print-agent%00', '/ws/superadmin/', '/WS/SUPERADMIN',
      'http://localhost/ws/panel', '/ws/panel;x'];
    for (const ck of [undefined, CK_ADMIN, CK_SUPER]) await probar(variantes, ck);
  });

  await t('L4 lo rechazado no reclamó ni cambió comandas, no entregó trabajos ni llamó al modelo, sin efectos', async () => {
    assert.deepEqual(await colaLegado(), colaAntes, 'la cola legado cambió: algo reclamó comandas');
    assert.deepEqual(await trabajosDe(EDGE_A.edge.id), trabajosAntesA, 'los trabajos de A cambiaron de estado');
    assert.deepEqual(await contarEfectos(), efectosAntes);
    assert.equal(llamadasModelo.length, 0, `el modelo recibió ${llamadasModelo.length} llamadas`);
    assert.equal(meta.obtenerMensajesEnviados().length, metaAntes, 'se mandó algo a WhatsApp');
    const salida = srv.obtenerSalida();
    assert.ok(!/Conexión legado|Legado negocio=/.test(salida), 'el servidor abrió o resolvió una conexión legado');
    assert.ok(!/\[Edge\] trabajo=.*entregado_a=[1-9]/.test(salida), 'se entregó un trabajo a alguien');
  });

  await t('L5 /ws/print-agent sin credencial válida no recibe nada y se cierra', async () => {
    const casos = [
      ['sin mensaje (timeout)', undefined],
      ['basura', 'no-es-json'],
      ['tipo incorrecto', { tipo: 'ack_impresion', trabajoId: trabajosAntesA[0]?.id }],
      ['token incorrecto', auth(EDGE_A.cred, { token: EDGE_A.cred.token.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a')) })],
      ['terminal inactiva', auth(credInactivo)],
      ['terminal inexistente', auth({ terminalId: randomUUID(), token: 'x'.repeat(64) })],
    ];
    const conexiones = await Promise.all(casos.map(([, m]) => printAgent(m)));
    const codigos = await Promise.all(conexiones.map((c) => Promise.race([c.cerrado, esperar(7000).then(() => 'sigue abierto')])));
    const malas = [];
    casos.forEach(([nombre], i) => {
      const c = conexiones[i];
      if (codigos[i] === 'sigue abierto') malas.push(`${nombre}: sigue abierto`);
      if (c.autenticado()) malas.push(`${nombre}: se autenticó`);
      const utiles = c.recibidos.filter((m) => m.tipo !== 'error');
      if (utiles.length) malas.push(`${nombre}: recibió ${utiles.map((m) => m.tipo).join(',')}`);
    });
    assert.deepEqual(malas, []);
    assert.deepEqual(await trabajosDe(EDGE_A.edge.id), trabajosAntesA, 'un print-agent sin credencial movió trabajos');
  });

  let edgeA = null;
  await t('L6 un Edge válido se autentica y recibe EXACTAMENTE los trabajos de su negocio', async () => {
    edgeA = await printAgent(auth(EDGE_A.cred));
    assert.ok(trabajosAntesA.length >= 2, 'la cola de A no tiene los trabajos del escenario');
    assert.ok(await hasta(() => edgeA.trabajos().length >= trabajosAntesA.length), `no llegaron los trabajos: ${JSON.stringify(edgeA.recibidos.map((m) => m.tipo))}`);
    await esperar(500);
    assert.deepEqual(edgeA.trabajos().sort(), trabajosAntesA.map((x) => x.id).sort(),
      `no recibió exactamente los de A: recibió ${JSON.stringify(edgeA.trabajos())}, esperaba ${JSON.stringify(trabajosAntesA)}`);
    assert.ok(trabajosAntesA.every((x) => x.negocio === A), 'la cola de la terminal de A tiene trabajos de otro negocio');
    assert.ok(await hasta(async () => (await trabajosDe(EDGE_A.edge.id)).every((x) => x.estado === 'enviado')), 'los ACK no dejaron los trabajos en enviado');
    assert.ok(!edgeA.recibidos.some((m) => m.tipo === 'nuevo_pedido'), 'recibió comandas legado');
  });

  let edgeB = null;
  await t('L7 el Edge de otro negocio recibe solo lo suyo; un segundo autenticar en el mismo socket no cambia la identidad', async () => {
    edgeB = await printAgent(auth(EDGE_B.cred));
    assert.ok(await hasta(() => edgeB.trabajos().length >= 1), 'el Edge de B no recibió su trabajo');
    const deB = (await trabajosDe(EDGE_B.edge.id)).map((x) => x.id);
    assert.deepEqual(edgeB.trabajos().sort(), deB.sort(), 'el Edge de B recibió algo que no es de B');
    assert.ok(!edgeA.trabajos().some((id) => deB.includes(id)), 'el Edge de A recibió trabajos de B');
    // Queda un trabajo PENDIENTE de B. Si el socket de A pudiera volverse B,
    // el servidor le entregaría ese pendiente al autenticarlo (como a todo Edge
    // que se autentica): no debe llegarle nada.
    await crearTrabajosDePedido({ negocioId: B, pedido: pedidoPrueba(B, 'B2') });
    const nuevosB = (await trabajosDe(EDGE_B.edge.id)).map((x) => x.id).filter((id) => !deB.includes(id));
    assert.equal(nuevosB.length, 1);
    // Precondición: el socket de A sigue vivo (si ya se hubiera cerrado, el
    // intento de reautenticarse no probaría nada).
    assert.equal(edgeA.ws.readyState, WebSocket.OPEN, 'el socket de A ya estaba cerrado antes del intento');
    edgeA.ws.send(JSON.stringify(auth(EDGE_B.cred)));
    await esperar(1200);
    assert.ok(!edgeA.trabajos().includes(nuevosB[0]), 'el socket de A recibió un trabajo de B tras intentar reautenticarse');
    assert.equal(edgeA.recibidos.filter((m) => m.tipo === 'terminal_autenticada').length, 1, 'el socket de A se autenticó dos veces');
  });

  await t('L8 un trabajo confirmado no se entrega dos veces al reconectar', async () => {
    const yaConfirmados = edgeA.trabajos();
    edgeA.ws.close();
    const otra = await printAgent(auth(EDGE_A.cred));
    assert.ok(await hasta(() => otra.autenticado()), 'la reconexión no se autenticó');
    await esperar(1000);
    assert.deepEqual(otra.trabajos().filter((id) => yaConfirmados.includes(id)), [], 'reentregó trabajos ya confirmados');
    otra.ws.close();
    edgeB?.ws.close();
  });

  await t('L9 /ws/panel y /ws/superadmin conservan su autenticación', async () => {
    const r = {
      panelSin: await abrirWS('/ws/panel'),
      panelAdmin: await abrirWS('/ws/panel', { ck: CK_ADMIN }),
      superSin: await abrirWS('/ws/superadmin'),
      superAdmin: await abrirWS('/ws/superadmin', { ck: CK_ADMIN }),
      superSuper: await abrirWS('/ws/superadmin', { ck: CK_SUPER }),
    };
    for (const c of Object.values(r)) if (c.abierto) c.ws.close();
    const ver = (c) => JSON.stringify({ abierto: c.abierto, status: c.status, error: c.error, motivo: c.motivo });
    assert.equal(r.panelSin.status, 401, `panel sin sesión: ${ver(r.panelSin)}`);
    assert.ok(r.panelAdmin.abierto, `panel con sesión: ${ver(r.panelAdmin)}`);
    assert.equal(r.superSin.status, 401, `superadmin sin sesión: ${ver(r.superSin)}`);
    assert.equal(r.superAdmin.status, 403, `superadmin con sesión de admin: ${ver(r.superAdmin)}`);
    assert.ok(r.superSuper.abierto, `superadmin con sesión de Superadmin: ${ver(r.superSuper)}`);
  });

  await t('L10 controles positivos: WhatsApp (webhook firmado) y el simulador llegan al modelo', async () => {
    const antes = llamadasModelo.length;
    const cuerpo = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: identificador },
      messages: [{ id: `wsl-${sufijo}`, from: CLIENTE_WA, type: 'text', text: { body: 'Hola, ¿qué tienen?' } }],
      contacts: [{ profile: { name: 'Cliente WS' } }] } }] }] });
    const r = await fetch(`${srv.base}/webhook/whatsapp`, { method: 'POST', body: cuerpo, headers: {
      'Content-Type': 'application/json', 'X-Hub-Signature-256': `sha256=${createHmac('sha256', secreto).update(cuerpo).digest('hex')}` } });
    assert.equal(r.status, 200);
    assert.ok(await hasta(() => meta.obtenerMensajesEnviados().some((m) => m.to === CLIENTE_WA), 20000),
      `el cliente de WhatsApp no recibió respuesta; servidor: ${srv.obtenerSalida().slice(-800)}`);
    const s = await fetch(`${srv.base}/api/admin/bot-simulador/sesion`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: CK_ADMIN }, body: '{}' });
    assert.equal(s.status, 200, `simulador: ${s.status}`);
    const { sessionId } = await s.json();
    const m = await fetch(`${srv.base}/api/admin/bot-simulador/mensaje`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: CK_ADMIN },
      body: JSON.stringify({ sessionId, mensaje: '¿qué me recomiendas para acompañar un té en la tarde?' }) });
    assert.equal(m.status, 200, `simulador mensaje: ${m.status}`);
    assert.ok(llamadasModelo.length > antes + 1, `los controles no llegaron al modelo contado (${llamadasModelo.length - antes})`);
  });

  await t('L11 al final: la cola legado sigue intacta y nadie recibió una comanda legado', async () => {
    assert.deepEqual(await colaLegado(), colaAntes);
    assert.ok(!/Conexión legado|Legado negocio=/.test(srv.obtenerSalida()));
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

await t('L12 las barreras estáticas del predeploy pasan', async () => {
  await import('../scripts/check-websocket-lista-cerrada.mjs');
  await import('../scripts/check-voz-retirada.mjs');
});

// ── Limpieza ───────────────────────────────────────────────────────────────
const limpiar = async (sql, p) => pool.query(sql, p).catch(() => {});
await limpiar(`DELETE FROM configuracion WHERE clave = 'print_agent_legacy_activo'`);
for (const f of legadoOriginal) await limpiar(`INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,'print_agent_legacy_activo',$2) ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = $2`, [f.negocio_id, f.valor]);
await limpiar(`DELETE FROM impresion_legacy_emitida WHERE negocio_id = $1 AND print_job_id = ANY($2)`, [A, foliosLegado.map((f) => `${f}:comanda`)]);
await limpiar(`DELETE FROM pedidos_activos WHERE negocio_id = $1 AND folio = ANY($2)`, [A, foliosLegado]);
for (const neg of [A, B]) {
  await limpiar(`DELETE FROM impresion_trabajos WHERE negocio_id = $1 AND origen_id LIKE $2`, [neg, `WSL-%-${sufijo}`]);
}
for (const tid of [EDGE_A.edge.id, EDGE_B.edge.id]) await limpiar('DELETE FROM impresion_trabajos WHERE terminal_id = $1', [tid]);
for (const tid of [EDGE_A.edge.id, EDGE_B.edge.id, inactivo.id]) {
  await limpiar('DELETE FROM impresion_rutas WHERE impresora_id IN (SELECT id FROM impresoras WHERE terminal_id = $1)', [tid]);
  await limpiar('DELETE FROM impresoras WHERE terminal_id = $1', [tid]);
  await limpiar('DELETE FROM edge_instalaciones WHERE terminal_id = $1', [tid]);
  await limpiar('DELETE FROM terminales WHERE id = $1', [tid]);
}
await actualizarConfiguracion({ reglas_atencion: reglasOriginalesA ?? '' }, A).catch(() => {});
await limpiar('DELETE FROM whatsapp_productos WHERE negocio_id=$1 AND producto_id=$2', [A, prodA]);
await limpiar('DELETE FROM menu_productos WHERE negocio_id=$1 AND id=$2', [A, prodA]);
await limpiar('DELETE FROM menu_categorias WHERE negocio_id=$1 AND id=$2', [A, catA]);
for (const tabla of ['whatsapp_entradas', 'whatsapp_conversaciones', 'conversaciones_control', 'conversacion_estado', 'agente_outbox',
  'agente_turnos', 'agente_operaciones', 'mensajes', 'whatsapp_productos', 'integraciones_canal', 'configuracion', 'menu_productos', 'menu_categorias', 'clientes']) {
  await limpiar(`DELETE FROM ${tabla} WHERE negocio_id=$1`, [NEG_WA]);
}
await limpiar('DELETE FROM negocios WHERE id=$1', [NEG_WA]);

console.log(`\n(pedidos legado sembrados con pedido real: ${pedidosLegadoSembrados}/2)`);
console.log(`RESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallos.length) for (const f of fallos) console.log(`  - ${f}`);
await pool.end();
process.exit(fallidas ? 1 : 0);
