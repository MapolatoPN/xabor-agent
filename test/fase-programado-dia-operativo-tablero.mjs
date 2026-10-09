// ─── El programado de anoche sigue en «En curso» tras un F5 ────────────────
//
// Cableado REAL de orders/diaOperativoDelPedido.js (la regla pura la prueba
// fase-programado-dia-operativo.mjs): el volcado que el WebSocket del panel
// manda al conectar/recargar, y el `deHoy` de GET /api/pos/envios (pestaña
// Domicilio).
//
// Caso real (9-oct, Mapolato Acuña): XAB-1401 se registró el 8-oct a las
// 22:10 para el 9-oct a las 8:30. El scheduler lo activó a las 7:34 y el
// volcado lo descartó en cada recarga porque miraba solo el día de registro:
// pagado, en estado «nuevo» y fuera del tablero.
//
// Flujo real de punta a punta: registrarPedido, conversión a programado y
// activación por el scheduler al arrancar. Lo único que se reescribe en la
// base es la FECHA de registro (`timestamp`) y el `programado_para` canónico
// que guarda el canal, para poner el pedido «ayer» sin esperar un día.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import WebSocket from 'ws';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT_DIA_OPERATIVO || '4963';

const { pool } = await import('../src/services/database.js');
const { crearTokenSesion } = await import('../src/services/session.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(nombre); }
}

const NEG = SEED.negocioA;
const cookie = `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId: SEED.adminNegocioAUsuarioId, negocioId: NEG, rol: 'admin' }))}`;
const ENV_BASE = { PORT: PUERTO, XABOR_RUTAS_PRUEBA: '1' };

const HORA = 3600e3;
// 26 h atrás siempre cae en el día operativo anterior; 50 h, en el de antes.
const AYER = new Date(Date.now() - 26 * HORA).toISOString();
const ANTEAYER = new Date(Date.now() - 50 * HORA).toISOString();

async function crearPedidoActivo(base) {
  const r = await fetch(base + '/test/pedido', { method: 'POST', headers: { Cookie: cookie } });
  const body = await r.json();
  assert.strictEqual(r.status, 200, `no se pudo crear el pedido de prueba: ${JSON.stringify(body)}`);
  return body.pedido.id;
}

async function programar(base, folio, programadoParaISO) {
  const r = await fetch(base + '/test/pedido-programar', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ folio, programadoPara: programadoParaISO }),
  });
  const body = await r.json();
  assert.strictEqual(body.ok, true, `la conversion a programado fallo: ${JSON.stringify(body)}`);
}

async function memoria(base) {
  const r = await fetch(base + '/pedidos', { headers: { Cookie: cookie } });
  assert.strictEqual(r.status, 200, 'GET /pedidos no respondio 200');
  return r.json();
}

// Lo que recibe un panel al conectar (= un F5): los `nuevo_pedido` con
// `replay: true`. Se escucha hasta 1.5 s sin mensajes nuevos (máx. 8 s).
async function volcadoDelPanel(base) {
  const ws = new WebSocket(base.replace('http://', 'ws://') + '/ws/panel', { headers: { Cookie: cookie } });
  const recibidos = [];
  let ultimo = Date.now();
  ws.on('message', (raw) => {
    try { recibidos.push(JSON.parse(raw.toString())); ultimo = Date.now(); } catch { /* no JSON */ }
  });
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('timeout abriendo WS panel')), 8000);
    ws.on('open', () => { clearTimeout(to); ultimo = Date.now(); resolve(); });
    ws.on('error', (e) => { clearTimeout(to); reject(e); });
  });
  const inicio = Date.now();
  while (Date.now() - ultimo < 1500 && Date.now() - inicio < 8000) await new Promise(r => setTimeout(r, 100));
  ws.close();
  return new Set(recibidos.filter(m => m.tipo === 'nuevo_pedido' && m.replay).map(m => m.pedido?.id));
}

async function deHoyEnDomicilio(base) {
  const r = await fetch(base + '/api/pos/envios', { headers: { Cookie: cookie } });
  assert.strictEqual(r.status, 200, 'GET /api/pos/envios no respondio 200');
  const { envios } = await r.json();
  return new Map(envios.map(e => [e.folio, e.deHoy]));
}

