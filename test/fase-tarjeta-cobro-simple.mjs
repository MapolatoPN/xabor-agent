// Tarjeta de comanda simple y «no sale sin cobrar» (28-sep-2026, con Mario).
//
// XAB-0953 apareció «Por cobrar» en Caja aunque el personal lo cobró con
// terminal: se capturó por cobrar, se entregó sin pasar por «Cobrar» y
// después ✏️ Pago cambió solo la etiqueta (15 así en Obispado en 30 días).
// La tarjeta tenía 10 botones. Queda: un botón con el siguiente paso
// («💵 Cobrar» → «📦 Entregado»), «⋯ Más» con lo demás y un solo «Cancelar
// pedido». El servidor no acepta entregar ni reetiquetar un pedido del
// mostrador sin cobrar, y lo que ya salió sin cobro se cobra desde Historial
// o Caja. La tienda que se paga al recibir queda como estaba: su cobro por
// este camino reescribiría el total sin envío ni promociones.
//
// Servidor y Postgres reales; tablero, Historial y Caja con Puppeteer.
//
// Uso: DATABASE_URL=... (y el resto de variables de las suites) node test/fase-tarjeta-cobro-simple.mjs
import puppeteer from 'puppeteer';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUERTO = process.env.TEST_PORT_TARJETA_COBRO || '4981';
const CLAVE_ADMIN = 'clave-de-prueba-tarjeta';

const { pool } = await import('../src/services/database.js');
const { crearTokenSesion } = await import('../src/services/session.js');
const { seCobraEnMostrador } = await import('../src/services/cortesCaja.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

// ── Negocio de prueba (se reconstruye en cada corrida) ──────────────────────
const SLUG = 'tarjeta-cobro-simple';
async function limpiar() {
  const { rows } = await pool.query(`SELECT id FROM negocios WHERE slug = $1`, [SLUG]);
  if (!rows.length) return;
  const id = rows[0].id;
  const q = (sql) => pool.query(sql, [id]).catch(() => {});
  await q(`DELETE FROM pagos WHERE negocio_id = $1`);
  await q(`DELETE FROM impresion_trabajos WHERE negocio_id = $1`);
  await q(`DELETE FROM pedido_emisiones WHERE negocio_id = $1`);
  await q(`DELETE FROM compras_reales WHERE negocio_id = $1`);
  await q(`DELETE FROM pedidos_activos WHERE negocio_id = $1`);
  // El POS también deja el pedido histórico y el cliente técnico del mostrador.
  await q(`DELETE FROM pedidos WHERE negocio_id = $1`);
  await q(`DELETE FROM clientes WHERE negocio_id = $1`);
  await q(`DELETE FROM folios_pedido_usados WHERE negocio_id = $1`);
  await q(`DELETE FROM menu_productos WHERE negocio_id = $1`);
  await q(`DELETE FROM menu_categorias WHERE negocio_id = $1`);
  await q(`DELETE FROM metodos_pago WHERE negocio_id = $1`);
  await q(`DELETE FROM negocio_modulos WHERE negocio_id = $1`);
  await q(`DELETE FROM configuracion WHERE negocio_id = $1`);
  await q(`DELETE FROM sucursales WHERE negocio_id = $1`);
  await q(`DELETE FROM usuario_negocios WHERE negocio_id = $1`);
  await q(`DELETE FROM usuarios WHERE negocio_id = $1`);
  await q(`DELETE FROM negocios WHERE id = $1`);
}
await limpiar();

const { rows: [neg] } = await pool.query(`INSERT INTO negocios (nombre, slug) VALUES ('Tarjeta Cobro Simple', $1) RETURNING id`, [SLUG]);
const N = neg.id;
for (const m of ['pos', 'caja', 'menu']) {
  await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,'activo')`, [N, m]);
}
await pool.query(`INSERT INTO metodos_pago (negocio_id, tipo, habilitado, orden) VALUES ($1,'efectivo',TRUE,0)`, [N]);
await pool.query(`INSERT INTO sucursales (negocio_id, nombre) VALUES ($1,'Principal')`, [N]);
async function persona(nombre, rol) {
  const { rows: [u] } = await pool.query(
    `INSERT INTO usuarios (negocio_id, nombre, email, password_hash) VALUES ($1,$2,$3,'x') RETURNING id`,
    [N, nombre, `${SLUG}-${rol}-${Math.random().toString(36).slice(2)}@test.local`]);
  await pool.query(`INSERT INTO usuario_negocios (usuario_id, negocio_id, rol) VALUES ($1,$2,$3)`, [u.id, N, rol]);
  return u.id;
}
const ADMIN = await persona('Admin Tarjeta', 'admin');
const STAFF = await persona('Sara Staff', 'staff');
const { rows: [cat] } = await pool.query(
  `INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,'Bebidas',TRUE,0) RETURNING id`, [N]);
const { rows: [refresco] } = await pool.query(
  `INSERT INTO menu_productos (negocio_id, categoria_id, codigo, nombre, descripcion, precio, disponible, orden)
   VALUES ($1,$2,'REFRESCO','Refresco','',39,TRUE,0) RETURNING id`, [N, cat.id]);

// Un pedido de la tienda que se paga al recibir, como lo deja tiendaCheckout
// (pago_confirmado: false, forma de pago real). Se siembra ANTES de arrancar:
// el servidor lo sube a su memoria al cargar los pedidos activos.
const FOLIO_TIENDA = `TST-PAGA-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
await pool.query(`INSERT INTO pedidos_activos (folio, estado, datos, negocio_id) VALUES ($1,'nuevo',$2,$3)`, [FOLIO_TIENDA, JSON.stringify({
  id: FOLIO_TIENDA, negocioId: N, canal: 'tienda_online', modalidad: 'recoger en tienda', estado: 'nuevo',
  forma_pago: 'efectivo', pago_confirmado: false, paga_despues: true, costo_envio: 0, subtotal: 39, total: 39,
  timestamp: new Date().toISOString(),
  cliente: { nombre: 'Paga Al Recibir', telefono: '—' },
  items: [{ nombre: 'Refresco', cantidad: 1, precio_unitario: 39 }],
}), N]);

