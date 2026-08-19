// ─── P0-11 FASE 3: cutover OLD -> NEW con la 063, alcance estrecho ──────────
//
// OLD real = commit 0f9e82b (origin/main), en un WORKTREE TEMPORAL que esta
// misma suite crea, verifica y destruye en cada corrida -- nunca depende de
// una edicion manual previa. NEW = esta misma rama. Misma base Postgres
// desechable (copia por TEMPLATE) para los dos, creada y destruida por la
// suite.
//
// REPRODUCIBILIDAD DEL ARNES OLD (auditoria independiente): el worktree se
// crea desde CERO en cada corrida, se verifica `git rev-parse HEAD` contra
// el SHA exacto esperado, se aplica un patch VERSIONADO
// (test/fixtures/p011-old-harness.patch, comiteado a este repo) con las dos
// rutas de prueba aditivas, y se verifica que el `git diff` resultante
// coincida EXACTAMENTE con ese patch -- nunca "probablemente esta bien".
// Cualquier alteracion del HEAD de OLD o de una funcion productiva de OLD
// hace que la propia suite aborte (ver caso 6).
//
// Alcance (exactamente lo pedido): pedido normal, crash antes de emitir,
// pendiente_pago con pago REAL via mock de Clip y el webhook real de NEW,
// programado, la ventana pre-063 (P0-11C), y la auto-verificacion del
// arnes. Nada de Clip real, deploy, main, Railway ni cambios de Meta/WhatsApp.
import { readFileSync, existsSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { randomUUID, randomBytes } from 'crypto';
import { spawn, execFileSync } from 'child_process';
import { createServer } from 'http';
import assert from 'assert';
import pkg from 'pg';

const { Pool, Client } = pkg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const RAIZ_NEW = join(__dirname, '..');
const PATCH_PATH = join(__dirname, 'fixtures', 'p011-old-harness.patch');
const SHA_OLD_ESPERADO = '0f9e82bdd90a52c20ea3352f16116a20e884533b';
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));

const BASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:testpass@localhost:55453/edged1';
const DESECHABLE = 'xabor_p011_cutover';
const urlDesechable = BASE_URL.replace(/\/[^/?]+(\?|$)/, `/${DESECHABLE}$1`);
process.env.DATABASE_URL = urlDesechable;
const nombreOrigen = (BASE_URL.match(/\/([^/?]+)(\?|$)/) || [])[1];
const urlAdmin = BASE_URL.replace(/\/[^/?]+(\?|$)/, '/postgres$1');
// pagosService.js corre DENTRO de este proceso de prueba (no solo via HTTP a
// los hijos) en el caso 3 -- fijar esto ANTES de cualquier import dinamico
// que pudiera tocar ese modulo, mismo patron que fase-pagos-expiracion.mjs.
const PUERTO_CLIP_MOCK_RESERVADO = Number(process.env.TEST_PORT_CUTOVER_CLIP || 4613);
process.env.CLIP_API_BASE_URL = `http://localhost:${PUERTO_CLIP_MOCK_RESERVADO}`;

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
  finally {
    // Si un caso falla a mitad de camino, sus servidores NO deben quedar
    // vivos ocupando el puerto del siguiente caso -- eso convertiria un
    // fallo real en una cascada de fallos falsos por "puerto ya en uso /
    // servidor viejo respondiendo".
    if (srvOld) { try { srvOld.detener(); } catch { /* ya abajo */ } srvOld = null; }
    if (srvNew) { try { srvNew.detener(); } catch { /* ya abajo */ } srvNew = null; }
    await new Promise(r => setTimeout(r, 400));
  }
}

const NEG = SEED.negocioA;
let pool = null;

function esperar(ms) { return new Promise(r => setTimeout(r, ms)); }
async function esperarHasta(fn, { timeoutMs = 20000, intervaloMs = 200 } = {}) {
  const lim = Date.now() + timeoutMs;
  for (;;) { const r = await fn(); if (r) return r; if (Date.now() > lim) return null; await esperar(intervaloMs); }
}

