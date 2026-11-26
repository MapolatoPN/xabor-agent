// Reportes › Ventas: «Lo que te diría un consejero» en el navegador (Fase 1).
// Sin Postgres: un servidor estático sirve panel/ y contesta las rutas con
// las funciones REALES del servidor (construirReporteProductos,
// consejosDeReporte, ventanaDelConsejero), así el panel y el servidor no
// pueden divergir sin que esta suite lo note. Ver fase-reportes-consejero
// (servidor, con base).
//
//   · Sin cualquiera de las dos banderas no hay recuadro ni se pide nada.
//   · Encendido: arriba de las tarjetas de Ventas, con los días que mira,
//     los consejos y la tabla del servidor; el HTML de un nombre sale como
//     texto; el periodo de arriba no lo vuelve a pedir; la sucursal sí.
//   · El aviso de pocos tickets, el error de una sucursal sin consejero,
//     el celular, la huella ?v= y cero errores de JavaScript.
//
// Los importes y nombres son inventados: el repo es público.
//
// Uso: node test/fase-reportes-consejero-panel.mjs
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import puppeteer from 'puppeteer';

const { armarReporteVentas, rangoDeReporte, fechaYHoraLocal } = await import('../src/services/reporteVentas.js');
const { construirReporteProductos } = await import('../src/services/reporteProductos.js');
const { detalleDeSucursal, sumarSucursales } = await import('../src/services/reporteVentasDetalle.js');
const { consejosDeReporte, ventanaDelConsejero } = await import('../src/services/reporteConsejero.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const PANEL_DIR = join(__dirname, '..', 'panel');
const TZ = 'America/Matamoros';
const HOY = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const V = ventanaDelConsejero(HOY);
const XSS = '<img src=x onerror="window.__xss=1">';

// ─── Datos inventados: los 120 tickets de la suite del servidor ─────────────
const PRODS = {
  chil: { id: 1, nombre: 'Chilaquiles', precio: 150, tipo: 'platillo', cat: 'DESAYUNOS', catId: 1 },
  taco: { id: 2, nombre: 'Taco de barbacoa', precio: 25, tipo: 'platillo', cat: `TACOS ${XSS}`, catId: 2 },
  cafe: { id: 3, nombre: 'Café', precio: 40, tipo: 'bebida', cat: 'BEBIDAS', catId: 3 },
  pastel: { id: 4, nombre: 'Pastel', precio: 90, tipo: 'platillo', cat: 'POSTRES', catId: 4 },
  salsa: { id: 5, nombre: 'Salsa extra', precio: 10, tipo: 'extra', cat: 'EXTRAS', catId: 5 },
};
const GRUPOS_A = [
  { n: 66, items: [['chil', 1], ['cafe', 1]] },
  { n: 20, items: [['chil', 1], ['taco', 3], ['cafe', 1]] },
  { n: 4, items: [['taco', 4]] },
  { n: 10, items: [['cafe', 1]] },
  { n: 10, items: [['chil', 2], ['pastel', 1], ['cafe', 2]] },
  { n: 10, items: [['chil', 1], ['salsa', 2]] },
];
const GRUPOS_B = [{ n: 3, items: [['chil', 1], ['taco', 2]] }];
const sumarDias = (fecha, dias) => new Date(Date.parse(`${fecha}T00:00:00Z`) + dias * 86400000).toISOString().slice(0, 10);
function sucursal(pre, grupos) {
  const filas = [], lineas = new Map();
  let i = 0;
  for (const g of grupos) {
    for (let k = 0; k < g.n; k++, i++) {
      const folio = `${pre}-${i + 1}`;
      const total = g.items.reduce((s, [p, n]) => s + PRODS[p].precio * n, 0);
      // 10:00 locales (16:00 UTC en CST) de uno de los 24 días antes de hoy.
      const creado_at = `${sumarDias(HOY, -(1 + (i % 24)))}T16:00:00.000Z`;
      const items = g.items.map(([p, n]) => ({ producto_id: PRODS[p].id, nombre: PRODS[p].nombre, cantidad: n, precio_unitario: PRODS[p].precio }));
      filas.push({ folio, estado: 'entregado', creado_at, registro: 'vigente',
        datos: { canal: 'pos', modalidad: 'recoger en tienda', forma_pago: 'efectivo', subtotal: total, total, items } });
      lineas.set(folio, items.map((x, j) => ({ ...x, tipo: PRODS[g.items[j][0]].tipo, modificadores: [] })));
    }
  }
  const catalogo = Object.values(PRODS).map((p) => ({ id: p.id, nombre: p.nombre, tipo: p.tipo, disponible: true,
    categoria_id: p.catId, categoria: p.cat, categoria_activa: true }));
  return { filas, lineas, catalogo };
}
const SUC = {
  a: { id: '11111111-1111-4111-8111-111111111111', nombre: 'Sucursal Uno', ...sucursal('CA', GRUPOS_A) },
  b: { id: '22222222-2222-4222-8222-222222222222', nombre: 'Sucursal Dos', ...sucursal('CB', GRUPOS_B) },
};

let BANDERA = false, CONSEJERO = false;
const PETICIONES = [];
const delRango = (filas, { desde, hasta }) => filas.filter((x) => { const l = fechaYHoraLocal(x.creado_at, TZ); return l && l.fecha >= desde && l.fecha <= hasta; });
const params = (query) => Object.fromEntries(new URLSearchParams(query));
const listaSucursales = () => [{ id: SUC.a.id, nombre: SUC.a.nombre, actual: true }, { id: SUC.b.id, nombre: SUC.b.nombre, actual: false }];
function elegidas(p) {
  if (!p.sucursal || p.sucursal === 'actual') return { sucs: [SUC.a], modo: 'actual' };
  if (p.sucursal === 'todas') return { sucs: [SUC.a, SUC.b], modo: 'todas' };
  const s = Object.values(SUC).find((x) => x.id === p.sucursal);
  return s ? { sucs: [s], modo: s === SUC.a ? 'actual' : 'otra' } : null;
}
function consejero(query) {
  const p = params(query);
  if (!BANDERA || !CONSEJERO) return [403, { error: 'apagado', code: 'REPORTE_APAGADO' }];
  const e = elegidas(p);
  if (!e) return [403, { error: 'No tienes acceso a esa sucursal', code: 'SUCURSAL_NO_PERMITIDA' }];
  const fuentes = e.sucs.map((s) => ({ negocio: { id: s.id, nombre: s.nombre }, tz: TZ, catalogo: s.catalogo,
    actual: { ventas: delRango(s.filas, V), lineas: s.lineas }, anterior: null }));
  return [200, { timezone: TZ, hoy: HOY, sucursal: e.modo, sucursales: listaSucursales(), elegidas: e.sucs.map((s) => s.id),
    ...consejosDeReporte(construirReporteProductos({ fuentes }), { ventana: V }) }];
}
function responder(url, query) {
  const p = params(query);
  if (url === '/api/reportes/ventas') {
    const rango = rangoDeReporte(p, HOY);
    if (rango.error) return [400, { error: rango.error }];
    return [200, armarReporteVentas({ filas: delRango(SUC.a.filas, rango), filasAnteriores: [], ...rango, tz: TZ, hoy: HOY, pagina: Number(p.pagina || 1), todas: p.todas === '1' })];
  }
  if (url === '/api/reportes/productos/estado') {
    return [200, BANDERA ? { activo: true, sucursales: listaSucursales(), consejero: CONSEJERO } : { activo: false, sucursales: [] }];
  }
  if (url === '/api/reportes/consejero') return consejero(query);
  if (url === '/api/reportes/ventas/detalle') {
    if (!BANDERA) return [403, { error: 'apagado', code: 'REPORTE_APAGADO' }];
    const rango = rangoDeReporte(p, HOY);
    if (rango.error) return [400, { error: rango.error }];
    const e = elegidas(p);
    if (!e) return [403, { error: 'No tienes acceso a esa sucursal' }];
    const detalles = e.sucs.map((s) => detalleDeSucursal({ id: s.id, nombre: s.nombre }, delRango(s.filas, rango)));
    return [200, { timezone: TZ, hoy: HOY, sucursal: e.modo, sucursales: listaSucursales(), rango, detalles,
      ...(detalles.length > 1 ? { total: sumarSucursales(detalles) } : {}) }];
  }
  const API = {
    '/api/auth/me': { rol: 'admin', negocioId: SUC.a.id, modulos: ['pos', 'caja', 'menu'], whatsappConfigurado: false },
    '/api/config/operativa': { nombre: 'Restaurante Prueba', nombre_corto: 'XABOR' },
    '/api/pedidos-programados': [],
    '/api/admin/checklist-activacion-bot': { automaticos: {}, manuales: {}, listoParaActivar: false },
  };
  return [200, API[url] ?? {}];
}
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const [url, query = ''] = req.url.split('?');
  if (url.startsWith('/api/') || url.startsWith('/pedidos/')) {
    PETICIONES.push({ url, query });
    const [status, cuerpo] = responder(url, query);
    res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(cuerpo));
    return;
  }
  const archivo = (url === '/' || url === '/app') ? join(PANEL_DIR, 'index.html') : join(PANEL_DIR, url.replace(/^\//, ''));
  if (archivo.startsWith(PANEL_DIR) && existsSync(archivo) && extname(archivo)) {
    res.writeHead(200, { 'content-type': MIME[extname(archivo)] || 'application/octet-stream' });
    return res.end(readFileSync(archivo));
  }
  res.writeHead(404); res.end('no');
});
await new Promise((r) => server.listen(0, r));
const puerto = server.address().port;

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(nombre); }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const pedidas = (ruta) => PETICIONES.filter((x) => x.url === ruta).map((x) => x.query);
const esperado = (query = '') => consejero(query)[1];

