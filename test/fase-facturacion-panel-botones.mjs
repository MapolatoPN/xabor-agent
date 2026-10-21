// Panel real (Puppeteer) con servidor de juguete: los cambios del 21-oct que
// Mario autorizó en panel/index.html.
//   A. «🧾 Factura» en el menú de la comanda: liga y QR para el mostrador,
//      para admin Y caja; el admin además puede capturar datos y facturar.
//   B. El modal «Generar factura» ya no ofrece regímenes fuera del catálogo.
//   C. «Cancelar CFDI» en el centro de Facturación (admin): motivo del SAT,
//      sustitución para 01/04 y estado de la cancelación en la fila.
//   D. Los scripts nuevos se cargan con la huella de su contenido (?v=).
// Sin Postgres ni Facturapi: el servidor de juguete contesta /api/* con JSON.
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import puppeteer from 'puppeteer';
import { generarMatrizQr } from '../src/services/autofacturaQr.js';
import { REGIMENES_SAT } from '../src/services/catalogosSat.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PANEL_DIR = join(__dirname, '..', 'panel');
const CAPTURAS = process.argv.includes('--capturas') ? (process.env.PROGRAMADOS_QA_DIR || __dirname) : null;
let pasadas = 0, fallidas = 0;
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; }
}
const assert = (c, m) => { if (!c) throw new Error(m); };

