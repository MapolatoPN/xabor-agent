// Reportes → Ventas en el navegador: la tarjeta, el desglose, la tabla y el
// CSV muestran la MISMA cuenta, y el panel pide días del negocio (no
// instantes de su reloj). Sin Postgres: un servidor estático sirve panel/ y
// contesta /api/reportes/ventas con lo que arma construirReporteVentas (la
// función real del servidor), así el panel y el servidor no pueden divergir
// sin que esta suite lo note. Ver también fase-reportes-ventas (servidor).
//
// Uso: node test/fase-reportes-ventas-panel.mjs
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const { construirReporteVentas } = await import('../src/services/reporteVentas.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const PANEL_DIR = join(__dirname, '..', 'panel');
const PUERTO = Number(process.env.TEST_PORT_REPVENTAS_PANEL || 0);

const fila = (folio, estado, datos, creado_at) => ({ folio, estado, datos, creado_at });
// Octubre, en pequeño: Rappi sin forma de pago, mostrador, tienda con envío,
// mesa con descuento y propina, un cancelado y un por cobrar.
const OCTUBRE = construirReporteVentas([
  fila('XAB-1371', 'entregado', { canal: 'rappi', pago: 'rappi_pay', subtotal: 136, descuento: 11.9, total: 136, modalidad: 'entrega a domicilio',
    cliente: { nombre: 'Cliente Rappi' }, items: [{ nombre: 'Chilaquiles', cantidad: 1, precio_unitario: 136 }] }, '2026-10-07T05:30:00.000Z'),
  fila('XAB-1372', 'entregado', { canal: 'pos', subtotal: 120.1, total: 120.1, forma_pago: 'efectivo', modalidad: 'recoger en tienda',
    cliente: { nombre: 'Rosa' }, items: [{ nombre: 'Licuado', cantidad: 2, precio_unitario: 60.05 }] }, '2026-10-07T17:10:00.000Z'),
  fila('XAB-1373', 'entregado', { canal: 'tienda_online', subtotal: 300, costo_envio: 50, descuento: 30, total: 320, forma_pago: 'enlace_pago',
    pago_confirmado: true, modalidad: 'entrega a domicilio', cliente: { nombre: 'Tere', telefono: '8781112233' }, items: [{ nombre: 'Pozole', cantidad: 1, precio_unitario: 300 }] }, '2026-10-07T17:20:00.000Z'),
  fila('RM-AB120001-0', 'entregado', { canal: 'restaurante_mesa', modalidad: 'mesa', subtotal: 500, descuento: 50.2, total: 449.8, propinas: 45,
    forma_pago: 'terminal', cliente: { nombre: 'Mesa 4' }, items: [{ nombre: 'Comida corrida', cantidad: 4, precio_unitario: 125 }] }, '2026-10-07T17:30:00.000Z'),
  fila('XAB-1375', 'cancelado', { canal: 'pos', subtotal: 200, total: 200, forma_pago: 'efectivo', items: [] }, '2026-10-07T17:40:00.000Z'),
  fila('XAB-1376', 'entregado', { canal: 'presencial', subtotal: 150, total: 150, forma_pago: 'por_cobrar', pago_confirmado: false, items: [] }, '2026-10-07T17:50:00.000Z'),
]);
const respuesta = (base, extra) => ({ ...JSON.parse(JSON.stringify(base)), ...extra });
const HOY = construirReporteVentas([
  fila('XAB-2001', 'entregado', { canal: 'pos', subtotal: 99, total: 99, forma_pago: 'efectivo', modalidad: 'recoger en tienda', items: [] }, new Date().toISOString()),
]);

const PETICIONES = [];
let zonaRespuesta = 'America/Matamoros';
let retrasoHoyMs = 0;
function reporte(query) {
  const p = new URLSearchParams(query);
  if (p.get('desde') === '2026-13-01') return [400, { error: 'Fechas inválidas: usa AAAA-MM-DD' }];
  if (p.get('periodo') === 'hoy') return [200, respuesta(HOY, { timezone: 'America/Matamoros', rango: { desde: '2026-11-11', hasta: '2026-11-11' } })];
  return [200, respuesta(OCTUBRE, { timezone: zonaRespuesta, rango: { desde: '2026-10-01', hasta: '2026-10-31' } })];
}
const API = {
  '/api/auth/me': { rol: 'admin', negocioId: 'neg-prueba', modulos: ['pos', 'caja', 'menu'], whatsappConfigurado: false },
  '/api/config/operativa': { nombre: 'Restaurante Prueba', nombre_corto: 'XABOR' },
  '/api/pedidos-programados': [],
  '/api/admin/checklist-activacion-bot': { automaticos: {}, manuales: {}, listoParaActivar: false },
};
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const [url, query = ''] = req.url.split('?');
  if (url.startsWith('/api/') || url.startsWith('/pedidos/')) {
    PETICIONES.push({ url, query });
    const [status, cuerpo] = url === '/api/reportes/ventas' ? reporte(query) : [200, API[url] ?? {}];
    const retraso = url === '/api/reportes/ventas' && /periodo=hoy/.test(query) ? retrasoHoyMs : 0;
    setTimeout(() => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(cuerpo)); }, retraso);
    return;
  }
  const archivo = (url === '/' || url === '/app') ? join(PANEL_DIR, 'index.html') : join(PANEL_DIR, url.replace(/^\//, ''));
  if (archivo.startsWith(PANEL_DIR) && existsSync(archivo) && extname(archivo)) {
    res.writeHead(200, { 'content-type': MIME[extname(archivo)] || 'application/octet-stream' });
    return res.end(readFileSync(archivo));
  }
  res.writeHead(404); res.end('no');
});
await new Promise(r => server.listen(PUERTO, r));
const puerto = server.address().port;

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(nombre); }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const esperar = (ms) => new Promise(r => setTimeout(r, ms));
const centavos = (texto) => Math.round(Number(String(texto).replace(/[^0-9.\-]/g, '')) * 100);
const consultas = () => PETICIONES.filter(p => p.url === '/api/reportes/ventas').map(p => p.query);

