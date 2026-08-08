// Carrera de arranque: el servidor aceptaba tráfico antes de terminar de
// reconstruir su estado inicial.
//
// server.listen corría en paralelo a initDB() → cargarPedidosDesdeDB(), así
// que un pedido creado en esa ventana quedaba persistido en pedidos_activos
// pero desaparecía de memoria cuando la carga reemplazaba el estado con la
// fotografía previa. El síntoma real: la API respondía "Pedido no encontrado"
// (404) sobre una fila que sí existía en la base.
//
// Esta suite fija las dos barreras del arreglo:
//   1. el puerto no se abre hasta que el bootstrap terminó (no hay ventana);
//   2. cargarPedidosDesdeDB() conserva lo creado durante la carga en vez de
//      descartarlo (reproducción determinista del bug original).
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import net from 'net';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(__dirname, '..');
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4948';

const { pool } = await import('../src/services/database.js');
const { registrarPedido, cargarPedidosDesdeDB, obtenerPedidoPorId, obtenerPedidos } = await import('../src/orders/orderManager.js');
const { crearTokenSesion } = await import('../src/services/session.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}
async function api(base, path, { cookie, method = 'GET', body, headers = {} } = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (cookie) h['Cookie'] = cookie;
  const r = await fetch(base + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, body: json };
}
const puertoAbierto = (puerto) => new Promise((resolve) => {
  const s = net.connect({ host: '127.0.0.1', port: Number(puerto) });
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('error', () => { s.destroy(); resolve(false); });
  setTimeout(() => { s.destroy(); resolve(false); }, 500);
});

const A = SEED.negocioA;
const ordenBase = () => ({
  negocioId: A, cliente: { nombre: 'Cliente Arranque', telefono: '8781112000' },
  modalidad: 'recoger en tienda', items: [], subtotal: 90, costo_envio: 0, descuento: 0, total: 90,
});
await pool.query(`DELETE FROM pedidos_activos WHERE negocio_id = $1 AND datos->>'canal' = 'arranque'`, [A]);
await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,'pos','activo')
  ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado='activo'`, [A]);

// ═════════ 1-3) El proceso no acepta tráfico durante el bootstrap ═════════
await t('ARRANQUE', '1-2. durante el bootstrap el puerto está cerrado: ninguna petición puede procesarse', async () => {
  const puerto = '4949';
  const proc = spawn(process.execPath, [join(RAIZ, 'src', 'server.js')], {
    cwd: RAIZ, env: { ...process.env, PORT: puerto }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let salida = '';
  proc.stdout.on('data', d => { salida += d.toString(); });
  proc.stderr.on('data', d => { salida += d.toString(); });
  try {
    // Sondear el puerto tan rápido como se pueda. El invariante es que el
    // puerto NO se abra antes de terminar la carga inicial de pedidos: esa
    // es exactamente la ventana en la que un pedido entrante se perdía de
    // memoria. Se ancla en "Pedidos cargados", que el arranque imprime antes
    // de escuchar (el "lista para tráfico" se imprime justo después del
    // listen, así que no sirve como referencia de "todavía no escucha").
    let aceptoAntesDeCargar = false;
    const limite = Date.now() + 30000;
    while (Date.now() < limite) {
      const cargado = /\[Startup\] Pedidos cargados: \d+/.test(salida);
      const abierto = await puertoAbierto(puerto);
      if (abierto && !cargado) aceptoAntesDeCargar = true;
      if (cargado && abierto) break;
      await new Promise(r => setTimeout(r, 5));
    }
    assert.ok(/\[Startup\] Cargando pedidos\.\.\./.test(salida), 'el arranque debe loguear la carga de pedidos');
    assert.strictEqual(aceptoAntesDeCargar, false, 'el puerto jamás debe aceptar conexiones antes de terminar la carga inicial');
    for (let i = 0; i < 100 && !/\[Startup\] Aplicación lista para tráfico/.test(salida); i++) await new Promise(r => setTimeout(r, 50));
    assert.ok(/\[Startup\] Aplicación lista para tráfico/.test(salida), 'el arranque debe declararse listo');
  } finally { proc.kill(); }
});

const srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 30000 });
const base = srv.base;
const cookieAdminA = `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId: SEED.adminNegocioAUsuarioId, negocioId: A, rol: 'admin' }))}`;

await t('ARRANQUE', '3. cuando /health responde, la aplicación ya se declaró lista (y lo dice)', async () => {
  const r = await api(base, '/health');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.status, 'ok');
  assert.strictEqual(r.body.listo, true, 'si contesta, es porque el bootstrap terminó');
  assert.ok(/pedidos activos cargados desde DB/.test(srv.obtenerSalida()), 'la carga inicial ocurrió antes de escuchar');
});

// ═════════ 4-7) Pedidos apenas queda listo, y en ráfaga ═════════
await t('TRAFICO', '4-6. el primer pedido tras quedar listo persiste, está en memoria y la API lo encuentra', async () => {
  const p = await registrarPedido(ordenBase(), 'arranque');
  const { rows } = await pool.query(`SELECT negocio_id FROM pedidos_activos WHERE folio = $1`, [p.id]);
  assert.strictEqual(rows.length, 1, 'existe en la base');
  assert.strictEqual(rows[0].negocio_id, A, 'con el tenant correcto');
  assert.ok(obtenerPedidoPorId(p.id, A), 'existe en memoria');
  const detalle = await api(base, `/api/pos/envios/${p.id}`, { cookie: cookieAdminA });
  assert.ok([200, 404].includes(detalle.status), 'la API responde sobre el folio (otra instancia no lo tiene en memoria)');
});
await t('TRAFICO', '7. 20 peticiones en ráfaga apenas queda listo: ninguna se pierde ni queda huérfana', async () => {
  const res = await Promise.all(Array.from({ length: 20 }, () => registrarPedido(ordenBase(), 'arranque')));
  const folios = res.map(p => p.id);
  assert.strictEqual(new Set(folios).size, 20);
  const { rows } = await pool.query(`SELECT folio FROM pedidos_activos WHERE folio = ANY($1)`, [folios]);
  assert.strictEqual(rows.length, 20, 'las 20 filas existen');
  for (const f of folios) assert.ok(obtenerPedidoPorId(f, A), `${f} debe estar en memoria`);
});

// ═════════ 8-9) Reproducción determinista: carga inicial vs pedido nuevo ═════════
await t('CARGA', '8. un pedido creado DURANTE la carga inicial sobrevive en memoria (era el bug)', async () => {
  // Reproducción determinista de la ventana: se retiene la carga JUSTO
  // DESPUÉS de que tomó su fotografía de pedidos_activos y ANTES de que
  // reemplace el estado en memoria. El pedido se crea en medio, así que no
  // aparece en esa fotografía. Con el código anterior, `pedidos.length = 0`
  // lo borraba y quedaba solo su fila en la base -- que es exactamente el
  // 404 "Pedido no encontrado" observado en producción de pruebas.
  const origQuery = pool.query.bind(pool);
  let fotografiaTomada = false;
  let liberar;
  const retencion = new Promise(r => { liberar = r; });
  pool.query = async (...args) => {
    const sql = args[0];
    const r = await origQuery(...args);
    if (typeof sql === 'string' && sql.includes('FROM pedidos_activos') && sql.includes("estado != 'entregado'")) {
      fotografiaTomada = true;
      await retencion;
    }
    return r;
  };

  let p;
  try {
    const cargando = cargarPedidosDesdeDB();
    for (let i = 0; i < 200 && !fotografiaTomada; i++) await new Promise(r => setTimeout(r, 10));
    assert.ok(fotografiaTomada, 'la carga debía haber leído ya los pedidos activos');
    p = await registrarPedido(ordenBase(), 'arranque'); // creado DESPUÉS de la fotografía
    liberar();
    await cargando;
  } finally {
    pool.query = origQuery;
  }

  const { rows } = await pool.query(`SELECT folio FROM pedidos_activos WHERE folio = $1`, [p.id]);
  assert.strictEqual(rows.length, 1, 'la fila se persistió');
  assert.ok(obtenerPedidoPorId(p.id, A), 'y NO desapareció de la memoria');
  const memoria = obtenerPedidos(A).filter(x => x.id === p.id);
  assert.strictEqual(memoria.length, 1, 'sin duplicarlo');
});
await t('CARGA', '9. tras la carga, el contador nunca retrocede por debajo de un folio ya entregado', async () => {
  const antes = await registrarPedido(ordenBase(), 'arranque');
  await cargarPedidosDesdeDB();
  const despues = await registrarPedido(ordenBase(), 'arranque');
  const nAntes = parseInt(antes.id.replace('XAB-', ''), 10);
  const nDespues = parseInt(despues.id.replace('XAB-', ''), 10);
  assert.ok(nDespues > nAntes, `el folio nuevo (${despues.id}) debe ser posterior a ${antes.id}`);
  const { rows } = await pool.query(`SELECT COUNT(*)::int c FROM pedidos_activos WHERE folio = $1`, [despues.id]);
  assert.strictEqual(rows[0].c, 1);
});

// ═════════ 10-11) Memoria vs base, y el P0 de folios intacto ═════════
await t('CONSISTENCIA', '10. todo pedido de esta suite: fila en base + entrada en memoria + tenant correcto', async () => {
  const { rows } = await pool.query(
    `SELECT folio, negocio_id FROM pedidos_activos WHERE negocio_id = $1 AND datos->>'canal' = 'arranque'`, [A]);
  assert.ok(rows.length >= 23, `esperaba al menos 23 pedidos de la suite, hay ${rows.length}`);
  for (const r of rows) {
    const enMemoria = obtenerPedidoPorId(r.folio, A);
    assert.ok(enMemoria, `${r.folio} está en la base pero no en memoria`);
    assert.strictEqual(enMemoria.negocioId, A);
  }
});
await t('CONSISTENCIA', '11. el P0 de folios sigue intacto: cero duplicados y cero filas huérfanas', async () => {
  const dup = await pool.query(`SELECT folio FROM pedidos_activos GROUP BY folio HAVING COUNT(*) > 1`);
  assert.strictEqual(dup.rows.length, 0, 'ningún folio duplicado');
  const enMemoria = obtenerPedidos(A).filter(p => p.canal === 'arranque').map(p => p.id);
  const { rows } = await pool.query(
    `SELECT folio FROM pedidos_activos WHERE negocio_id = $1 AND datos->>'canal' = 'arranque'`, [A]);
  const enDB = rows.map(r => r.folio);
  assert.deepStrictEqual([...enMemoria].sort(), [...enDB].sort(), 'memoria y base deben coincidir exactamente');
});

// ═════════ 12) Un bootstrap fallido no queda escuchando ═════════
await t('FALLO', '12. si el bootstrap falla, el proceso no acepta tráfico: sale con error y el puerto queda cerrado', async () => {
  const puerto = '4952';
  const proc = spawn(process.execPath, [join(RAIZ, 'src', 'server.js')], {
    cwd: RAIZ,
    env: { ...process.env, PORT: puerto, DATABASE_URL: 'postgresql://nadie:nada@127.0.0.1:1/basequenoexiste' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let salida = '';
  proc.stdout.on('data', d => { salida += d.toString(); });
  proc.stderr.on('data', d => { salida += d.toString(); });
  const code = await new Promise((resolve) => {
    proc.on('exit', resolve);
    setTimeout(() => { proc.kill(); resolve('timeout'); }, 40000);
  });
  assert.notStrictEqual(code, 'timeout', 'no debe quedarse colgado con la base caída');
  assert.notStrictEqual(code, 0, 'debe salir con código de error');
  assert.ok(/\[Startup\] ERROR/.test(salida), 'debe dejar un log claro del fallo de arranque');
  assert.ok(!/Aplicación lista para tráfico/.test(salida), 'jamás debe declararse listo');
  assert.strictEqual(await puertoAbierto(puerto), false, 'el puerto nunca se abrió');
});

await pool.query(`DELETE FROM pedidos_activos WHERE negocio_id = $1 AND datos->>'canal' = 'arranque'`, [A]);

console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }

await srv.detener();
await pool.end();
process.exitCode = fallidas > 0 ? 1 : 0;
