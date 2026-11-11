// Número por sucursal en el panel (migración 137, fase 2): tablero, comanda
// que imprime el navegador y ticket de cliente.
//
// Decisión de Mario (11-nov-2026): «OB-152 grande, #3170 chico». En el ticket,
// OB-152 grande y el folio XAB-3170 debajo. Sin numeración, todo como siempre.
//
// El número llega en el pedido (`numero_sucursal_etiqueta`, lo pone el trigger
// en datos). El panel solo lo usa si tiene la forma «AB12-n» o «N.º n»: un
// texto raro no se pinta, y nunca se ejecuta.
//
// No necesita Postgres: servidor estático de juguete + panel real con
// Puppeteer, igual que fase-panel-escapa-cliente.
//
// Uso: node test/fase-numero-sucursal-panel.mjs [--capturas]
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PANEL_DIR = join(__dirname, '..', 'panel');
const CAPTURAS = process.argv.includes('--capturas');

const API = {
  '/api/auth/me': { rol: 'admin', negocioId: 'neg-prueba', modulos: ['pos', 'whatsapp', 'menu', 'restaurante', 'caja'], whatsappConfigurado: true },
  '/api/config/operativa': { nombre: 'Restaurante Prueba', nombre_corto: 'XABOR', direccion: 'Calle 1', ciudad: 'Matamoros', rfc: 'XAXX010101000', telefono: '8781234567', whatsapp: '8781234567' },
  '/api/pedidos-programados': [],
  '/api/admin/checklist-activacion-bot': { automaticos: {}, manuales: {}, listoParaActivar: false },
};
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url.startsWith('/api/')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(API[url] ?? {}));
  }
  const archivo = (url === '/' || url === '/app') ? join(PANEL_DIR, 'index.html') : join(PANEL_DIR, url.replace(/^\//, ''));
  if (archivo.startsWith(PANEL_DIR) && existsSync(archivo) && extname(archivo)) {
    res.writeHead(200, { 'content-type': MIME[extname(archivo)] || 'application/octet-stream' });
    return res.end(readFileSync(archivo));
  }
  res.writeHead(404); res.end('no');
});
await new Promise(r => server.listen(0, r));
const puerto = server.address().port;

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(nombre); }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

const navegador = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await navegador.newPage();
await page.setViewport({ width: 1400, height: 900 });
page.on('dialog', d => d.dismiss().catch(() => {}));
const erroresPagina = [];
page.on('pageerror', e => erroresPagina.push(e.message));

const pedido = (id, extra = {}) => ({
  id, estado: 'nuevo', canal: 'tienda_online', modalidad: 'recoger en tienda', total: 150, forma_pago: 'efectivo',
  timestamp: new Date().toISOString(), cliente: { nombre: 'Ana', telefono: '8780000000' },
  items: [{ nombre: 'Licuado', cantidad: 1, precio_unitario: 150 }], ...extra,
});
const tarjeta = (id) => page.evaluate((id) => {
  const c = document.getElementById(`comanda-${id}`);
  return c ? {
    orden: c.querySelector('.resumen-orden')?.textContent.trim() ?? null,
    folioChico: c.querySelector('.resumen-orden .resumen-folio')?.textContent.trim() ?? null,
    detalle: c.querySelector('.ticket-orden-num')?.textContent.replace(/\s+/g, ' ').trim() ?? null,
  } : null;
}, id);
// El texto de la primera etiqueta que tenga ese estilo en el HTML.
const conEstilo = (html, estilo) => {
  const i = html.indexOf(estilo);
  if (i < 0) return null;
  const desde = html.indexOf('>', i) + 1;
  return html.slice(desde, html.indexOf('<', desde)).trim();
};