const navegador = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await navegador.newPage();
await page.setViewport({ width: 1400, height: 900 });
// El navegador de la prueba vive en Tokio: si el panel cortara días o
// pintara horas con SU reloj, se notaría.
await page.emulateTimezone('Asia/Tokyo');
page.on('dialog', d => d.accept().catch(() => {}));

const leer = () => page.evaluate(() => ({
  total: document.getElementById('pos-total-val').textContent,
  pedidos: document.getElementById('pos-pedidos').textContent,
  filas: [...document.querySelectorAll('#ventas-body tr')].map(tr => [...tr.children].map(td => td.innerText.trim())),
  desglose: [...document.querySelectorAll('#ventas-desglose .vd-linea')].map(l => [...l.children].map(s => s.textContent.trim())),
  titulo: document.querySelector('#ventas-desglose .vd-titulo')?.textContent.replace(/\s+/g, ' ').trim() || '',
  notas: document.querySelector('#ventas-desglose .vd-notas')?.innerText || '',
}));
async function cargarOctubre() {
  await page.evaluate(() => { document.getElementById('fecha-desde').value = '2026-10-01'; document.getElementById('fecha-hasta').value = '2026-10-31'; setPeriodoCustom(); });
  await page.waitForFunction(() => document.querySelectorAll('#ventas-body tr').length === 4);
}