const creados = [];
let srv = null;
try {
  await pool.query(
    `INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,'pos','activo')
     ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = 'activo'`, [NEG]);

  srv = await arrancarServidor({ ...ENV_BASE }, { timeoutMs: 90000 });

  // A. XAB-1401: registrado ayer, programado para AHORA (se activa al arrancar).
  const A = await crearPedidoActivo(srv.base); creados.push(A);
  const ahora = new Date().toISOString();
  await programar(srv.base, A, ahora);
  await pool.query(
    `UPDATE pedidos_programados SET datos = datos || jsonb_build_object('timestamp', $2::text, 'programado_para', $3::text)
      WHERE folio = $1`, [A, AYER, ahora]);

  // B. Programado para AYER, registrado antes de ayer: viejo de verdad.
  const B = await crearPedidoActivo(srv.base); creados.push(B);
  await programar(srv.base, B, AYER);
  await pool.query(
    `UPDATE pedidos_programados SET datos = datos || jsonb_build_object('timestamp', $2::text, 'programado_para', $3::text)
      WHERE folio = $1`, [B, ANTEAYER, AYER]);

  // C. Pedido normal registrado ayer y sin cerrar.
  const C = await crearPedidoActivo(srv.base); creados.push(C);
  await pool.query(
    `UPDATE pedidos_activos SET datos = jsonb_set(datos, '{timestamp}', to_jsonb($2::text)) WHERE folio = $1`, [C, AYER]);

  // D. Pedido normal de hoy.
  const D = await crearPedidoActivo(srv.base); creados.push(D);

  // Reiniciar = la memoria se rehace desde la base y el scheduler activa A y B.
  await srv.detener();
  srv = await arrancarServidor({ ...ENV_BASE }, { timeoutMs: 90000 });

  let enMemoria = [];
  for (let i = 0; i < 40; i++) {
    enMemoria = await memoria(srv.base);
    if (enMemoria.some(p => p.id === A) && enMemoria.some(p => p.id === B)) break;
    await new Promise(r => setTimeout(r, 300));
  }
  const porFolio = new Map(enMemoria.map(p => [p.id, p]));

  await t('0. precondición: el escenario es el de XAB-1401 (activado, en memoria, registrado ayer)', async () => {
    for (const f of [A, B, C, D]) assert.ok(porFolio.has(f), `${f} no está en memoria tras el reinicio`);
    assert.strictEqual(porFolio.get(A).timestamp, AYER, 'A no quedó registrado «ayer»');
    assert.strictEqual(porFolio.get(A).programado_para, ahora, 'A no trae su programado_para canónico');
    assert.strictEqual(porFolio.get(C).timestamp, AYER, 'C no quedó registrado «ayer»');
    const prog = await pool.query(`SELECT folio, activado FROM pedidos_programados WHERE folio = ANY($1)`, [[A, B]]);
    assert.ok(prog.rows.length === 2 && prog.rows.every(r => r.activado === true), 'el scheduler no activó A y B');
  });

  const volcado = await volcadoDelPanel(srv.base);

  await t('1. XAB-1401: el programado de anoche para hoy SÍ llega al tablero al recargar', async () => {
    assert.ok(volcado.has(A), 'el programado activado hoy no vino en el volcado del panel');
  });

  await t('2. la guarda de aa99cba sigue: lo de días anteriores no resucita, lo de hoy sí', async () => {
    assert.ok(volcado.has(D), 'el pedido de hoy no vino en el volcado (el volcado no está funcionando)');
    assert.ok(!volcado.has(C), 'un pedido normal de ayer resucitó en el tablero');
    assert.ok(!volcado.has(B), 'un programado de ayer resucitó en el tablero');
  });

  await t('3. Domicilio: el programado de hoy va arriba y lo viejo en «Sin cerrar de días anteriores»', async () => {
    const deHoy = await deHoyEnDomicilio(srv.base);
    assert.strictEqual(deHoy.get(A), true, 'el programado de hoy quedó como «de días anteriores»');
    assert.strictEqual(deHoy.get(D), true, 'el pedido de hoy quedó como «de días anteriores»');
    assert.strictEqual(deHoy.get(C), false, 'el pedido normal de ayer quedó como de hoy');
    assert.strictEqual(deHoy.get(B), false, 'el programado de ayer quedó como de hoy');
  });
} catch (e) {
  console.error('ERROR FATAL:', e.stack || e);
  fallidas++; fallos.push('ERROR FATAL');
} finally {
  try { if (srv) await srv.detener(); } catch { /* ya abajo */ }
  if (creados.length) {
    await pool.query(`DELETE FROM pedidos_programados WHERE folio = ANY($1)`, [creados]).catch(() => {});
    await pool.query(`DELETE FROM pedidos_activos WHERE folio = ANY($1)`, [creados]).catch(() => {});
  }
  await pool.end().catch(() => {});
}

console.log(`\n═══ fase-programado-dia-operativo-tablero: ${pasadas} pasadas, ${fallidas} fallidas ═══`);
if (fallos.length) console.log('Fallos: ' + fallos.join(' | '));
process.exit(fallidas ? 1 : 0);
