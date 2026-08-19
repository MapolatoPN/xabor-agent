// ─── P0-16: el programado sale de la DB pero no de la MEMORIA ──────────────
//
// La transicion SQL de la 062 retira `pedidos_activos` dentro de la MISMA
// transaccion atomica -- eso ya esta probado (fase-cutover-059,
// fase-folio-programados-identidad, fase-programado-crash-real). Pero el
// pedido tambien vive en el arreglo `pedidos` de orderManager.js (lo puso ahi
// `registrarPedido()`), y el panel arma su snapshot al conectar/reconectar
// con `obtenerPedidos(ws.negocioId)` -- MEMORIA, no DB. Cuando los canales
// dejaron de llamar a `eliminarPedido()` por separado (para no duplicar el
// DELETE ni reabrir la ventana no atomica de P0-15E), nada volvia a sacar al
// pedido de ese arreglo: la base ya no lo tenia, pero el panel seguia
// mostrandolo como activo indefinidamente.
//
// Esta suite corre el flujo REAL de punta a punta -- registrarPedido real,
// memoria real, conversion real -- nunca un INSERT directo a pedidos_activos.
// El snapshot se verifica con `GET /pedidos`, la MISMA fuente
// (`obtenerPedidos(req.negocioId)`) que usa el WebSocket al reconectar.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4952';

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

async function crearPedidoActivo(base) {
  const r = await fetch(base + '/test/pedido', { method: 'POST', headers: { Cookie: cookie } });
  const body = await r.json();
  assert.strictEqual(r.status, 200, `no se pudo crear el pedido de prueba: ${JSON.stringify(body)}`);
  return body.pedido.id;
}

// La MISMA fuente que arma el snapshot de reconexion/F5 del WebSocket
// (server.js: `obtenerPedidos(ws.negocioId)`).
async function snapshotPanel(base) {
  const r = await fetch(base + '/pedidos', { headers: { Cookie: cookie } });
  assert.strictEqual(r.status, 200, 'GET /pedidos no respondio 200');
  return r.json();
}

async function programar(base, folio, programadoParaISO) {
  const r = await fetch(base + '/test/pedido-programar', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ folio, programadoPara: programadoParaISO }),
  });
  return r.json();
}

