// ASISTENTE DEL RESTAURANTE, Fase 1: sus avisos en la campanita, en un
// navegador real (puppeteer) contra el servidor local de prueba.
//
// Negocio y avisos INVENTADOS. Cubre: la huella ?v= de los dos archivos y su
// orden en index.html; la sección «Asistente del restaurante» con su número
// en la campana; el texto que viene de la base se pinta como texto; «Ver
// números» con la tabla formateada; Útil (y que cuenta como visto); «No
// avisar de esto» lo quita; junto con los avisos del panel, el número se suma
// y «Marcar todos» cubre los dos; el operador no lo ve ni lo pide; en ensayo
// no aparece; y en el celular la lista no se sale de la pantalla.
import assert from 'assert';
import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const raiz = (r) => join(__dirname, '..', r);

if (!process.env.DATABASE_URL) { console.error('Falta DATABASE_URL'); process.exit(2); }
if (/railway|rlwy/i.test(process.env.DATABASE_URL)) { console.error('Esta suite no corre contra Railway'); process.exit(2); }

const { pool } = await import('../src/services/database.js');
const { fechaOperativaDe } = await import('../src/services/cortesCaja.js');
const { sumarDias } = await import('../src/asistenteRestaurante/reglas.js');
const P = await import('../src/asistenteRestaurante/proceso.js');
const AV = await import('../src/asistenteRestaurante/avisos.js');
const AP = await import('../src/services/avisosPanel.js');

let pasadas = 0, fallidas = 0; const fallos = [];
async function t(nombre, fn) {
  if (process.env.CASOS && !new RegExp(process.env.CASOS).test(nombre)) return;
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

// ═══ A. Los archivos ═══════════════════════════════════════════════════════
const HTML = readFileSync(raiz('panel/index.html'), 'utf8');
const JS_PANEL = readFileSync(raiz('panel/avisos-panel.js'), 'utf8');
const JS_ASIS = readFileSync(raiz('panel/asistente-avisos.js'), 'utf8');
const huella = (f) => createHash('sha256').update(readFileSync(raiz(`panel/${f}`))).digest('hex').slice(0, 8);

await t('A1. huellas ?v= correctas y el asistente se carga DESPUÉS de la campanita', () => {
  const p = `<script src="/avisos-panel.js?v=${huella('avisos-panel.js')}"></script>`;
  const s = `<script src="/asistente-avisos.js?v=${huella('asistente-avisos.js')}"></script>`;
  assert.ok(HTML.includes(p), `la huella correcta de avisos-panel.js es ${huella('avisos-panel.js')}`);
  assert.ok(HTML.includes(s), `la huella correcta de asistente-avisos.js es ${huella('asistente-avisos.js')}`);
  assert.ok(HTML.indexOf(p) < HTML.indexOf(s));
  assert.match(HTML, /fuentes: \{ asistente: MODULOS\.includes\('pos'\) \},/);
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML|document\.write/.test(JS_ASIS), 'el módulo del asistente arma HTML con texto');
});

await t('A2. el módulo se suma a la campanita y formatea los números', () => {
  const ctx = {}; vm.createContext(ctx);
  vm.runInContext(JS_PANEL, ctx); vm.runInContext(JS_ASIS, ctx);
  const M = ctx.XaborAsistenteAvisos;
  assert.strictEqual(M.fuente.id, 'asistente');
  assert.strictEqual(M.valor(4200.4, 'dinero'), '$4,200');
  assert.strictEqual(M.valor(12.345, 'pct'), '12.3 %');
  assert.strictEqual(M.valor(1.256, 'decimal'), '1.26');
  assert.strictEqual(M.valor(1520, 'entero'), '1,520');
  assert.strictEqual(M.valor(null, 'dinero'), '—');
  assert.strictEqual(M.valor('Café', 'texto'), 'Café');
  assert.strictEqual(M.fechaCorta('2026-12-03'), '3 dic');
  assert.strictEqual(M.textoRevisar({ numero: 'Venta semanal de «Café»', valor: 3500, formato: 'dinero', el: '2026-12-03' }),
    'Revisar el 3 dic: Venta semanal de «Café» (hoy: $3,500).');
  assert.strictEqual(M.textoRevisar(null), '');
});

// ═══ B. En un navegador real ══════════════════════════════════════════════
const ZONAS = ['America/Matamoros', 'Asia/Tokyo', 'Europe/Madrid', 'America/Los_Angeles', 'Australia/Sydney'];
const TZ = ZONAS.find((z) => [0, 20, 40].every((m) => { const h = P.horaLocal(new Date(Date.now() + m * 60000), z); return h < 5 || h >= 13; }));
const HOY = fechaOperativaDe(new Date(), TZ);

