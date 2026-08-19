// ─── P0-11 FASE 3: cutover OLD -> NEW con la 063, alcance estrecho ──────────
//
// OLD real = commit 0f9e82b (origin/main), en un worktree git separado
// (C:\xabor-old-p011-cutover), corrido como proceso hijo real -- nunca
// simulado. NEW = esta misma rama. Misma base Postgres desechable
// (xabor_p011_cutover, copia por TEMPLATE de la base local) para los dos.
//
// Alcance (exactamente lo pedido, nada mas): pedido normal, crash antes de
// emitir, pendiente_pago, y programado. Nada de Clip, deploy, main, Railway
// ni cambios de Meta/WhatsApp.
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import assert from 'assert';
import pkg from 'pg';

const { Pool, Client } = pkg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const RAIZ_NEW = join(__dirname, '..');
const RAIZ_OLD = 'C:\\xabor-old-p011-cutover';
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));

const BASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:testpass@localhost:55453/edged1';
const DESECHABLE = 'xabor_p011_cutover';
const urlDesechable = BASE_URL.replace(/\/[^/?]+(\?|$)/, `/${DESECHABLE}$1`);
// Este PROCESO tambien llama funciones de NEW directamente (no solo via
// HTTP a los hijos), asi que su propio database.js debe apuntar a la base
// desechable -- si no, "confirmarPedidoPendientePago" (import directo)
// conecta al pool contra la base local de siempre y nunca encuentra la fila.
process.env.DATABASE_URL = urlDesechable;
const nombreOrigen = (BASE_URL.match(/\/([^/?]+)(\?|$)/) || [])[1];
const urlAdmin = BASE_URL.replace(/\/[^/?]+(\?|$)/, '/postgres$1');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

const NEG = SEED.negocioA;
let pool = null;

/**
 * Base desechable, copia por TEMPLATE de la base local (mismo patron que
 * fase-cutover-059.mjs): se crea y se destruye en cada corrida, para que
 * esta suite sea re-ejecutable de forma autonoma dentro de la bateria
 * completa, sin pasos manuales previos.
 */
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
  // pg_terminate_backend en destruirBaseDesechable() puede cortar una
  // conexion del pool a mitad de su cierre -- sin este handler, ese error
  // asincrono no tiene listener y tumba el proceso entero DESPUES de que
  // todos los asserts ya pasaron.
  pool.on('error', () => {});
  // Retira los objetos de la 063 para representar "antes del deploy": el
  // resto del esquema (059-062 incluidos) se conserva tal cual esta en la
  // base local, que es exactamente la situacion real de un cutover -- OLD
  // (0f9e82b) ya convive con esas migraciones previas.
  await pool.query(`DROP TRIGGER IF EXISTS trg_asegurar_emision_operacional ON pedidos_activos`);
  await pool.query(`DROP FUNCTION IF EXISTS xabor_asegurar_emision_operacional()`);
  await pool.query(`DROP TABLE IF EXISTS pedido_emisiones`);
}

