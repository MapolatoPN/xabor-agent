// El canal de voz se retiró: con el servidor REAL, ninguna variante de sus
// rutas existe, y lo rechazado no llega al modelo ni deja efectos.
//
// Decisión del dueño (27-sep-2026): la voz no se usa y se retira por completo,
// sin autenticación de Twilio ni tokens. Por /webhook/voice/start y /ws/voice
// se llegaba sin credencial al modelo, a registrarPedido + emitirPedido
// (comanda), a pagos pendientes, a transcripciones y a sesiones en memoria.
//
//   VR1-VR3  POST /webhook/voice/start y sus variantes → 404, con y sin sesión.
//   VR4      /ws/voice y sus variantes no completan el upgrade (404), con y sin
//            sesión, AUNQUE la raíz legado esté armada.
//   VR5      la raíz «/» tampoco abre, aunque haya un negocio legado armado:
//            desde el 27-sep-2026 el upgrade es una lista cerrada (antes este
//            caso exigía lo contrario: era el control de que la raíz aceptaba).
//   VR6-VR7  lo rechazado: cero llamadas al modelo y cero efectos.
//   VR8-VR9  controles positivos: WhatsApp (webhook firmado) y el simulador
//            administrativo SÍ llegan al modelo contado y contestan.
//   VR10     tras los controles: ni pedidos, folios, comandas, impresión,
//            pagos ni transcripciones.
//   VR11     la barrera estática del predeploy pasa.
//
// Las llamadas al modelo se CUENTAN con un servidor propio que habla como la
// API de Anthropic (JSON y streaming). Meta también es simulado. Nada sale de
// la máquina.
//
// Uso: DATABASE_URL=<local, sembrada> node test/fase-voz-retirada.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { createHmac, randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { arrancarServidor } from './lib-servidor.mjs';
import { arrancarMetaMock } from './lib-meta-mock.mjs';
import { publicarCartaWhatsapp } from './lib-carta-whatsapp.mjs';

const host = new URL(process.env.DATABASE_URL).hostname;
assert(['localhost', '127.0.0.1', '::1'].includes(host), 'solo corre contra Postgres local');

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT_VOZ_RETIRADA || '4095';
const WS_BASE = `ws://localhost:${PUERTO}`;
const NEG_A = SEED.negocioA;

const { pool, obtenerConfiguracion, actualizarConfiguracion } = await import('../src/services/database.js');
const { crearTokenSesion } = await import('../src/services/session.js');
const { validarEstructuraReglas } = await import('../src/agent/prompts.js');

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
const CK_ADMIN = cookie(SEED.adminNegocioAUsuarioId, NEG_A, 'admin');
const CK_STAFF = cookie(SEED.staffNegocioAUsuarioId, NEG_A, 'staff');