const TAG = 'AP' + (Date.now() % 1e8).toString(36).toUpperCase();
const q = (sql, params) => pool.query(sql, params);
const uno = async (sql, params) => (await q(sql, params)).rows[0];
async function limpiar() {
  const { rows } = await q(`SELECT id FROM negocios WHERE slug LIKE '%-asis-f1p-_'`);
  for (const { id } of rows) {
    const del = (sql) => q(sql, [id]).catch(() => {});
    await del('DELETE FROM asistente_restaurante_silenciados WHERE negocio_id = $1');
    await del('DELETE FROM asistente_restaurante_corridas WHERE negocio_id = $1');
    await del('DELETE FROM avisos_panel WHERE negocio_id = $1');
    await del('DELETE FROM configuracion WHERE negocio_id = $1');
    await del('DELETE FROM negocio_modulos WHERE negocio_id = $1');
    await del('DELETE FROM usuario_negocios WHERE negocio_id = $1');
  }
  for (const { id } of rows) {
    await q('DELETE FROM usuarios WHERE negocio_id = $1', [id]).catch(() => {});
    await q('DELETE FROM negocios WHERE id = $1', [id]).catch(() => {});
  }
}
await limpiar();
const A = (await uno('INSERT INTO negocios (nombre, slug) VALUES ($1, $2) RETURNING id', [`${TAG} Sucursal`, `${TAG.toLowerCase()}-asis-f1p-a`])).id;
for (const m of ['pos', 'caja', 'whatsapp']) await q(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,'activo')`, [A, m]);
async function usuario(nombre, rol) {
  const u = await uno(`INSERT INTO usuarios (negocio_id, nombre, email, password_hash, activo) VALUES ($1,$2,$3,'x',true) RETURNING id`,
    [A, nombre, `${TAG.toLowerCase()}-${nombre.replace(/\W+/g, '').toLowerCase()}@test.local`]);
  await q('INSERT INTO usuario_negocios (usuario_id, negocio_id, rol, activo) VALUES ($1,$2,$3,true)', [u.id, A, rol]);
  return u.id;
}
const ADMIN = await usuario(`${TAG} Dueño`, 'admin');
const STAFF = await usuario(`${TAG} Cajera`, 'staff');
async function cfg(clave, valor) {
  await q('DELETE FROM configuracion WHERE negocio_id = $1 AND clave = $2', [A, clave]);
  if (valor !== undefined) await q('INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,$2,$3)', [A, clave, valor]);
}
await cfg('timezone', TZ);

const XSS = '<img src=x onerror="window.__xss=1">';
const REVISAR_EL = sumarDias(HOY, 7);
async function sembrar() {
  await q('DELETE FROM asistente_restaurante_corridas WHERE negocio_id = $1', [A]);
  await q('DELETE FROM asistente_restaurante_silenciados WHERE negocio_id = $1', [A]);
  const c = await uno(`INSERT INTO asistente_restaurante_corridas (negocio_id, fecha, modo, estado, candidatos, elegidos)
                       VALUES ($1, $2, 'visible', 'lista', 2, 2) RETURNING id`, [A, HOY]);
  const h = (tipo, firma, impacto, titulo, contenido) => uno(
    `INSERT INTO asistente_restaurante_hallazgos (negocio_id, corrida_id, tipo, firma, impacto, titulo, contenido, elegido, motivo, mostrado)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, true, 'elegido', true) RETURNING id::text`, [A, c.id, tipo, firma, impacto, titulo, JSON.stringify(contenido)]);
  const h1 = await h('producto_baja', 'producto_baja:p1', 4200, `«${XSS}» vendió 30 % menos que las 4 semanas anteriores (−$4,200).`, {
    detalle: {
      numeros: [{ etiqueta: 'Venta de las últimas 4 semanas', valor: 9800, formato: 'dinero' }, { etiqueta: 'Tickets con él, ahora', valor: 1520, formato: 'entero' }],
      tabla: { columnas: ['Producto', 'Tickets', 'Venta'], formatos: ['texto', 'entero', 'dinero'], filas: [[XSS, 1520, 9800.4], ['Café', 300, 1200]] },
      nota: 'Sin pedidos grandes.',
    },
    sugerencia: 'Revisa que el platillo esté a la vista en el menú y en la tienda.',
    revisar: { numero: 'Venta semanal del platillo', valor: 2450, formato: 'dinero', el: REVISAR_EL },
    frecuencia: 'diaria',
  });
  const h2 = await h('ventas_sin_forma_pago', 'ventas_sin_forma_pago', 600, '3 ventas de la semana no tienen forma de pago ($600).', {
    detalle: { numeros: [{ etiqueta: 'Ventas', valor: 3, formato: 'entero' }] },
    sugerencia: 'Captura la forma de pago de esas ventas para que el corte cuadre.',
    revisar: { numero: 'Ventas sin forma de pago en la próxima semana', valor: 3, formato: 'entero', el: REVISAR_EL },
    frecuencia: 'diaria',
  });
  return { h1: h1.id, h2: h2.id };
}

const { crearTokenSesion } = await import('../src/services/session.js');
const { arrancarServidor } = await import('./lib-servidor.mjs');
const ses = (u, rol) => encodeURIComponent(crearTokenSesion({ usuarioId: u, negocioId: A, rol }));
const SES = { admin: ses(ADMIN, 'admin'), staff: ses(STAFF, 'staff') };

let puppeteer = null;
try { puppeteer = (await import('puppeteer')).default; } catch { /* sin navegador */ }
let srv = null, navegador = null;
try {
  if (!puppeteer) {
    await t('B. navegador real (puppeteer)', () => { throw new Error('puppeteer no está instalado: no se probó en navegador'); });
  } else {
    srv = await arrancarServidor({ PORT: process.env.TEST_PORT_ASISTENTE_PANEL || '4796' }, { timeoutMs: 40000 });
    const BASE = srv.base;
    navegador = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    async function abrirPanel(sesion, { ancho = 1280, alto = 800 } = {}) {
      const ctxN = await navegador.createBrowserContext();
      await ctxN.setCookie({ name: 'xabor_sesion', value: sesion, url: BASE, httpOnly: true, sameSite: 'Lax' });
      const page = await ctxN.newPage();
      await page.setViewport({ width: ancho, height: alto });
      const pedidas = [];
      const errores = [];
      page.on('request', (r) => { if (r.url().includes('/api/admin/asistente-restaurante/')) pedidas.push(r.url()); });
      page.on('pageerror', (e) => errores.push(e.message));
      await page.evaluateOnNewDocument(() => { window.__xss = 0; });
      await page.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded' });
      return { page, pedidas, errores, cerrar: () => ctxN.close() };
    }
    const contador = (page) => page.$eval('#btn-avisos .av-contador', (e) => (e.hidden ? '' : e.textContent));
    const abrirLista = async (page) => {
      await page.waitForSelector('#btn-avisos:not([hidden])', { timeout: 20000 });
      await page.click('#btn-avisos');
      await page.waitForSelector('#menu-avisos:not([hidden]) .as-item', { timeout: 10000 });
    };
    const opinion = async (id) => (await q('SELECT opinion FROM asistente_restaurante_opiniones WHERE hallazgo_id = $1', [id])).rows.map((r) => r.opinion);
    const visto = async (id) => !!(await uno('SELECT visto_en FROM asistente_restaurante_hallazgos WHERE id = $1', [id])).visto_en;

    await cfg(AV.BANDERA, 'true');
    await cfg(AV.CLAVE_MODO, 'visible');
    await cfg(AV.CLAVE_DESTINATARIOS, JSON.stringify([ADMIN]));
    await cfg(AP.BANDERA_AVISOS_PANEL, undefined);
    let ids = await sembrar();

    await t('B1. la campana muestra el número; la sección del asistente pinta el texto de la base como texto; control primero', async () => {
      const p = await abrirPanel(SES.admin);
      try {
        await p.page.waitForSelector('#btn-avisos:not([hidden])', { timeout: 20000 });
        assert.strictEqual(await contador(p.page), '2');
        await abrirLista(p.page);
        assert.strictEqual(await p.page.$eval('#menu-avisos .as-seccion', (e) => e.textContent), 'Asistente del restaurante');
        const items = await p.page.$$eval('#menu-avisos .as-item', (els) => els.map((e) => ({ id: e.dataset.asistente, texto: e.textContent })));
        // El de control ($600) va antes que el de ventas ($4,200).
        assert.deepStrictEqual(items.map((i) => i.id), [ids.h2, ids.h1], 'el aviso de control no va primero');
        const venta = items[1].texto;
        assert.ok(venta.includes(`«${XSS}» vendió 30 % menos`), 'el texto no se ve tal cual');
        assert.ok(venta.includes('$4,200 en juego'));
        assert.ok(venta.includes('Qué hacer: Revisa que el platillo'));
        assert.ok(venta.includes(`Revisar el ${Number(REVISAR_EL.slice(8))} `) && venta.includes('(hoy: $2,450).'), venta);
        assert.strictEqual(await p.page.$('#menu-avisos img'), null, 'el texto de la base se volvió una etiqueta');
        assert.strictEqual(await p.page.evaluate(() => window.__xss), 0);
        assert.strictEqual(await p.page.$('#menu-avisos .av-vacio'), null, 'con los avisos del panel apagados no debe decir «Sin avisos»');
        assert.deepStrictEqual(p.errores, []);
      } finally { await p.cerrar(); }
    });

    await t('B2. «Ver números»: los números y la tabla formateados, y se ocultan otra vez', async () => {
      const p = await abrirPanel(SES.admin);
      try {
        await abrirLista(p.page);
        const sel = `#menu-avisos .as-item[data-asistente="${ids.h1}"]`;
        assert.strictEqual(await p.page.$eval(`${sel} .as-detalle`, (e) => e.hidden), true);
        await p.page.click(`${sel} .as-ver`);
        await p.page.waitForFunction((s) => document.querySelector(`${s} .as-detalle`)?.hidden === false, { timeout: 5000 }, sel);
        const d = await p.page.$eval(`${sel} .as-detalle`, (e) => ({
          numeros: [...e.querySelectorAll('dd')].map((x) => x.textContent),
          celdas: [...e.querySelectorAll('tbody tr')].map((tr) => [...tr.children].map((td) => td.textContent)),
          nota: e.querySelector('.as-nota')?.textContent,
        }));
        assert.deepStrictEqual(d.numeros, ['$9,800', '1,520']);
        assert.deepStrictEqual(d.celdas, [[XSS, '1,520', '$9,800'], ['Café', '300', '$1,200']]);
        assert.strictEqual(d.nota, 'Sin pedidos grandes.');
        assert.strictEqual(await p.page.$eval(`${sel} .as-ver`, (e) => e.textContent), 'Ocultar números');
        await p.page.click(`${sel} .as-ver`);
        await p.page.waitForFunction((s) => document.querySelector(`${s} .as-detalle`)?.hidden === true, { timeout: 5000 }, sel);
        assert.ok(!(await p.page.$eval('#menu-avisos', (e) => e.hidden)), 'el clic cerró la lista');
      } finally { await p.cerrar(); }
    });

    await t('B3. «Útil» queda marcado, se guarda y cuenta como visto', async () => {
      const p = await abrirPanel(SES.admin);
      try {
        await abrirLista(p.page);
        const sel = `#menu-avisos .as-item[data-asistente="${ids.h1}"]`;
        await p.page.click(`${sel} .as-util`);
        await p.page.waitForFunction(() => document.querySelector('#btn-avisos .av-contador')?.textContent === '1', { timeout: 10000 });
        assert.strictEqual(await p.page.$eval(`${sel} .as-util`, (e) => e.getAttribute('aria-pressed')), 'true');
        assert.strictEqual(await p.page.$eval(`${sel} .as-no_util`, (e) => e.getAttribute('aria-pressed')), 'false');
        assert.deepStrictEqual(await opinion(ids.h1), ['util']);
        assert.strictEqual(await visto(ids.h1), true);
        assert.strictEqual(await p.page.$(`${sel} .as-marcar`), null, 'ya visto y sigue el botón «Visto»');
      } finally { await p.cerrar(); }
    });

    await t('B4. «No avisar de esto» lo quita de la lista y lo calla en la sucursal', async () => {
      const p = await abrirPanel(SES.admin);
      try {
        await abrirLista(p.page);
        await p.page.click(`#menu-avisos .as-item[data-asistente="${ids.h2}"] .as-no_avisar`);
        await p.page.waitForFunction((id) => !document.querySelector(`#menu-avisos .as-item[data-asistente="${id}"]`), { timeout: 10000 }, ids.h2);
        assert.strictEqual(await contador(p.page), '');
        const { rows } = await q('SELECT firma FROM asistente_restaurante_silenciados WHERE negocio_id = $1', [A]);
        assert.deepStrictEqual(rows.map((r) => r.firma), ['ventas_sin_forma_pago']);
      } finally { await p.cerrar(); }
    });

    await t('B5. con los avisos del panel encendidos: el número se suma y «Marcar todos» cubre los dos', async () => {
      ids = await sembrar();
      await cfg(AP.BANDERA_AVISOS_PANEL, 'true');
      await AP.registrarAvisoPanel(A, 'fallas_bot', { datos: { errores: 3 } });
      const p = await abrirPanel(SES.admin);
      try {
        await p.page.waitForSelector('#btn-avisos:not([hidden])', { timeout: 20000 });
        await p.page.waitForFunction(() => document.querySelector('#btn-avisos .av-contador')?.textContent === '3', { timeout: 10000 });
        await abrirLista(p.page);
        assert.strictEqual((await p.page.$$('#menu-avisos .av-item')).length, 1, 'falta el aviso del panel');
        assert.strictEqual((await p.page.$$('#menu-avisos .as-item')).length, 2);
        assert.match(await p.page.$eval('#menu-avisos .av-cabecera', (e) => e.textContent), /Avisos \(3 sin ver\)/);
        await p.page.$eval('#menu-avisos .av-todos', (e) => e.click());
        await p.page.waitForFunction(() => document.querySelector('#btn-avisos .av-contador')?.hidden === true, { timeout: 10000 });
        assert.strictEqual(await visto(ids.h1), true);
        assert.strictEqual(await visto(ids.h2), true);
        const { rows: [r] } = await q('SELECT COUNT(*)::int AS n FROM avisos_panel WHERE negocio_id = $1 AND visto_en IS NULL', [A]);
        assert.strictEqual(r.n, 0);
      } finally { await p.cerrar(); await cfg(AP.BANDERA_AVISOS_PANEL, undefined); }
    });

    await t('B6. el operador no ve la campana ni pide los avisos del asistente', async () => {
      ids = await sembrar();
      const p = await abrirPanel(SES.staff);
      try {
        await p.page.waitForFunction(() => document.readyState === 'complete', { timeout: 20000 });
        await new Promise((r) => setTimeout(r, 2500));
        assert.strictEqual(await p.page.$eval('#btn-avisos', (e) => e.hidden), true);
        assert.deepStrictEqual(p.pedidas, []);
      } finally { await p.cerrar(); }
    });

    await t('B7. en ensayo, o con la bandera apagada, la campana no aparece', async () => {
      for (const [clave, valor] of [[AV.CLAVE_MODO, 'ensayo'], [AV.BANDERA, 'false']]) {
        await cfg(AV.BANDERA, 'true'); await cfg(AV.CLAVE_MODO, 'visible');
        await cfg(clave, valor);
        const p = await abrirPanel(SES.admin);
        try {
          await p.page.waitForFunction(() => document.readyState === 'complete', { timeout: 20000 });
          await new Promise((r) => setTimeout(r, 2500));
          assert.ok(p.pedidas.length >= 1, 'el administrador ni preguntó');
          assert.strictEqual(await p.page.$eval('#btn-avisos', (e) => e.hidden), true, `${clave}=${valor} y se ve`);
        } finally { await p.cerrar(); }
      }
      await cfg(AV.BANDERA, 'true'); await cfg(AV.CLAVE_MODO, 'visible');
    });

    await t('B8. en el celular la lista y su tabla no se salen de la pantalla', async () => {
      ids = await sembrar();
      const p = await abrirPanel(SES.admin, { ancho: 375, alto: 812 });
      try {
        await abrirLista(p.page);
        await p.page.click(`#menu-avisos .as-item[data-asistente="${ids.h1}"] .as-ver`);
        await p.page.waitForSelector(`#menu-avisos .as-item[data-asistente="${ids.h1}"] .as-detalle:not([hidden])`, { timeout: 5000 });
        const m = await p.page.$eval('#menu-avisos', (e) => { const r = e.getBoundingClientRect(); return { izq: r.left, der: r.right }; });
        assert.ok(m.izq >= 0 && m.der <= 375, `la lista se sale: ${JSON.stringify(m)}`);
        const ancho = await p.page.evaluate(() => document.documentElement.scrollWidth);
        assert.ok(ancho <= 376, `la página se desborda: ${ancho}px`);
        assert.deepStrictEqual(p.errores, []);
      } finally { await p.cerrar(); }
    });
  }
} finally {
  if (navegador) await navegador.close().catch(() => {});
  if (srv) { try { srv.detener(); } catch { /* ya terminó */ } }
  await limpiar().catch((e) => console.error('limpieza:', e.message));
}

console.log(`\n${pasadas} OK, ${fallidas} FALLO`);
if (fallos.length) console.log(fallos.map((f) => `  - ${f}`).join('\n'));
await pool.end().catch(() => {});
process.exit(fallidas ? 1 : 0);