try {
  await page.goto(`http://localhost:${puerto}/app#pedidos`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => typeof upsertPedidoEnTablero === 'function'
    && typeof comandaHTML === 'function' && typeof ticketHTML === 'function');
  await page.evaluate(() => { window.__xss = []; });

  // ── Tablero ────────────────────────────────────────────────────────────────
  await t('1. tablero: «OB-152» en la tarjeta y el folio chico al lado', async () => {
    await page.evaluate((p) => upsertPedidoEnTablero(p), pedido('XAB-3170', { numero_sucursal: 152, numero_sucursal_etiqueta: 'OB-152' }));
    const c = await tarjeta('XAB-3170');
    assert(c, 'no se pintó la tarjeta');
    assert(c.orden === 'OB-152 #3170', `la tarjeta dice «${c.orden}»`);
    assert(c.folioChico === '#3170', `el folio chico es «${c.folioChico}»`);
    // «chico» de verdad: a lo más 80 % del número y sin negritas fuertes (un
    // <small> sin estilo queda en ~83 % y en 800, y se confunde con el número).
    const tam = await page.evaluate(() => {
      const o = document.querySelector('#comanda-XAB-3170 .resumen-orden');
      const f = o.querySelector('.resumen-folio');
      return [parseFloat(getComputedStyle(o).fontSize), parseFloat(getComputedStyle(f).fontSize),
        Number(getComputedStyle(o).fontWeight), Number(getComputedStyle(f).fontWeight)];
    });
    assert(tam[1] <= tam[0] * 0.8, `el folio no es chico: ${tam[1]}px contra ${tam[0]}px`);
    assert(tam[3] < tam[2], `el folio pesa igual que el número: ${tam[3]} contra ${tam[2]}`);
  });

  await t('2. detalle de la tarjeta (lo que sale al imprimirla): «Orden: OB-152» y «#3170»', async () => {
    const c = await tarjeta('XAB-3170');
    assert(c.detalle === 'Orden: OB-152 #3170', `el detalle dice «${c.detalle}»`);
  });

  await t('3. sin numeración, la tarjeta sigue igual que hoy: «#3171»', async () => {
    await page.evaluate((p) => upsertPedidoEnTablero(p), pedido('XAB-3171'));
    const c = await tarjeta('XAB-3171');
    assert(c.orden === '#3171' && c.folioChico === null, `la tarjeta dice «${c.orden}»`);
    assert(c.detalle === 'Orden: 3171', `el detalle dice «${c.detalle}»`);
  });

  await t('4. una etiqueta con otra forma no se pinta ni se ejecuta', async () => {
    const raras = ['ob-1', 'OBISPADO-1', 'OB-0', '<img src=x onerror="window.__xss.push(1)">', 'OB-1<b>', 12];
    let k = 0;
    for (const raro of raras) {
      const id = `XAB-${3180 + k++}`;
      await page.evaluate((p) => upsertPedidoEnTablero(p), pedido(id, { numero_sucursal_etiqueta: raro }));
      const c = await tarjeta(id);
      assert(c.orden === `#${id.slice(4)}`, `con ${JSON.stringify(raro)} la tarjeta dice «${c.orden}»`);
    }
    await new Promise(r => setTimeout(r, 300));
    const corrido = await page.evaluate(() => window.__xss.length);
    assert(corrido === 0, 'se ejecutó código de la etiqueta');
  });

  await t('5. «N.º 152» (sucursal sin prefijo) también se pinta', async () => {
    await page.evaluate((p) => upsertPedidoEnTablero(p), pedido('XAB-3190', { numero_sucursal_etiqueta: 'N.º 152' }));
    const c = await tarjeta('XAB-3190');
    assert(c.orden === 'N.º 152 #3190', `la tarjeta dice «${c.orden}»`);
  });

  // ── Comanda del navegador (respaldo cuando no hay Edge) ───────────────────
  await t('6. comanda impresa desde el panel: OB-152 en 52px y #3170 chico debajo', async () => {
    const html = await page.evaluate((p) => comandaHTML(p), pedido('XAB-3170', { numero_sucursal_etiqueta: 'OB-152' }));
    assert(conEstilo(html, 'font-size:52px') === 'OB-152', `en grande dice «${conEstilo(html, 'font-size:52px')}»`);
    assert(conEstilo(html, 'font-size:14px;font-weight:700;') === '#3170', 'falta el folio chico');
    assert(html.indexOf('OB-152') < html.indexOf('#3170'), 'el folio va debajo');
    const sin = await page.evaluate((p) => comandaHTML(p), pedido('XAB-3171'));
    assert(conEstilo(sin, 'font-size:52px') === '3171' && !sin.includes('#3171'), 'sin numeración cambió la comanda');
  });

  // ── Ticket de cliente ──────────────────────────────────────────────────────
  await t('7. ticket de cliente: OB-152 grande y «Folio: XAB-3170» debajo', async () => {
    const html = await page.evaluate((p) => ticketHTML(p), pedido('XAB-3170', { numero_sucursal_etiqueta: 'OB-152' }));
    assert(conEstilo(html, '<div class="orden-num"') === 'OB-152', `en grande dice «${conEstilo(html, '<div class="orden-num"')}»`);
    assert(conEstilo(html, '<div class="orden-folio"') === 'Folio: XAB-3170', 'falta el folio XAB debajo');
    const sin = await page.evaluate((p) => ticketHTML(p), pedido('XAB-3171'));
    assert(conEstilo(sin, '<div class="orden-num"') === '3171' && !sin.includes('<div class="orden-folio"'),
      'sin numeración cambió el ticket');
  });

  await t('8. sin errores de JavaScript en la página', async () => {
    assert(!erroresPagina.length, erroresPagina.join(' | '));
  });

  if (CAPTURAS) {
    await page.evaluate(() => toggleComanda('XAB-3170'));
    const el = await page.$('#comanda-XAB-3170');
    await el.screenshot({ path: join(__dirname, '.preview-comanda-numero-sucursal.png') });
    const comanda = await navegador.newPage();
    await comanda.setViewport({ width: 320, height: 640 });
    await comanda.setContent(await page.evaluate((p) => comandaHTML(p), pedido('XAB-3170', { numero_sucursal_etiqueta: 'OB-152' })));
    await comanda.screenshot({ path: join(__dirname, '.preview-comanda-numero-sucursal-papel.png'), fullPage: true });
    await comanda.setContent(await page.evaluate((p) => ticketHTML(p), pedido('XAB-3170', { numero_sucursal_etiqueta: 'OB-152' })));
    await comanda.screenshot({ path: join(__dirname, '.preview-comanda-numero-sucursal-ticket.png'), fullPage: true });
    await comanda.close();
    console.log('  (capturas en test/.preview-comanda-numero-sucursal*.png)');
  }
} finally {
  await navegador.close().catch(() => {});
  server.close();
}

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallidas) { for (const f of fallos) console.log(` - ${f}`); process.exit(1); }
