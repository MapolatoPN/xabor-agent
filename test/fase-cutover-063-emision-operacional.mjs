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
import WebSocket from 'ws';

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
  // P0-11D: la plantilla de seed trae docenas de pedidos_activos legacy
  // 'nuevo'/'en_preparacion'/'listo' ajenos a esta suite (ruido del seed
  // general, no pedidos que ninguna prueba aqui cree ni verifique). Con el
  // backfill nuevo, CUALQUIERA de esas filas ambiguas bloquearia
  // predeploy-063 en TODOS los casos, no solo en el que de verdad prueba el
  // bloqueo -- se retiran antes de que la suite empiece, para que solo el
  // pedido P que cada caso crea explicitamente determine si predeploy pasa
  // o aborta.
  await pool.query(`DELETE FROM pedidos_activos WHERE estado IN ('nuevo', 'en_preparacion', 'listo')`);
  // ...pero ese DELETE le rompe el contador a OLD si la plantilla creció:
  // OLD (0f9e82b) siembra su folio de MAX(pedidos_activos) al arrancar,
  // mientras que los claims de la 061 en la plantilla avanzan con cada
  // corrida de las demas suites (via folio_pedido_seq). Si el MAX restante
  // (solo filas terminales, potencialmente viejas) queda cientos de folios
  // por detras de los claims, la barrera 060 bloquea los 20 candidatos de
  // OLD -> FOLIO_NO_DISPONIBLE y ningun caso puede ni crear un pedido
  // (observado de verdad durante las mutaciones finales). En produccion no
  // pasa: el tablero vivo mantiene su MAX pegado a los claims. Se siembra
  // aqui una fila TERMINAL con un folio fresco de la secuencia (nunca
  // reclamado, la barrera lo deja pasar y el INSERT lo reclama), para que
  // el contador de OLD arranque por delante de todos los claims.
  const { rows: [sem] } = await pool.query(`SELECT nextval('folio_pedido_seq')::int AS n`);
  await pool.query(
    `INSERT INTO pedidos_activos (folio, negocio_id, estado, datos) VALUES ($1,$2,'entregado',$3::jsonb)`,
    [`XAB-${sem.n}`, NEG, JSON.stringify({ id: `XAB-${sem.n}`, cliente: { telefono: '8990000000' }, total: 0, semilla_contador_old: true })]);
  // Y por la misma razon: el seed trae pedidos_programados sin activar cuyo
  // horario ya paso -- el job de arranque de CUALQUIER servidor (OLD o NEW,
  // activarPedidosProgramados) los reinsertaria como 'nuevo' frescos en
  // cada caso, contaminando el conteo de ambiguos. Se marcan activados (son
  // ruido de seed, ningun caso de esta suite los crea ni los verifica; el
  // caso 4 crea SU PROPIO programado por la ruta real de OLD).
  await pool.query(`UPDATE pedidos_programados SET activado = TRUE WHERE activado = FALSE`);
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
  const tocados = status.split('\n').map(l => l.trim()).filter(Boolean).sort();
  const esperados = ['M src/orders/orderManager.js', 'M src/server.js'];
  if (JSON.stringify(tocados) !== JSON.stringify(esperados)) {
    throw new Error(`el worktree OLD tiene archivos tocados distintos de los esperados por el patch tras aplicarlo: "${status}"`);
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

// P0-11D: conecta al /ws/panel REAL (mismo patron que
// fase-emision-operacional-crash-real.mjs) y resuelve en cuanto observa el
// `nuevo_pedido` real del folio dado -- nunca se asume que el panel ya lo
// vio, se espera el evento real.
function conectarWsPanel(baseUrl, cookie) {
  const wsUrl = baseUrl.replace('http://', 'ws://') + '/ws/panel';
  const ws = new WebSocket(wsUrl, { headers: { Cookie: cookie } });
  const vistos = [];
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg?.tipo === 'nuevo_pedido') vistos.push(msg.pedido?.id);
    } catch { /* frames no-JSON */ }
  });
  const abierto = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
    setTimeout(() => reject(new Error('timeout abriendo /ws/panel')), 8000);
  });
  return {
    abierto,
    esperarNuevoPedido: (folio, timeoutMs = 15000) => esperarHasta(
      async () => (vistos.includes(folio) ? true : null), { timeoutMs, intervaloMs: 100 }),
    cerrar: () => { try { ws.close(); } catch { /* ya cerrado */ } },
  };
}

// P0-11D: ruta productiva REAL para avanzar el estado de un pedido desde el
// panel (`PATCH /pedidos/:id/estado`, orderManager.js: actualizarEstadoPedido)
// -- nunca un UPDATE manual a la base.
async function avanzarEstadoReal(baseUrl, cookie, folio, estado) {
  const r = await fetch(`${baseUrl}/pedidos/${folio}/estado`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ estado }),
  });
  assert.strictEqual(r.status, 200, `PATCH /pedidos/${folio}/estado -> ${estado} fallo (status ${r.status})`);
  return r.json();
}