// ═══ Base desechable, autogestionada ═════════════════════════════════════
async function crearBaseDesechable() {
  const admin = new Client({ connectionString: urlAdmin });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DESECHABLE}`);
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname = $1 AND pid <> pg_backend_pid()`, [nombreOrigen]);
  await admin.query(`CREATE DATABASE ${DESECHABLE} TEMPLATE ${nombreOrigen}`);
  await admin.end();

  pool = new Pool({ connectionString: urlDesechable });
  pool.on('error', () => {});
  await pool.query(`DROP TRIGGER IF EXISTS trg_asegurar_emision_operacional ON pedidos_activos`);
  await pool.query(`DROP FUNCTION IF EXISTS xabor_asegurar_emision_operacional()`);
  await pool.query(`DROP TABLE IF EXISTS pedido_emisiones`);
}
async function destruirBaseDesechable() {
  if (pool) await pool.end().catch(() => {});
  try {
    const { pool: poolCompartido, poolDeClaims } = await import('../src/services/database.js');
    await poolCompartido.end().catch(() => {});
    await poolDeClaims().end().catch(() => {});
  } catch { /* si nunca se importo, no hay nada que cerrar */ }
  const admin = new Client({ connectionString: urlAdmin });
  await admin.connect();
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname = $1 AND pid <> pg_backend_pid()`, [DESECHABLE]).catch(() => {});
  await admin.query(`DROP DATABASE IF EXISTS ${DESECHABLE}`).catch(() => {});
  await admin.end();
}

// ═══ Worktree OLD: reproducible desde cero, verificado, desechable ═══════
function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}
function normalizar(texto) { return texto.replace(/\r\n/g, '\n').trimEnd(); }

/** Aborta con un mensaje claro si el worktree no es EXACTAMENTE el esperado. */
function verificarHeadYLimpieza(path) {
  const head = git(['rev-parse', 'HEAD'], path).trim();
  if (head !== SHA_OLD_ESPERADO) {
    throw new Error(`worktree OLD en HEAD equivocado: esperado ${SHA_OLD_ESPERADO}, obtenido ${head} -- mutacion de HEAD detectada`);
  }
  const status = git(['status', '--porcelain'], path).trim();
  if (status !== '') {
    throw new Error(`worktree OLD tiene cambios sin explicar ANTES del patch versionado -- mutacion de una funcion productiva detectada:\n${status}`);
  }
}

/** Tras aplicar el patch, el diff real debe coincidir EXACTO con el versionado. */
function verificarPatchAplicadoExacto(path) {
  const diffReal = normalizar(git(['diff'], path));
  const diffEsperado = normalizar(readFileSync(PATCH_PATH, 'utf8'));
  if (diffReal !== diffEsperado) {
    throw new Error(
      `el diff del worktree OLD tras aplicar el patch NO coincide exactamente con ${PATCH_PATH} -- ` +
      `alguien modifico una funcion productiva de OLD ademas del patch versionado, o el patch no aplico limpio.`);
  }
  const status = git(['status', '--porcelain'], path).trim();
  if (status !== 'M src/server.js') {
    throw new Error(`el worktree OLD tiene archivos tocados fuera de src/server.js tras el patch: "${status}"`);
  }
}

async function crearWorktreeOLDTemporal() {
  const path = join(tmpdir(), 'xabor-old-p011-' + randomUUID().slice(0, 8));
  git(['worktree', 'add', '--detach', path, SHA_OLD_ESPERADO], RAIZ_NEW);
  verificarHeadYLimpieza(path);
  git(['apply', PATCH_PATH], path);
  verificarPatchAplicadoExacto(path);
  // package.json identico a NEW en este SHA -- junction en vez de npm install
  // completo (mismo dependency tree, mucho mas rapido).
  symlinkSync(join(RAIZ_NEW, 'node_modules'), join(path, 'node_modules'), 'junction');
  return {
    path,
    limpiar: () => {
      try { rmSync(join(path, 'node_modules'), { force: true }); } catch { /* junction, no recursivo */ }
      try { git(['worktree', 'remove', '--force', path], RAIZ_NEW); } catch (e) { console.warn('[cutover-063] no se pudo limpiar el worktree temporal:', e.message); }
    },
  };
}

function esperarSalida(proc, timeoutMs = 15000) {
  if (proc.exitCode !== null) return Promise.resolve(proc.exitCode);
  return new Promise((resolve) => { const to = setTimeout(() => resolve(null), timeoutMs); proc.once('exit', (c) => { clearTimeout(to); resolve(c); }); });
}
async function arrancarDesde(raiz, envExtra, { timeoutMs = 90000 } = {}) {
  const env = { ...process.env, ...envExtra };
  const proc = spawn(process.execPath, [join(raiz, 'src', 'server.js')], { cwd: raiz, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let salida = '';
  proc.stdout.on('data', d => { salida += d.toString(); });
  proc.stderr.on('data', d => { salida += d.toString(); });
  const puerto = envExtra.PORT;
  const base = `http://localhost:${puerto}`;
  const inicio = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    try { const r = await fetch(base + '/health'); if (r.ok) return { proc, base, detener: () => proc.kill(), obtenerSalida: () => salida }; }
    catch { /* aun no levanta */ }
    await esperar(300);
  }
  proc.kill();
  throw new Error(`El servidor (${raiz}) no respondio /health en ${timeoutMs}ms.\nSalida:\n${salida.slice(-2000)}`);
}