const srv = await arrancarServidor({ PORT: PUERTO, ADMIN_PASSWORD: CLAVE_ADMIN }, { timeoutMs: 30000 });
const galleta = (id, rol) => `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId: id, negocioId: N, rol }))}`;
const cookieAdmin = galleta(ADMIN, 'admin');
const cookieStaff = galleta(STAFF, 'staff');
async function api(path, { cookie = cookieAdmin, method = 'GET', body, headers = {} } = {}) {
  const r = await fetch(srv.base + path, {
    method, headers: { 'Content-Type': 'application/json', Cookie: cookie, ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, body: json };
}
// Pedido de mostrador («Para llevar»): nace por cobrar, como en el POS.
let n = 0;
async function pedidoMostrador(nombre = `Cliente ${++n}`) {
  const r = await api('/api/pedido-presencial', { method: 'POST', body: { items: [{ producto_id: refresco.id, cantidad: 1 }], nombre } });
  assert(r.status === 200 && r.body?.ok && r.body?.pedido?.id, `crear pedido: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.pedido.id;
}
const fila = async (folio) => (await pool.query(`SELECT estado, datos FROM pedidos_activos WHERE folio = $1 AND negocio_id = $2`, [folio, N])).rows[0];
// «Entregado» se archiva en la base después de responder (archivarPedidoActivo
// no se espera): se lee hasta que llegue, o hasta 5 s.
async function esperarEstado(folio, estado, ms = 5000) {
  const hasta = Date.now() + ms;
  let f = await fila(folio);
  while (f?.estado !== estado && Date.now() < hasta) {
    await new Promise(r => setTimeout(r, 100));
    f = await fila(folio);
  }
  return f;
}

try {
  // ═══════════ Servidor ═══════════
  let sinCobrar = null;
  await t('SERVIDOR', '1. un pedido de mostrador nace por cobrar', async () => {
    sinCobrar = await pedidoMostrador('Por Cobrar');
    const f = await fila(sinCobrar);
    assert(f.datos.pago_confirmado === false && f.datos.forma_pago === 'por_cobrar',
      `nació ${JSON.stringify({ p: f.datos.pago_confirmado, f: f.datos.forma_pago })}`);
  });
  await t('SERVIDOR', '2. no se entrega sin cobrar: 409 PEDIDO_SIN_COBRO y la base no cambia', async () => {
    const r = await api(`/pedidos/${sinCobrar}/estado`, { method: 'PATCH', body: { estado: 'entregado' } });
    assert(r.status === 409 && r.body?.codigo === 'PEDIDO_SIN_COBRO', `respuesta: ${r.status} ${JSON.stringify(r.body)}`);
    assert((await fila(sinCobrar)).estado === 'nuevo', 'se entregó sin cobrar');
  });
  await t('SERVIDOR', '2b. el caso XAB-0953: reetiquetado «terminal» sin cobro tampoco se entrega ni se vuelve a reetiquetar', async () => {
    const folio = await pedidoMostrador('Reetiquetado');
    // Como lo dejaba ✏️ Pago antes de este cambio: la etiqueta dice terminal y
    // la marca de pago sigue en false.
    await pool.query(`UPDATE pedidos_activos SET datos = jsonb_set(datos, '{forma_pago}', '"terminal (tarjeta presente)"')
                      WHERE folio = $1 AND negocio_id = $2`, [folio, N]);
    const e = await api(`/pedidos/${folio}/estado`, { method: 'PATCH', body: { estado: 'entregado' } });
    assert(e.status === 409 && e.body?.codigo === 'PEDIDO_SIN_COBRO', `entrega: ${e.status} ${JSON.stringify(e.body)}`);
    const p = await api(`/api/admin/pedido/${folio}/pago`, { method: 'PATCH', body: { forma_pago: 'efectivo' } });
    assert(p.status === 409 && p.body?.codigo === 'PEDIDO_POR_COBRAR', `corrección: ${p.status} ${JSON.stringify(p.body)}`);
  });
  await t('SERVIDOR', '3. «Preparando» y «Listo» siguen sin pedir cobro', async () => {
    for (const estado of ['en_preparacion', 'listo']) {
      const r = await api(`/pedidos/${sinCobrar}/estado`, { method: 'PATCH', body: { estado } });
      assert(r.status === 200, `${estado}: ${r.status} ${JSON.stringify(r.body)}`);
    }
    // El cambio de estado también se escribe en la base después de responder.
    assert((await esperarEstado(sinCobrar, 'listo')).estado === 'listo', 'no quedó listo');
  });
  await t('SERVIDOR', '4. corregir la forma de pago de uno sin cobrar: 409 PEDIDO_POR_COBRAR (la etiqueta no cobra)', async () => {
    const r = await api(`/api/admin/pedido/${sinCobrar}/pago`, { method: 'PATCH', body: { forma_pago: 'terminal (tarjeta presente)' } });
    assert(r.status === 409 && r.body?.codigo === 'PEDIDO_POR_COBRAR', `respuesta: ${r.status} ${JSON.stringify(r.body)}`);
    const f = await fila(sinCobrar);
    assert(f.datos.forma_pago === 'por_cobrar' && f.datos.pago_confirmado === false, 'cambió la etiqueta');
  });
  await t('SERVIDOR', '5. ya cobrado, la forma de pago se corrige y el pedido se entrega', async () => {
    const folio = await pedidoMostrador('Cobrado Api');
    const c = await api(`/pedidos/${folio}/cobro`, { method: 'PATCH', body: { forma_pago: 'efectivo', billete: 50 } });
    assert(c.status === 200 && c.body?.ok, `cobro: ${JSON.stringify(c.body)}`);
    const r = await api(`/api/admin/pedido/${folio}/pago`, { method: 'PATCH', body: { forma_pago: 'terminal (tarjeta presente)' } });
    assert(r.status === 200, `corrección: ${r.status} ${JSON.stringify(r.body)}`);
    const e = await api(`/pedidos/${folio}/estado`, { method: 'PATCH', body: { estado: 'entregado' } });
    assert(e.status === 200, `entrega: ${e.status} ${JSON.stringify(e.body)}`);
    const f = await esperarEstado(folio, 'entregado');
    assert(f.estado === 'entregado' && f.datos.forma_pago === 'terminal (tarjeta presente)' && f.datos.pago_confirmado === true,
      `base: ${JSON.stringify({ e: f.estado, f: f.datos.forma_pago, p: f.datos.pago_confirmado })}`);
  });
  await t('REGLA', '6. la regla del panel y la del servidor dicen lo mismo en todos los casos', async () => {
    const fuente = readFileSync(join(__dirname, '..', 'panel', 'index.html'), 'utf8');
    const i = fuente.indexOf('function esPorCobrar(p)');
    const j = fuente.indexOf('\n}\n', i);
    assert(i > 0 && j > i, 'no se encontró esPorCobrar en el panel');
    const ctx = {};
    vm.runInNewContext(`${fuente.slice(i, j + 2)}; resultado = esPorCobrar;`, ctx);
    const esPorCobrar = ctx.resultado;
    const casos = [];
    for (const canal of ['presencial', 'tienda_online', 'pos', 'whatsapp', undefined]) {
      for (const pago_confirmado of [true, false, undefined, null]) {
        for (const forma_pago of ['por_cobrar', 'pendiente', 'efectivo', 'terminal (tarjeta presente)', 'rappi', '', undefined]) {
          casos.push({ canal, pago_confirmado, forma_pago });
        }
      }
    }
    const distintos = casos.filter(c => esPorCobrar({ ...c, estado: 'entregado' }) !== seCobraEnMostrador(c));
    assert(!distintos.length, `difieren: ${JSON.stringify(distintos.slice(0, 5))}`);
    assert(casos.some(c => seCobraEnMostrador(c)), 'la regla nunca dice «por cobrar»: la prueba no prueba nada');
    assert(esPorCobrar({ canal: 'presencial', estado: 'pendiente_pago', pago_confirmado: false }) === false,
      'un pedido que espera pago en línea no se cobra en caja');
  });
  await t('TIENDA', '7. la tienda que se paga al recibir sigue como estaba: se corrige su forma de pago y se entrega sin 409', async () => {
    const r = await api(`/api/admin/pedido/${FOLIO_TIENDA}/pago`, { method: 'PATCH', body: { forma_pago: 'terminal (tarjeta presente)' } });
    assert(r.status === 200, `corrección: ${r.status} ${JSON.stringify(r.body)}`);
    const e = await api(`/pedidos/${FOLIO_TIENDA}/estado`, { method: 'PATCH', body: { estado: 'entregado' } });
    assert(e.status === 200, `entrega: ${e.status} ${JSON.stringify(e.body)}`);
    const f = await esperarEstado(FOLIO_TIENDA, 'entregado');
    assert(f.estado === 'entregado' && Number(f.datos.total) === 39, `base: ${JSON.stringify({ e: f.estado, t: f.datos.total })}`);
  });

  // ═══════════ Pantallas ═══════════
  const navegador = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const ERRORES = [];
  async function pagina(cookie, etiqueta) {
    const ctx = await navegador.createBrowserContext();
    const page = await ctx.newPage();
    await page.setViewport({ width: 1300, height: 900 });
    await page.setCookie({ name: 'xabor_sesion', value: cookie.slice(cookie.indexOf('=') + 1), url: srv.base });
    // La impresión abre una ventana aparte: aquí queda anotada (qué papel salió).
    await page.evaluateOnNewDocument(() => {
      window.__papeles = [];
      window.open = function () {
        const papel = { html: '' };
        window.__papeles.push(papel);
        return { document: { write(h) { papel.html += h; }, close() {} }, print() {}, close() {}, onload: null };
      };
    });
    page.on('dialog', d => d.accept().catch(() => {}));
    page.on('pageerror', e => ERRORES.push(`${etiqueta}: ${e.message || e}`));
    await page.goto(srv.base + '/app', { waitUntil: 'networkidle2' });
    await page.waitForFunction(() => typeof renderComanda === 'function' && typeof ws !== 'undefined' && ws && ws.readyState === 1, { timeout: 15000 });
    await page.evaluate(() => mostrarTab('comandas'));
    return page;
  }
  const tickets = (page) => page.evaluate(() => window.__papeles.filter(p => /TICKET DE CLIENTE/.test(p.html)).length);
  const esperarTarjeta = (page, folio) => page.waitForSelector(`#comanda-${folio}`, { timeout: 10000 });
  const esperarSinTarjeta = (page, folio) => page.waitForFunction((f) => !document.getElementById(`comanda-${f}`), { timeout: 10000 }, folio);
  const abrirTarjeta = (page, folio) => page.evaluate((f) => { if (!comandasAbiertas.has(f)) toggleComanda(f); }, folio);
  // Botones que el operador VE en el pie de la tarjeta (lo plegado no cuenta).
  const visibles = (page, folio) => page.evaluate((f) => [...document.querySelectorAll(`#comanda-${f} .comanda-footer button`)]
    .filter(b => b.getClientRects().length > 0).map(b => b.textContent.trim()), folio);
  const delMenu = (page, folio) => page.evaluate((f) => [...document.querySelectorAll(`#menu-${f} button`)].map(b => b.textContent.trim()), folio);
  try {
    const adm = await pagina(cookieAdmin, 'admin');

    let folioT = null;
    await t('TARJETA', '8. sin cobrar, la tarjeta muestra solo «💵 Cobrar» y «⋯ Más»', async () => {
      folioT = await pedidoMostrador('Mostrador Uno');
      await esperarTarjeta(adm, folioT);
      await abrirTarjeta(adm, folioT);
      const v = await visibles(adm, folioT);
      assert(v.length === 2 && v[0].endsWith('Cobrar') && v[1].endsWith('Más'), `visibles: ${JSON.stringify(v)}`);
    });
    await t('TARJETA', '9. «Más» trae lo demás, y sin cobrar no ofrece corregir la forma de pago', async () => {
      await adm.click(`#comanda-${folioT} .btn-mas`);
      const v = await visibles(adm, folioT);
      for (const texto of ['Preparando', 'Listo', 'Imprimir comanda', 'Imprimir ticket', 'Reenviar a cocina', 'Cancelar pedido']) {
        assert(v.some(x => x.endsWith(texto)), `falta «${texto}»: ${JSON.stringify(v)}`);
      }
      assert(!(await delMenu(adm, folioT)).some(x => /Corregir forma de pago/.test(x)), 'sin cobrar no se corrige la forma de pago');
      assert(!v.some(x => x.endsWith('Entregado')), 'sin cobrar no se ofrece «Entregado»');
      await adm.keyboard.press('Escape');
      assert(await adm.evaluate((f) => document.getElementById(`menu-${f}`).hidden, folioT), 'Escape no cerró «Más»');
    });
    await t('TARJETA', '10. la ventana de cobro no trae forma de pago elegida; sin elegir no cobra', async () => {
      await adm.click(`#comanda-${folioT} .btn-cobrar`);
      await adm.waitForFunction(() => document.getElementById('modal-cobro').classList.contains('visible'), { timeout: 5000 });
      const sel = await adm.evaluate(() => document.querySelectorAll('[data-cobro-pago].selected').length);
      assert(sel === 0, `hay ${sel} formas preseleccionadas`);
      await adm.evaluate(() => confirmarCobro());
      const fb = await adm.$eval('#cobro-fb', el => el.textContent.trim());
      assert(fb === 'Elige cómo pagó.', `aviso: ${fb}`);
      assert((await fila(folioT)).datos.pago_confirmado === false, 'cobró sin forma de pago');
    });
    await t('TARJETA', '11. al cobrar con terminal sale el ticket y la tarjeta pasa a «📦 Entregado»', async () => {
      await adm.click('[data-cobro-pago="terminal (tarjeta presente)"]');
      await adm.evaluate(() => confirmarCobro());
      await adm.waitForFunction((f) => /Entregado/.test(document.querySelector(`#comanda-${f} .btn-principal`)?.textContent || ''), { timeout: 8000 }, folioT);
      const f = await fila(folioT);
      assert(f.datos.pago_confirmado === true && f.datos.forma_pago === 'terminal (tarjeta presente)',
        `base: ${JSON.stringify({ p: f.datos.pago_confirmado, f: f.datos.forma_pago })}`);
      assert(await tickets(adm) === 1, `tickets impresos: ${await tickets(adm)}`);
      // El aviso en vivo del cobro (WebSocket 'pago_confirmado') no agrega una
      // segunda insignia, y no dice «Clip» de un cobro con terminal.
      await new Promise(r => setTimeout(r, 500));
      const insignias = await adm.$$eval(`#comanda-${folioT} .badge-pago-clip`, bs => bs.map(b => b.textContent.trim()));
      assert(insignias.length === 1 && insignias[0] === '✓ Pagado', `insignias: ${JSON.stringify(insignias)}`);
      const v = await visibles(adm, folioT);
      assert(v.length === 2 && v[0].endsWith('Entregado') && v[1].endsWith('Más'), `visibles: ${JSON.stringify(v)}`);
      assert((await delMenu(adm, folioT)).some(x => /Corregir forma de pago/.test(x)), 'ya cobrado, el administrador corrige la forma de pago desde «Más»');
      // La ventana de cobro se cierra sola un momento después.
      await adm.waitForFunction(() => !document.getElementById('modal-cobro').classList.contains('visible'), { timeout: 5000 });
    });
    await t('TARJETA', '12. «Entregado» lo saca del tablero y queda entregado en la base', async () => {
      await adm.click(`#comanda-${folioT} .btn-entregado`);
      await esperarSinTarjeta(adm, folioT);
      assert((await esperarEstado(folioT, 'entregado')).estado === 'entregado', 'no quedó entregado');
    });
    await t('TARJETA', '13. un «Entregado» que el servidor rechaza (pantalla vieja) deja la tarjeta en «Cobrar» y avisa', async () => {
      const folio = await pedidoMostrador('Pantalla Vieja');
      await esperarTarjeta(adm, folio);
      // Como la tenía una pantalla con el panel anterior: la tarjeta cree que
      // ya está cobrado.
      await adm.evaluate((f) => { pedidos[f].pago_confirmado = true; document.getElementById(`comanda-${f}`).innerHTML = renderComanda(pedidos[f]); }, folio);
      await adm.evaluate(() => document.getElementById('avisos-panel')?.replaceChildren());
      await adm.evaluate((f) => marcarEntregado(f), folio);
      await adm.waitForFunction((f) => /Cobrar/.test(document.querySelector(`#comanda-${f} .btn-principal`)?.textContent || ''), { timeout: 8000 }, folio);
      const avisos = await adm.evaluate(() => [...document.querySelectorAll('#avisos-panel [role=alert]')].map(a => a.textContent));
      assert(avisos.some(a => /no está cobrado/.test(a)), `avisos: ${JSON.stringify(avisos)}`);
      assert((await fila(folio)).estado === 'nuevo', 'se entregó');
    });
    await t('TIENDA', '14. la tarjeta de la tienda que se paga al recibir no cambia: nunca dice «Cobrar»', async () => {
      const html = await adm.evaluate(() => renderComanda({
        id: 'TST-TIENDA-RENDER', canal: 'tienda_online', modalidad: 'recoger en tienda', estado: 'listo',
        forma_pago: 'efectivo', pago_confirmado: false, total: 39, timestamp: new Date().toISOString(),
        cliente: { nombre: 'Paga Al Recibir', telefono: '—' }, items: [{ nombre: 'Refresco', cantidad: 1, precio_unitario: 39 }],
      }));
      assert(/btn-entregado btn-principal/.test(html) && !/btn-cobrar/.test(html), 'la tienda que paga al recibir mostró «Cobrar»');
    });

    // ═══════════ Cancelar: un solo botón ═══════════
    await t('CANCELAR', '15. administrador: «Más» → «Cancelar pedido» pide solo el motivo; queda cancelado con él y quién', async () => {
      const folio = await pedidoMostrador('Cancelar Admin');
      await esperarTarjeta(adm, folio);
      await abrirTarjeta(adm, folio);
      await adm.click(`#comanda-${folio} .btn-mas`);
      await adm.click(`#menu-${folio} .menu-peligro`);
      await adm.waitForFunction(() => document.getElementById('modal-cancelar-overlay').style.display === 'flex', { timeout: 5000 });
      assert(await adm.$eval('#cancelar-clave-wrap', el => el.style.display === 'none'), 'al administrador no se le pide contraseña');
      await adm.click('#btn-confirmar-cancelar');
      const fb = await adm.$eval('#cancelar-fb', el => el.textContent.trim());
      assert(fb === 'Escribe el motivo de la cancelación.', `sin motivo: ${fb}`);
      assert((await fila(folio)).estado === 'nuevo', 'canceló sin motivo');
      await adm.type('#cancelar-motivo', 'El cliente se fue');
      await adm.click('#btn-confirmar-cancelar');
      await esperarSinTarjeta(adm, folio);
      const f = await fila(folio);
      assert(f.estado === 'cancelado' && f.datos.cancelacion?.motivo === 'El cliente se fue' && f.datos.cancelacion?.por === ADMIN,
        `base: ${JSON.stringify({ e: f.estado, c: f.datos.cancelacion })}`);
    });
    await t('CANCELAR', '16. personal: el mismo botón pide la contraseña de administrador; mal no cancela, bien sí', async () => {
      const staff = await pagina(cookieStaff, 'staff');
      const folio = await pedidoMostrador('Cancelar Staff');
      await esperarTarjeta(staff, folio);
      await abrirTarjeta(staff, folio);
      await staff.click(`#comanda-${folio} .btn-mas`);
      const menu = await delMenu(staff, folio);
      assert(!menu.some(x => /Reenviar a cocina|Corregir forma de pago/.test(x)), `el personal ve opciones de administrador: ${JSON.stringify(menu)}`);
      await staff.click(`#menu-${folio} .menu-peligro`);
      await staff.waitForFunction(() => document.getElementById('modal-cancelar-overlay').style.display === 'flex', { timeout: 5000 });
      assert(await staff.$eval('#cancelar-clave-wrap', el => el.style.display !== 'none'), 'al personal se le pide la contraseña');
      await staff.type('#cancelar-motivo', 'Pedido duplicado');
      await staff.click('#btn-confirmar-cancelar');
      assert((await staff.$eval('#cancelar-fb', el => el.textContent.trim())) === 'Falta la contraseña de administrador.', 'sin contraseña');
      await staff.type('#cancelar-clave', 'otra');
      await staff.click('#btn-confirmar-cancelar');
      await staff.waitForFunction(() => /incorrecta/.test(document.getElementById('cancelar-fb').textContent), { timeout: 5000 });
      assert((await fila(folio)).estado === 'nuevo', 'canceló con contraseña equivocada');
      await staff.$eval('#cancelar-clave', el => { el.value = ''; });
      await staff.type('#cancelar-clave', CLAVE_ADMIN);
      await staff.click('#btn-confirmar-cancelar');
      await esperarSinTarjeta(staff, folio);
      const f = await fila(folio);
      assert(f.estado === 'cancelado' && f.datos.cancelacion?.motivo === 'Pedido duplicado' && f.datos.cancelacion?.por === STAFF,
        `base: ${JSON.stringify({ e: f.estado, c: f.datos.cancelacion })}`);
      await staff.close();
    });

    // ═══════════ Historial y Caja ═══════════
    await t('HISTORIAL', '17. lo que salió sin cobro va en «Por cobrar» (no en ventas) y su «Cobrar» lo registra', async () => {
      const folio = await pedidoMostrador('Salio Sin Cobro');
      await esperarTarjeta(adm, folio);
      // Como quedaron los 15 de Obispado: entregado, reetiquetado y sin cobro.
      await pool.query(`UPDATE pedidos_activos SET estado = 'entregado', entregado_at = NOW(),
                          datos = jsonb_set(datos, '{forma_pago}', '"terminal (tarjeta presente)"')
                        WHERE folio = $1 AND negocio_id = $2`, [folio, N]);
      await adm.evaluate((f) => retirarComandaDelTablero(f), folio);
      await adm.evaluate(() => { window.__papeles = []; mostrarTab('historial'); });
      await adm.waitForFunction(() => !!document.querySelector('#hist-chips .corte-chip[data-filtro="por_cobrar"]'), { timeout: 10000 });
      const chip = await adm.$eval('#hist-chips .corte-chip[data-filtro="por_cobrar"]', b => b.textContent.replace(/\s+/g, ' ').trim());
      assert(/^Por cobrar 1 · \$39/.test(chip), `pestaña: ${chip}`);
      await adm.evaluate(() => histFiltrar('todas'));
      const enVentas = await adm.$$eval('#historial-lista > div', ds => ds.some(d => d.textContent.includes('Salio Sin Cobro')));
      assert(!enVentas, 'se contó como venta');
      const tiendaEnVentas = await adm.$$eval('#historial-lista > div', ds => ds.some(d => d.textContent.includes('Paga Al Recibir')));
      assert(tiendaEnVentas, 'la tienda que se paga al recibir dejó de verse donde estaba');
      await adm.evaluate(() => histFiltrar('por_cobrar'));
      await adm.click('#historial-lista .hist-cobrar');
      await adm.waitForFunction(() => document.getElementById('modal-cobro').classList.contains('visible'), { timeout: 5000 });
      const total = await adm.$eval('#cobro-total', el => el.textContent.trim());
      assert(total === '$39', `total estimado: ${total}`);
      await adm.click('[data-cobro-pago="terminal (tarjeta presente)"]');
      await adm.evaluate(() => confirmarCobro());
      await adm.waitForFunction(() => /Por cobrar 0/.test(document.querySelector('#hist-chips .corte-chip[data-filtro="por_cobrar"]')?.textContent || ''), { timeout: 10000 });
      const f = await fila(folio);
      assert(f.datos.pago_confirmado === true && f.datos.forma_pago === 'terminal (tarjeta presente)' && Number(f.datos.total) === 39,
        `base: ${JSON.stringify({ p: f.datos.pago_confirmado, f: f.datos.forma_pago, t: f.datos.total })}`);
      assert(await tickets(adm) === 0, 'cobrar algo que ya salió no imprime ticket');
      await adm.waitForFunction(() => !document.getElementById('modal-cobro').classList.contains('visible'), { timeout: 5000 });
    });
    await t('CAJA', '18. en Caja, «Por cobrar» del mostrador trae «Cobrar»: al cobrar sale de ahí y suma al efectivo; la tienda no', async () => {
      const folio = await pedidoMostrador('Caja Cobra');
      await esperarTarjeta(adm, folio);
      await adm.evaluate(() => mostrarTab('corte'));
      await adm.waitForFunction((f) => (CORTE_DATA?.pendientes || []).some(p => p.folio === f)
        && [...document.querySelectorAll('#corte-lista .corte-cobrar')].some(b => b.getAttribute('onclick').includes(f)), { timeout: 10000 }, folio);
      const conBoton = await adm.$$eval('#corte-lista .corte-cobrar', bs => bs.map(b => b.getAttribute('onclick')));
      assert(!conBoton.some(o => o.includes('TST-PAGA-')), 'la tienda que se paga al recibir no se cobra desde Caja');
      assert((await adm.evaluate(() => CORTE_DATA.pendientes.map(p => p.folio))).includes(FOLIO_TIENDA), 'la tienda sigue listada por cobrar, como antes');
      const antes = await adm.evaluate(() => Number(CORTE_DATA.ventas_efectivo) || 0);
      await adm.evaluate((f) => cobrarDesdeCaja(f), folio);
      await adm.waitForFunction(() => document.getElementById('modal-cobro').classList.contains('visible'), { timeout: 5000 });
      await adm.click('[data-cobro-pago="efectivo"]');
      await adm.type('#cobro-billete', '50');
      await adm.evaluate(() => confirmarCobro());
      await adm.waitForFunction((a) => (Number(CORTE_DATA?.ventas_efectivo) || 0) > a, { timeout: 10000 }, antes);
      const despues = await adm.evaluate(() => Number(CORTE_DATA.ventas_efectivo) || 0);
      assert(Math.round((despues - antes) * 100) === 3900, `efectivo: ${antes} → ${despues}`);
      assert(!(await adm.evaluate((f) => CORTE_DATA.pendientes.some(p => p.folio === f), folio)), 'sigue por cobrar');
      const f = await fila(folio);
      assert(f.datos.pago_confirmado === true && Number(f.datos.cambio) === 11, `base: ${JSON.stringify({ p: f.datos.pago_confirmado, c: f.datos.cambio })}`);
    });
    await t('PANTALLAS', '19. ninguna pantalla lanzó errores de JavaScript', async () => {
      assert(ERRORES.length === 0, ERRORES.join(' | '));
    });
  } finally {
    await navegador.close().catch(() => {});
  }
} finally {
  srv.detener();
  await limpiar().catch(() => {});
  await pool.end();
}

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallidas) { console.log('Fallos:\n  · ' + fallos.join('\n  · ')); process.exit(1); }
process.exit(0);