try {
  await page.goto(`http://localhost:${puerto}/app#ventas`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => typeof cargarVentas === 'function');
  await page.evaluate(() => mostrarTab('ventas'));
  await page.waitForFunction(() => document.querySelectorAll('#ventas-body tr').length >= 1 && !/Cargando/.test(document.getElementById('ventas-body').innerText));

  await t('P1. abrir Ventas pide «hoy» al servidor; los botones mandan periodo; el rango manda días', async () => {
    assert(consultas().includes('periodo=hoy'), `consultas: ${consultas()}`);
    await page.evaluate(() => setPeriodo('mes'));
    await esperar(150);
    assert(consultas().includes('periodo=mes'), `consultas: ${consultas()}`);
    await page.evaluate(() => setPeriodo('semana'));
    await esperar(150);
    assert(consultas().includes('periodo=semana'), `consultas: ${consultas()}`);
    await cargarOctubre();
    assert(consultas().includes('desde=2026-10-01&hasta=2026-10-31'), `el rango no salió como días: ${consultas()}`);
    assert(!consultas().some(q => /T\d\d:|Z/.test(q)), `se mandó un instante del navegador: ${consultas()}`);
  });

  await t('P2. tarjeta = Σ columna Total = venta neta del desglose; en la tabla solo hay ventas', async () => {
    const v = await leer();
    const suma = v.filas.reduce((s, f) => s + centavos(f[6]), 0);
    assert(centavos(v.total) === suma, `tarjeta ${v.total} ≠ Σ tabla ${suma / 100}`);
    assert(centavos(v.total) === Math.round(OCTUBRE.resumen.total_ventas * 100), `tarjeta ${v.total}`);
    const neta = v.desglose.find(l => /Venta neta/.test(l[0]));
    assert(neta && centavos(neta[1]) === suma, `venta neta ${neta}`);
    assert(v.pedidos === '4', `pedidos: ${v.pedidos}`);
    assert(!v.filas.some(f => /#1375|#1376/.test(f.join(' '))), 'se coló un cancelado o un por cobrar');
    assert(v.filas.some(f => /rappi/i.test(f[4])), 'Rappi no dice su forma de pago');
  });

  await t('P3. el desglose trae bruta, descuentos, envíos, neta y cancelados, y cuadra', async () => {
    const v = await leer();
    const et = v.desglose.map(l => l[0]);
    for (const e of ['Venta bruta', '− Descuentos', '+ Envíos cobrados', '= Venta neta', 'Cancelados excluidos (1)']) {
      assert(et.includes(e), `falta «${e}»: ${et}`);
    }
    const m = Object.fromEntries(v.desglose.map(l => [l[0], centavos(l[1])]));
    assert(m['Venta bruta'] - Math.abs(m['− Descuentos']) + m['+ Envíos cobrados'] === m['= Venta neta'], `no cuadra: ${JSON.stringify(m)}`);
    assert(m['Cancelados excluidos (1)'] === 20000, `cancelados: ${m['Cancelados excluidos (1)']}`);
    assert(/\$1,056\.10/.test(v.desglose.find(l => l[0] === 'Venta bruta')[1]), `formato con miles: ${v.desglose[0]}`);
    assert(/01\/10\/2026 al 31\/10\/2026/.test(v.titulo), `rango: ${v.titulo}`);
    assert(/Por cobrar.*1 pedido.*\$150\.00/.test(v.notas), `por cobrar: ${v.notas}`);
    assert(/Propinas: \$45\.00/.test(v.notas), `propinas: ${v.notas}`);
    assert(/Rappi informó \$11\.90/.test(v.notas), `Rappi: ${v.notas}`);
  });

  await t('P4. la hora se pinta en la zona del negocio, no en la del navegador (Tokio)', async () => {
    const v = await leer();
    const rappi = v.filas.find(f => /rappi/i.test(f[4]));
    // 05:30Z del 7-oct = 00:30 del 7 en Matamoros (CDT). En Tokio serían las 14:30.
    assert(/07\/10/.test(rappi[0]) && /12:30/.test(rappi[0]), `hora: ${rappi[0]}`);
    zonaRespuesta = 'America/Hermosillo';
    await cargarOctubre();
    await esperar(100);
    const h = (await leer()).filas.find(f => /rappi/i.test(f[4]));
    assert(/06\/10/.test(h[0]) && /10:30/.test(h[0]), `en Hermosillo: ${h[0]}`);
    zonaRespuesta = 'America/Matamoros';
    await cargarOctubre();
  });

  await t('P5. el CSV trae los mismos renglones y su Total suma la tarjeta; el nombre lleva los días', async () => {
    const r = await page.evaluate(() => {
      const BlobReal = window.Blob;
      let csv = '', nombre = '';
      window.Blob = function (partes, opts) { csv = partes.join(''); return new BlobReal(partes, opts); };
      const clicReal = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () { nombre = this.download; };
      try { exportarCSV(); } finally { window.Blob = BlobReal; HTMLAnchorElement.prototype.click = clicReal; }
      return { csv, nombre, total: document.getElementById('pos-total-val').textContent };
    });
    const lineas = r.csv.replace(/^﻿/, '').trim().split('\n');
    const cab = lineas[0].split(',').map(x => x.replace(/"/g, ''));
    assert(cab.join('|') === 'Fecha y hora|Folio|Cliente|Telefono|Canal|Modalidad|Pago|Items|Venta bruta|Descuento|Envio|Total', `cabecera: ${cab}`);
    assert(lineas.length - 1 === 4, `renglones: ${lineas.length - 1}`);
    const celdas = lineas.slice(1).map(l => l.match(/"((?:[^"]|"")*)"/g).map(x => x.slice(1, -1)));
    const suma = celdas.reduce((s, c) => s + centavos(c[11]), 0);
    assert(suma === centavos(r.total), `Σ CSV ${suma / 100} ≠ tarjeta ${r.total}`);
    for (const c of celdas) assert(centavos(c[8]) - centavos(c[9]) + centavos(c[10]) === centavos(c[11]), `renglón no cuadra: ${c}`);
    assert(r.nombre === 'ventas-xabor-2026-10-01_a_2026-10-31.csv', `nombre: ${r.nombre}`);
  });

  await t('P6. un error del servidor se muestra y no deja números viejos', async () => {
    await page.evaluate(() => cargarVentas({ desde: '2026-13-01' }));
    await page.waitForFunction(() => /Fechas inválidas/.test(document.getElementById('ventas-body').innerText));
    const v = await leer();
    assert(v.total === '$0.00' && v.pedidos === '0' && v.desglose.length === 0, `quedó: ${JSON.stringify(v).slice(0, 200)}`);
  });

  await t('P7. dos clics seguidos: gana el último, aunque el primero conteste después', async () => {
    retrasoHoyMs = 600;
    await page.evaluate(() => { setPeriodo('hoy'); setPeriodo('mes'); });
    await esperar(1000);
    retrasoHoyMs = 0;
    const v = await leer();
    assert(v.pedidos === '4', `se pintó la respuesta vieja: pedidos ${v.pedidos}`);
  });

  await t('P8. Inicio usa la misma definición y el «hoy» del negocio', async () => {
    await page.evaluate(() => cargarInicio());
    await page.waitForFunction(() => /\$99/.test(document.getElementById('inicio-ventas').textContent));
    const sub = await page.evaluate(() => document.getElementById('inicio-ventas-sub').textContent);
    assert(/1 pedido cobrado/.test(sub), `Inicio: ${sub}`);
  });
} finally {
  await navegador.close().catch(() => {});
  server.close();
}

console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallidas) { console.log('Fallos:\n  · ' + fallos.join('\n  · ')); process.exit(1); }
process.exit(0);