async function cookieAdminA() {
  const { crearTokenSesion } = await import('../src/services/session.js');
  return `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId: SEED.adminNegocioAUsuarioId, negocioId: NEG, rol: 'admin' }))}`;
}

const pedidoDe = async (folio) => (await pool.query(
  `SELECT estado, datos, created_at FROM pedidos_activos WHERE folio=$1 AND negocio_id=$2`, [folio, NEG])).rows[0] || null;
const deudaExacta = async (folio, creadoAt) => (await pool.query(
  `SELECT * FROM pedido_emisiones WHERE negocio_id=$1 AND folio=$2 AND pedido_creado_at=$3`, [NEG, folio, creadoAt])).rows[0] || null;
const deudasDeFolio = async (folio) => (await pool.query(
  `SELECT * FROM pedido_emisiones WHERE negocio_id=$1 AND folio=$2 ORDER BY created_at`, [NEG, folio])).rows;
const comprasDe = async (telefono) => (await pool.query(
  `SELECT * FROM compras_reales WHERE negocio_id=$1 AND cliente_telefono=$2`, [NEG, telefono])).rows;

function aplicar063() {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [join(RAIZ_NEW, 'scripts', 'predeploy-063-emision-operacional.mjs')],
      { cwd: RAIZ_NEW, env: { ...process.env, DATABASE_URL: urlDesechable }, stdio: ['ignore', 'pipe', 'pipe'] });
    let salida = '';
    proc.stdout.on('data', d => salida += d.toString());
    proc.stderr.on('data', d => salida += d.toString());
    proc.on('exit', (code) => resolve({ code, salida }));
  });
}
const hayTablaDeuda = async () => (await pool.query(
  `SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_name='pedido_emisiones'`)).rows[0].n === 1;