// ═══ Servidor de juguete ═══
const URL_LIGA = 'https://xabor.test/f/abcdefghijklmnopqrstuvwx';
const est = { rol: 'staff', modulos: ['pos', 'facturacion'], llamadas: [], autofactura: 'ok', cancelaciones: [], cancelarResp: { estado: 'en_proceso', cancellation_status: 'pending' } };
const RECIBOS = [{ folio: 'XAB-0901', estado: 'facturado', total: 245, factura_id: 'inv_901', uuid: 'AAAAAAAA-BBBB-CCCC-DDDD-000000000901', created_at: '2026-10-20T15:00:00Z', cliente: 'Cliente Fiscal', cliente_rfc: 'CFI010101AA1' }];
const servidor = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  let cuerpo = ''; req.on('data', (c) => { cuerpo += c; });
  req.on('end', () => {
    const json = (status, d) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(d)); };
    if (url.startsWith('/api/') || url.startsWith('/pedidos')) est.llamadas.push({ metodo: req.method, url, cuerpo });
    if (url === '/api/auth/me') return json(200, { rol: est.rol, negocioId: 'neg-prueba', modulos: est.modulos, whatsappConfigurado: true });
    if (url === '/api/config/operativa') return json(200, { nombre: 'Restaurante Prueba', nombre_corto: 'XABOR', whatsapp: '8781234567' });
    if (url === '/api/pedidos-programados') return json(200, []);
    const af = url.match(/^\/api\/facturacion\/pedidos\/([^/]+)\/autofactura$/);
    if (af && req.method === 'POST') {
      if (est.autofactura === 'no_pagado') return json(409, { error: 'La venta no está pagada.', codigo: 'PEDIDO_NO_PAGADO' });
      return json(200, { ok: true, autofactura: { estado: 'vigente', folio: decodeURIComponent(af[1]), total: 245, url: URL_LIGA, expiresAt: '2026-11-20T06:00:00Z', qr: generarMatrizQr(URL_LIGA) } });
    }
    if (url === '/api/admin/facturacion/recibos') return json(200, { recibos: RECIBOS, paginacion: { total: RECIBOS.length } });
    if (url === '/api/admin/facturacion/servicios') return json(200, { servicios: [], paginacion: { total: 0 } });
    if (url === '/api/admin/facturacion/cancelaciones') return json(200, { ok: true, cancelaciones: est.cancelaciones });
    const cc = url.match(/^\/api\/admin\/facturacion\/facturas\/([^/]+)\/cancelar$/);
    if (cc && req.method === 'POST') {
      const c = { factura_id: decodeURIComponent(cc[1]), ...est.cancelarResp };
      est.cancelaciones = [c];
      return json(200, { ok: true, cancelacion: c });
    }
    if (url.startsWith('/api/')) return json(200, {});
    const archivo = (url === '/' || url === '/app') ? join(PANEL_DIR, 'index.html') : join(PANEL_DIR, url.replace(/^\//, ''));
    if (archivo.startsWith(PANEL_DIR) && existsSync(archivo) && extname(archivo)) {
      res.writeHead(200, { 'content-type': { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' }[extname(archivo)] || 'application/octet-stream' });
      return res.end(readFileSync(archivo));
    }
    res.writeHead(404); res.end('no');
  });
});
await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
const ORIGEN = `http://localhost:${servidor.address().port}`;

const PEDIDO = (id, extra = {}) => ({ id, estado: 'listo', canal: 'pos', modalidad: 'recoger en tienda', total: 245, forma_pago: 'efectivo',
  timestamp: new Date().toISOString(), cliente: { nombre: 'Cliente Mostrador', telefono: '8781112233' },
  items: [{ nombre: 'Combito', cantidad: 1, precio_unitario: 245 }], ...extra });

const navegador = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
async function abrirPanel(rol, modulos = ['pos', 'facturacion']) {
  Object.assign(est, { rol, modulos, autofactura: 'ok' });
  const ctx = await navegador.createBrowserContext();
  await ctx.overridePermissions(ORIGEN, ['clipboard-read', 'clipboard-write']);
  const page = await ctx.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on('dialog', (d) => d.dismiss());
  await page.goto(`${ORIGEN}/app#pedidos`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => typeof renderComanda === 'function' && typeof XaborFacturaMostrador === 'object' && typeof XaborCancelacionCfdi === 'object');
  return { page, ctx };
}
const ponerPedido = (page, p) => page.evaluate((x) => upsertPedidoEnTablero(x), p);
const textoMenu = (page, id) => page.$eval(`#menu-${id}`, (m) => m.innerText);

try {
  await t('D. index.html carga facturaMostrador.js y cancelacionCfdi.js con la huella de su contenido', () => {
    const html = readFileSync(join(PANEL_DIR, 'index.html'), 'utf8');
    for (const f of ['facturaMostrador.js', 'cancelacionCfdi.js']) {
      const v = createHash('sha256').update(readFileSync(join(PANEL_DIR, f), 'utf8')).digest('hex').slice(0, 8);
      assert(html.includes(`/${f}?v=${v}`), `${f} sin ?v=${v}`);
    }
  });

  // ── A. Caja ───────────────────────────────────────────────────────────────
  {
    const { page, ctx } = await abrirPanel('staff');
    await ponerPedido(page, PEDIDO('XAB-0901'));
    await ponerPedido(page, PEDIDO('XAB-0902', { canal: 'presencial', forma_pago: 'por_cobrar', estado: 'nuevo' }));
    await t('A1. la caja ve «🧾 Factura» en el menú de una venta; no en una por cobrar', async () => {
      assert((await textoMenu(page, 'XAB-0901')).includes('🧾 Factura'), 'sin botón en la venta');
      assert(!(await textoMenu(page, 'XAB-0902')).includes('🧾 Factura'), 'botón en una venta por cobrar');
    });
    await t('A2. abre la ventana con el QR, la liga, WhatsApp al cliente y sin «facturar» para la caja', async () => {
      await page.evaluate(() => abrirFacturaMostrador('XAB-0901'));
      await page.waitForSelector('.factura-mostrador [data-fm-qr] svg');
      const v = await page.evaluate(() => {
        const c = document.querySelector('.factura-mostrador');
        return { url: c.querySelector('[data-fm-url]').value, wa: c.querySelector('[data-fm-wa]').href,
          facturar: !!c.querySelector('[data-fm-facturar]'), ancho: c.querySelector('[data-fm-qr] svg').getBoundingClientRect().width };
      });
      assert(v.url === URL_LIGA, v.url);
      assert(v.wa.startsWith('https://wa.me/528781112233?text=') && decodeURIComponent(v.wa).includes(URL_LIGA), v.wa);
      assert(!v.facturar, 'la caja no debe ver «Capturar datos y facturar»');
      assert(v.ancho > 120, `QR de ${v.ancho}px`);
      const post = est.llamadas.find((l) => l.metodo === 'POST' && l.url === '/api/facturacion/pedidos/XAB-0901/autofactura');
      assert(post, 'no pidió la liga a la ruta de la caja');
    });
    if (CAPTURAS) await page.screenshot({ path: join(CAPTURAS, 'factura-mostrador.png') });
    await t('A3. «Copiar liga» copia y lo avisa; si el portapapeles se niega, copia a la antigua', async () => {
      await page.evaluate(() => {
        window.__copiado = null;
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (x) => { window.__copiado = x; } } });
      });
      await page.click('.factura-mostrador [data-fm-copiar]');
      await page.waitForFunction(() => document.querySelector('.factura-mostrador [data-fm-aviso]').textContent === 'Liga copiada.', { timeout: 5000 });
      assert(await page.evaluate(() => window.__copiado) === URL_LIGA, 'copió otra cosa');
      await page.evaluate(() => {
        window.__antigua = 0;
        document.querySelector('.factura-mostrador [data-fm-aviso]').textContent = '';
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new DOMException('Document is not focused.', 'NotAllowedError'); } } });
        document.execCommand = (c) => { if (c === 'copy') window.__antigua++; return c === 'copy'; };
      });
      await page.click('.factura-mostrador [data-fm-copiar]');
      await page.waitForFunction(() => document.querySelector('.factura-mostrador [data-fm-aviso]').textContent === 'Liga copiada.', { timeout: 5000 });
      assert(await page.evaluate(() => window.__antigua) === 1, 'no intentó execCommand');
    });
    await t('A4. la venta sin pagar muestra un mensaje claro, sin liga', async () => {
      est.autofactura = 'no_pagado';
      await page.evaluate(() => abrirFacturaMostrador('XAB-0901'));
      await page.waitForFunction(() => /aún no está pagada/.test(document.querySelector('.factura-mostrador [data-fm-cuerpo]')?.textContent || ''));
      assert(await page.$('.factura-mostrador [data-fm-url]') === null, 'mostró una liga');
      await page.click('.factura-mostrador [data-fm-cerrar]');
      assert(await page.$('.factura-mostrador') === null, 'no se cerró');
    });
    await ctx.close();
  }
  {
    const { page, ctx } = await abrirPanel('staff', ['pos']);
    await ponerPedido(page, PEDIDO('XAB-0903'));
    await t('A5. sin el módulo de facturación no aparece el botón', async () => {
      assert(!(await textoMenu(page, 'XAB-0903')).includes('🧾 Factura'));
    });
    await ctx.close();
  }

  // ── A6, B y C. Admin ──────────────────────────────────────────────────────
  {
    const { page, ctx } = await abrirPanel('admin');
    await ponerPedido(page, PEDIDO('XAB-0904'));
    await t('A6. el admin puede pasar de la ventana a «Generar factura» con el folio puesto', async () => {
      await page.evaluate(() => abrirFacturaMostrador('XAB-0904'));
      await page.waitForSelector('.factura-mostrador [data-fm-facturar]');
      await page.click('.factura-mostrador [data-fm-facturar]');
      const v = await page.evaluate(() => ({ visible: getComputedStyle(document.getElementById('modal-factura-overlay')).display, folio: document.getElementById('factura-folio').value, abierta: !!document.querySelector('.factura-mostrador') }));
      assert(v.visible === 'flex' && v.folio === 'XAB-0904' && !v.abierta, JSON.stringify(v));
      await page.evaluate(() => cerrarModalFactura());
    });
    await t('B. el modal «Generar factura» solo ofrece regímenes del catálogo del SAT (sin 609, 628, 629, 630)', async () => {
      const opciones = await page.$$eval('#factura-regimen option', (os) => os.map((o) => o.value).filter(Boolean));
      const catalogo = new Set(REGIMENES_SAT.map((r) => r.clave));
      const fuera = opciones.filter((o) => !catalogo.has(o));
      assert(!fuera.length, `fuera del catálogo: ${fuera.join(', ')}`);
      assert(opciones.length >= 15, `muy pocas opciones: ${opciones.length}`);
    });
    await t('C1. el centro de Facturación ofrece «Cancelar CFDI» en una venta timbrada', async () => {
      await page.evaluate(() => mostrarTab('facturacion'));
      await page.waitForFunction(() => document.querySelector('#facturacion-recibos-lista table'));
      const acciones = await page.$eval('#facturacion-recibos-lista .facturacion-menu', (m) => m.textContent);
      assert(acciones.includes('Cancelar CFDI'), acciones);
    });
    await t('C2. el motivo 01 exige el CFDI que la sustituye; con él, manda motivo y sustitución', async () => {
      await page.evaluate(() => { document.querySelector('#facturacion-recibos-lista details').open = true; });
      await page.evaluate(() => [...document.querySelectorAll('#facturacion-recibos-lista .facturacion-menu button')].find((b) => b.textContent.includes('Cancelar CFDI')).click());
      await page.waitForSelector('.cancelar-cfdi [data-cc-motivo]');
      await page.select('.cancelar-cfdi [data-cc-motivo]', '01');
      assert(await page.$eval('.cancelar-cfdi [data-cc-bloque-sust]', (e) => getComputedStyle(e).display !== 'none'), 'no pidió la sustitución');
      await page.click('.cancelar-cfdi [data-cc-enviar]');
      assert((await page.$eval('.cancelar-cfdi [data-cc-aviso]', (e) => e.textContent)).includes('sustituye'), 'envió sin sustitución');
      assert(!est.llamadas.some((l) => l.url.endsWith('/cancelar')), 'llamó al servidor sin sustitución');
      if (CAPTURAS) await page.screenshot({ path: join(CAPTURAS, 'cancelar-cfdi.png') });
      await page.type('.cancelar-cfdi [data-cc-sust]', 'AAAAAAAA-BBBB-CCCC-DDDD-000000000999');
      await page.click('.cancelar-cfdi [data-cc-enviar]');
      await page.waitForFunction(() => /Cancelación solicitada/.test(document.querySelector('.cancelar-cfdi [data-cc-aviso]').textContent));
      const post = est.llamadas.find((l) => l.url === '/api/admin/facturacion/facturas/inv_901/cancelar');
      assert(post && JSON.parse(post.cuerpo).motivo === '01' && JSON.parse(post.cuerpo).sustitucion === 'AAAAAAAA-BBBB-CCCC-DDDD-000000000999', JSON.stringify(post));
    });
    await t('C3. la fila muestra «Cancelación en proceso» y ofrece actualizarla', async () => {
      await page.click('.cancelar-cfdi [data-cc-cerrar]');
      await page.waitForFunction(() => /Cancelación en proceso/.test(document.querySelector('#facturacion-recibos-lista')?.innerText || ''));
      const acciones = await page.$eval('#facturacion-recibos-lista .facturacion-menu', (m) => m.textContent);
      assert(acciones.includes('Actualizar cancelación') && !acciones.includes('Cancelar CFDI'), acciones);
    });
    await t('C4. ya cancelada: etiqueta «Cancelada» y sin botón de cancelar', async () => {
      est.cancelaciones = [{ factura_id: 'inv_901', estado: 'cancelada' }];
      await page.evaluate(() => cargarCentroFacturacion());
      await page.waitForFunction(() => /Cancelada/.test(document.querySelector('#facturacion-recibos-lista')?.innerText || ''));
      const menu = await page.$('#facturacion-recibos-lista .facturacion-menu');
      const acciones = menu ? await page.evaluate((m) => m.textContent, menu) : '';
      assert(!acciones.includes('Cancelar CFDI'), acciones);
    });
    await ctx.close();
  }
} finally {
  await navegador.close();
  servidor.closeAllConnections?.();
  await new Promise((r) => servidor.close(() => r()));
}
console.log(`\nPASADAS: ${pasadas}   FALLOS: ${fallidas}`);
process.exit(fallidas ? 1 : 0);
