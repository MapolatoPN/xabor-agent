// ─── «Listo, en espera de recolección» y «Entregado a repartidor» ──────────
//
// Pedido de los trabajadores, aprobado por Mario el 15-oct-2026:
//   · al pulsar Listo la tarjeta dice «Listo, en espera de recolección»;
//   · un pedido a domicilio se cierra con «🛵 Entregado a repartidor»: la
//     tarjeta sale del tablero como hoy y el historial lo dice así;
//   · el WhatsApp de «va en camino» se manda al entregarlo al repartidor, ya
//     no al pulsar Listo (ahí: «listo, en breve sale con el repartidor»).
// Lo que se protege, con servidor real, un Meta simulado y Chrome:
//   · qué le llega al cliente en cada clic, y que un doble clic no repite;
//   · recoger en tienda no cambia; sin teléfono real no se manda nada;
//   · Meta caído no frena el cambio de estado;
//   · la tarjeta, el aviso de confirmación y el historial.
// Negocio propio (slug listo-repartidor-a), se reconstruye en cada corrida.
//
// Uso: DATABASE_URL=... (y el resto de variables de las suites) node test/fase-listo-entregado-repartidor.mjs
//      SALTAR_UI=1 omite Chrome.
import { readFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';
import { arrancarMetaMock } from './lib-meta-mock.mjs';
import { mensajeEstadoParaCliente, telefonoAvisable } from '../src/services/avisosEstadoPedido.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const PUERTO = process.env.TEST_PORT_LISTO_REPARTIDOR || '4991';
const CAPTURAS = process.env.CAPTURAS_DIR || join(__dirname, '.capturas-cuenta');
mkdirSync(CAPTURAS, { recursive: true });

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}
const esperar = (ms) => new Promise(r => setTimeout(r, ms));

// ═══════════ Sin servidor: el texto y el código ═══════════
const DOM = 'entrega a domicilio', REC = 'recoger en tienda';
const ped = (modalidad, telefono = '5218780000001') => ({ id: 'XAB-0001', modalidad, cliente: { telefono } });

await t('PURO', '1. qué se le dice al cliente en cada estado y modalidad', () => {
  assert.strictEqual(mensajeEstadoParaCliente(ped(DOM), 'listo'), 'Tu pedido XAB-0001 está listo. En breve sale con el repartidor.');
  assert.ok(!/camino/.test(mensajeEstadoParaCliente(ped(DOM), 'listo')), 'Listo a domicilio ya no dice «en camino»');
  assert.strictEqual(mensajeEstadoParaCliente(ped(DOM), 'entregado'), 'Tu pedido XAB-0001 va en camino. Llega en unos minutos.');
  assert.strictEqual(mensajeEstadoParaCliente(ped(REC), 'listo'), 'Tu pedido XAB-0001 está listo. Puedes pasar a recogerlo cuando gustes.');
  assert.strictEqual(mensajeEstadoParaCliente(ped(REC), 'entregado'), null, 'recoger: al entregar no se manda nada');
  for (const e of ['nuevo', 'en_preparacion', 'cancelado']) assert.strictEqual(mensajeEstadoParaCliente(ped(DOM), e), null, e);
  for (const tel of ['—', '', null, '12345', 'rappi-998877']) {
    assert.strictEqual(telefonoAvisable(tel), false, `teléfono ${tel}`);
    assert.strictEqual(mensajeEstadoParaCliente(ped(DOM, tel), 'entregado'), null, `sin teléfono real (${tel})`);
  }
});