let srv = null;
try {
  srv = await arrancarServidor({ ...ENV_BASE }, { timeoutMs: 90000 });

  await t('1. flujo real: registrarPedido -> memoria -> conversion -> DB(activos=0,programados=1) -> memoria SIN el pedido', async () => {
    const folio = await crearPedidoActivo(srv.base);

    const antes = await snapshotPanel(srv.base);
    assert.ok(antes.some(p => p.id === folio), 'el pedido recien creado no aparece en memoria (obtenerPedidos)');

    const futuro = new Date(Date.now() + 3 * 3600e3).toISOString(); // fuera de la ventana de activacion (+1h)
    const conv = await programar(srv.base, folio, futuro);
    assert.strictEqual(conv.ok, true, `la conversion fallo: ${JSON.stringify(conv)}`);

    const activo = await pool.query(`SELECT 1 FROM pedidos_activos WHERE folio=$1`, [folio]);
    assert.strictEqual(activo.rowCount, 0, 'el activo sigue en pedidos_activos tras la conversion');
    const prog = await pool.query(`SELECT 1 FROM pedidos_programados WHERE folio=$1 AND activado=FALSE`, [folio]);
    assert.strictEqual(prog.rowCount, 1, 'no quedo el programado pendiente en la base');

    const despues = await snapshotPanel(srv.base);
    assert.ok(!despues.some(p => p.id === folio),
      'P0-16: el pedido SIGUE en memoria (obtenerPedidos) pese a que la DB ya lo convirtio a programado');
  });

  await t('2. F5/reconexion: el snapshot del panel (misma fuente que el WS) no muestra el programado futuro', async () => {
    const folio = await crearPedidoActivo(srv.base);
    const futuro = new Date(Date.now() + 3 * 3600e3).toISOString();
    const conv = await programar(srv.base, folio, futuro);
    assert.strictEqual(conv.ok, true);

    const snapshot = await snapshotPanel(srv.base);
    assert.ok(!snapshot.some(p => p.id === folio),
      'el pedido programado para el futuro aparece en el snapshot que alimenta nuevo_pedido/replay al reconectar');
  });

  await t('3. CRASH BOUNDARY: tras exito, un restart NO vuelve a cargar el programado (ya no esta en pedidos_activos)', async () => {
    const folio = await crearPedidoActivo(srv.base);
    const futuro = new Date(Date.now() + 3 * 3600e3).toISOString();
    const conv = await programar(srv.base, folio, futuro);
    assert.strictEqual(conv.ok, true);

    await srv.detener();
    srv = await arrancarServidor({ ...ENV_BASE }, { timeoutMs: 90000 });

    const snapshot = await snapshotPanel(srv.base);
    assert.ok(!snapshot.some(p => p.id === folio),
      'tras reiniciar, cargarPedidosDesdeDB() volvio a traer el programado a memoria');
  });

  await t('4. ACTIVACION: antes de su hora memoria=0, tras el scheduler memoria=1 exactamente (nunca fantasma duplicado)', async () => {
    const folio = await crearPedidoActivo(srv.base);
    const pasado = new Date(Date.now() - 5 * 60e3).toISOString(); // ya vencido
    const conv = await programar(srv.base, folio, pasado);
    assert.strictEqual(conv.ok, true);

    const antesActivar = await snapshotPanel(srv.base);
    assert.ok(!antesActivar.some(p => p.id === folio), 'aparece en memoria antes de que el scheduler lo active');

    // activarPedidosProgramados() corre UNA VEZ al arrancar (server.js:7918)
    // y luego cada 5 min: reiniciar equivale a "llega su hora y corre el
    // scheduler", sin esperar el intervalo real.
    await srv.detener();
    srv = await arrancarServidor({ ...ENV_BASE }, { timeoutMs: 90000 });

    // activarPedidosProgramados() corre fire-and-forget DESPUES de que
    // server.listen() ya respondio /health (server.js: "para que nada de
    // esto pueda retrasar la disponibilidad del servicio") -- hay una
    // ventana real entre "el servidor esta listo" y "el scheduler ya
    // termino su primera pasada". Presupuesto generoso a proposito: bajo
    // contencion (varios procesos hijo spawneados/matados en la misma
    // corrida de suites) 6s no siempre alcanzan.
    let despuesActivar = [];
    for (let i = 0; i < 40; i++) {
      despuesActivar = await snapshotPanel(srv.base);
      if (despuesActivar.some(p => p.id === folio)) break;
      await new Promise(r => setTimeout(r, 300));
    }
    const veces = despuesActivar.filter(p => p.id === folio).length;
    assert.strictEqual(veces, 1,
      `el scheduler dejo el pedido ${veces} veces en memoria (esperado: exactamente 1, nunca un fantasma duplicado ni cero)`);

    // El scheduler escribe `activado=true` DESPUES de agregar a memoria
    // (orden deliberado y crash-safe: si muere antes de marcar, el retry
    // idempotente del siguiente ciclo converge -- ver activarPedidosProgramados
    // y fase-programado-crash-real). Leerlo con una sola consulta inmediata
    // tras ver el folio en memoria es una carrera de LECTURA del test sobre
    // ese estado intermedio documentado: cazada de verdad en el gate final
    // de P0-11 (el snapshot ya mostraba el pedido, activado leyo false, y
    // milisegundos despues la fila ya estaba en true). Se espera acotado a
    // que la escritura durable aterrice -- el assert sigue siendo estricto:
    // si en 5s no llega, es rojo real.
    let activadoDB = null;
    for (let i = 0; i < 25; i++) {
      const progDB = await pool.query(`SELECT activado FROM pedidos_programados WHERE folio=$1`, [folio]);
      activadoDB = progDB.rows[0]?.activado ?? null;
      if (activadoDB === true) break;
      await new Promise(r => setTimeout(r, 200));
    }
    assert.strictEqual(activadoDB, true, 'el programado no quedo marcado activado=true en la base (tras esperar hasta 5s la escritura que sigue a la memoria)');
    const activoDB = await pool.query(`SELECT 1 FROM pedidos_activos WHERE folio=$1`, [folio]);
    assert.strictEqual(activoDB.rowCount, 1, 'el scheduler no reinserto el pedido en pedidos_activos');
  });

} catch (e) {
  console.error('ERROR FATAL:', e.stack || e);
  fallidas++; fallos.push('ERROR FATAL');
} finally {
  try { if (srv) await srv.detener(); } catch { /* ya abajo */ }
  await pool.end().catch(() => {});
}

console.log(`\n═══ fase-programado-memoria-panel: ${pasadas} OK · ${fallidas} fallos ═══`);
if (fallos.length) console.log('Fallos: ' + fallos.join(' | '));
process.exit(fallidas ? 1 : 0);