// ═══ Mock de Clip (para el caso 3, pago REAL, no una transicion directa) ═══
let nClip = 0;
const CHECKOUTS = new Map();
const clipMock = createServer((req, res) => {
  let cuerpo = '';
  req.on('data', c => { cuerpo += c; });
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST' && req.url === '/v2/checkout') {
      const b = JSON.parse(cuerpo || '{}');
      const id = `clip-p011c3-${++nClip}`;
      CHECKOUTS.set(id, { referencia: b.metadata?.external_reference || null, estado: 'PENDING', monto: Number(b.amount) });
      res.end(JSON.stringify({ payment_request_id: id, payment_request_url: `https://pago.mock/${id}`, status: 'CHECKOUT' }));
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/v2/checkout/')) {
      const c = CHECKOUTS.get(decodeURIComponent(req.url.split('/').pop()));
      if (!c) { res.statusCode = 404; res.end('{}'); return; }
      res.end(JSON.stringify({
        object_type: 'payment_link', payment_request_id: 'x',
        status: c.estado === 'COMPLETED' ? 'CHECKOUT_COMPLETED' : 'CHECKOUT_PENDING',
        amount: c.monto ?? null, currency: 'MXN',
        metadata: { external_reference: c.referencia, customer_info: {} },
        payment_request_url: 'https://x', created_at: '2026-08-19T00:00:00.000Z', expired_at: null,
      }));
      return;
    }
    res.statusCode = 404; res.end('{}');
  });
});

let cookie = null;
let srvOld = null, srvNew = null;
let worktreeOld = null;
const clipMockPuerto = PUERTO_CLIP_MOCK_RESERVADO;
const PUERTO_OLD = process.env.TEST_PORT_CUTOVER_OLD || '4611';
const PUERTO_NEW = process.env.TEST_PORT_CUTOVER_NEW || '4612';

