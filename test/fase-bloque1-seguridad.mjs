// Fase 1, bloque 1 — lo urgente y barato (21-nov-2026).
//
//   1.2 Un error en una ruta ya no apaga el servidor: Express 4 no recogía el
//       rechazo de una ruta async y Node 22 terminaba el proceso (para todos
//       los negocios). Ahora responde 500 sin detalles y sigue.
//   1.3 Webhooks: producción exige META_APP_SECRET (sin él, el webhook de
//       WhatsApp aceptaba cualquier POST), avisa si Rappi no está en
//       «exigir», y el webhook de Clip tiene límite de frecuencia.
//   1.4 Temporada y tienda: tope de pedidos vigentes por teléfono en una
//       campaña y límite de pedidos CREADOS por conexión en una hora.
//
// «Cancelar pedido» con la clave de autorización (1.1) vive en
// fase-cancelar-sin-borrar.mjs, junto al resto de la cancelación.
//
// Servidor y Postgres reales (una copia desechable de la base local).
// Uso: DATABASE_URL=... (y el resto de variables de las suites) node test/fase-bloque1-seguridad.mjs
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { arrancarServidor } from './lib-servidor.mjs';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const URL_DB = new URL(process.env.DATABASE_URL || 'postgresql://x@nadie/nada');
if (!['localhost', '127.0.0.1', '::1'].includes(URL_DB.hostname) || !URL_DB.pathname.slice(1).startsWith('test')) {
  console.error('ABORTO: esta suite solo corre contra una base local cuyo nombre empiece con "test".');
  process.exit(2);
}
const PUERTO = Number(process.env.TEST_PORT_BLOQUE1 || 4793);

const { pool } = await import('../src/services/database.js');
const { crearTokenSesion } = await import('../src/services/session.js');
const { crearLimiteAltas } = await import('../src/services/limiteAltas.js');
const { capturarErroresAsync, erroresAsyncInstalados, manejadorErroresFinal, vigilarRechazosSinManejar } =
  await import('../src/services/erroresAsync.js');