// ── Modelo contado ─────────────────────────────────────────────────────────
// Si algo rechazado llegara al modelo, recibiría una orden: la prueba vería
// también el pedido. Los controles positivos la reemplazan por un saludo.
const ORDEN = 'Listo. <ORDEN_CONFIRMADA>' + JSON.stringify({
  items: [{ nombre: 'VOZ Retirada Café', cantidad: 2, precio_unitario: 35 }],
  modalidad: 'recoger en tienda', forma_pago: 'enlace de pago',
  cliente: { nombre: 'Llamada falsa', telefono: '+520000000482' }, total: 70,
}) + '</ORDEN_CONFIRMADA>';
let respuestaModelo = ORDEN;
const llamadasModelo = [];
const modelo = createServer((req, res) => {
  let cuerpo = '';
  req.on('data', (c) => { cuerpo += c; });
  req.on('end', () => {
    let p = {};
    try { p = JSON.parse(cuerpo); } catch { /* sin JSON */ }
    llamadasModelo.push({ ruta: req.url, stream: Boolean(p.stream) });
    const texto = respuestaModelo;
    const id = `msg_contado_${llamadasModelo.length}`;
    const model = p.model || 'claude-haiku-4-5-20251001';
    if (!p.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model,
        content: [{ type: 'text', text: texto }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 } }));
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const ev = (tipo, data) => res.write(`event: ${tipo}\ndata: ${JSON.stringify({ type: tipo, ...data })}\n\n`);
    ev('message_start', { message: { id, type: 'message', role: 'assistant', model, content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
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
  'impresion_trabajos', 'impresion_legacy_emitida', 'pedido_emisiones', 'pagos', 'transcripciones_voz',
  'mensajes', 'agente_outbox', 'clientes'];
// Lo que ni los controles positivos (un saludo) pueden producir.
const TABLAS_SIN_CONTROL = ['pedidos_activos', 'pedidos', 'pedidos_programados', 'folios_pedido_usados',
  'impresion_trabajos', 'impresion_legacy_emitida', 'pedido_emisiones', 'pagos', 'transcripciones_voz'];
async function contarEfectos() {
  const cuenta = {};
  for (const tabla of TABLAS_EFECTO) {
    const r = await q1('SELECT to_regclass($1) IS NULL AS falta', [`public.${tabla}`]);
    cuenta[tabla] = r.falta ? 'sin tabla' : (await q1(`SELECT count(*)::int AS n FROM ${tabla}`)).n;
  }
  return cuenta;
}

// ── Fixture ────────────────────────────────────────────────────────────────
// Negocio propio para WhatsApp, con número de voz mapeado (con el código
// anterior, /start lo habría conectado) y raíz legado ARMADA (con el código
// anterior sin rechazo explícito, /ws/voice habría caído ahí).
const sufijo = Math.floor(Math.random() * 1e6).toString().padStart(6, '0');
const CLIENTE_WA = `5287844${sufijo}`;
const ADMIN_WA = `5287855${sufijo}`;
const NUMERO_VOZ = `+52000${sufijo}`;
const identificador = `voz-retirada-${randomUUID()}`;
const secreto = 'firma-local-voz-retirada';
const NEG = (await q1('INSERT INTO negocios (nombre, slug) VALUES ($1,$2) RETURNING id',
  ['Voz Retirada', `voz-retirada-${randomUUID()}`])).id;
const catNeg = (await q1(`INSERT INTO menu_categorias (negocio_id,nombre,orden,activa) VALUES ($1,'Cafés',0,TRUE) RETURNING id`, [NEG])).id;
const cafe = (await q1(`INSERT INTO menu_productos (negocio_id,categoria_id,nombre,precio,disponible) VALUES ($1,$2,'VOZ Retirada Café',35,TRUE) RETURNING id`, [NEG, catNeg])).id;
await publicarCartaWhatsapp(pool, NEG, [cafe]);
await pool.query(`INSERT INTO integraciones_canal(negocio_id,canal,identificador,activo) VALUES($1,'whatsapp',$2,TRUE)`, [NEG, identificador]);
await pool.query(`INSERT INTO integraciones_canal(negocio_id,canal,identificador,activo) VALUES($1,'voz',$2,TRUE)`, [NEG, NUMERO_VOZ]);
await actualizarConfiguracion({ int_wa_phone_id: identificador, int_wa_token: 'token-mock-voz-retirada', wa_admin_numero: ADMIN_WA }, NEG);
await pool.query('UPDATE negocios SET bot_whatsapp_activo=TRUE WHERE id=$1', [NEG]);
// La raíz legado se arma DESPUÉS del arranque: initDB deja a Nonna Maye en modo
// legado (como en producción) y con dos candidatos el servidor rechazaría todo.

// Carta y horario del negocio A para el simulador (se restauran al final).
const catA = (await q1(`INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,'VOZ Retirada Carta',TRUE,995) RETURNING id`, [NEG_A])).id;
const prodA = (await q1(`INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio, disponible, orden) VALUES ($1,$2,'VOZ Retirada Té',30,TRUE,0) RETURNING id`, [NEG_A, catA])).id;
await publicarCartaWhatsapp(pool, NEG_A, [prodA]);
const reglasOriginalesA = (await obtenerConfiguracion(NEG_A)).reglas_atencion ?? null;
let reglasBase = null;
try { reglasBase = reglasOriginalesA ? JSON.parse(reglasOriginalesA) : null; } catch { reglasBase = null; }
const DIA_ABIERTO = { abierto: true, apertura: '00:00', cierre: '24:00' };
const reglasAbiertas = validarEstructuraReglas(reglasBase) ? structuredClone(reglasBase) : {
  restaurante: 'Voz retirada', cierres_especiales: [], promociones: [], politicas: [],
  pedidos: { modalidades: ['recoger en tienda'], tiempo_preparacion_minutos: 20, pedido_minimo_entrega: 0,
    costo_envio: 0, pago_aceptado: ['efectivo'] },
};
reglasAbiertas.horarios = Object.fromEntries(
  ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'].map((d) => [d, DIA_ABIERTO]));
reglasAbiertas.cierres_especiales = [];
await actualizarConfiguracion({ reglas_atencion: JSON.stringify(reglasAbiertas) }, NEG_A);
await actualizarConfiguracion({ reglas_atencion: JSON.stringify(reglasAbiertas) }, NEG);

// ── Clientes HTTP y WebSocket ──────────────────────────────────────────────
let srv = null;
let meta = null;
async function http(ruta, { method = 'POST', ck, cuerpo, tipo = 'form', cabeceras = {} } = {}) {
  const headers = { ...cabeceras };
  let body;
  if (cuerpo !== undefined && method !== 'GET') {
    if (tipo === 'form') { headers['Content-Type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(cuerpo).toString(); }
    else { headers['Content-Type'] = 'application/json'; body = JSON.stringify(cuerpo); }
  }
  if (ck) headers.Cookie = ck;
  const r = await fetch(srv.base + ruta, { method, headers, body, redirect: 'manual' });
  return { status: r.status, texto: await r.text() };
}
function abrirWS(ruta, { ck, timeoutMs = 4000 } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(WS_BASE + ruta, ck ? { headers: { Cookie: ck } } : undefined);
    const tope = setTimeout(() => { resolve({ abierto: false, motivo: 'timeout' }); ws.terminate(); }, timeoutMs);
    ws.on('open', () => { clearTimeout(tope); resolve({ abierto: true, ws }); });
    ws.on('unexpected-response', (req, res) => { clearTimeout(tope); resolve({ abierto: false, status: res.statusCode }); req.destroy(); });
    ws.on('error', (e) => { clearTimeout(tope); resolve({ abierto: false, error: e.message }); });
  });
}
// Si una ruta llegara a abrir, se intenta lo que hacía Twilio: setup + prompt.
async function atacarWS(ruta, ck) {
  const c = await abrirWS(ruta, { ck });
  if (!c.abierto) return c;
  const callSid = `CA${sufijo}${Date.now()}`;
  c.ws.send(JSON.stringify({ type: 'setup', callSid, from: '+520000000482', to: NUMERO_VOZ }));
  await esperar(150);
  if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify({ type: 'prompt', voicePrompt: 'Quiero dos cafés, confirmo' }));
  await esperar(1500);
  try { c.ws.close(); } catch { /* ya cerrado */ }
  return c;
}
const firmaTwilioFalsa = 'bm8tZXMtdW5hLWZpcm1h';
const cuerpoTwilio = () => ({ CallSid: `CA${sufijo}${Date.now()}`, AccountSid: `AC${'0'.repeat(32)}`,
  From: '+520000000482', To: NUMERO_VOZ, CallStatus: 'ringing', Direction: 'inbound' });
const pareceVoz = (texto) => /<Response|ConversationRelay|<Say|<Hangup/i.test(texto);

try {
  meta = await arrancarMetaMock();
  srv = await arrancarServidor({
    PORT: PUERTO,
    META_GRAPH_BASE_URL: meta.baseUrl,
    META_APP_SECRET: secreto,
    ANTHROPIC_BASE_URL: MODELO_URL,
    ANTHROPIC_API_KEY: 'sk-ant-prueba-local-no-es-real',
    OPENAI_BASE_URL: MODELO_URL,
    OPENAI_API_KEY: 'sk-prueba-local-no-es-real',
    TWILIO_AUTH_TOKEN: 'token-twilio-de-prueba-local',
    PUBLIC_URL: `http://localhost:${PUERTO}`,
  }, { timeoutMs: 60000, omitir: ['MESERO_AGENTE_MODE', 'MESERO_SHADOW_MODE', 'PEDIDO_SHADOW_MODE'] });

  const legados = (await q1(`SELECT count(*)::int AS n FROM configuracion WHERE clave='print_agent_legacy_activo' AND valor='true'`)).n;
  if (legados === 0) await actualizarConfiguracion({ print_agent_legacy_activo: 'true' }, NEG);
  assert.ok(legados <= 1, `hay ${legados} negocios en modo legado: la raíz rechazaría todo y VR4 no probaría nada`);

  const efectosAntes = await contarEfectos();
  const metaAntes = meta.obtenerMensajesEnviados().length;

  await t('VR1 POST /webhook/voice/start (el cuerpo que mandaba Twilio, con firma) responde 404', async () => {
    const r = await http('/webhook/voice/start', { cuerpo: cuerpoTwilio(), cabeceras: { 'X-Twilio-Signature': firmaTwilioFalsa } });
    assert.equal(r.status, 404, `respondió ${r.status}: ${r.texto.slice(0, 160)}`);
    assert.ok(!pareceVoz(r.texto), `respondió TwiML: ${r.texto.slice(0, 160)}`);
  });

  await t('VR2 tampoco existe con sesión de administrador ni de staff', async () => {
    for (const [quien, ck] of [['admin', CK_ADMIN], ['staff', CK_STAFF]]) {
      const r = await http('/webhook/voice/start', { ck, cuerpo: cuerpoTwilio() });
      assert.equal(r.status, 404, `${quien}: respondió ${r.status}`);
      assert.ok(!pareceVoz(r.texto), `${quien}: respondió TwiML`);
    }
  });

  await t('VR3 ninguna variante de método, ruta, mayúsculas o cuerpo la revive', async () => {
    const variantes = [
      ['GET', '/webhook/voice/start'], ['PUT', '/webhook/voice/start'], ['POST', '/webhook/voice'],
      ['POST', '/webhook/voice/'], ['POST', '/webhook/voice/start/'], ['POST', '/WEBHOOK/VOICE/START'],
      ['POST', '/Webhook/Voice/Start'], ['POST', '/webhook/voice/start?x=1'], ['POST', '/webhook/voice/status'],
      ['POST', '/webhook//voice/start'], ['POST', '/audio/x.mp3'],
    ];
    for (const [method, ruta] of variantes) {
      for (const ck of [undefined, CK_ADMIN]) {
        const r = await http(ruta, { method, ck, cuerpo: cuerpoTwilio() });
        assert.equal(r.status, 404, `${method} ${ruta}${ck ? ' (admin)' : ''} respondió ${r.status}`);
        assert.ok(!pareceVoz(r.texto), `${method} ${ruta}: respondió TwiML`);
      }
    }
    const json = await http('/webhook/voice/start', { cuerpo: cuerpoTwilio(), tipo: 'json' });
    assert.equal(json.status, 404, `con cuerpo JSON respondió ${json.status}`);
  });

  await t('VR4 /ws/voice y sus variantes no completan el upgrade (404), con o sin sesión', async () => {
    const rutas = ['/ws/voice', '/ws/voice/', '/ws/voice/abc', '/ws/voice?callSid=CAx', '/WS/VOICE',
      '/Ws/Voice/abc', '//ws/voice', '/ws//voice', '/ws/%76oice', `/ws/voice/${'A'.repeat(43)}`];
    for (const ruta of rutas) {
      for (const ck of [undefined, CK_ADMIN]) {
        const c = await atacarWS(ruta, ck);
        assert.ok(!c.abierto, `${ruta}${ck ? ' (admin)' : ''} completó el upgrade`);
        assert.equal(c.status, 404, `${ruta}${ck ? ' (admin)' : ''}: ${JSON.stringify(c)}`);
      }
    }
  });

  await t('VR5 la raíz «/» tampoco completa el upgrade (404), aunque haya un negocio legado armado', async () => {
    const armados = (await q1(`SELECT count(*)::int AS n FROM configuracion WHERE clave='print_agent_legacy_activo' AND valor='true'`)).n;
    assert.equal(armados, 1, 'el escenario exige un negocio legado armado');
    for (const ck of [undefined, CK_ADMIN]) {
      const c = await abrirWS('/', { ck });
      if (c.abierto) c.ws.close();
      assert.ok(!c.abierto, `la raíz «/»${ck ? ' (admin)' : ''} completó el upgrade`);
      assert.equal(c.status, 404, `la raíz «/»${ck ? ' (admin)' : ''}: ${JSON.stringify({ status: c.status, error: c.error })}`);
    }
  });

  await t('VR6 lo rechazado no llamó al modelo', async () => {
    assert.equal(llamadasModelo.length, 0, `el modelo recibió ${llamadasModelo.length} llamadas`);
  });

  await t('VR7 ni dejó pedidos, folios, comandas, impresión, pagos, transcripciones, mensajes, outbox ni clientes', async () => {
    assert.deepEqual(await contarEfectos(), efectosAntes);
    assert.equal(meta.obtenerMensajesEnviados().length, metaAntes, 'se mandó algo a WhatsApp');
    const salida = srv.obtenerSalida();
    assert.ok(!/\[Voz/.test(salida), 'el servidor registró actividad del canal de voz');
  });

  // ── Controles positivos ─────────────────────────────────────────────────
  respuestaModelo = '¡Hola! Con gusto. ¿Qué te gustaría pedir?';
  await t('VR8 control: WhatsApp (webhook firmado) llega al modelo y el cliente recibe respuesta', async () => {
    const antes = llamadasModelo.length;
    const cuerpo = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ field: 'messages', value: {
        metadata: { phone_number_id: identificador },
        messages: [{ id: `vr-${sufijo}`, from: CLIENTE_WA, type: 'text', text: { body: 'Hola, ¿qué tienen?' } }],
        contacts: [{ profile: { name: 'Cliente voz retirada' } }],
      } }] }],
    });
    const r = await fetch(`${srv.base}/webhook/whatsapp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json',
        'X-Hub-Signature-256': `sha256=${createHmac('sha256', secreto).update(cuerpo).digest('hex')}` },
      body: cuerpo,
    });
    assert.equal(r.status, 200);
    const fin = Date.now() + 20000;
    while (Date.now() < fin && !meta.obtenerMensajesEnviados().some((m) => m.to === CLIENTE_WA)) await esperar(100);
    const enviados = meta.obtenerMensajesEnviados().filter((m) => m.to === CLIENTE_WA);
    assert.ok(enviados.length >= 1, `el cliente no recibió nada; servidor: ${srv.obtenerSalida().slice(-1200)}`);
    assert.ok(llamadasModelo.length > antes, 'WhatsApp contestó sin pasar por el modelo contado: el contador no probaría nada');
  });

  await t('VR9 control: el simulador administrativo abre sesión y conversa (con sesión de admin)', async () => {
    const sin = await http('/api/admin/bot-simulador/sesion', { cuerpo: {}, tipo: 'json' });
    assert.equal(sin.status, 401, `sin sesión respondió ${sin.status}`);
    const s = await http('/api/admin/bot-simulador/sesion', { ck: CK_ADMIN, cuerpo: {}, tipo: 'json' });
    assert.equal(s.status, 200, `sesion respondió ${s.status}: ${s.texto.slice(0, 160)}`);
    const sessionId = JSON.parse(s.texto).sessionId;
    const antes = llamadasModelo.length;
    const m = await http('/api/admin/bot-simulador/mensaje', { ck: CK_ADMIN, tipo: 'json',
      cuerpo: { sessionId, mensaje: '¿qué me recomiendas para acompañar un té en la tarde?' } });
    assert.equal(m.status, 200, `mensaje respondió ${m.status}: ${m.texto.slice(0, 200)}`);
    assert.ok(llamadasModelo.length > antes, `el simulador no llegó al modelo contado: ${m.texto.slice(0, 200)}`);
  });

  await t('VR10 tras los controles: ni pedidos, folios, comandas, impresión, pagos ni transcripciones', async () => {
    const despues = await contarEfectos();
    for (const tabla of TABLAS_SIN_CONTROL) assert.equal(despues[tabla], efectosAntes[tabla], `${tabla} cambió`);
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

await t('VR11 la barrera estática del predeploy (check-voz-retirada) pasa', async () => {
  await import('../scripts/check-voz-retirada.mjs');
});

// ── Limpieza ───────────────────────────────────────────────────────────────
await actualizarConfiguracion({ reglas_atencion: reglasOriginalesA ?? '' }, NEG_A).catch(() => {});
for (const [sql, p] of [
  ['DELETE FROM whatsapp_productos WHERE negocio_id=$1 AND producto_id=$2', [NEG_A, prodA]],
  ['DELETE FROM menu_productos WHERE negocio_id=$1 AND id=$2', [NEG_A, prodA]],
  ['DELETE FROM menu_categorias WHERE negocio_id=$1 AND id=$2', [NEG_A, catA]],
]) await pool.query(sql, p).catch(() => {});
for (const tabla of ['whatsapp_entradas', 'whatsapp_conversaciones', 'conversaciones_control', 'conversacion_estado',
  'agente_outbox', 'agente_turnos', 'agente_operaciones', 'mensajes', 'whatsapp_productos', 'integraciones_canal',
  'configuracion', 'menu_productos', 'menu_categorias', 'clientes']) {
  await pool.query(`DELETE FROM ${tabla} WHERE negocio_id=$1`, [NEG]).catch(() => {});
}
await pool.query('DELETE FROM negocios WHERE id=$1', [NEG]).catch(() => {});

console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallos.length) for (const f of fallos) console.log(`  - ${f}`);
await pool.end();
process.exit(fallidas ? 1 : 0);