const navegador = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const erroresPagina = [];
async function abrirPanel(hash = '#reportes', ancho = 1400) {
  const page = await navegador.newPage();
  await page.setViewport({ width: ancho, height: 900 });
  page.on('pageerror', (e) => erroresPagina.push(e.message));
  page.on('dialog', (d) => d.accept().catch(() => {}));
  await page.goto(`http://localhost:${puerto}/app${hash}`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => typeof cargarVentas === 'function' && window.XaborReportes && window.XaborConsejero);
  return page;
}
// Lo que se ve del recuadro.
const recuadro = (page) => page.evaluate(() => {
  const el = document.getElementById('ventas-consejero');
  if (!el) return { existe: false, cuantos: 0 };
  return {
    existe: true, cuantos: document.querySelectorAll('#ventas-consejero').length,
    visible: !el.hidden && el.getBoundingClientRect().height > 0,
    padre: el.parentElement?.id,
    ventana: el.querySelector('[data-ventana]')?.innerText.trim() || '',
    sucursales: el.querySelector('.rp-caja > .rp-sub')?.innerText.trim() || '',
    aviso: el.querySelector('[data-aviso]') ? [el.querySelector('[data-aviso]').dataset.aviso, el.querySelector('[data-aviso]').innerText.trim()] : null,
    error: el.querySelector('.rc-error')?.innerText.trim() || '',
    consejos: [...el.querySelectorAll('[data-consejo]')].map((x) => ({ tipo: x.dataset.consejo, titulo: x.querySelector('.rc-tit').innerText.trim(), texto: x.querySelector('p').innerText.trim() })),
    tablaAbierta: el.querySelector('details[data-tabla-arrastre]')?.open ?? null,
    // textContent: con la tabla cerrada, innerText sale vacío.
    filas: [...el.querySelectorAll('tr[data-arrastre]')].map((tr) => [...tr.children].map((td) => td.textContent.replace(/\s+/g, ' ').trim())),
  };
});
const comoPantalla = (cs) => cs.map(({ tipo, titulo, texto }) => ({ tipo, titulo, texto }));
// CAPTURA=<carpeta> guarda cómo se ve el recuadro (para revisarlo a ojo).
async function capturar(page, nombre) {
  if (!process.env.CAPTURA) return;
  const el = await page.$('#ventas-consejero');
  if (el) await el.screenshot({ path: join(process.env.CAPTURA, nombre) });
}
const esperarConsejos = (page) => page.waitForFunction(() => document.querySelector('#ventas-consejero [data-consejo]'), { timeout: 5000 });