const { revisarSecretos } = await import('../src/services/guardaSecretos.js');
const T = await import('../src/services/pedidosTemporada.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}

// ═════════════ A. Piezas, en este proceso ═════════════

await t('ALTAS', 'limiteAltas: toma hasta el tope, devolver libera, devolver dos veces no regala lugar, la hora vence', async () => {
  let ahora = 1_000_000;
  const l = crearLimiteAltas({ limite: 2, ventanaMs: 1000, reloj: () => ahora });
  const a = l.tomar('ip1');
  const b = l.tomar('ip1');
  assert.ok(a && b);
  assert.equal(l.tomar('ip1'), null, 'el tercero debía quedarse fuera');
  assert.ok(l.tomar('ip2'), 'otra conexión tiene su propio tope');
  b(); b();
  assert.equal(l.usados('ip1'), 1, 'devolver dos veces no debe liberar dos lugares');
  const c = l.tomar('ip1');
  assert.ok(c);
  assert.equal(l.tomar('ip1'), null);
  ahora += 1001;
  assert.equal(l.usados('ip1'), 0, 'pasada la ventana no cuenta');
  assert.ok(l.tomar('ip1'));
  assert.throws(() => crearLimiteAltas({ limite: 0 }));
});

await t('ERRORES', 'capturarErroresAsync: un rechazo async y un throw responden 500 JSON sin el mensaje interno; un JSON roto, 400', async () => {
  assert.equal(capturarErroresAsync(), true);
  assert.equal(capturarErroresAsync(), false, 'instalarlo dos veces no envuelve dos veces');
  assert.equal(erroresAsyncInstalados(), true);
  const app = express();
  app.use(express.json());
  app.get('/async', async () => { throw new Error('invalid input syntax for type integer: "x"'); });
  app.get('/sync', () => { throw new Error('detalle interno síncrono'); });
  app.get('/sin-motivo', () => Promise.reject());
  app.post('/json', (req, res) => res.json({ ok: true }));
  app.get('/bien', (req, res) => res.json({ ok: true }));
  app.use(manejadorErroresFinal);
  const srv = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const errorOriginal = console.error;
  const anotado = [];
  console.error = (...a) => anotado.push(a.join(' '));
  try {
    for (const ruta of ['/async', '/sync', '/sin-motivo']) {
      const r = await fetch(base + ruta);
      const texto = await r.text();
      assert.equal(r.status, 500, `${ruta}: ${r.status}`);
      assert.equal(JSON.parse(texto).code, 'ERROR_INTERNO', `${ruta}: ${texto}`);
      assert.ok(!/invalid input|interno síncrono|at /.test(texto), `${ruta} filtró el detalle: ${texto}`);
    }
    const roto = await fetch(base + '/json', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"a":' });
    const cuerpo = await roto.json();
    assert.equal(roto.status, 400);
    assert.equal(cuerpo.code, 'PETICION_INVALIDA');
    assert.equal((await fetch(base + '/bien')).status, 200, 'después de los errores sigue respondiendo');
  } finally {
    console.error = errorOriginal;
    srv.close();
  }
  assert.ok(anotado.some((l) => l.includes('[Error] GET /async -> 500')), `no anotó el error: ${anotado.join(' | ')}`);
});

await t('ERRORES', 'vigilarRechazosSinManejar: un rechazo fuera de una petición se anota con «unhandledRejection» y no lanza', async () => {
  const proc = new EventEmitter();
  assert.equal(vigilarRechazosSinManejar(proc), true);
  assert.equal(vigilarRechazosSinManejar(proc), false, 'se registra una sola vez');
  const errorOriginal = console.error;
  const anotado = [];
  console.error = (...a) => anotado.push(a.join(' '));
  try {
    proc.emit('unhandledRejection', new Error('job de prueba'));
    proc.emit('unhandledRejection', 'texto suelto');
  } finally { console.error = errorOriginal; }
  assert.equal(anotado.length, 2);
  assert.ok(anotado.every((l) => l.includes('unhandledRejection (el servidor sigue)')), anotado.join(' | '));
});

const META = 'prueba-meta-bloque1-' + randomBytes(6).toString('hex');
const SESION_LARGA = 'prueba-sesion-bloque1-suficientemente-larga-' + randomBytes(8).toString('hex');
await t('SECRETOS', 'producción exige META_APP_SECRET; fuera de producción no; los mensajes no llevan valores', async () => {
  const sin = revisarSecretos({ NODE_ENV: 'production', SESSION_SECRET: SESION_LARGA });
  assert.deepEqual(sin.bloqueantes.filter((b) => b.startsWith('META_APP_SECRET')).length, 1, JSON.stringify(sin.bloqueantes));
  assert.equal(revisarSecretos({ RAILWAY_PROJECT_ID: 'x', SESSION_SECRET: SESION_LARGA, META_APP_SECRET: '  ' }).bloqueantes.length, 1, 'solo espacios = vacía');
  const con = revisarSecretos({ NODE_ENV: 'production', SESSION_SECRET: SESION_LARGA, META_APP_SECRET: META });
  assert.deepEqual(con.bloqueantes, []);
  assert.deepEqual(revisarSecretos({ SESSION_SECRET: SESION_LARGA }).bloqueantes, [], 'local: no exige');
  for (const m of [...sin.bloqueantes, ...sin.avisos, ...con.avisos]) {
    assert.ok(!m.includes(META) && !m.includes(SESION_LARGA), `un mensaje repite un valor: ${m}`);
  }
});

await t('SECRETOS', 'Rappi: avisa (no bloquea) si la firma no está en «exigir» o si se exige sin secreto', async () => {
  const base = { NODE_ENV: 'production', SESSION_SECRET: SESION_LARGA, META_APP_SECRET: META };
  const avisoRappi = (env) => revisarSecretos({ ...base, ...env }).avisos.filter((a) => a.startsWith('RAPPI_WEBHOOK_FIRMA'));
  assert.equal(avisoRappi({}).length, 1, 'sin variable = registrar: avisa');
  // Con el secreto puesto, lo único que falta es «exigir»: ese es el aviso.
  for (const env of [{ RAPPI_WEBHOOK_SECRET: 'abc' }, { RAPPI_WEBHOOK_FIRMA: 'registrar', RAPPI_WEBHOOK_SECRET: 'abc' }]) {
    const a = avisoRappi(env);
    assert.equal(a.length, 1, JSON.stringify(env));
    assert.match(a[0], /no está en «exigir»/, JSON.stringify(env));
  }
  assert.match(avisoRappi({ RAPPI_WEBHOOK_FIRMA: 'exigir' })[0] || '', /RAPPI_WEBHOOK_SECRET/);
  assert.match(avisoRappi({ RAPPI_WEBHOOK_FIRMA: 'exigir', RAPPI_WEBHOOK_SECRET: ' , ' })[0] || '', /RAPPI_WEBHOOK_SECRET/, 'solo comas = sin secreto');
  assert.equal(avisoRappi({ RAPPI_WEBHOOK_FIRMA: ' Exigir ', RAPPI_WEBHOOK_SECRET: 'abc' }).length, 0);
  assert.deepEqual(revisarSecretos({ ...base }).bloqueantes, [], 'Rappi nunca bloquea');
});

await t('TEMPORADA', 'maxPedidosPorTelefono: 3 por omisión; la variable lo cambia; un valor raro no lo apaga', async () => {
  assert.equal(T.maxPedidosPorTelefono({}), 3);
  assert.equal(T.maxPedidosPorTelefono({ XABOR_TEMPORADA_MAX_POR_TELEFONO: '5' }), 5);
  assert.equal(T.maxPedidosPorTelefono({ XABOR_TEMPORADA_MAX_POR_TELEFONO: '0' }), 3);
  assert.equal(T.maxPedidosPorTelefono({ XABOR_TEMPORADA_MAX_POR_TELEFONO: 'mucho' }), 3);
});

// ═════════════ B. Producción sin META_APP_SECRET ═════════════

function arrancarCrudo(envExtra, { omitir = [], timeoutMs = 40000 } = {}) {
  const env = { ...process.env, ...envExtra };
  for (const k of ['RAILWAY_ENVIRONMENT_ID', 'RAILWAY_PROJECT_ID', 'XABOR_ACCESO_LEGADO', ...omitir]) delete env[k];
  Object.assign(env, envExtra);
  for (const k of omitir) delete env[k];
  const proc = spawn(process.execPath, [join(RAIZ, 'src', 'server.js')], { cwd: RAIZ, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let salida = '';
  proc.stdout.on('data', (d) => { salida += d; });
  proc.stderr.on('data', (d) => { salida += d; });
  return new Promise((resolve) => {
    let listo = false;
    const fin = setTimeout(() => { proc.kill(); resolve({ timeout: true, salida: () => salida }); }, timeoutMs);
    proc.on('exit', (code) => { if (!listo) { clearTimeout(fin); resolve({ salio: true, code, salida: () => salida }); } });
    (async function sondear() {
      while (!listo && proc.exitCode === null) {
        try {
          const r = await fetch(`http://localhost:${envExtra.PORT}/health`);
          if (r.ok) { listo = true; clearTimeout(fin); proc.kill(); return resolve({ listo: true, salida: () => salida }); }
        } catch { /* aún no */ }
        await new Promise((r) => setTimeout(r, 300));
      }
    })();
  });
}

await t('SECRETOS', 'el servidor en producción sin META_APP_SECRET no arranca (sale 1 antes de tocar la base)', async () => {
  const s = await arrancarCrudo({ PORT: String(PUERTO + 1), NODE_ENV: 'production', SESSION_SECRET: SESION_LARGA }, { omitir: ['META_APP_SECRET'] });
  assert.ok(s.salio, s.listo ? 'ARRANCÓ sin META_APP_SECRET' : 'no terminó a tiempo');
  assert.equal(s.code, 1);
  assert.ok(s.salida().includes('[Secretos] FALLO: META_APP_SECRET no está definida'), s.salida().slice(-800));
  assert.ok(!s.salida().includes('[Startup] Inicializando base'), 'no debió tocar la base');
  assert.ok(!s.salida().includes(SESION_LARGA), 'el log repite un valor');
});

await t('SECRETOS', 'predeploy-check-secretos: falla sin META_APP_SECRET y pasa con él', async () => {
  const correr = (env) => {
    const e = { ...process.env };
    for (const k of ['NODE_ENV', 'RAILWAY_ENVIRONMENT_ID', 'RAILWAY_PROJECT_ID', 'SESSION_SECRET', 'META_APP_SECRET']) delete e[k];
    return spawnSync(process.execPath, [join(RAIZ, 'scripts', 'predeploy-check-secretos.mjs')], { env: { ...e, ...env }, encoding: 'utf8', timeout: 30000 });
  };
  const sin = correr({ NODE_ENV: 'production', SESSION_SECRET: SESION_LARGA });
  assert.equal(sin.status, 1, sin.stdout + sin.stderr);
  assert.ok((sin.stdout + sin.stderr).includes('META_APP_SECRET'));
  const con = correr({ NODE_ENV: 'production', SESSION_SECRET: SESION_LARGA, META_APP_SECRET: META });
  assert.equal(con.status, 0, con.stdout + con.stderr);
  assert.ok(!(con.stdout + con.stderr).includes(META), 'la salida repite el valor');
});

// ═════════════ C. Servidor real (modo local) ═════════════

const SUF = randomUUID().slice(0, 8);
const q1 = async (sql, p) => (await pool.query(sql, p)).rows[0];
const N = (await q1(`INSERT INTO negocios (nombre, slug, activo, estado) VALUES ('Bloque 1', $1, true, 'activo') RETURNING id`, [`bloque1-${SUF}`])).id;
const { id: ADMIN } = await q1(`INSERT INTO usuarios (negocio_id, nombre, email, activo) VALUES ($1,'Admin Bloque 1',$2,true) RETURNING id`,
  [N, `admin-${SUF}@bloque1.test.local`]);
await pool.query(`INSERT INTO usuario_negocios (usuario_id, negocio_id, rol, activo) VALUES ($1,$2,'admin',true)`, [ADMIN, N]);
for (const m of ['pos', 'menu', 'tienda_online']) {
  await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,'activo')
    ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = 'activo'`, [N, m]);
}
const cookieAdmin = `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId: ADMIN, negocioId: N, rol: 'admin' }))}`;

// Tienda mínima: un producto publicado, abierta todo el día, efectivo al recoger.
const { id: CAT } = await q1(`INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,'Bloque 1',TRUE,0) RETURNING id`, [N]);
const { id: PROD } = await q1(`INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio, disponible, orden)
  VALUES ($1,$2,'Torta bloque 1',90,TRUE,0) RETURNING id`, [N, CAT]);
await pool.query(`INSERT INTO tienda_productos (negocio_id, producto_id, publicado) VALUES ($1,$2,TRUE)`, [N, PROD]);
await pool.query(`INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,'reglas_atencion',$2)`, [N, JSON.stringify({
  horarios: Object.fromEntries(['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo']
    .map((d) => [d, { abierto: true, apertura: '00:00', cierre: '23:59' }])),
  pedidos: { tiempo_preparacion_minutos: 20 },
})]);
await pool.query(`INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,'tienda_metodos_pago','["efectivo"]')`, [N]);
await pool.query(`INSERT INTO metodos_pago (negocio_id, tipo, habilitado, orden) VALUES ($1,'efectivo',TRUE,0)
  ON CONFLICT (negocio_id, tipo) DO UPDATE SET habilitado = TRUE`, [N]);
const SLUG_TIENDA = `bloque1-tienda-${SUF}`;
await pool.query(`INSERT INTO tienda_config (negocio_id, estado, slug_publico, titular, modalidades)
  VALUES ($1,'publicada',$2,'Tienda bloque 1',$3)`, [N, SLUG_TIENDA, JSON.stringify(['recoger'])]);

// Campaña de Temporada abierta, en 7 días.
const { d: FECHA } = await q1(`SELECT to_char((NOW() AT TIME ZONE 'America/Matamoros')::date + 7, 'YYYY-MM-DD') AS d`);
const CLAVE = `bloque1-${SUF}`;
const CAMP = await T.guardarCampana(N, null, {
  clave: CLAVE, titulo: 'Thanksgiving bloque 1', producto: 'Platillo de pavo', precio: 250, descripcion: 'Pavo.',
  fecha: FECHA, hora_inicio: '09:00', hora_fin: '16:00', minutos_ventana: 60,
  cupo_platillos: 400, cupo_domicilio: 10, max_platillos_pedido: 40, cierra_en: null,
  prefijo: 'BQ', acepta_recoger: true, acepta_domicilio: true, activa: true,
});

const srv = await arrancarServidor({
  PORT: String(PUERTO),
  XABOR_CLIP_WEBHOOK_LIMITE: '3',
  XABOR_TEMPORADA_LIMITE_ENVIO_HORA: '4',
  XABOR_TIENDA_LIMITE_PEDIDOS_HORA: '2',
}, { timeoutMs: 60000, omitir: ['XABOR_TEMPORADA_MAX_POR_TELEFONO'] });
const vivo = () => srv.proc.exitCode === null && srv.proc.signalCode === null;
async function pedir(ruta, { metodo = 'GET', cuerpo, crudo, cookie, ip } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  if (ip) headers['X-Forwarded-For'] = ip;
  const r = await fetch(srv.base + ruta, { method: metodo, headers, body: crudo ?? (cuerpo === undefined ? undefined : JSON.stringify(cuerpo)) });
  const texto = await r.text();
  let json = null; try { json = JSON.parse(texto); } catch {}
  return { status: r.status, body: json, texto };
}

try {
  // ── 1.2 Las rutas que tumbaban el servidor (Fase 0) ──
  await t('ERRORES', 'las rutas del menú que tumbaban el servidor responden 500 sin detalles y el servidor sigue', async () => {
    const casos = [
      ['DELETE', '/api/admin/menu/categorias/x'],
      ['POST', '/api/admin/menu/categorias', {}],
      ['GET', '/api/admin/menu/productos/x/modificadores'],
      ['PATCH', `/api/admin/menu/categorias/${CAT}`, { nombre: 'N'.repeat(300) }],
    ];
    for (const [metodo, ruta, cuerpo] of casos) {
      const r = await pedir(ruta, { metodo, cuerpo, cookie: cookieAdmin });
      assert.equal(r.status, 500, `${metodo} ${ruta}: ${r.status} ${r.texto.slice(0, 200)}`);
      assert.equal(r.body?.code, 'ERROR_INTERNO', `${metodo} ${ruta}: ${r.texto.slice(0, 200)}`);
      assert.ok(!/syntax|violates|too long|column|relation|at /i.test(r.texto), `${metodo} ${ruta} filtró detalles: ${r.texto}`);
      await new Promise((ok) => setTimeout(ok, 150));
      assert.ok(vivo(), `el servidor se cayó con ${metodo} ${ruta}:\n${srv.obtenerSalida().slice(-1500)}`);
      assert.equal((await pedir('/health')).status, 200, `después de ${metodo} ${ruta}`);
    }
    assert.ok(srv.obtenerSalida().includes('[Error] DELETE /api/admin/menu/categorias/x -> 500'), 'no quedó en el log');
    // La categoría no cambió de nombre con el PATCH rechazado.
    assert.equal((await q1(`SELECT nombre FROM menu_categorias WHERE id = $1`, [CAT])).nombre, 'Bloque 1');
  });

  await t('ERRORES', 'un JSON mal formado responde 400 con texto fijo, sin la pila', async () => {
    const r = await pedir('/api/admin/menu/categorias', { metodo: 'POST', crudo: '{"nombre":', cookie: cookieAdmin });
    assert.equal(r.status, 400, r.texto.slice(0, 200));
    assert.equal(r.body?.code, 'PETICION_INVALIDA');
    assert.ok(!/at |SyntaxError|node_modules/.test(r.texto), r.texto);
    assert.ok(vivo());
  });

  // ── 1.3 Límite del webhook de Clip ──
  await t('CLIP', 'webhook de Clip: 3 por minuto por conexión (con la variable); el 4.º recibe 429 y otra conexión sigue', async () => {
    const estados = [];
    for (let i = 0; i < 4; i++) estados.push((await pedir('/webhook/clip', { metodo: 'POST', cuerpo: {}, ip: '198.51.100.7' })).status);
    assert.deepEqual(estados.slice(0, 3).map((s) => s === 429), [false, false, false], `los primeros 3: ${estados}`);
    assert.equal(estados[3], 429, `el 4.º: ${estados}`);
    assert.notEqual((await pedir('/webhook/clip', { metodo: 'POST', cuerpo: {}, ip: '198.51.100.8' })).status, 429, 'otra conexión no debe frenarse');
  });

  // ── 1.4 Temporada ──
  const pedidoT = (telefono, extra = {}) => ({
    nombre: 'Cliente Bloque', telefono, platillos: 2, modalidad: 'recoger', ventana: '09:00', claveEnvio: randomUUID(), ...extra,
  });
  const agendar = (cuerpo, ip) => pedir(`/api/temporada/${CLAVE}/pedidos`, { metodo: 'POST', cuerpo, ip });
  let ipN = 10;
  const ipNueva = () => `203.0.113.${ipN++}`;

  await t('TEMPORADA', 'tope por teléfono: 3 vigentes en la campaña; el 4.º es 409 LIMITE_TELEFONO aunque cambie el formato del número', async () => {
    for (const tel of ['878 555 0101', '8785550101', '(878) 555-0101']) {
      const r = await agendar(pedidoT(tel), ipNueva());
      assert.equal(r.status, 201, `${tel}: ${r.status} ${r.texto}`);
    }
    // Con la lada de país es el mismo número.
    const cuarto = await agendar(pedidoT('52 878 555 0101'), ipNueva());
    assert.equal(cuarto.status, 409, cuarto.texto);
    assert.equal(cuarto.body?.codigo, 'LIMITE_TELEFONO');
    assert.equal(cuarto.body?.max, 3);
    assert.match(cuarto.body?.error || '', /comunícate con el restaurante/);
    const otro = await agendar(pedidoT('878 555 0102'), ipNueva());
    assert.equal(otro.status, 201, `otro teléfono: ${otro.texto}`);
  });

  await t('TEMPORADA', 'un pedido cancelado no cuenta: cancelar uno deja agendar otro con ese teléfono', async () => {
    const { id } = await q1(`SELECT id FROM temporada_pedidos WHERE campana_id = $1 AND estado = 'confirmado' ORDER BY id LIMIT 1`, [CAMP.id]);
    await T.cancelarPedidoTemporada(N, id, { motivo: 'Prueba del tope' }, { actorId: ADMIN });
    const r = await agendar(pedidoT('878 555 0101'), ipNueva());
    assert.equal(r.status, 201, r.texto);
    assert.equal((await agendar(pedidoT('878 555 0101'), ipNueva())).status, 409);
  });

  await t('TEMPORADA', 'el mismo envío repetido no choca con el tope: devuelve el pedido que ya existe', async () => {
    const tel = '878 555 0110';
    const cuerpos = [pedidoT(tel), pedidoT(tel), pedidoT(tel)];
    for (const c of cuerpos) assert.equal((await agendar(c, ipNueva())).status, 201);
    const otra = await agendar(cuerpos[2], ipNueva());
    assert.equal(otra.status, 200, otra.texto);
    assert.equal(otra.body?.repetido, true);
  });

  await t('TEMPORADA', 'por conexión: 4 pedidos agendados por hora (con la variable); los fallidos y los repetidos no gastan', async () => {
    const ip = '192.0.2.50';
    const malo = await agendar(pedidoT('878 555 0201', { ventana: '03:00' }), ip);
    assert.equal(malo.status, 400, `un horario inválido: ${malo.texto}`);
    const primero = pedidoT('878 555 0202');
    assert.equal((await agendar(primero, ip)).status, 201);
    const rep = await agendar(primero, ip);
    assert.equal(rep.status, 200, `repetido: ${rep.texto}`);
    for (const tel of ['878 555 0203', '878 555 0204', '878 555 0205']) {
      const r = await agendar(pedidoT(tel), ip);
      assert.equal(r.status, 201, `${tel}: ${r.texto}`);
    }
    const quinto = await agendar(pedidoT('878 555 0206'), ip);
    assert.equal(quinto.status, 429, quinto.texto);
    assert.equal(quinto.body?.codigo, 'LIMITE_CONEXION');
    const n = await q1(`SELECT COUNT(*)::int AS n FROM temporada_pedidos WHERE campana_id = $1 AND telefono LIKE '%5550206%'`, [CAMP.id]);
    assert.equal(n.n, 0, 'el rechazado no debía agendarse');
    assert.equal((await agendar(pedidoT('878 555 0207'), '192.0.2.51')).status, 201, 'otra conexión no se frena');
  });

  // ── 1.4 Tienda ──
  const checkout = (ip, token = randomBytes(24).toString('hex'), telefono = '8995550300') => pedir(`/api/tienda/${SLUG_TIENDA}/checkout`, {
    metodo: 'POST', ip,
    cuerpo: { checkoutToken: token, items: [{ productoId: PROD, cantidad: 1 }], modalidad: 'recoger',
      cliente: { nombre: 'Cliente Tienda', telefono }, metodoPago: 'efectivo' },
  });
  await t('TIENDA', 'checkout: 2 pedidos por hora por conexión (con la variable); el mismo checkout repetido no gasta; el 3.º es 429', async () => {
    const ip = '192.0.2.80';
    // Un checkout que no crea nada (carrito vacío) no gasta lugar.
    const vacio = await pedir(`/api/tienda/${SLUG_TIENDA}/checkout`, { metodo: 'POST', ip, cuerpo: {
      checkoutToken: randomBytes(24).toString('hex'), items: [], modalidad: 'recoger',
      cliente: { nombre: 'Cliente Tienda', telefono: '8995550399' }, metodoPago: 'efectivo' } });
    assert.ok(vacio.status >= 400 && vacio.status < 500 && vacio.status !== 429, `carrito vacío: ${vacio.status} ${vacio.texto.slice(0, 200)}`);
    const token = randomBytes(24).toString('hex');
    const a = await checkout(ip, token);
    assert.equal(a.status, 200, a.texto.slice(0, 300));
    assert.equal(a.body?.yaExistia, false);
    const rep = await checkout(ip, token);
    assert.equal(rep.status, 200, rep.texto.slice(0, 300));
    assert.equal(rep.body?.yaExistia, true);
    const b = await checkout(ip, undefined, '8995550301');
    assert.equal(b.status, 200, b.texto.slice(0, 300));
    const c = await checkout(ip, undefined, '8995550302');
    assert.equal(c.status, 429, c.texto.slice(0, 300));
    assert.equal(c.body?.codigo, 'LIMITE_CONEXION');
    const n = await q1(`SELECT COUNT(*)::int AS n FROM pedidos_activos WHERE negocio_id = $1 AND datos->>'canal' = 'tienda_online'`, [N]);
    assert.equal(n.n, 2, `pedidos creados: ${n.n}`);
    assert.equal((await checkout('192.0.2.81', undefined, '8995550303')).status, 200, 'otra conexión no se frena');
  });

  await t('ERRORES', 'después de todo, el servidor sigue vivo', async () => {
    assert.ok(vivo(), srv.obtenerSalida().slice(-1500));
  });
} finally {
  srv.detener();
  await pool.end();
}

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallidas) { console.log('Fallos:\n  · ' + fallos.join('\n  · ')); process.exit(1); }
process.exit(0);