const SERVER = readFileSync(join(root, 'src/server.js'), 'utf8');
await t('PURO', '2. la ruta de estado avisa con el módulo y solo si el estado de la MEMORIA cambió', () => {
  const ini = SERVER.indexOf("app.patch('/pedidos/:id/estado'");
  const fin = SERVER.indexOf('\n});', ini);
  const bloque = SERVER.slice(ini, fin);
  assert.ok(ini >= 0 && fin > ini, 'no existe la ruta');
  assert.ok(bloque.includes('mensajeEstadoParaCliente(pedido, estado)'), 'la ruta no usa el módulo');
  assert.ok(!SERVER.includes('listo y en camino'), 'quedó el texto viejo de «listo y en camino»');
  // El estado anterior se lee ANTES de cambiarlo y de la memoria, que se
  // actualiza en el mismo tramo síncrono: la base va detrás.
  const anterior = bloque.indexOf('const estadoAnterior = obtenerPedidos(req.negocioId)');
  const cambia = bloque.indexOf('actualizarEstadoPedido(req.params.id');
  assert.ok(anterior > 0 && anterior < cambia, 'el estado anterior no se lee de la memoria antes de cambiarlo');
  assert.ok(bloque.includes('estadoAnterior === estado ? null'), 'falta la guarda del doble clic');
});