try {
  if (!existsSync(PATCH_PATH)) throw new Error(`Falta el patch versionado en ${PATCH_PATH}`);
  await new Promise(r => clipMock.listen(clipMockPuerto, r));

  await crearBaseDesechable();
  cookie = await cookieAdminA();

  // ═══ CASO 6 primero: auto-verificacion del arnes (mutacion detectada) ═══
  await t('6. el arnes detecta HEAD alterado o una funcion productiva modificada, y aborta', async () => {
    const w = await crearWorktreeOLDTemporal(); // arnes limpio, referencia
    try {
      // Mutacion A: HEAD alterado.
      git(['checkout', '--detach', 'HEAD~1'], w.path);
      assert.throws(() => verificarHeadYLimpieza(w.path), /HEAD equivocado/,
        'el arnes NO detecto que el HEAD del worktree OLD cambio');
      git(['checkout', '--detach', SHA_OLD_ESPERADO], w.path);

      // Mutacion B: una funcion PRODUCTIVA de OLD modificada ademas del
      // patch versionado (el escenario que de verdad importa: alguien
      // "arregla algo" en OLD sin darse cuenta de que invalida la prueba).
      const archivoReal = join(w.path, 'src', 'orders', 'orderManager.js');
      const original = readFileSync(archivoReal, 'utf8');
      writeFileSync(archivoReal, original + '\n// MUTACION DE PRUEBA P0-11 CASO 6\n');
      assert.throws(() => verificarPatchAplicadoExacto(w.path), /NO coincide exactamente/,
        'el arnes NO detecto que se modifico una funcion productiva de OLD fuera del patch versionado');
      writeFileSync(archivoReal, original); // restaurar antes de limpiar
    } finally {
      w.limpiar();
    }
  });

  // ═══ Worktree OLD real para el resto de los casos ════════════════════════
  worktreeOld = await crearWorktreeOLDTemporal();
  const RAIZ_OLD = worktreeOld.path;
  console.log(`  [cutover-063] worktree OLD verificado en ${RAIZ_OLD} (HEAD=${SHA_OLD_ESPERADO.slice(0, 12)}, patch aplicado exacto)`);

  assert.strictEqual(await hayTablaDeuda(), false, 'la base desechable ya tiene pedido_emisiones: no representa "antes de 063"');

  // ═══ CASO 5 (P0-11C) PRIMERO: OLD acepta P justo ANTES de instalar la
  // 063 -- necesita la base todavia VIRGEN (nadie mas debe aplicar 063
  // antes que este caso, o dejaria de reproducir la ventana). Los casos
  // 1-4 corren DESPUES: para ellos, que la 063 ya este instalada (idempotente
  // y re-ejecutable, por diseño -- ver el propio comentario de la migracion)
  // es indistinguible de un cutover real donde OLD sigue vivo un rato mas
  // tras el deploy. ═══════════════════════════════════════════════════════
  await t('5. P0-11C: OLD acepta P justo antes de la 063 -- NUNCA queda silenciosamente marcado como emitido', async () => {
    srvOld = await arrancarDesde(RAIZ_OLD, { PORT: PUERTO_OLD, XABOR_RUTAS_PRUEBA: '1', DATABASE_URL: urlDesechable, NODE_ENV: 'development' });

    const r = await fetch(srvOld.base + '/test/pedido', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ cliente: { telefono: '8990000005' } }),
    });
    const body = await r.json();
    assert.strictEqual(r.status, 200);
    const folio = body.pedido.id;
    const activo = await pedidoDe(folio);
    assert.strictEqual(activo.estado, 'nuevo', 'P debe seguir en el primer estado (nunca tocado) para reproducir la ventana');

    // Paso 5-6 del pedido del usuario: SIN esperar (sin "impedir/demorar"
    // artificial -- eso seria inventar una garantia de tiempo), se aplica
    // la 063 EN CALIENTE mientras OLD sigue vivo, lo mas rapido posible
    // tras la respuesta HTTP -- el peor caso real.
    const r063p = await aplicar063();
    assert.strictEqual(r063p.code, 0, `predeploy-063 fallo:\n${r063p.salida.slice(-1500)}`);

    const deudaTrasBackfill = await deudaExacta(folio, activo.created_at);
    assert.ok(deudaTrasBackfill, 'P no recibio NINGUNA fila del backfill -- el fixture no reproduce la ventana');
    assert.strictEqual(deudaTrasBackfill.origen, 'legacy_nuevo_no_verificado',
      `P debe backfillearse por la rama B (estado='nuevo', ambiguo), no la A -- obtenido origen=${deudaTrasBackfill.origen}`);
    assert.strictEqual(deudaTrasBackfill.estado, 'pendiente',
      `P debe quedar EJECUTABLE (pendiente), nunca asumido saldado sin revision -- obtenido estado=${deudaTrasBackfill.estado}`);

    srvOld.detener();
    await esperarSalida(srvOld.proc, 8000);
    srvOld = null;

    // Paso 9-10: NEW arranca, y SIN RETRY MANUAL (ni una sola llamada de
    // este test a emitirPedido ni a reconciliar a mano) debe recuperar a P.
    srvNew = await arrancarDesde(RAIZ_NEW, { PORT: PUERTO_NEW, XABOR_RUTAS_PRUEBA: '1', DATABASE_URL: urlDesechable });
    const saldada = await esperarHasta(async () => {
      const d = await deudaExacta(folio, activo.created_at);
      return d?.estado === 'saldada' ? d : null;
    }, { timeoutMs: 20000 });
    assert.ok(saldada, `P0-11C: la ventana pre-063 dejo a P sin recuperar -- EMISION PERDIDA (obtenido: ${JSON.stringify(await deudaExacta(folio, activo.created_at))})`);
    assert.strictEqual(saldada.origen, 'legacy_nuevo_no_verificado', 'el origen se perdio en el camino');

    const compras = await comprasDe(activo.datos?.cliente?.telefono);
    assert.strictEqual(compras.length, 1, `P debe terminar con EXACTAMENTE una compra real (obtenido ${compras.length})`);

    await srvNew.detener();
    srvNew = null;
  });

  // ═══ CASO 1: OLD vivo, se aplica la 063 en caliente, pedido normal ═══════
  await t('1. OLD vivo + 063 aplicada en caliente: el trigger crea la deuda aunque OLD no la conozca', async () => {
    srvOld = await arrancarDesde(RAIZ_OLD, { PORT: PUERTO_OLD, XABOR_RUTAS_PRUEBA: '1', DATABASE_URL: urlDesechable, NODE_ENV: 'development' });

    const r063 = await aplicar063();
    assert.strictEqual(r063.code, 0, `predeploy-063 fallo (exit ${r063.code}):\n${r063.salida.slice(-1500)}`);
    assert.strictEqual(await hayTablaDeuda(), true, 'predeploy-063 no dejo la tabla pedido_emisiones');

    const r = await fetch(srvOld.base + '/test/pedido', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ cliente: { telefono: '8990000001' } }),
    });
    const body = await r.json();
    assert.strictEqual(r.status, 200, `OLD /test/pedido fallo: ${JSON.stringify(body)}`);
    const folio = body.pedido.id;

    const activo = await pedidoDe(folio);
    assert.ok(activo, 'el pedido de OLD no quedo en pedidos_activos');
    const deuda = await esperarHasta(async () => await deudaExacta(folio, activo.created_at));
    assert.ok(deuda, 'el trigger de la 063 NO creo deuda para un INSERT hecho por el binario OLD');
    assert.strictEqual(deuda.origen, 'trigger', 'la deuda no vino del trigger DB');

    await esperar(800);
    srvOld.detener();
    await esperarSalida(srvOld.proc, 8000);
    srvOld = null;

    srvNew = await arrancarDesde(RAIZ_NEW, { PORT: PUERTO_NEW, XABOR_RUTAS_PRUEBA: '1', DATABASE_URL: urlDesechable });
    const saldada = await esperarHasta(async () => {
      const d = await deudaExacta(folio, activo.created_at);
      return d?.estado === 'saldada' ? d : null;
    }, { timeoutMs: 20000 });
    assert.ok(saldada, `NEW no salio la deuda que dejo OLD (obtenido: ${JSON.stringify(await deudaExacta(folio, activo.created_at))})`);

    const todasLasDeudas = await deudasDeFolio(folio);
    assert.strictEqual(todasLasDeudas.length, 1, `se esperaba UNA sola deuda logica para el folio de OLD, hubo ${todasLasDeudas.length}`);
    const compras = await comprasDe(activo.datos?.cliente?.telefono);
    assert.strictEqual(compras.length, 1, `NEW debe registrar EXACTAMENTE una compra real para este pedido (obtenido ${compras.length})`);

    await srvNew.detener();
    srvNew = null;
  });

  // ═══ CASO 2: OLD recibe pedido y muere ANTES de que su propia emision termine ═══
  await t('2. OLD recibe pedido y muere antes de emitir: NEW hace el recovery automatico', async () => {
    srvOld = await arrancarDesde(RAIZ_OLD, { PORT: PUERTO_OLD, XABOR_RUTAS_PRUEBA: '1', DATABASE_URL: urlDesechable, NODE_ENV: 'development' });

    const r = await fetch(srvOld.base + '/test/pedido', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ cliente: { telefono: '8990000002' } }),
    });
    const body = await r.json();
    assert.strictEqual(r.status, 200);
    const folio = body.pedido.id;

    srvOld.detener();
    await esperarSalida(srvOld.proc, 8000);
    srvOld = null;

    const activo = await pedidoDe(folio);
    assert.ok(activo, 'el pedido de OLD no sobrevivio a la muerte del proceso');

    srvNew = await arrancarDesde(RAIZ_NEW, { PORT: PUERTO_NEW, XABOR_RUTAS_PRUEBA: '1', DATABASE_URL: urlDesechable });
    const saldada = await esperarHasta(async () => {
      const d = await deudaExacta(folio, activo.created_at);
      return d?.estado === 'saldada' ? d : null;
    }, { timeoutMs: 20000 });
    assert.ok(saldada, 'NEW no recupero la emision tras la muerte real de OLD');
    assert.strictEqual((await deudasDeFolio(folio)).length, 1, 'debe haber UNA sola deuda logica, no mas');

    await srvNew.detener();
    srvNew = null;
  });

  // ═══ CASO 3: pendiente_pago con OLD, PAGO REAL (mock Clip + webhook real de NEW) ═══
  await t('3. pendiente_pago con OLD + pago REAL via mock de Clip y el webhook real de NEW: deuda 1, emision', async () => {
    srvOld = await arrancarDesde(RAIZ_OLD, { PORT: PUERTO_OLD, XABOR_RUTAS_PRUEBA: '1', DATABASE_URL: urlDesechable, NODE_ENV: 'development' });
    const r = await fetch(srvOld.base + '/test/pedido-pendiente-pago-p011', { method: 'POST', headers: { Cookie: cookie } });
    const body = await r.json();
    assert.strictEqual(r.status, 200, `OLD no pudo crear el pendiente_pago: ${JSON.stringify(body)}`);
    const folio = body.pedido.id;

    const activo = await pedidoDe(folio);
    assert.strictEqual(activo.estado, 'pendiente_pago');
    await esperar(500);
    assert.strictEqual((await deudasDeFolio(folio)).length, 0, 'un pedido pendiente_pago con OLD vivo no debe tener NINGUNA deuda operacional');

    srvOld.detener();
    await esperarSalida(srvOld.proc, 8000);
    srvOld = null;

    // NEW toma el pedido pendiente_pago que dejo OLD y genera un enlace de
    // pago REAL (mismo mock de Clip ya establecido en este proyecto --
    // fase-emision-operacional-durable.mjs, fase-pagos-expiracion.mjs).
    const { guardarIntegracionPago, marcarProveedorPrincipal } = await import('../src/services/integracionesService.js');
    await guardarIntegracionPago(NEG, 'clip', { apiKey: 'test-key-no-real', apiSecret: 'test-secret-no-real' }, { actualizadoPor: SEED.superadminUsuarioId });
    await marcarProveedorPrincipal(NEG, 'clip', SEED.superadminUsuarioId);
    process.env.CLIP_API_BASE_URL = `http://localhost:${clipMockPuerto}`;

    srvNew = await arrancarDesde(RAIZ_NEW, {
      PORT: PUERTO_NEW, XABOR_RUTAS_PRUEBA: '1', DATABASE_URL: urlDesechable,
      CLIP_API_BASE_URL: `http://localhost:${clipMockPuerto}`, XABOR_URL_PUBLICA: `http://localhost:${PUERTO_NEW}`,
    });

    const { crearEnlacePago } = await import('../src/services/pagosService.js');
    const enlace = await crearEnlacePago({ negocioId: NEG, pedidoId: folio, actor: SEED.superadminUsuarioId });
    const pago = (await pool.query(`SELECT * FROM pagos WHERE negocio_id=$1 AND pedido_folio=$2 ORDER BY created_at DESC LIMIT 1`, [NEG, folio])).rows[0];
    assert.ok(pago, 'crearEnlacePago (NEW) no dejo fila en pagos para el pendiente_pago que dejo OLD');
    CHECKOUTS.get(enlace.referenciaExterna).estado = 'COMPLETED';

    // El webhook REAL de NEW -- no una llamada directa a confirmarPedidoPendientePago.
    const wr = await fetch(srvNew.base + '/webhook/clip', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resource: 'CHECKOUT', resource_status: 'COMPLETED', me_reference_id: pago.referencia_interna }),
    });
    assert.strictEqual(wr.status, 200, 'el webhook real de Clip en NEW no respondio 200');

    const activoFinal = await esperarHasta(async () => {
      const a = await pedidoDe(folio);
      return a?.estado === 'nuevo' ? a : null;
    });
    assert.ok(activoFinal, 'el webhook real no libero el pedido a cocina');
    const deuda = await esperarHasta(async () => {
      const d = await deudaExacta(folio, activoFinal.created_at);
      return d?.estado === 'saldada' ? d : null;
    });
    assert.ok(deuda, 'el pago real (via webhook) no dejo la deuda operacional saldada');

    await srvNew.detener();
    srvNew = null;
  });

  // ═══ CASO 4: programado creado por el camino NO atomico real de OLD ═════
  await t('4. programado creado por OLD: sin deuda inmediata; NEW lo activa -> deuda 1, emision 1', async () => {
    srvOld = await arrancarDesde(RAIZ_OLD, { PORT: PUERTO_OLD, XABOR_RUTAS_PRUEBA: '1', DATABASE_URL: urlDesechable, NODE_ENV: 'development' });

    const pasado = new Date(Date.now() - 5 * 60e3).toISOString();
    const r = await fetch(srvOld.base + '/test/pedido-programado-p011', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ programadoPara: pasado }),
    });
    const body = await r.json();
    assert.strictEqual(r.status, 200, `OLD no pudo crear el programado: ${JSON.stringify(body)}`);
    const folio = body.pedido.id;

    assert.strictEqual((await pool.query(`SELECT 1 FROM pedidos_activos WHERE folio=$1 AND negocio_id=$2`, [folio, NEG])).rowCount, 0,
      'OLD no retiro el activo tras programar (el fixture no reproduce el camino real de OLD)');
    assert.strictEqual((await pool.query(`SELECT 1 FROM pedidos_programados WHERE folio=$1`, [folio])).rowCount, 1,
      'OLD no dejo el programado en pedidos_programados');
    assert.strictEqual((await deudasDeFolio(folio)).length, 0,
      'el programado creado por OLD genero una deuda operacional inmediata');

    srvOld.detener();
    await esperarSalida(srvOld.proc, 8000);
    srvOld = null;

    srvNew = await arrancarDesde(RAIZ_NEW, { PORT: PUERTO_NEW, XABOR_RUTAS_PRUEBA: '1', DATABASE_URL: urlDesechable });

    const reactivado = await esperarHasta(async () =>
      (await pool.query(`SELECT created_at, datos FROM pedidos_activos WHERE folio=$1 AND negocio_id=$2`, [folio, NEG])).rows[0] || null,
      { timeoutMs: 20000 });
    assert.ok(reactivado, 'NEW no reactivo el programado que dejo OLD');

    const saldada = await esperarHasta(async () => {
      const d = await deudaExacta(folio, reactivado.created_at);
      return d?.estado === 'saldada' ? d : null;
    }, { timeoutMs: 20000 });
    assert.ok(saldada, `la activacion del programado de OLD no genero una deuda saldada en NEW`);

    const todas = await deudasDeFolio(folio);
    assert.strictEqual(todas.length, 1, `se esperaba UNA sola deuda para el folio activado, hubo ${todas.length}`);
    const compras = await comprasDe(reactivado.datos?.cliente?.telefono);
    assert.strictEqual(compras.length, 1, `la activacion debe registrar EXACTAMENTE una compra real (obtenido ${compras.length})`);

    await srvNew.detener();
    srvNew = null;
  });

} catch (e) {
  console.error('ERROR FATAL:', e.stack || e);
  fallidas++; fallos.push('ERROR FATAL: ' + e.message);
} finally {
  try { if (srvOld) srvOld.detener(); } catch { /* ya abajo */ }
  try { if (srvNew) srvNew.detener(); } catch { /* ya abajo */ }
  try { if (worktreeOld) worktreeOld.limpiar(); } catch { /* best effort */ }
  try { clipMock.close(); } catch { /* ya cerrado */ }
  await destruirBaseDesechable().catch(() => {});
}

console.log(`\n═══ fase-cutover-063-emision-operacional: ${pasadas} OK · ${fallidas} fallos ═══`);
if (fallos.length) console.log('Fallos: ' + fallos.join(' | '));
process.exit(fallidas ? 1 : 0);