async function destruirBaseDesechable() {
  if (pool) await pool.end().catch(() => {});
  // Este proceso tambien abrio, vía imports dinamicos (confirmarPedidoPendientePago,
  // reconciliarEmisionesOperacionalesPendientes, etc.), el pool COMPARTIDO de
  // database.js -- cerrarlo tambien, o pg_terminate_backend le corta la
  // conexion sin listener de error y tumba el proceso.
  try {
    const { pool: poolCompartido, poolDeClaims } = await import('../src/services/database.js');
    await poolCompartido.end().catch(() => {});
    // poolDeClaims() es un singleton lazy: si algun escenario lo disparo
    // (conEmisionExclusiva/conEmisionOperacionalExclusiva), esta llamada
    // devuelve la MISMA instancia ya creada, nunca una nueva.
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

function esperar(ms) { return new Promise(r => setTimeout(r, ms)); }
async function esperarHasta(fn, { timeoutMs = 20000, intervaloMs = 200 } = {}) {
  const lim = Date.now() + timeoutMs;
  for (;;) {
    const r = await fn();
    if (r) return r;
    if (Date.now() > lim) return null;
    await esperar(intervaloMs);
  }
}

/** Variante de lib-servidor.mjs::arrancarServidor que acepta un cwd/raiz arbitrario. */
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
function esperarSalida(proc, timeoutMs = 15000) {
  if (proc.exitCode !== null) return Promise.resolve(proc.exitCode);
  return new Promise((resolve) => { const to = setTimeout(() => resolve(null), timeoutMs); proc.once('exit', (c) => { clearTimeout(to); resolve(c); }); });
}

async function cookieAdminA() {
  // crearTokenSesion es identico entre OLD y NEW en esta ventana de commits
  // (no forma parte de lo que P0-11 toco); se usa la version de NEW porque
  // es el mismo proceso Node que corre este script de prueba.
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

let cookie = null;
let srvOld = null, srvNew = null;
const PUERTO_OLD = process.env.TEST_PORT_CUTOVER_OLD || '4611';
const PUERTO_NEW = process.env.TEST_PORT_CUTOVER_NEW || '4612';

try {
  if (!existsSync(join(RAIZ_OLD, 'src', 'server.js'))) {
    throw new Error(
      `Falta el worktree OLD en ${RAIZ_OLD}. Crearlo con:\n` +
      `  git worktree add ${RAIZ_OLD} 0f9e82b\n` +
      `  (junction de node_modules, ver docs del commit de Fase 3)\n` +
      `y agregar las dos rutas de prueba locales (nunca comiteadas) a su server.js:\n` +
      `  /test/pedido-programado-p011 y /test/pedido-pendiente-pago-p011.`);
  }

  await crearBaseDesechable();
  cookie = await cookieAdminA();

  assert.strictEqual(await hayTablaDeuda(), false, 'la base desechable ya tiene pedido_emisiones: no representa "antes de 063"');

  // ═══ ESCENARIO 1: OLD vivo, se aplica 063 en caliente, OLD recibe un pedido normal ═══
  await t('1. OLD vivo + 063 aplicada en caliente: el trigger crea la deuda aunque OLD no la conozca', async () => {
    srvOld = await arrancarDesde(RAIZ_OLD, { PORT: PUERTO_OLD, XABOR_RUTAS_PRUEBA: '1', DATABASE_URL: urlDesechable, NODE_ENV: 'development' });

    const r063 = await aplicar063();
    assert.strictEqual(r063.code, 0, `predeploy-063 fallo (exit ${r063.code}):\n${r063.salida.slice(-1500)}`);
    assert.strictEqual(await hayTablaDeuda(), true, 'predeploy-063 no dejo la tabla pedido_emisiones');

    // OLD sigue vivo, SIN reiniciar, y ahora recibe un pedido normal.
    const r = await fetch(srvOld.base + '/test/pedido', { method: 'POST', headers: { Cookie: cookie } });
    const body = await r.json();
    assert.strictEqual(r.status, 200, `OLD /test/pedido fallo: ${JSON.stringify(body)}`);
    const folio = body.pedido.id;

    const activo = await pedidoDe(folio);
    assert.ok(activo, 'el pedido de OLD no quedo en pedidos_activos');
    const deuda = await esperarHasta(async () => await deudaExacta(folio, activo.created_at));
    assert.ok(deuda, 'el trigger de la 063 NO creo deuda para un INSERT hecho por el binario OLD -- justo lo que la 063 tiene que garantizar sin depender de codigo de aplicacion');
    assert.strictEqual(deuda.origen, 'trigger', 'la deuda no vino del trigger DB');

    // OLD termina su propio ciclo de emision (best-effort, sin saber de la deuda).
    await esperar(800);

    // OLD muere, NEW arranca sobre la MISMA base.
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

  // ═══ ESCENARIO 2: OLD recibe pedido y muere ANTES de que su propia emision termine ═══
  await t('2. OLD recibe pedido y muere antes de emitir: NEW hace el recovery automatico', async () => {
    srvOld = await arrancarDesde(RAIZ_OLD, { PORT: PUERTO_OLD, XABOR_RUTAS_PRUEBA: '1', DATABASE_URL: urlDesechable, NODE_ENV: 'development' });

    const r = await fetch(srvOld.base + '/test/pedido', { method: 'POST', headers: { Cookie: cookie } });
    const body = await r.json();
    assert.strictEqual(r.status, 200);
    const folio = body.pedido.id;

    // Muerte REAL, deliberadamente INMEDIATA: OLD no tiene ningun punto de
    // fallo inyectable (es codigo de antes de P0-9/P0-11), asi que la unica
    // forma de reproducir "muere antes de emitir" sobre el binario REAL es
    // matarlo lo mas cerca posible de la respuesta HTTP -- el fire-and-forget
    // de OLD (emitirPedido(pedido), sin await) puede o no haber empezado.
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

  // ═══ ESCENARIO 3: OLD recibe pendiente_pago (via anticipo estructurado), luego NEW confirma el pago ═══
  await t('3. pendiente_pago con OLD: deuda operacional 0; NEW confirma el pago -> deuda 1 -> emision', async () => {
    srvOld = await arrancarDesde(RAIZ_OLD, { PORT: PUERTO_OLD, XABOR_RUTAS_PRUEBA: '1', DATABASE_URL: urlDesechable, NODE_ENV: 'development' });

    // Ruta de prueba local (solo en el worktree OLD, nunca comiteada) que
    // llama a la MISMA guardarPedidoActivo real de OLD con el pedido en la
    // forma exacta que produce el gate real de anticipo estructurado
    // (CANALES_ORDEN_LLM + pedido_requiere_anticipo, ya presente en 0f9e82b)
    // cuando resuelve estadoInicial='pendiente_pago' -- sin pasar por el
    // validador de catalogo, que es irrelevante para lo que la 063 prueba
    // (el trigger solo mira la columna estado, nunca el contenido del pedido).
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

    srvNew = await arrancarDesde(RAIZ_NEW, { PORT: PUERTO_NEW, XABOR_RUTAS_PRUEBA: '1', DATABASE_URL: urlDesechable });
    const { confirmarPedidoPendientePago } = await import('../src/orders/orderManager.js');
    const confirmado = await confirmarPedidoPendientePago(folio, NEG);
    assert.ok(confirmado, 'confirmarPedidoPendientePago (NEW) no confirmo el pedido que dejo OLD');

    const activoFinal = await pedidoDe(folio);
    assert.strictEqual(activoFinal.estado, 'nuevo', 'la confirmacion no libero el pedido a cocina');
    const deuda = await esperarHasta(async () => {
      const d = await deudaExacta(folio, activoFinal.created_at);
      return d?.estado === 'saldada' ? d : null;
    });
    assert.ok(deuda, 'la transicion pendiente_pago->nuevo (via NEW) no dejo la deuda operacional saldada');

    await srvNew.detener();
    srvNew = null;
  });

  // ═══ ESCENARIO 4: OLD crea un programado (su propio camino no-atomico); NEW lo activa despues ═══
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

    // El camino REAL de OLD (whatsapp-meta.js: guardarPedidoProgramado +
    // eliminarPedido, dos sentencias separadas, sin atomicidad -- P0-15C):
    // el activo debe haber desaparecido y el programado debe existir.
    assert.strictEqual((await pool.query(`SELECT 1 FROM pedidos_activos WHERE folio=$1 AND negocio_id=$2`, [folio, NEG])).rowCount, 0,
      'OLD no retiro el activo tras programar (el fixture no reproduce el camino real de OLD)');
    assert.strictEqual((await pool.query(`SELECT 1 FROM pedidos_programados WHERE folio=$1`, [folio])).rowCount, 1,
      'OLD no dejo el programado en pedidos_programados');
    assert.strictEqual((await deudasDeFolio(folio)).length, 0,
      'el programado creado por OLD genero una deuda operacional inmediata (la 063 debe excluir el INSERT temporal con programado_para presente y programado_id ausente)');

    srvOld.detener();
    await esperarSalida(srvOld.proc, 8000);
    srvOld = null;

    // NEW arranca; su scheduler productivo (activarPedidosProgramados) corre
    // al iniciar y activa el programado vencido que dejo OLD.
    srvNew = await arrancarDesde(RAIZ_NEW, { PORT: PUERTO_NEW, XABOR_RUTAS_PRUEBA: '1', DATABASE_URL: urlDesechable });

    const reactivado = await esperarHasta(async () =>
      (await pool.query(`SELECT created_at, datos FROM pedidos_activos WHERE folio=$1 AND negocio_id=$2`, [folio, NEG])).rows[0] || null,
      { timeoutMs: 20000 });
    assert.ok(reactivado, 'NEW no reactivo el programado que dejo OLD');

    const saldada = await esperarHasta(async () => {
      const d = await deudaExacta(folio, reactivado.created_at);
      return d?.estado === 'saldada' ? d : null;
    }, { timeoutMs: 20000 });
    assert.ok(saldada, `la activacion del programado de OLD no genero una deuda saldada en NEW (obtenido: ${JSON.stringify(await deudaExacta(folio, reactivado.created_at))})`);

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
  await destruirBaseDesechable().catch(() => {});
}

console.log(`\n═══ fase-cutover-063-emision-operacional: ${pasadas} OK · ${fallidas} fallos ═══`);
if (fallos.length) console.log('Fallos: ' + fallos.join(' | '));
process.exit(fallidas ? 1 : 0);
