// /ws/print-agent con el servidor REAL: un frame grande no se junta en
// memoria, un JSON que no es objeto no tumba el proceso y ningún error de un
// mensaje se convierte en una promesa rechazada sin manejador (en Node eso
// TERMINA el proceso: panel, WhatsApp e impresión de todos los negocios).
//
//   P1  anónimo, frame mayor que el máximo (entero, y solo la cabecera de uno
//       de 16 MiB): 1009 enseguida, sin un byte de datos, sin buscar terminal
//       ni negocio, sin mover trabajos ni llamar al modelo.
//   P2  primer mensaje anónimo null, [], true, 0, "", {}, vacío e inválido:
//       autenticación fallida con su motivo exacto, sin buscar terminal.
//   P3  Edge autenticado manda null, [], true, 0, "", {}, vacío e inválido,
//       uno por uno: proceso vivo, /health y conexiones nuevas responden,
//       ningún trabajo cambia, nada cruza de negocio, cada uno se ignora con
//       su motivo y ni un «error inesperado».
//   P4  objetos hostiles del Edge autenticado (tipo que no es texto, toString
//       roto, ACK de otro negocio, anidación profunda): nada cambia ni cae.
//   P5  después, el Edge se reconecta, se autentica, recibe EXACTAMENTE sus
//       trabajos y confirma uno (solo ese pasa a enviado); el de B, lo suyo.
//   P6  el mayor mensaje legítimo (impresoras_detectadas: 50 impresoras de 200
//       caracteres con el peor escape de JSON) llega entero al panel; 64 KiB
//       exactos pasan; un byte más cierra con 1009 sin tumbar nada.
//   P7  excepción inyectada DENTRO del manejador (lib-sonda-print-agent.mjs):
//       el .catch la recoge —el Edge autenticado sigue; el anónimo se cierra
//       con 1011— y el proceso sigue vivo.
//   P8  panel y Superadmin: 70 KiB o UTF-8 inválido cierran SU conexión
//       (1009 / 1007) y el proceso sigue. No tenían escucha de 'error': con
//       maxPayload, un panel con sesión habría tumbado el servidor con 64 KiB.
//   P9  al final: proceso vivo, ningún rechazo ni 'error' sin manejar en toda
//       la salida, cero llamadas al modelo.
//   P10 las barreras estáticas del predeploy pasan.
//
// Uso: DATABASE_URL=<local, sembrada> node test/fase-print-agent-payload.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import net from 'node:net';
import WebSocket from 'ws';
import { arrancarServidor } from './lib-servidor.mjs';
import { arrancarMetaMock } from './lib-meta-mock.mjs';

const host = new URL(process.env.DATABASE_URL).hostname;
assert(['localhost', '127.0.0.1', '::1'].includes(host), 'solo corre contra Postgres local');

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT_PRINT_PAYLOAD || '4097';
const A = SEED.negocioA;
const B = SEED.negocioB;
const SONDA = join(__dirname, 'lib-sonda-print-agent.mjs');
// La misma marca de la sonda. Importarla de allí instalaría la sonda en ESTE
// proceso (espía de SQL y console que lanza), así que se repite y se comprueba.
const MARCA_FALLA = '__falla_inyectada_ws__';
assert.ok(readFileSync(SONDA, 'utf8').includes(`'${MARCA_FALLA}'`), 'la marca de lib-sonda-print-agent.mjs cambió');
const MAX = 64 * 1024; // MAX_PAYLOAD_WS de src/server.js

const { pool } = await import('../src/services/database.js');
const { crearTokenSesion } = await import('../src/services/session.js');
const { crearEdge, generarEmparejamiento, canjearEmparejamiento } = await import('../src/services/edgeService.js');
const { crearImpresora, crearRuta, crearTrabajosDePedido } = await import('../src/services/impresionService.js');
const { sanitizarImpresoras } = await import('../edge/impresorasWindows.js');

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
const cookie = (usuarioId, negocioId, rol) =>
  `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId, negocioId, rol }))}`;
const CK_ADMIN = cookie(SEED.adminNegocioAUsuarioId, A, 'admin');
const CK_SUPER = cookie(SEED.superadminUsuarioId, A, 'admin');
const sufijo = Math.floor(Math.random() * 1e6).toString().padStart(6, '0');