// ═══════════ Negocio, pedidos sembrados y servidor ═══════════
const { pool } = await import('../src/services/database.js');
const { crearTokenSesion } = await import('../src/services/session.js');
const SLUG = 'listo-repartidor-a';
async function limpiar() {
  const { rows } = await pool.query(`SELECT id FROM negocios WHERE slug = $1`, [SLUG]);
  if (!rows.length) return;
  const q = (sql) => pool.query(sql, [rows[0].id]).catch(() => {});
  // Entregar un pedido deja además su cliente del negocio y su compra real.
  for (const tabla of ['clientes_negocio', 'compras_reales', 'pagos', 'impresion_trabajos', 'pedido_emisiones', 'facturas_pedido',
    'pedidos_activos', 'pedidos', 'clientes', 'folios_pedido_usados', 'metodos_pago', 'negocio_modulos', 'configuracion',
    'sucursales', 'usuario_negocios', 'usuarios']) {
    await q(`DELETE FROM ${tabla} WHERE negocio_id = $1`);
  }
  await pool.query(`DELETE FROM negocios WHERE id = $1`, [rows[0].id]);   // si algo lo sigue usando, que se diga
}
await limpiar();
const { rows: [neg] } = await pool.query(`INSERT INTO negocios (nombre, slug) VALUES ('Listo Repartidor', $1) RETURNING id`, [SLUG]);
const N = neg.id;
for (const m of ['pos', 'caja']) await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,'activo')`, [N, m]);
await pool.query(`INSERT INTO metodos_pago (negocio_id, tipo, habilitado, orden) VALUES ($1,'efectivo',TRUE,0)`, [N]);
await pool.query(`INSERT INTO sucursales (negocio_id, nombre) VALUES ($1,'Principal')`, [N]);
// Credenciales de WhatsApp FALSAS: los envíos van al Meta simulado.
for (const [clave, valor] of [['int_wa_phone_id', 'PNID-LISTO-REPARTIDOR'], ['int_wa_token', 'token-falso-listo-repartidor']]) {
  await pool.query(`INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,$2,$3)`, [N, clave, valor]);
}
const { rows: [u] } = await pool.query(
  `INSERT INTO usuarios (negocio_id, nombre, email, password_hash) VALUES ($1,'Admin Listo',$2,'x') RETURNING id`,
  [N, `${SLUG}-admin-${Math.random().toString(36).slice(2)}@test.local`]);
await pool.query(`INSERT INTO usuario_negocios (usuario_id, negocio_id, rol) VALUES ($1,$2,'admin')`, [u.id, N]);
const cookieAdmin = `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId: u.id, negocioId: N, rol: 'admin' }))}`;

// Pedidos cobrados en la base ANTES de arrancar: el servidor los sube a su
// memoria, como al reiniciar con pedidos en curso.
const sufijo = Math.random().toString(36).slice(2, 6).toUpperCase();
const TEL = { d1: '5218780000101', d2: '5218780000102', r1: '5218780000103', u1: '5218780000104', u2: '5218780000105', d3: '5218780000106' };
const FOLIOS = {};
async function sembrar(clave, { modalidad, canal = 'whatsapp', telefono, estado = 'en_preparacion' }) {
  const folio = `TST-LR${sufijo}-${clave.toUpperCase()}`;
  FOLIOS[clave] = folio;
  await pool.query(`INSERT INTO pedidos_activos (folio, estado, datos, negocio_id) VALUES ($1,$2,$3,$4)`, [folio, estado, JSON.stringify({
    id: folio, negocioId: N, canal, modalidad, estado, forma_pago: 'efectivo', pago_confirmado: true,
    costo_envio: modalidad === DOM ? 60 : 0, subtotal: 120, total: modalidad === DOM ? 180 : 120, timestamp: new Date().toISOString(),
    cliente: { nombre: `Cliente ${clave}`, telefono, ...(modalidad === DOM ? { direccion: 'Calle Falsa 123' } : {}) },
    items: [{ nombre: 'Chilaquiles', cantidad: 1, precio_unitario: 120 }],
  }), N]);
}
await sembrar('d1', { modalidad: DOM, telefono: TEL.d1 });
await sembrar('d2', { modalidad: DOM, telefono: TEL.d2, estado: 'listo' });
await sembrar('d3', { modalidad: DOM, telefono: TEL.d3, estado: 'listo' });
await sembrar('r1', { modalidad: REC, telefono: TEL.r1 });
await sembrar('p1', { modalidad: DOM, canal: 'presencial', telefono: '—' });
await sembrar('rp', { modalidad: DOM, canal: 'rappi', telefono: 'rappi-998877' });
await sembrar('u1', { modalidad: DOM, telefono: TEL.u1 });
await sembrar('u2', { modalidad: REC, telefono: TEL.u2 });

const meta = await arrancarMetaMock();
const srv = await arrancarServidor({ PORT: PUERTO, META_GRAPH_BASE_URL: meta.baseUrl }, { timeoutMs: 40000 });
async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch(srv.base + path, {
    method, headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await r.json(); } catch { /* sin cuerpo */ }
  return { status: r.status, body: json };
}
const estado = (folio, e) => api(`/pedidos/${folio}/estado`, { method: 'PATCH', body: { estado: e } });
const mensajesA = (tel) => meta.obtenerMensajesEnviados().filter(m => m.to === tel).map(m => m.text?.body || '');
async function hastaMensajes(tel, n, ms = 4000) {
  const fin = Date.now() + ms;
  while (mensajesA(tel).length < n && Date.now() < fin) await esperar(50);
  return mensajesA(tel);
}
const fila = async (folio) => (await pool.query(`SELECT estado, datos FROM pedidos_activos WHERE folio = $1`, [folio])).rows[0];

try {
  // ═══════════ Lo que le llega al cliente ═══════════
  await t('WHATSAPP', '3. Listo a domicilio: «en breve sale con el repartidor», no «en camino»; un doble clic no lo repite', async () => {
    assert.strictEqual((await estado(FOLIOS.d1, 'listo')).status, 200);
    const m = await hastaMensajes(TEL.d1, 1);
    assert.deepStrictEqual(m, ['Tu pedido ' + FOLIOS.d1 + ' está listo. En breve sale con el repartidor.']);
    assert.strictEqual((await estado(FOLIOS.d1, 'listo')).status, 200);
    await esperar(700);
    assert.strictEqual(mensajesA(TEL.d1).length, 1, 'el doble clic mandó el aviso otra vez');
  });

  await t('WHATSAPP', '4. Entregado a repartidor: «va en camino», queda entregado en la base y otro clic no repite', async () => {
    assert.strictEqual((await estado(FOLIOS.d1, 'entregado')).status, 200);
    const m = await hastaMensajes(TEL.d1, 2);
    assert.strictEqual(m[1], 'Tu pedido ' + FOLIOS.d1 + ' va en camino. Llega en unos minutos.');
    const fin = Date.now() + 5000;
    while ((await fila(FOLIOS.d1)).estado !== 'entregado' && Date.now() < fin) await esperar(100);
    assert.strictEqual((await fila(FOLIOS.d1)).estado, 'entregado');
    const otra = await estado(FOLIOS.d1, 'entregado');
    assert.ok([200, 404].includes(otra.status), `segundo clic: ${otra.status}`);
    await esperar(700);
    assert.strictEqual(mensajesA(TEL.d1).length, 2, 'el segundo «entregado» mandó otro «va en camino»');
  });

  await t('WHATSAPP', '4b. dos «entregado» al mismo tiempo (doble clic real): un solo «va en camino»', async () => {
    const [a, b] = await Promise.all([estado(FOLIOS.d3, 'entregado'), estado(FOLIOS.d3, 'entregado')]);
    assert.ok(a.status === 200 && [200, 404].includes(b.status), `${a.status} / ${b.status}`);
    await hastaMensajes(TEL.d3, 1);
    await esperar(800);
    assert.deepStrictEqual(mensajesA(TEL.d3), ['Tu pedido ' + FOLIOS.d3 + ' va en camino. Llega en unos minutos.']);
  });

  await t('WHATSAPP', '5. recoger en tienda no cambia: «puedes pasar» al estar listo y nada al entregar', async () => {
    await estado(FOLIOS.r1, 'listo');
    assert.deepStrictEqual(await hastaMensajes(TEL.r1, 1), ['Tu pedido ' + FOLIOS.r1 + ' está listo. Puedes pasar a recogerlo cuando gustes.']);
    assert.strictEqual((await estado(FOLIOS.r1, 'entregado')).status, 200);
    await esperar(700);
    assert.strictEqual(mensajesA(TEL.r1).length, 1, 'al entregar un pedido para recoger se mandó un aviso');
  });

  await t('WHATSAPP', '6. sin teléfono real (mostrador «—», Rappi) no se manda nada', async () => {
    const antes = meta.obtenerMensajesEnviados().length;
    for (const f of [FOLIOS.p1, FOLIOS.rp]) {
      assert.strictEqual((await estado(f, 'listo')).status, 200);
      assert.strictEqual((await estado(f, 'entregado')).status, 200);
    }
    await esperar(700);
    assert.strictEqual(meta.obtenerMensajesEnviados().length, antes);
  });

  await t('WHATSAPP', '7. con Meta caído el pedido se entrega igual: el aviso nunca frena el clic', async () => {
    meta.forzarErrorSiguienteEnvio();
    const r = await estado(FOLIOS.d2, 'entregado');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const fin = Date.now() + 5000;
    while ((await fila(FOLIOS.d2)).estado !== 'entregado' && Date.now() < fin) await esperar(100);
    assert.strictEqual((await fila(FOLIOS.d2)).estado, 'entregado');
  });

  // ═══════════ La pantalla ═══════════
  if (process.env.SALTAR_UI) console.log('  --  [UI] omitida (SALTAR_UI)'); else await t('UI', '8. en Chrome: «Listo, en espera de recolección», «🛵 Entregado a repartidor» con su aviso, y el historial', async () => {
    const puppeteer = (await import('puppeteer')).default;
    const nav = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    try {
      const page = await nav.newPage();
      const errores = [], dialogos = [];
      page.on('pageerror', e => errores.push(e.message || String(e)));
      page.on('dialog', d => { dialogos.push(d.message()); d.accept().catch(() => {}); });
      await page.setViewport({ width: 1300, height: 900 });
      await page.setCookie({ name: 'xabor_sesion', value: cookieAdmin.slice(cookieAdmin.indexOf('=') + 1), url: srv.base });
      await page.evaluateOnNewDocument(() => { window.open = () => ({ document: { write() {}, close() {} }, print() {}, close() {}, onload: null }); });
      await page.goto(srv.base + '/app', { waitUntil: 'networkidle2' });
      await page.waitForFunction(() => typeof renderComanda === 'function' && typeof ws !== 'undefined' && ws && ws.readyState === 1, { timeout: 15000 });
      await page.evaluate(() => mostrarTab('comandas'));
      for (const f of [FOLIOS.u1, FOLIOS.u2]) {
        await page.waitForSelector(`#comanda-${f}`, { timeout: 10000 });
        await page.evaluate((x) => { if (!comandasAbiertas.has(x)) toggleComanda(x); }, f);
      }
      const principal = (f) => page.$eval(`#comanda-${f} .btn-principal`, b => b.textContent.trim());
      assert.strictEqual(await principal(FOLIOS.u1), '🛵 Entregado a repartidor');
      assert.strictEqual(await principal(FOLIOS.u2), '📦 Entregado');
      // Listo: las dos etiquetas de la tarjeta (plegada y abierta) lo dicen.
      for (const f of [FOLIOS.u1, FOLIOS.u2]) {
        await page.evaluate((x) => cambiarEstado(x, 'listo'), f);
        await page.waitForFunction((x) => {
          const t = [...document.querySelectorAll(`[data-pedido-estado="${x}"]`)].map(e => e.textContent);
          return t.length === 2 && t.every(s => s === 'Listo, en espera de recolección');
        }, { timeout: 8000 }, f);
      }
      await page.$eval(`#comanda-${FOLIOS.u1}`, el => el.scrollIntoView({ block: 'start' }));
      await (await page.$(`#comanda-${FOLIOS.u1}`)).screenshot({ path: join(CAPTURAS, 'listo-repartidor-1-domicilio.png') });
      await (await page.$(`#comanda-${FOLIOS.u2}`)).screenshot({ path: join(CAPTURAS, 'listo-repartidor-2-recoger.png') });
      // Entregar al repartidor: pregunta con sus palabras y saca la tarjeta.
      await page.click(`#comanda-${FOLIOS.u1} .btn-entregado`);
      await page.waitForFunction((x) => !document.getElementById(`comanda-${x}`), { timeout: 10000 }, FOLIOS.u1);
      assert.ok(dialogos.some(d => /repartidor/.test(d) && /va en camino/.test(d)), `aviso: ${JSON.stringify(dialogos)}`);
      await page.click(`#comanda-${FOLIOS.u2} .btn-entregado`);
      await page.waitForFunction((x) => !document.getElementById(`comanda-${x}`), { timeout: 10000 }, FOLIOS.u2);
      assert.ok(dialogos.includes('¿Marcar como entregado?'), 'recoger conserva su pregunta');
      assert.deepStrictEqual(await hastaMensajes(TEL.u1, 2), [
        'Tu pedido ' + FOLIOS.u1 + ' está listo. En breve sale con el repartidor.',
        'Tu pedido ' + FOLIOS.u1 + ' va en camino. Llega en unos minutos.',
      ]);
      // Historial: el domicilio dice «Entregado a repartidor»; recoger no.
      const fin = Date.now() + 5000;
      while ((await fila(FOLIOS.u1)).estado !== 'entregado' && Date.now() < fin) await esperar(100);
      await page.evaluate(() => { mostrarTab('historial'); return cargarHistorial(); });
      await page.waitForFunction(() => (document.getElementById('historial-lista')?.textContent || '').includes('TST-LR'), { timeout: 10000 });
      const linea = (f) => page.evaluate((x) => {
        const fila = [...document.querySelectorAll('#historial-lista > div')].find(d => d.textContent.includes(x));
        return fila ? fila.querySelector('.historial-hora')?.textContent || '' : null;
      }, f);
      assert.ok((await linea(FOLIOS.u1))?.includes('Entregado a repartidor'), `historial del domicilio: ${await linea(FOLIOS.u1)}`);
      const rec = await linea(FOLIOS.u2);
      assert.ok(rec !== null && !rec.includes('repartidor'), `historial de recoger: ${rec}`);
      assert.deepStrictEqual(errores, [], 'errores de JavaScript en el panel');
    } finally { await nav.close(); }
  });
} finally {
  console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
  if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }
  srv.detener();
  meta.detener();
  await limpiar().catch(() => {});
  await pool.end();
  process.exitCode = fallidas > 0 ? 1 : 0;
}