try {
  await t('C1. sin la bandera de Productos: ni recuadro ni petición', async () => {
    BANDERA = false; CONSEJERO = true;
    PETICIONES.length = 0;
    const page = await abrirPanel('#reportes');
    await esperar(700);
    const r = await recuadro(page);
    assert(!r.existe || !r.visible, `se ve el recuadro: ${JSON.stringify(r)}`);
    assert(!pedidas('/api/reportes/consejero').length, 'pidió el consejero sin la bandera de Productos');
    await page.close();
  });

  await t('C2. con Productos pero sin la del consejero: ni recuadro ni petición, y Ventas sigue con su detalle', async () => {
    BANDERA = true; CONSEJERO = false;
    PETICIONES.length = 0;
    const page = await abrirPanel('#reportes');
    await page.waitForFunction(() => /Formas de pago/.test(document.getElementById('ventas-detalle')?.innerText || ''), { timeout: 5000 });
    await esperar(400);
    const r = await recuadro(page);
    assert(!r.existe || !r.visible, `se ve el recuadro: ${JSON.stringify(r)}`);
    assert(!pedidas('/api/reportes/consejero').length, 'pidió el consejero sin su bandera');
    await page.close();
  });

  BANDERA = true; CONSEJERO = true;
  PETICIONES.length = 0;
  const page = await abrirPanel('#reportes');
  await esperarConsejos(page);

  await t('C3. encendido: arriba de las tarjetas de Ventas, con los días que mira', async () => {
    const r = await recuadro(page);
    assert(r.visible && r.cuantos === 1 && r.padre === 'vista-ventas', JSON.stringify(r));
    assert(r.ventana === `Últimos 28 días: ${V.etiqueta}`, `etiqueta: «${r.ventana}»`);
    const pos = await page.evaluate(() => {
      const caja = document.getElementById('ventas-consejero');
      const tarjeta = document.getElementById('pos-total-val').closest('.pos-card');
      return { antes: !!(caja.compareDocumentPosition(tarjeta) & Node.DOCUMENT_POSITION_FOLLOWING), arriba: caja.getBoundingClientRect().bottom <= tarjeta.getBoundingClientRect().top + 1 };
    });
    assert(pos.antes && pos.arriba, `no está arriba de las tarjetas: ${JSON.stringify(pos)}`);
    assert(pedidas('/api/reportes/consejero').length === 1 && pedidas('/api/reportes/consejero')[0] === 'sucursal=actual', JSON.stringify(pedidas('/api/reportes/consejero')));
  });

  await t('C4. los consejos y la tabla son los del servidor; el HTML de un nombre sale como texto', async () => {
    const r = await recuadro(page);
    const s = esperado('sucursal=actual');
    assert(s.estado === 'ok' && s.consejos.length === 3, `el servidor no dio 3 consejos: ${JSON.stringify(s.consejos.map((c) => c.tipo))}`);
    assert(JSON.stringify(r.consejos) === JSON.stringify(comoPantalla(s.consejos)), `pantalla ${JSON.stringify(r.consejos)} ≠ servidor ${JSON.stringify(comoPantalla(s.consejos))}`);
    assert(r.consejos[1].titulo === `Pesa más de lo que parece: TACOS ${XSS}`, `el nombre con HTML: «${r.consejos[1].titulo}»`);
    assert(!r.aviso && !r.error, JSON.stringify(r));
    assert(r.tablaAbierta === false, 'la tabla debe empezar cerrada');
    assert(r.filas.length === s.tabla.length && r.filas.map((f) => f[0]).join('|') === s.tabla.map((f) => f.nombre).join('|'), JSON.stringify(r.filas.map((f) => f[0])));
    const tac = r.filas.find((f) => f[0].startsWith('TACOS'));
    assert(JSON.stringify(tac.slice(1)) === JSON.stringify(['7.6 %', '24 · 20 %', '$5,700 · 22.8 %', '4 · 16.7 %', '$238', '$201', 'BEBIDAS, DESAYUNOS']), `TACOS: ${JSON.stringify(tac)}`);
    const xss = await page.evaluate(() => window.__xss === 1 || !!document.querySelector('#ventas-consejero img'));
    assert(!xss, 'se ejecutó o se insertó el HTML de un nombre');
    await capturar(page, 'consejero-escritorio.png');
  });

  await t('C5. cambiar el periodo de arriba no lo vuelve a pedir (mira siempre los últimos 28 días)', async () => {
    const antes = pedidas('/api/reportes/consejero').length;
    const ventasAntes = pedidas('/api/reportes/ventas').length;
    await page.evaluate(() => setPeriodo('mes'));
    await esperar(600);
    assert(pedidas('/api/reportes/ventas').length > ventasAntes, 'Ventas no se recargó: la prueba no prueba nada');
    assert(pedidas('/api/reportes/consejero').length === antes, `lo pidió otra vez: ${JSON.stringify(pedidas('/api/reportes/consejero'))}`);
    const r = await recuadro(page);
    assert(r.visible && r.cuantos === 1 && r.consejos.length === 3 && r.ventana === `Últimos 28 días: ${V.etiqueta}`, JSON.stringify(r));
  });

  await t('C6. la sucursal sí: «Todas» lo pide de nuevo, dice cuáles junta y la tabla abierta sigue abierta', async () => {
    await page.click('#ventas-consejero details[data-tabla-arrastre] summary');
    await page.waitForFunction(() => /Formas de pago/.test(document.getElementById('ventas-detalle').innerText));
    await page.select('#ventas-detalle [data-sucursal-ventas]', 'todas');
    await page.waitForFunction(() => /Sucursal Dos/.test(document.getElementById('ventas-consejero').innerText), { timeout: 5000 });
    assert(pedidas('/api/reportes/consejero').at(-1) === 'sucursal=todas', `última: ${pedidas('/api/reportes/consejero').at(-1)}`);
    const r = await recuadro(page);
    const s = esperado('sucursal=todas');
    assert(r.sucursales === 'Sucursal Uno + Sucursal Dos', `sucursales: «${r.sucursales}»`);
    assert(JSON.stringify(r.consejos) === JSON.stringify(comoPantalla(s.consejos)), `pantalla ${JSON.stringify(r.consejos)} ≠ servidor`);
    assert(r.tablaAbierta === true, 'la tabla se cerró al volver a pintar');
    assert(r.filas.find((f) => f[0].startsWith('TACOS'))[2].startsWith('27 '), `TACOS con las dos: ${JSON.stringify(r.filas)}`);
  });

  await t('C7. una sucursal con pocos tickets: lo dice, sin consejos, y la tabla sigue', async () => {
    await page.select('#ventas-detalle [data-sucursal-ventas]', SUC.b.id);
    await page.waitForFunction(() => document.querySelector('#ventas-consejero [data-aviso]'), { timeout: 5000 });
    const r = await recuadro(page);
    assert(JSON.stringify(r.aviso) === JSON.stringify(['pocos_tickets', 'Con 3 tickets en estos días todavía no hay suficiente para aconsejarte: hacen falta al menos 100.']), JSON.stringify(r.aviso));
    assert(!r.consejos.length && r.filas.length >= 1 && r.sucursales === 'Sucursal Dos', JSON.stringify(r));
  });

  await t('C8. una sucursal sin el consejero: lo explica en vez de quedarse en blanco', async () => {
    await page.evaluate(() => window.XaborConsejero.cargar({ activo: true, sucursal: '99999999-9999-4999-8999-999999999999' }));
    await page.waitForFunction(() => document.querySelector('#ventas-consejero .rc-error'), { timeout: 5000 });
    const r = await recuadro(page);
    assert(r.error === 'El consejero no está encendido en esa sucursal.' && !r.consejos.length, JSON.stringify(r));
    await page.select('#ventas-detalle [data-sucursal-ventas]', 'actual');
    await esperarConsejos(page);
    assert((await recuadro(page)).consejos.length === 3, 'no volvió a la sucursal propia');
  });

  await t('C9. ir a Productos y volver no lo duplica ni lo pide otra vez', async () => {
    const antes = pedidas('/api/reportes/consejero').length;
    await page.click('#pest-productos');
    await esperar(400);
    const fuera = await recuadro(page);
    assert(fuera.existe && !fuera.visible, 'se ve fuera de Ventas');
    await page.click('#pest-ventas');
    await esperar(600);
    const r = await recuadro(page);
    assert(r.visible && r.cuantos === 1 && r.consejos.length === 3, JSON.stringify(r));
    assert(pedidas('/api/reportes/consejero').length === antes, 'lo pidió otra vez');
  });
  await page.close();

  await t('C10. en el celular no desborda la página, ni con la tabla abierta', async () => {
    const cel = await abrirPanel('#reportes', 375);
    await esperarConsejos(cel);
    await cel.click('#ventas-consejero details[data-tabla-arrastre] summary');
    await esperar(150);
    const m = await cel.evaluate(() => {
      const caja = document.getElementById('ventas-consejero');
      return {
        pagina: document.documentElement.scrollWidth, vista: window.innerWidth,
        caja: Math.round(caja.getBoundingClientRect().right),
        consejos: [...caja.querySelectorAll('[data-consejo]')].filter((x) => x.scrollWidth > x.clientWidth + 1).length,
      };
    });
    assert(m.pagina <= m.vista && m.caja <= m.vista && !m.consejos, `desborda: ${JSON.stringify(m)}`);
    await capturar(cel, 'consejero-celular.png');
    await cel.close();
  });

  await t('C11. la huella ?v= de index.html es la de cada archivo (la caché no sirve uno viejo)', async () => {
    const html = readFileSync(join(PANEL_DIR, 'index.html'), 'utf8');
    for (const archivo of ['reportes-productos.js', 'reportes-consejero.js']) {
      const h = createHash('sha256').update(readFileSync(join(PANEL_DIR, archivo))).digest('hex').slice(0, 8);
      assert(html.includes(`<script src="/${archivo}?v=${h}"></script>`), `index.html no trae ${archivo}?v=${h}`);
    }
    assert(html.indexOf('/reportes-productos.js?v=') < html.indexOf('/reportes-consejero.js?v='), 'el orden de los scripts cambió');
  });

  await t('C12. sin errores de JavaScript en toda la corrida', async () => {
    assert(!erroresPagina.length, erroresPagina.join(' | '));
  });
} finally {
  await navegador.close().catch(() => {});
  server.close();
}

console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallidas) { console.log('Fallos:\n  · ' + fallos.join('\n  · ')); process.exit(1); }
process.exit(0);