// ── Modelo contado: aquí nada debe llegar a él ─────────────────────────────
const llamadasModelo = [];
const modelo = createServer((req, res) => {
  llamadasModelo.push({ ruta: req.url });
  req.resume();
  req.on('end', () => { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":"no debía llamarse"}'); });
});
await new Promise((r) => modelo.listen(0, '127.0.0.1', r));
const MODELO_URL = `http://127.0.0.1:${modelo.address().port}`;

// ── Trabajos ───────────────────────────────────────────────────────────────
const pendientesDe = async (terminalId) => (await pool.query(
  `SELECT id::text, estado FROM impresion_trabajos
    WHERE terminal_id = $1 AND estado IN ('pendiente','entregado','fallido') ORDER BY id`, [terminalId])).rows;
const estadoDe = async (id) => (await pool.query('SELECT estado FROM impresion_trabajos WHERE id = $1', [id])).rows[0]?.estado;

// ── Frames a mano (el cliente enmascara; el servidor no) ────────────────────
function frame(opcode, payload, { declarado = payload.length } = {}) {
  const mascara = randomBytes(4);
  let cab;
  if (declarado < 126) cab = Buffer.from([0x80 | opcode, 0x80 | declarado]);
  else if (declarado < 65536) { cab = Buffer.alloc(4); cab[0] = 0x80 | opcode; cab[1] = 0x80 | 126; cab.writeUInt16BE(declarado, 2); }
  else { cab = Buffer.alloc(10); cab[0] = 0x80 | opcode; cab[1] = 0x80 | 127; cab.writeBigUInt64BE(BigInt(declarado), 2); }
  const cuerpo = Buffer.from(payload);
  for (let k = 0; k < cuerpo.length; k++) cuerpo[k] ^= mascara[k % 4];
  return Buffer.concat([cab, mascara, cuerpo]);
}
function framesDe(buf) {
  const out = [];
  let i = 0;
  while (i + 2 <= buf.length) {
    const op = buf[i] & 0x0f;
    let largo = buf[i + 1] & 0x7f;
    let j = i + 2;
    if (largo === 126) { if (j + 2 > buf.length) break; largo = buf.readUInt16BE(j); j += 2; }
    else if (largo === 127) { if (j + 8 > buf.length) break; largo = Number(buf.readBigUInt64BE(j)); j += 8; }
    if (j + largo > buf.length) break;
    const cuerpo = buf.subarray(j, j + largo);
    out.push({ op, codigo: op === 8 && largo >= 2 ? cuerpo.readUInt16BE(0) : null });
    i = j + largo;
  }
  return out;
}
// Upgrade crudo por TCP: deja el socket listo para escribir frames a mano.
function wsCrudo(ruta, { ck } = {}) {
  return new Promise((resolve, reject) => {
    const s = net.connect(Number(PUERTO), '127.0.0.1');
    let buf = Buffer.alloc(0);
    let tras = null;
    let cerrado = false;
    const alCerrar = [];
    const tope = setTimeout(() => { s.destroy(); reject(new Error('el upgrade no respondió')); }, 4000);
    s.on('connect', () => s.write(`GET ${ruta} HTTP/1.1\r\nHost: localhost:${PUERTO}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
      + `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n` + (ck ? `Cookie: ${ck}\r\n` : '') + '\r\n'));
    s.on('data', (d) => {
      if (tras) { tras = Buffer.concat([tras, d]); return; }
      buf = Buffer.concat([buf, d]);
      const i = buf.indexOf('\r\n\r\n');
      if (i < 0) return;
      clearTimeout(tope);
      const cab = buf.subarray(0, i).toString('latin1');
      if (!/^HTTP\/1\.1 101/.test(cab)) { s.destroy(); reject(new Error(`sin upgrade: ${cab.slice(0, 40)}`)); return; }
      tras = buf.subarray(i + 4);
      resolve({
        s,
        recibido: () => tras,
        cierre: (ms) => new Promise((r) => {
          if (cerrado) return r(true);
          const t2 = setTimeout(() => r(false), ms);
          alCerrar.push(() => { clearTimeout(t2); r(true); });
        }),
      });
    });
    s.on('close', () => { cerrado = true; for (const f of alCerrar.splice(0)) f(); });
    s.on('error', () => {});
  });
}

// ── Clientes WebSocket ─────────────────────────────────────────────────────
function abrirWS(ruta, { ck, timeoutMs = 4000 } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PUERTO}${ruta}`, ck ? { headers: { Cookie: ck } } : undefined);
    const tope = setTimeout(() => { resolve({ abierto: false, motivo: 'timeout' }); ws.terminate(); }, timeoutMs);
    const cerrado = new Promise((r) => ws.on('close', (code) => r(code)));
    ws.on('open', () => { clearTimeout(tope); resolve({ abierto: true, ws, cerrado }); });
    ws.on('unexpected-response', (req, res) => { clearTimeout(tope); resolve({ abierto: false, status: res.statusCode }); req.destroy(); });
    ws.on('error', (e) => { clearTimeout(tope); resolve({ abierto: false, error: e.message }); });
  });
}
// Un print-agent como edge/connection.js: manda (o no) su primer mensaje,
// anota TODO lo que recibe, confirma trabajos si se le pide y contesta
// solicitar_impresoras con lo que se le dé.
function printAgent(primerMensaje, { confirmar = true, impresoras = null } = {}) {
  const ws = new WebSocket(`ws://localhost:${PUERTO}/ws/print-agent`);
  const recibidos = [];
  let cierre = null;
  const cerrado = new Promise((r) => ws.on('close', (code) => { cierre = code; r(code); }));
  const abierto = new Promise((r) => ws.on('open', r));
  ws.on('open', () => { if (primerMensaje !== undefined) ws.send(typeof primerMensaje === 'string' ? primerMensaje : JSON.stringify(primerMensaje)); });
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    recibidos.push(m);
    if (confirmar && m.tipo === 'trabajo_impresion' && m.trabajo?.id) {
      ws.send(JSON.stringify({ tipo: 'ack_impresion', trabajoId: m.trabajo.id, resultado: 'enviado' }));
    }
    if (impresoras && m.tipo === 'solicitar_impresoras') ws.send(impresoras(m.solicitudId));
  });
  ws.on('error', () => {});
  return { ws, recibidos, cerrado, abierto, codigo: () => cierre,
    autenticado: () => recibidos.some((m) => m.tipo === 'terminal_autenticada'),
    trabajos: () => recibidos.filter((m) => m.tipo === 'trabajo_impresion').map((m) => m.trabajo.id) };
}
const auth = (cred) => ({ tipo: 'autenticar_terminal', terminalId: cred.terminalId, token: cred.token, instalacionId: `inst-${cred.terminalId.slice(0, 8)}` });
const cerradoEn = (c, ms) => Promise.race([c.cerrado, esperar(ms).then(() => 'sigue abierto')]);

// ── Fixture: Edge de A y de B, con trabajos pendientes ─────────────────────
async function montarEdge(neg, nombre) {
  await pool.query(`INSERT INTO sucursales (negocio_id, nombre) VALUES ($1,'Principal') ON CONFLICT (negocio_id, nombre) DO UPDATE SET activo = true`, [neg]);
  const edge = await crearEdge(neg, { nombre });
  const { codigo } = await generarEmparejamiento(neg, edge.id);
  const cred = await canjearEmparejamiento(codigo);
  const imp = await crearImpresora(neg, { terminalId: edge.id, nombre: `${nombre} impresora`, transporte: 'mock', anchoColumnas: 42 });
  await crearRuta(neg, { impresoraId: imp.id, ambito: 'documento', clave: 'comanda' });
  return { edge, cred, imp };
}
const pedidoPrueba = (neg, n) => ({ id: `PAY-${n}-${sufijo}`, negocioId: neg, items: [{ nombre: 'Café payload', cantidad: 1 }], canal: 'test' });

const EDGE_A = await montarEdge(A, `Edge A payload ${sufijo}`);
const EDGE_B = await montarEdge(B, `Edge B payload ${sufijo}`);
const TA = EDGE_A.edge.id;
const TB = EDGE_B.edge.id;
for (const n of [1, 2]) await crearTrabajosDePedido({ negocioId: A, pedido: pedidoPrueba(A, `A${n}`) });
await crearTrabajosDePedido({ negocioId: B, pedido: pedidoPrueba(B, 'B1') });
// Foto completa (cada columna, vía md5 de la fila) de los trabajos de las dos terminales.
const fotoTrabajos = async () => (await pool.query(
  `SELECT id::text, terminal_id::text AS terminal, negocio_id::text AS negocio, estado, md5(row_to_json(t)::text) AS huella
     FROM impresion_trabajos t WHERE terminal_id = ANY($1::uuid[]) ORDER BY id`, [[TA, TB]])).rows;

let srv = null;
let meta = null;
const marca = () => srv.obtenerSalida().length;
const desde = (m) => srv.obtenerSalida().slice(m);
const procesoVivo = () => srv.proc.exitCode === null && srv.proc.signalCode === null;
async function vivo() {
  assert.ok(procesoVivo(), `el proceso del servidor TERMINÓ (exit=${srv.proc.exitCode}): ${srv.obtenerSalida().slice(-700)}`);
  const r = await fetch(`${srv.base}/health`).catch((e) => ({ status: `sin respuesta (${e.message})` }));
  assert.equal(r.status, 200, `/health: ${r.status}`);
}
try {
  meta = await arrancarMetaMock();
  srv = await arrancarServidor({
    PORT: PUERTO, META_GRAPH_BASE_URL: meta.baseUrl, META_APP_SECRET: 'firma-local-payload',
    ANTHROPIC_BASE_URL: MODELO_URL, ANTHROPIC_API_KEY: 'sk-ant-prueba-local-no-es-real',
    OPENAI_BASE_URL: MODELO_URL, OPENAI_API_KEY: 'sk-prueba-local-no-es-real',
    // La sonda va SOLO al proceso del servidor, detrás de lo que ya hubiera
    // (la guarda de red del lote, si la hay).
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(SONDA).href}`.trim(),
  }, { timeoutMs: 60000, omitir: ['MESERO_AGENTE_MODE', 'MESERO_SHADOW_MODE', 'PEDIDO_SHADOW_MODE'] });
  assert.ok(srv.obtenerSalida().includes('[SONDA] cargada en el servidor'), 'la sonda no se cargó en el servidor: las pruebas de consulta y de falla no probarían nada');

  // Al arrancar, el servidor emite en segundo plano los pedidos sembrados sin
  // emisión; la foto de «antes» se toma cuando la cola de A dejó de moverse.
  let previo = -1;
  const finEspera = Date.now() + 20000;
  while (Date.now() < finEspera) {
    const n = (await pendientesDe(TA)).length;
    if (n === previo && n >= 2) break;
    previo = n;
    await esperar(1500);
  }
  const idsB = (await pendientesDe(TB)).map((x) => x.id);
  assert.ok(idsB.length >= 1, 'B no tiene su trabajo pendiente');

  await t('P1 anónimo con un frame mayor que el máximo: 1009 enseguida, sin datos, sin buscar terminal, sin mover trabajos ni llamar al modelo', async () => {
    const antes = await fotoTrabajos();
    const m = marca();
    // a) El frame entero (70 KiB).
    const c = printAgent(undefined);
    await c.abierto;
    c.ws.send('x'.repeat(70 * 1024));
    assert.equal(await cerradoEn(c, 3000), 1009, 'el frame grande no se cortó con 1009');
    assert.deepEqual(c.recibidos, [], `recibió datos: ${JSON.stringify(c.recibidos)}`);
    // b) Solo la cabecera de uno de 16 MiB y 1 KiB de cuerpo: sin límite, ws
    //    se quedaría esperando (y juntando) el resto.
    const cr = await wsCrudo('/ws/print-agent');
    const t0 = Date.now();
    cr.s.write(frame(0x1, Buffer.alloc(1024, 0x78), { declarado: 16 * 1024 * 1024 }));
    const cerro = await cr.cierre(3000);
    const ms = Date.now() - t0;
    assert.ok(cerro && ms < 1500, `el servidor siguió esperando el cuerpo (${cerro ? `cerró a los ${ms} ms` : 'no cerró en 3 s'})`);
    assert.deepEqual(framesDe(cr.recibido()).map((f) => [f.op, f.codigo]), [[8, 1009]], 'la única respuesta debía ser el cierre 1009');
    await vivo();
    const salida = desde(m);
    assert.ok(!salida.includes('[SONDA-SQL] autenticar-terminal'), 'buscó una terminal (y su negocio) para un frame rechazado');
    assert.ok(!/\[PrintAgent\] (Autenticación fallida|Terminal autenticada)/.test(salida), 'el manejador de mensajes llegó a ver el frame');
    assert.deepEqual(await fotoTrabajos(), antes, 'un frame rechazado movió trabajos');
    assert.equal(llamadasModelo.length, 0, 'llamó al modelo');
  });

  await t('P2 primer mensaje anónimo null, [], true, 0, "", {}, vacío o inválido: autenticación fallida con su motivo, sin buscar terminal', async () => {
    const casos = [
      ['null', 'null', 'el mensaje no es un objeto JSON'], ['[]', '[]', 'el mensaje no es un objeto JSON'],
      ['true', 'true', 'el mensaje no es un objeto JSON'], ['0', '0', 'el mensaje no es un objeto JSON'],
      ['""', '""', 'el mensaje no es un objeto JSON'], ['{}', '{}', 'tipo de mensaje incorrecto'],
      ['vacío', '', 'JSON inválido'], ['inválido', '{"tipo":', 'JSON inválido'],
    ];
    const malas = [];
    for (const [nombre, texto, motivo] of casos) {
      const m = marca();
      const c = printAgent(texto);
      const codigo = await cerradoEn(c, 3000);
      if (codigo === 'sigue abierto') malas.push(`${nombre}: sigue abierto`);
      if (codigo === 1011) malas.push(`${nombre}: 1011 (lanzó dentro del manejador)`);
      if (c.autenticado()) malas.push(`${nombre}: se autenticó`);
      const utiles = c.recibidos.filter((x) => x.tipo !== 'error');
      if (utiles.length) malas.push(`${nombre}: recibió ${utiles.map((x) => x.tipo).join(',')}`);
      const salida = desde(m);
      if (!salida.includes(`Autenticación fallida (${motivo})`)) malas.push(`${nombre}: sin «${motivo}» en el log`);
      if (salida.includes('[SONDA-SQL] autenticar-terminal')) malas.push(`${nombre}: buscó una terminal`);
      if (/error inesperado/.test(salida)) malas.push(`${nombre}: «error inesperado»`);
      if (!procesoVivo()) { malas.push(`${nombre}: el proceso terminó`); break; }
    }
    assert.deepEqual(malas, []);
    await vivo();
  });

  let edgeA = null;
  const antesP3 = { foto: null };
  await t('P3 Edge autenticado manda null, [], true, 0, "", {}, vacío e inválido: se ignoran, sin tumbar, sin tocar trabajos ni cruzar de negocio', async () => {
    edgeA = printAgent(auth(EDGE_A.cred), { confirmar: false });
    assert.ok(await hasta(() => edgeA.autenticado()), 'el Edge de A no se autenticó');
    const esperados = (await pendientesDe(TA)).map((x) => x.id);
    assert.ok(await hasta(() => esperados.every((id) => edgeA.trabajos().includes(id))), 'no llegaron los trabajos pendientes de A');
    assert.ok(await hasta(async () => (await pendientesDe(TA)).every((x) => x.estado === 'entregado')), 'la base no terminó de marcarlos entregados');
    await esperar(400);
    antesP3.foto = await fotoTrabajos();
    const casos = [
      ['null', 'null', 'no es un objeto JSON (null)'], ['[]', '[]', 'no es un objeto JSON (arreglo)'],
      ['true', 'true', 'no es un objeto JSON (boolean)'], ['0', '0', 'no es un objeto JSON (number)'],
      ['""', '""', 'no es un objeto JSON (string)'], ['{}', '{}', 'sin tipo de texto'],
      ['vacío', '', 'no es JSON (0 bytes)'], ['inválido', '{"tipo":', 'no es JSON (8 bytes)'],
    ];
    const malas = [];
    for (const [nombre, texto, motivo] of casos) {
      const m = marca();
      edgeA.ws.send(texto);
      const linea = `[Edge] mensaje ignorado de terminal=${TA}: ${motivo}`;
      if (!(await hasta(() => desde(m).includes(linea), 3000))) malas.push(`${nombre}: sin «${motivo}» en el log`);
      if (/error inesperado/.test(desde(m))) malas.push(`${nombre}: «error inesperado» (lanzó dentro del manejador)`);
      if (!procesoVivo()) { malas.push(`${nombre}: el proceso terminó`); break; }
      const salud = await fetch(`${srv.base}/health`).then((r) => r.status).catch((e) => e.message);
      if (salud !== 200) malas.push(`${nombre}: /health ${salud}`);
      const nueva = await abrirWS('/ws/panel', { ck: CK_ADMIN });
      if (!nueva.abierto) malas.push(`${nombre}: una conexión nueva no abrió (${nueva.status ?? nueva.error ?? nueva.motivo})`);
      else nueva.ws.close();
      if (edgeA.ws.readyState !== WebSocket.OPEN) malas.push(`${nombre}: se cerró la conexión del Edge`);
    }
    assert.deepEqual(malas, []);
    assert.deepEqual(await fotoTrabajos(), antesP3.foto, 'un mensaje inválido cambió trabajos (de A o de B)');
    assert.ok(!edgeA.trabajos().some((id) => idsB.includes(id)), 'el Edge de A recibió trabajos de B');
  });

  await t('P4 objetos hostiles del Edge autenticado (tipo no texto, toString roto, ACK ajeno, anidación profunda): nada cambia ni cae', async () => {
    assert.equal(edgeA?.ws.readyState, WebSocket.OPEN, 'precondición: el Edge de A sigue conectado');
    const idA = (await pendientesDe(TA))[0]?.id;
    assert.ok(idA, 'A no tiene un trabajo entregado sin confirmar');
    const idB = idsB[0];
    const casos = [
      ['tipo null', '{"tipo":null}', `terminal=${TA}: sin tipo de texto`],
      ['tipo con toString roto', '{"tipo":{"toString":1,"valueOf":1}}', `terminal=${TA}: sin tipo de texto`],
      ['tipo arreglo', '{"tipo":["latido"]}', `terminal=${TA}: sin tipo de texto`],
      ['ACK de un trabajo de B', JSON.stringify({ tipo: 'ack_impresion', trabajoId: idB, resultado: 'enviado' }), `ACK rechazado — terminal=${TA} trabajo=${idB}`],
      ['ACK con resultado roto', `{"tipo":"ack_impresion","trabajoId":"${idA}","resultado":{"toString":1}}`, `error procesando ACK de terminal=${TA}`],
      ['ACK con error roto', `{"tipo":"ack_impresion","trabajoId":"${idA}","resultado":"enviado","error":{"toString":1}}`, `error procesando ACK de terminal=${TA}`],
      ['ACK con trabajoId objeto', '{"tipo":"ack_impresion","trabajoId":{"toString":1},"resultado":"enviado"}', null],
      ['impresoras sin solicitud', '{"tipo":"impresoras_detectadas","solicitudId":{"toString":1},"impresoras":"x"}', null],
      ['__proto__', '{"tipo":"latido","__proto__":{"tipo":"x"}}', null],
      ['anidación profunda (60 KB)', '['.repeat(30000) + ']'.repeat(30000), `mensaje ignorado de terminal=${TA}: no es`],
    ];
    const malas = [];
    for (const [nombre, texto, linea] of casos) {
      const m = marca();
      edgeA.ws.send(texto);
      if (linea) { if (!(await hasta(() => desde(m).includes(linea), 3000))) malas.push(`${nombre}: sin «${linea}» en el log`); }
      else await esperar(300);
      if (/error inesperado/.test(desde(m))) malas.push(`${nombre}: «error inesperado»`);
      if (!procesoVivo()) { malas.push(`${nombre}: el proceso terminó`); break; }
      if (edgeA.ws.readyState !== WebSocket.OPEN) { malas.push(`${nombre}: se cerró la conexión del Edge`); break; }
    }
    assert.deepEqual(malas, []);
    await vivo();
    assert.deepEqual(await fotoTrabajos(), antesP3.foto, 'un objeto hostil cambió trabajos (de A o de B)');
    assert.equal(await estadoDe(idB), 'pendiente', 'el ACK de A movió el trabajo de B');
  });

  await t('P5 tras los mensajes inválidos, el Edge se reconecta, recibe EXACTAMENTE sus trabajos y confirma uno; el de B, solo lo suyo', async () => {
    edgeA?.ws.close();
    if (edgeA) await cerradoEn(edgeA, 3000);
    for (const n of [3, 4]) await crearTrabajosDePedido({ negocioId: A, pedido: pedidoPrueba(A, `A${n}`) });
    const esperados = (await pendientesDe(TA)).map((x) => x.id).sort();
    assert.ok(esperados.length >= 4, `la cola de A tiene ${esperados.length} trabajos`);
    const m = marca();
    const otra = printAgent(auth(EDGE_A.cred), { confirmar: false });
    assert.ok(await hasta(() => otra.autenticado()), 'no se reautenticó');
    assert.ok(await hasta(() => otra.trabajos().length >= esperados.length), `llegaron ${otra.trabajos().length} de ${esperados.length}`);
    await esperar(800);
    assert.deepEqual([...otra.trabajos()].sort(), esperados, 'no recibió EXACTAMENTE sus trabajos (o alguno dos veces)');
    assert.ok(!otra.trabajos().some((id) => idsB.includes(id)), 'recibió trabajos de B');
    assert.ok(desde(m).includes('[SONDA-SQL] autenticar-terminal'), 'control positivo: la sonda no vio la búsqueda de la terminal');
    const elegido = esperados[0];
    otra.ws.send(JSON.stringify({ tipo: 'ack_impresion', trabajoId: elegido, resultado: 'enviado' }));
    assert.ok(await hasta(async () => (await estadoDe(elegido)) === 'enviado'), 'el ACK no dejó el trabajo en enviado');
    await esperar(300);
    assert.deepEqual((await pendientesDe(TA)).map((x) => x.id).sort(), esperados.filter((id) => id !== elegido), 'el ACK tocó otros trabajos');
    otra.ws.close();
    await cerradoEn(otra, 3000);
    const edgeB = printAgent(auth(EDGE_B.cred), { confirmar: false });
    assert.ok(await hasta(() => edgeB.trabajos().length >= idsB.length), 'el Edge de B no recibió su trabajo');
    await esperar(500);
    assert.deepEqual([...edgeB.trabajos()].sort(), [...idsB].sort(), 'el Edge de B recibió algo que no es suyo');
    edgeB.ws.close();
    await cerradoEn(edgeB, 3000);
  });

  // 50 nombres DISTINTOS de 200 caracteres que JSON escapa a 6 bytes cada uno:
  // el mayor impresoras_detectadas que el Edge puede producir (lo sanea él).
  const SEIS = [0, 1, 2, 3, 4, 5, 6, 7, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31].map((c) => String.fromCharCode(c));
  const impresorasPeorCaso = sanitizarImpresoras(Array.from({ length: 50 }, (_, i) => ({
    nombre: '\u0001' + SEIS[i % SEIS.length] + SEIS[Math.floor(i / SEIS.length) % SEIS.length] + '\u0001'.repeat(197),
    estado: 'Offline', predeterminada: false,
  })));
  const respuestaImpresoras = (solicitudId) => JSON.stringify({ tipo: 'impresoras_detectadas', solicitudId, ok: true, impresoras: impresorasPeorCaso, error: null });

  await t('P6 el mayor mensaje legítimo llega entero al panel; 64 KiB exactos pasan; un byte más cierra con 1009 sin tumbar nada', async () => {
    const bytes = Buffer.byteLength(respuestaImpresoras(randomUUID()));
    assert.ok(impresorasPeorCaso.length === 50 && impresorasPeorCaso.every((i) => i.nombre.length === 200), 'el Edge ya no deja 50 nombres de 200');
    assert.ok(bytes > 60000 && bytes <= MAX, `el peor caso del Edge mide ${bytes} bytes y el máximo es ${MAX}`);
    const e = printAgent(auth(EDGE_A.cred), { confirmar: false, impresoras: respuestaImpresoras });
    assert.ok(await hasta(() => e.autenticado()), 'el Edge de A no se autenticó');
    const r = await fetch(`${srv.base}/api/impresion/self-service`, { headers: { Cookie: CK_ADMIN } });
    assert.equal(r.status, 200, `self-service: ${r.status}`);
    const equipo = (await r.json()).equipos?.find((x) => x.id === TA);
    assert.ok(equipo?.consultaOk, `la consulta de impresoras no llegó: ${JSON.stringify({ consultaOk: equipo?.consultaOk, consultando: equipo?.consultando, error: equipo?.errorConsulta })}`);
    assert.deepEqual(equipo.detectadas.map((d) => d.nombre), impresorasPeorCaso.map((i) => i.nombre), `el panel no recibió las 50 impresoras enteras (${bytes} bytes)`);
    assert.equal(e.ws.readyState, WebSocket.OPEN, 'el mensaje legítimo más grande cerró la conexión');
    const latido = (n) => { const base = '{"tipo":"latido","relleno":""}'; return `{"tipo":"latido","relleno":"${'x'.repeat(n - base.length)}"}`; };
    assert.equal(Buffer.byteLength(latido(MAX)), MAX);
    e.ws.send(latido(MAX));
    await esperar(600);
    assert.equal(e.ws.readyState, WebSocket.OPEN, `${MAX} bytes exactos cerraron la conexión`);
    e.ws.send(latido(MAX + 1));
    assert.equal(await cerradoEn(e, 3000), 1009, `${MAX + 1} bytes no se cortaron con 1009`);
    await vivo();
  });

  await t('P7 excepción inyectada dentro del manejador: el .catch la recoge, el Edge autenticado sigue, el anónimo se cierra con 1011 y el proceso vive', async () => {
    const e = printAgent(auth(EDGE_A.cred), { confirmar: false });
    assert.ok(await hasta(() => e.autenticado()), 'el Edge de A no se autenticó');
    await esperar(300);
    let m = marca();
    e.ws.send(JSON.stringify({ tipo: MARCA_FALLA }));
    const lineaA = `[PrintAgent] error inesperado procesando un mensaje (terminal=${TA}): falla inyectada por la sonda de pruebas`;
    assert.ok(await hasta(() => desde(m).includes(lineaA) || !procesoVivo(), 3000) && desde(m).includes(lineaA),
      `el .catch no recogió la falla del Edge autenticado: ${desde(m).slice(-500)}`);
    await esperar(300);
    await vivo();
    assert.equal(e.ws.readyState, WebSocket.OPEN, 'la conexión autenticada se cerró por una falla interna');
    m = marca();
    e.ws.send('{}');
    assert.ok(await hasta(() => desde(m).includes(`[Edge] mensaje ignorado de terminal=${TA}: sin tipo de texto`), 3000), 'tras la falla, la conexión ya no procesa mensajes');
    e.ws.close();
    m = marca();
    const anon = printAgent({ tipo: 'autenticar_terminal', terminalId: MARCA_FALLA, token: 'x'.repeat(64) });
    assert.equal(await cerradoEn(anon, 4000), 1011, 'la falla antes de autenticar no cerró la conexión con 1011');
    assert.deepEqual(anon.recibidos, [], `el anónimo recibió datos: ${JSON.stringify(anon.recibidos)}`);
    assert.ok(desde(m).includes('[PrintAgent] error inesperado procesando un mensaje (terminal=sin autenticar): falla inyectada por la sonda de pruebas'),
      'el .catch no registró la falla del anónimo');
    await esperar(300);
    await vivo();
  });

  await t('P8 panel y Superadmin: 70 KiB o UTF-8 inválido cierran SU conexión (1009 / 1007) y el proceso sigue', async () => {
    const panel = await abrirWS('/ws/panel', { ck: CK_ADMIN });
    assert.ok(panel.abierto, 'el panel con sesión no abrió');
    panel.ws.send('x'.repeat(70 * 1024));
    assert.equal(await Promise.race([panel.cerrado, esperar(3000).then(() => 'sigue abierto')]), 1009, 'el panel con 70 KiB');
    await vivo();
    const crudo = await wsCrudo('/ws/panel', { ck: CK_ADMIN });
    crudo.s.write(frame(0x1, Buffer.from([0xff, 0xfe, 0xfd])));
    assert.ok(await crudo.cierre(3000), 'el panel con UTF-8 inválido no se cerró');
    assert.ok(framesDe(crudo.recibido()).some((f) => f.op === 8 && f.codigo === 1007), 'el cierre del UTF-8 inválido no fue 1007');
    await vivo();
    const superadmin = await abrirWS('/ws/superadmin', { ck: CK_SUPER });
    assert.ok(superadmin.abierto, 'Superadmin no abrió');
    superadmin.ws.send('x'.repeat(70 * 1024));
    assert.equal(await Promise.race([superadmin.cerrado, esperar(3000).then(() => 'sigue abierto')]), 1009, 'Superadmin con 70 KiB');
    await vivo();
    const anon = await wsCrudo('/ws/print-agent');
    anon.s.write(frame(0x1, Buffer.from([0xff, 0xfe, 0xfd])));
    assert.ok(await anon.cierre(3000), 'el print-agent anónimo con UTF-8 inválido no se cerró');
    await vivo();
  });

  await t('P9 al final: proceso vivo, ningún rechazo ni error sin manejar en toda la salida, cero llamadas al modelo', async () => {
    await vivo();
    const salida = srv.obtenerSalida();
    assert.ok(!/UnhandledPromiseRejection|unhandledRejection|Unhandled 'error' event|triggerUncaughtException|ERR_UNHANDLED_REJECTION/.test(salida),
      `hubo un rechazo o un 'error' sin manejar: ${salida.match(/.*(Unhandled|unhandled|triggerUncaught).*/)?.[0]}`);
    assert.equal(llamadasModelo.length, 0, `el modelo recibió ${llamadasModelo.length} llamadas`);
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

await t('P10 las barreras estáticas del predeploy pasan', async () => {
  await import('../scripts/check-websocket-lista-cerrada.mjs');
  await import('../scripts/check-voz-retirada.mjs');
});

// ── Limpieza ───────────────────────────────────────────────────────────────
const limpiar = async (sql, p) => pool.query(sql, p).catch(() => {});
for (const tid of [TA, TB]) {
  await limpiar('DELETE FROM impresion_trabajos WHERE terminal_id = $1', [tid]);
  await limpiar('DELETE FROM impresion_rutas WHERE impresora_id IN (SELECT id FROM impresoras WHERE terminal_id = $1)', [tid]);
  await limpiar('DELETE FROM impresoras WHERE terminal_id = $1', [tid]);
  await limpiar('DELETE FROM edge_instalaciones WHERE terminal_id = $1', [tid]);
  await limpiar('DELETE FROM terminales WHERE id = $1', [tid]);
}
for (const neg of [A, B]) await limpiar(`DELETE FROM impresion_trabajos WHERE negocio_id = $1 AND origen_id LIKE $2`, [neg, `PAY-%-${sufijo}`]);

console.log(`RESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallos.length) for (const f of fallos) console.log(`  - ${f}`);
await pool.end();
process.exit(fallidas ? 1 : 0);