// P0-11D, casos 9/10 (mutacion): devuelve el SQL REAL de la migracion con
// UNA sustitucion textual puntual -- nunca reescribe el archivo en disco,
// solo el texto en memoria que se manda a `pool.query`. Exige que el texto
// buscado aparezca EXACTAMENTE una vez, para no mutar por accidente la
// rama equivocada del backfill (hay dos INSERT parecidos).
function sqlMigracionMutada(buscar, reemplazar) {
  const original = readFileSync(join(RAIZ_NEW, 'migrations', '063_emision_operacional.sql'), 'utf8');
  const apariciones = original.split(buscar).length - 1;
  assert.strictEqual(apariciones, 1,
    `el texto a mutar debe aparecer EXACTAMENTE una vez en la migracion real, aparecio ${apariciones} veces -- actualizar esta mutacion de prueba`);
  return original.replace(buscar, reemplazar);
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

// P0-11D: regresa la base al estado "sin 063" -- exactamente los mismos
// DROP que crearBaseDesechable usa para virginizar la copia del template.
// Necesario porque VARIOS casos de esta suite (5, 7, 8, y las mutaciones
// 9/10) reproducen la ventana PRE-063, que exige que el trigger NO exista
// cuando OLD inserta el pedido -- una vez instalada la 063 por un caso
// anterior, el INSERT generaria origen='trigger' y el caso ya no estaria
// probando el backfill sino el camino normal post-063 (falso verde).
async function desinstalar063() {
  await pool.query(`DROP TRIGGER IF EXISTS trg_asegurar_emision_operacional ON pedidos_activos`);
  await pool.query(`DROP FUNCTION IF EXISTS xabor_asegurar_emision_operacional()`);
  await pool.query(`DROP TABLE IF EXISTS pedido_emisiones`);
}

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

  // ═══ Los casos PRE-063 (7, 8 y 5) corren PRIMERO, cada uno sobre base
  // VIRGEN (sin trigger ni tabla): reproducen la ventana en la que OLD
  // acepta un pedido ANTES de que la 063 exista. Los casos 1-4 corren
  // DESPUES: para ellos, que la 063 ya este instalada (idempotente y
  // re-ejecutable por diseño) es indistinguible de un cutover real donde
  // OLD sigue vivo un rato mas tras el deploy. ════════════════════════════
  // ═══ CASOS 7 y 8 (P0-11D) primero: la
  // funcion reproducirLegacyAmbiguoConEstadoAvanzado (declarada mas abajo,
  // hoisting de function declaration) desinstala la 063 y limpia su pedido
  // al terminar, para que el siguiente caso pre-063 arranque virgen. ═══════
  await t('7. P0-11D: panel vio nuevo_pedido, personal avanzo a en_preparacion, impresion legacy incompleta -- NUNCA se asume emitido',
    () => reproducirLegacyAmbiguoConEstadoAvanzado('caso 7 (en_preparacion)', 'en_preparacion', '8990000007'));

  await t('8. P0-11D: mismo escenario con estado=listo -- misma frontera fail-closed',
    () => reproducirLegacyAmbiguoConEstadoAvanzado('caso 8 (listo)', 'listo', '8990000008'));

  await t('5. P0-11C/D: OLD acepta P justo antes de la 063 (estado=nuevo) -- NUNCA se asume ni se auto-ejecuta, solo revision explicita', async () => {
    assert.strictEqual(await hayTablaDeuda(), false,
      'caso 5: la 063 ya esta instalada -- este caso exige base virgen (revisar la limpieza del caso anterior)');
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
    assert.strictEqual(r063p.code, 1, 'predeploy-063 debe ABORTAR (P0-11D): P quedo requiere_revision sin resolver, el deploy no puede pasar en silencio');
    assert.match(r063p.salida, /requiere_revision|deuda\(s\) legacy ambigua/,
      `predeploy-063 aborto por una razon distinta a la esperada:\n${r063p.salida.slice(-1500)}`);

    // La 063 (tabla+trigger+backfill) SI quedo instalada aunque el script
    // haya salido con error -- P0-11D exige exactamente esto: el trigger
    // protege TODO pedido nuevo desde este instante, solo el conjunto
    // ambiguo preexistente bloquea el exit code.
    assert.strictEqual(await hayTablaDeuda(), true, 'la 063 debio quedar instalada aunque el predeploy haya abortado por ambiguos sin resolver');

    const deudaTrasBackfill = await deudaExacta(folio, activo.created_at);
    assert.ok(deudaTrasBackfill, 'P no recibio NINGUNA fila del backfill -- el fixture no reproduce la ventana');
    assert.strictEqual(deudaTrasBackfill.origen, 'legacy_ambiguo_no_verificado',
      `P debe backfillearse por la rama B (estado='nuevo', ambiguo) -- obtenido origen=${deudaTrasBackfill.origen}`);
    assert.strictEqual(deudaTrasBackfill.estado, 'requiere_revision',
      `P0-11D: P NUNCA debe quedar EJECUTABLE en automatico ni asumido saldado -- obtenido estado=${deudaTrasBackfill.estado}`);

    srvOld.detener();
    await esperarSalida(srvOld.proc, 8000);
    srvOld = null;

    // NEW arranca: su reconciliador SOLO procesa estado='pendiente' -- P
    // debe permanecer intacto en 'requiere_revision' pase el tiempo que
    // pase, sin ninguna llamada manual de este test a emitir/reconciliar.
    srvNew = await arrancarDesde(RAIZ_NEW, { PORT: PUERTO_NEW, XABOR_RUTAS_PRUEBA: '1', DATABASE_URL: urlDesechable });
    await esperar(4000);
    const trasEsperar = await deudaExacta(folio, activo.created_at);
    assert.strictEqual(trasEsperar.estado, 'requiere_revision',
      `P0-11D: NEW NO debe auto-ejecutar un legacy ambiguo -- obtenido estado=${trasEsperar.estado} (violacion: se reimprimiria/asumiria en automatico)`);

    // Resolucion humana explicita y durable (nunca un heuristico de tiempo):
    // se decide "requiere reimpresion" -- a partir de ahi SI es una deuda
    // 'pendiente' normal, y el reconciliador real de NEW la completa sola.
    const { resolverEmisionLegacyAmbigua } = await import('../src/services/database.js');
    await resolverEmisionLegacyAmbigua(NEG, folio, activo.created_at, 'requiere_reimpresion', 'prueba P0-11D caso 5');

    // La resolucion llego DESPUES de la pasada de arranque del
    // reconciliador de NEW -- la siguiente pasada periodica es a los 45s
    // (server.js), asi que el margen debe superar un intervalo completo.
    const saldada = await esperarHasta(async () => {
      const d = await deudaExacta(folio, activo.created_at);
      return d?.estado === 'saldada' ? d : null;
    }, { timeoutMs: 60000 });
    assert.ok(saldada, `tras la resolucion explicita, NEW debio completar la emision (obtenido: ${JSON.stringify(await deudaExacta(folio, activo.created_at))})`);
    assert.strictEqual(saldada.origen, 'legacy_revisado_manual', 'el origen no reflejo la resolucion manual');
    // P0-11E: decision, nota e instante de la decision sobreviven al recovery.
    assert.strictEqual(saldada.resuelto_decision, 'requiere_reimpresion',
      `resuelto_decision debe sobrevivir al recovery -- obtenido ${saldada.resuelto_decision}`);
    assert.strictEqual(saldada.resuelto_nota, 'prueba P0-11D caso 5', 'la nota no sobrevivio intacta al recovery');
    assert.ok(saldada.resuelto_at, 'resuelto_at quedo NULL');

    const compras = await comprasDe(activo.datos?.cliente?.telefono);
    assert.strictEqual(compras.length, 1, `P debe terminar con EXACTAMENTE una compra real (obtenido ${compras.length})`);

    await srvNew.detener();
    srvNew = null;
  });

  // ═══ CASO 1: OLD vivo, se aplica la 063 en caliente, pedido normal ═══════
  await t('1. OLD vivo + 063 aplicada en caliente: el trigger crea la deuda aunque OLD no la conozca', async () => {
    srvOld = await arrancarDesde(RAIZ_OLD, { PORT: PUERTO_OLD, XABOR_RUTAS_PRUEBA: '1', DATABASE_URL: urlDesechable, NODE_ENV: 'development' });

    // Este re-run de predeploy tras el abort del caso 5 ES el escenario G
    // del pedido de auditoria: los ambiguos preexistentes ya se resolvieron
    // (caso 5), asi que la segunda ejecucion pasa con exit 0.
    const r063 = await aplicar063();
    assert.strictEqual(r063.code, 0, `predeploy-063 fallo (exit ${r063.code}):\n${r063.salida.slice(-1500)}`);
    assert.strictEqual(await hayTablaDeuda(), true, 'predeploy-063 no dejo la tabla pedido_emisiones');

    // Escenario A del pedido de auditoria: los legacy TERMINALES
    // (entregado/cancelado, decenas en el seed) no bloquean el deploy (el
    // exit 0 de arriba ya lo prueba) y jamas se cocinan: TODOS quedan
    // 'saldada' -- ninguno en un estado que el reconciliador pudiera
    // ejecutar.
    const { rows: [term] } = await pool.query(`SELECT
      (SELECT COUNT(*)::int FROM pedidos_activos WHERE estado IN ('entregado','cancelado')) AS activos_terminales,
      (SELECT COUNT(*)::int FROM pedido_emisiones WHERE origen='legacy_asumida_emitida' AND estado='saldada') AS saldadas,
      (SELECT COUNT(*)::int FROM pedido_emisiones WHERE origen='legacy_asumida_emitida' AND estado<>'saldada') AS no_saldadas`);
    assert.ok(term.activos_terminales > 0, 'el seed debia traer legacy terminales -- el escenario A no esta probando nada');
    assert.ok(term.saldadas > 0, 'ningun legacy terminal quedo backfilleado saldada');
    assert.strictEqual(term.no_saldadas, 0, `${term.no_saldadas} legacy terminal(es) quedaron en un estado ejecutable/revisable -- un entregado/cancelado jamas debe volver a cocinarse`);

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

  // ═══ CASO 7 (P0-11D, MANDATORIO): panel YA vio el pedido, personal lo
  // avanzo a en_preparacion, la impresion legacy TODAVIA no habia
  // terminado ═══════════════════════════════════════════════════════════
  //
  // Contradice la premisa de la primera correccion de P0-11C ("estado
  // avanzado = ya se imprimio"): el propio P0-11A explica por que la
  // allow-list operacional incluye en_preparacion/listo -- el personal
  // puede avanzar el pedido en el panel MIENTRAS la emision todavia
  // necesita recovery. Y emitirPedido hace Edge -> BROADCAST AL PANEL ->
  // impresion legacy (solo si Edge no se hizo cargo) -- el panel se entera
  // ANTES de que el papel exista.
  //
  // Para hacer el punto de corte DETERMINISTICO (nunca "esperar un poco")
  // se usa la instrumentacion TEST-ONLY versionada en el patch de OLD
  // (XABOR_TEST_PAUSAR_ANTES_DE_PRINT_LEGACY, doble candado NODE_ENV +
  // env explicita -- ver test/fixtures/p011-old-harness.patch): congela el
  // flujo de OLD justo despues del broadcast real y antes de la impresion
  // legacy. El WebSocket observa el `nuevo_pedido` REAL -- no se asume que
  // el panel lo vio, se espera el evento.
  async function reproducirLegacyAmbiguoConEstadoAvanzado(nombreCaso, estadoObjetivo, telefono) {
    // La ventana PRE-063 exige que el trigger NO exista cuando OLD inserta
    // -- si un caso anterior la dejo instalada, el pedido naceria con
    // origen='trigger' y esta prueba dejaria de discriminar (falso verde).
    assert.strictEqual(await hayTablaDeuda(), false,
      `${nombreCaso}: la 063 ya esta instalada -- este caso exige base virgen (revisar el orden de casos / la limpieza del caso anterior)`);

    srvOld = await arrancarDesde(RAIZ_OLD, {
      PORT: PUERTO_OLD, XABOR_RUTAS_PRUEBA: '1', DATABASE_URL: urlDesechable, NODE_ENV: 'development',
      XABOR_TEST_PAUSAR_ANTES_DE_PRINT_LEGACY: '1',
    });
    const ws = conectarWsPanel(srvOld.base, cookie);
    await ws.abierto;

    const r = await fetch(srvOld.base + '/test/pedido', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ cliente: { telefono } }),
    });
    const body = await r.json();
    assert.strictEqual(r.status, 200, `OLD no pudo crear el pedido de prueba: ${JSON.stringify(body)}`);
    const folio = body.pedido.id;

    const visto = await ws.esperarNuevoPedido(folio, 15000);
    assert.ok(visto, `${nombreCaso}: el panel NUNCA recibio el nuevo_pedido REAL de ${folio} -- el fixture no reproduce la ventana`);
    ws.cerrar();

    const antesDeAvanzar = await pedidoDe(folio);
    assert.strictEqual(antesDeAvanzar.estado, 'nuevo', 'el estado no debia haber cambiado todavia -- solo el panel lo vio');

    // La ruta productiva REAL del panel -- nunca un UPDATE manual. La
    // persistencia del cambio es fire-and-forget en OLD
    // (_persistirCambioEstado -> actualizarEstadoPedidoDB sin await), asi
    // que se sondea la base en vez de asumir que el 200 ya la reflejo.
    await avanzarEstadoReal(srvOld.base, cookie, folio, estadoObjetivo);
    const trasAvanzar = await esperarHasta(async () => {
      const p = await pedidoDe(folio);
      return p?.estado === estadoObjetivo ? p : null;
    }, { timeoutMs: 10000 });
    assert.ok(trasAvanzar,
      `la ruta productiva real no dejo el pedido en ${estadoObjetivo} (obtenido ${(await pedidoDe(folio))?.estado})`);

    // OLD sigue vivo, CONGELADO despues del broadcast y antes de la
    // impresion legacy -- la 063 corre EN CALIENTE, el peor caso real.
    const r063 = await aplicar063();
    assert.strictEqual(r063.code, 1, `${nombreCaso}: predeploy-063 debio ABORTAR (P0-11D) -- P quedo requiere_revision sin resolver`);
    assert.match(r063.salida, /requiere_revision|deuda\(s\) legacy ambigua/, `predeploy-063 aborto por una razon distinta a la esperada:\n${r063.salida.slice(-1500)}`);

    const deuda = await deudaExacta(folio, antesDeAvanzar.created_at);
    assert.ok(deuda, `${nombreCaso}: P no recibio NINGUNA fila del backfill -- el fixture no reproduce la ventana`);
    assert.strictEqual(deuda.origen, 'legacy_ambiguo_no_verificado',
      `${nombreCaso}: origen incorrecto -- obtenido ${deuda.origen}`);
    assert.strictEqual(deuda.estado, 'requiere_revision',
      `${nombreCaso}: un pedido en '${estadoObjetivo}' con la impresion legacy TODAVIA incompleta NUNCA debe asumirse saldado -- obtenido estado=${deuda.estado} (EMISION SILENCIOSAMENTE PERDIDA si esto fuera 'saldada')`);

    // Matar a OLD MIENTRAS sigue congelado en la pausa -- nunca se libera,
    // la impresion legacy real jamas llega a ejecutarse en este escenario.
    srvOld.detener();
    await esperarSalida(srvOld.proc, 8000);
    srvOld = null;

    // NEW arranca: su reconciliador SOLO procesa estado='pendiente' -- P
    // debe permanecer en 'requiere_revision' pase el tiempo que pase, SIN
    // ninguna llamada manual de este test a emitir/reconciliar.
    srvNew = await arrancarDesde(RAIZ_NEW, { PORT: PUERTO_NEW, XABOR_RUTAS_PRUEBA: '1', DATABASE_URL: urlDesechable });
    await esperar(4000);
    const trasEsperar = await deudaExacta(folio, antesDeAvanzar.created_at);
    assert.strictEqual(trasEsperar.estado, 'requiere_revision',
      `${nombreCaso}: NEW NO debe auto-ejecutar un legacy ambiguo aunque el estado ya haya avanzado -- obtenido ${trasEsperar.estado}`);

    // Resolucion humana explicita y durable -- a partir de ahi SI es una
    // deuda 'pendiente' normal, y el reconciliador real de NEW la completa.
    const { resolverEmisionLegacyAmbigua } = await import('../src/services/database.js');
    await resolverEmisionLegacyAmbigua(NEG, folio, antesDeAvanzar.created_at, 'requiere_reimpresion', `prueba P0-11D ${nombreCaso}`);

    // La resolucion llego despues de la pasada de arranque del
    // reconciliador de NEW -- la siguiente pasada periodica es a los 45s.
    const saldada = await esperarHasta(async () => {
      const d = await deudaExacta(folio, antesDeAvanzar.created_at);
      return d?.estado === 'saldada' ? d : null;
    }, { timeoutMs: 60000 });
    assert.ok(saldada, `${nombreCaso}: tras la resolucion explicita, NEW debio completar la emision (obtenido: ${JSON.stringify(await deudaExacta(folio, antesDeAvanzar.created_at))})`);
    assert.strictEqual(saldada.origen, 'legacy_revisado_manual', 'el origen no reflejo la resolucion manual');
    // P0-11E: la DECISION sobrevive al recovery. Sin resuelto_decision, esta
    // fila 'saldada' seria indistinguible de un 'confirmado_emitido' -- la
    // auditoria perderia para siempre QUE decidio el humano.
    assert.strictEqual(saldada.resuelto_decision, 'requiere_reimpresion',
      `${nombreCaso}: resuelto_decision debe seguir siendo 'requiere_reimpresion' despues del recovery -- obtenido ${saldada.resuelto_decision}`);
    assert.strictEqual(saldada.resuelto_nota, `prueba P0-11D ${nombreCaso}`,
      `${nombreCaso}: la nota no sobrevivio intacta al recovery`);
    assert.ok(saldada.resuelto_at, `${nombreCaso}: resuelto_at quedo NULL`);

    const compras = await comprasDe(telefono);
    assert.strictEqual(compras.length, 1, `${nombreCaso}: debe terminar con EXACTAMENTE una compra real (obtenido ${compras.length})`);

    await srvNew.detener();
    srvNew = null;

    // Limpieza para el SIGUIENTE caso pre-063: se desinstala la 063 (los
    // mismos DROP con los que crearBaseDesechable virginiza la copia) y se
    // retira el pedido de este caso de pedidos_activos -- si quedara, el
    // proximo backfill lo volveria a marcar 'requiere_revision' (la tabla
    // con su fila 'saldada' se acaba de dropear) y bloquearia predeploy en
    // casos que no lo estan probando.
    await desinstalar063();
    await pool.query(`DELETE FROM pedidos_activos WHERE negocio_id=$1 AND folio=$2`, [NEG, folio]);
  }

  // ═══ CASO 9 (MUTACION): revertir a "estado avanzado = ya emitido" debe
  // reproducir P0-11D en rojo -- prueba que el caso 7 SI discrimina ═══════
  await t('9. MUTACION: revertir el backfill a "en_preparacion/listo = ya emitido" reproduce P0-11D', async () => {
    const buscar = `AND estado IN ('entregado', 'cancelado')`;
    const sqlMutado = sqlMigracionMutada(buscar, `AND estado IN ('en_preparacion', 'listo', 'entregado', 'cancelado')`);

    // La mutacion prueba el BACKFILL sobre un pedido PRE-063: si el trigger
    // siguiera instalado (los casos 1-4 lo dejaron), el INSERT del fixture
    // generaria su deuda por el trigger ANTES del backfill y el ON CONFLICT
    // taparia la mutacion (falso resultado). Se desinstala primero -- la
    // migracion mutada la reinstala al ejecutarse.
    await desinstalar063();
    const folio = `XAB-M9${String(Date.now()).slice(-6)}`;
    await pool.query(
      `INSERT INTO pedidos_activos (folio, negocio_id, estado, datos) VALUES ($1,$2,'en_preparacion',$3::jsonb)`,
      [folio, NEG, JSON.stringify({ id: folio, cliente: { telefono: '8990009009' }, total: 100 })]);
    await pool.query(sqlMutado);

    const fila = (await pool.query(`SELECT estado, origen FROM pedido_emisiones WHERE negocio_id=$1 AND folio=$2`, [NEG, folio])).rows[0];
    assert.ok(fila, 'la mutacion ni siquiera genero una fila -- esta prueba no discrimina nada');
    assert.strictEqual(fila.estado, 'saldada',
      `la mutacion debia reproducir el defecto (asumir 'saldada' incorrectamente) para probar que el caso 7 real lo detectaria -- obtenido ${fila.estado}`);
    console.log('  [mutacion 9] confirmado: con el codigo revertido, en_preparacion con impresion incompleta se marca "saldada" -- el caso 7 real (que exige "requiere_revision") lo habria detectado.');

    await pool.query(`DELETE FROM pedido_emisiones WHERE negocio_id=$1 AND folio=$2`, [NEG, folio]);
    await pool.query(`DELETE FROM pedidos_activos WHERE negocio_id=$1 AND folio=$2`, [NEG, folio]);
  });

  // ═══ CASO 10 (MUTACION): convertir TODO legacy no terminal en pendiente
  // ejecutable viola "no auto-reimprimir" -- prueba que esta invariante
  // esta realmente verificada, no solo declarada ══════════════════════════
  await t('10. MUTACION: convertir legacy no terminal en "pendiente" ejecutable viola "no auto-reimprimir"', async () => {
    const buscar = `SELECT negocio_id, folio, date_trunc('milliseconds', created_at), 'requiere_revision', 'legacy_ambiguo_no_verificado'`;
    const sqlMutado = sqlMigracionMutada(buscar,
      `SELECT negocio_id, folio, date_trunc('milliseconds', created_at), 'pendiente', 'legacy_ambiguo_no_verificado'`);

    // Misma razon que el caso 9: el fixture debe ser un pedido PRE-063.
    await desinstalar063();
    const folio = `XAB-M10${String(Date.now()).slice(-5)}`;
    await pool.query(
      `INSERT INTO pedidos_activos (folio, negocio_id, estado, datos) VALUES ($1,$2,'listo',$3::jsonb)`,
      [folio, NEG, JSON.stringify({ id: folio, cliente: { telefono: '8990009010' }, total: 100 })]);
    await pool.query(sqlMutado);

    const fila = (await pool.query(`SELECT estado, origen FROM pedido_emisiones WHERE negocio_id=$1 AND folio=$2`, [NEG, folio])).rows[0];
    assert.ok(fila, 'la mutacion ni siquiera genero una fila -- esta prueba no discrimina nada');
    assert.strictEqual(fila.estado, 'pendiente',
      `la mutacion debia dejar la fila EJECUTABLE (violando "no auto-reimprimir") para probar la invariante -- obtenido ${fila.estado}`);
    console.log('  [mutacion 10] confirmado: convertir el legacy ambiguo en "pendiente" lo vuelve EJECUTABLE por el reconciliador -- exactamente el auto-reimprimir que el gate prohibe. El diseño real usa "requiere_revision", fuera del alcance del reconciliador.');

    await pool.query(`DELETE FROM pedido_emisiones WHERE negocio_id=$1 AND folio=$2`, [NEG, folio]);
    await pool.query(`DELETE FROM pedidos_activos WHERE negocio_id=$1 AND folio=$2`, [NEG, folio]);
  });

  // ═══ CASO 11 (P0-11E): la resolucion manual es DURABLE y fail-closed ═══
  //
  // La auditoria encontro que la nota era opcional (default NULL) y que la
  // decision no quedaba persistida: tras el recovery de una
  // 'requiere_reimpresion', la fila terminaba estado='saldada'/
  // origen='legacy_revisado_manual' -- IDENTICA a un 'confirmado_emitido' --
  // y la DB perdia para siempre QUE decidio el humano. Este caso cubre la
  // bateria fail-closed completa; la supervivencia de la decision al
  // recovery REAL ya se verifica en los casos 5/7/8 (asserts sobre
  // resuelto_decision/resuelto_nota/resuelto_at tras 'saldada').
  await t('11. P0-11E: nota obligatoria, decision durable, sin doble resolucion, identidad exacta', async () => {
    const { resolverEmisionLegacyAmbigua } = await import('../src/services/database.js');

    // Fixtures PRE-063 por el backfill REAL: sin trigger instalado, dos
    // pedidos 'nuevo', migracion real -> ambos requiere_revision.
    await desinstalar063();
    const marca = String(Date.now()).slice(-6);
    const folioA = `XAB-11${marca.slice(0, 5)}1`;
    const folioB = `XAB-11${marca.slice(0, 5)}2`;
    for (const f of [folioA, folioB]) {
      await pool.query(
        `INSERT INTO pedidos_activos (folio, negocio_id, estado, datos) VALUES ($1,$2,'nuevo',$3::jsonb)`,
        [f, NEG, JSON.stringify({ id: f, cliente: { telefono: '8990000011' }, total: 100 })]);
    }
    await pool.query(readFileSync(join(RAIZ_NEW, 'migrations', '063_emision_operacional.sql'), 'utf8'));

    const deudaDe = async (f) => (await pool.query(
      `SELECT * FROM pedido_emisiones WHERE negocio_id=$1 AND folio=$2`, [NEG, f])).rows[0];
    let dA = await deudaDe(folioA);
    assert.strictEqual(dA?.estado, 'requiere_revision', 'el fixture A no quedo ambiguo');
    const creadoA = dA.pedido_creado_at;
    const creadoB = (await deudaDe(folioB)).pedido_creado_at;

    // 1. Sin nota -> falla ANTES de tocar la fila.
    await assert.rejects(
      () => resolverEmisionLegacyAmbigua(NEG, folioA, creadoA, 'confirmado_emitido'),
      /OBLIGATORIA/, 'resolver sin nota debio fallar');
    // 2. Nota solo whitespace -> falla igual.
    await assert.rejects(
      () => resolverEmisionLegacyAmbigua(NEG, folioA, creadoA, 'confirmado_emitido', '   \t '),
      /OBLIGATORIA/, 'una nota de puro whitespace debio fallar');
    // 3. Decision fuera de las dos conocidas -> falla.
    await assert.rejects(
      () => resolverEmisionLegacyAmbigua(NEG, folioA, creadoA, 'resolver_como_sea', 'nota valida'),
      /invalida/, 'una decision desconocida debio fallar');
    // 4. Identidad equivocada (pedido_creado_at de OTRA instancia del folio)
    //    -> no toca nada.
    const creadoDesplazado = new Date(new Date(creadoA).getTime() + 1);
    await assert.rejects(
      () => resolverEmisionLegacyAmbigua(NEG, folioA, creadoDesplazado, 'confirmado_emitido', 'nota valida'),
      /nada que resolver/, 'una identidad desplazada 1ms debio fallar sin tocar nada');
    dA = await deudaDe(folioA);
    assert.strictEqual(dA.estado, 'requiere_revision', 'algun intento invalido SI toco la fila');
    assert.strictEqual(dA.resuelto_decision, null, 'algun intento invalido dejo resuelto_decision');
    assert.strictEqual(dA.resuelto_nota, null, 'algun intento invalido dejo resuelto_nota');
    assert.strictEqual(dA.resuelto_at, null, 'algun intento invalido dejo resuelto_at');

    // 5. El CLI tambien falla cerrado sin --nota (y sin abrir conexion).
    const cli = (args) => new Promise((resolve) => {
      const p = spawn(process.execPath, [join(RAIZ_NEW, 'scripts', 'resolver-legacy-ambiguo-063.mjs'), ...args],
        { cwd: RAIZ_NEW, env: { ...process.env, DATABASE_URL: urlDesechable }, stdio: ['ignore', 'pipe', 'pipe'] });
      let salida = '';
      p.stdout.on('data', d => salida += d);
      p.stderr.on('data', d => salida += d);
      p.on('exit', (code) => resolve({ code, salida }));
    });
    // El texto EXACTO de la columna (timestamp SIN tz): es lo que un
    // operador copia de un SELECT. Un toISOString() con 'Z' NO sirve --
    // Postgres tomaria la parte literal en UTC y jamas coincidiria con el
    // valor naive guardado (la misma trampa de timezone documentada en la
    // migracion 063).
    const { rows: [{ t: creadoTextoA }] } = await pool.query(
      `SELECT pedido_creado_at::text AS t FROM pedido_emisiones WHERE negocio_id=$1 AND folio=$2`, [NEG, folioA]);
    const identidadA = [`--negocio=${NEG}`, `--folio=${folioA}`, `--creadoAt=${creadoTextoA}`];
    let rc = await cli([...identidadA, '--resolucion=confirmado_emitido']);
    assert.strictEqual(rc.code, 1, 'el CLI sin --nota debio salir 1');
    assert.match(rc.salida, /OBLIGATORIA/, 'el CLI no explico que la nota es obligatoria');
    rc = await cli([...identidadA, '--resolucion=confirmado_emitido', '--nota=   ']);
    assert.strictEqual(rc.code, 1, 'el CLI con nota whitespace debio salir 1');
    dA = await deudaDe(folioA);
    assert.strictEqual(dA.estado, 'requiere_revision', 'el CLI invalido toco la fila');

    // 6. confirmado_emitido valido (por el CLI real) -> saldada + rastro completo.
    rc = await cli([...identidadA, '--resolucion=confirmado_emitido', '--nota=comanda fisica verificada en el local']);
    assert.strictEqual(rc.code, 0, `el CLI valido fallo: ${rc.salida.slice(-400)}`);
    dA = await deudaDe(folioA);
    assert.strictEqual(dA.estado, 'saldada');
    assert.strictEqual(dA.resuelto_decision, 'confirmado_emitido');
    assert.strictEqual(dA.resuelto_nota, 'comanda fisica verificada en el local');
    assert.ok(dA.resuelto_at, 'resuelto_at quedo NULL tras confirmar');
    assert.ok(dA.saldada_at, 'saldada_at quedo NULL tras confirmar');

    // 7. Resolver DE NUEVO -> falla cerrado, la decision original no cambia.
    await assert.rejects(
      () => resolverEmisionLegacyAmbigua(NEG, folioA, creadoA, 'requiere_reimpresion', 'intento de sobreescritura'),
      /nada que resolver/, 'resolver dos veces debio fallar');
    dA = await deudaDe(folioA);
    assert.strictEqual(dA.resuelto_decision, 'confirmado_emitido', 'la doble resolucion sobreescribio la decision');
    assert.strictEqual(dA.resuelto_nota, 'comanda fisica verificada en el local', 'la doble resolucion sobreescribio la nota');

    // 8. requiere_reimpresion (fixture B): decision durable YA desde el paso
    //    a 'pendiente', antes de cualquier recovery.
    const r = await resolverEmisionLegacyAmbigua(NEG, folioB, creadoB, 'requiere_reimpresion', 'sin evidencia de papel, reimprimir');
    assert.strictEqual(r.estado, 'pendiente');
    const dB = await deudaDe(folioB);
    assert.strictEqual(dB.estado, 'pendiente');
    assert.strictEqual(dB.resuelto_decision, 'requiere_reimpresion');
    assert.strictEqual(dB.resuelto_nota, 'sin evidencia de papel, reimprimir');
    assert.ok(dB.resuelto_at, 'resuelto_at quedo NULL tras ordenar reimpresion');

    // Limpieza (la fila B quedo 'pendiente' sin servidor que la procese --
    // borrar el fixture evita que un caso futuro herede una deuda ejecutable
    // ajena; la supervivencia al recovery REAL ya esta cubierta en 5/7/8).
    for (const f of [folioA, folioB]) {
      await pool.query(`DELETE FROM pedido_emisiones WHERE negocio_id=$1 AND folio=$2`, [NEG, f]);
      await pool.query(`DELETE FROM pedidos_activos WHERE negocio_id=$1 AND folio=$2`, [NEG, f]);
    }
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
