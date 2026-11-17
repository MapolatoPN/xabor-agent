// Reportes → Ventas en el navegador: la tarjeta, el desglose, la tabla y el
// CSV muestran la MISMA cuenta, y el panel pide días del negocio (no
// instantes de su reloj). Fase 2: ventas por día con la comparación, el
// promedio por día de la semana, el mapa de calor y la tabla por páginas.
// Sin Postgres: un servidor estático sirve panel/ y contesta
// /api/reportes/ventas con lo que arma armarReporteVentas (la función real
// del servidor), así el panel y el servidor no pueden divergir sin que esta
// suite lo note. Ver también fase-reportes-ventas y
// fase-reportes-ventas-analisis (servidor, con base).
//
// Los importes son inventados: el repo es público.
//
// Uso: node test/fase-reportes-ventas-panel.mjs
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const { armarReporteVentas, rangoDeReporte, paginaDeReporte } = await import('../src/services/reporteVentas.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const PANEL_DIR = join(__dirname, '..', 'panel');
const PUERTO = Number(process.env.TEST_PORT_REPVENTAS_PANEL || 0);
const TZ = 'America/Matamoros';
const HOY_NEGOCIO = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());

const fila = (folio, estado, datos, creado_at) => ({ folio, estado, datos, creado_at });
// Octubre, en pequeño: Rappi sin forma de pago, mostrador, tienda con envío,
// mesa con descuento y propina, un cancelado y un por cobrar.
const OCT_CHICO = [
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
];
const efectivo = (folio, total, creado_at, nombre = 'Café') => fila(folio, 'entregado', { canal: 'pos', subtotal: total, total, forma_pago: 'efectivo',
  modalidad: 'recoger en tienda', cliente: { nombre: `Cliente ${folio}` }, items: [{ nombre, cantidad: 1, precio_unitario: total }] }, creado_at);
const PREVIOS = {
  chico: [efectivo('XAB-1300', 500, '2026-09-10T17:00:00.000Z')],
  mayor: [efectivo('XAB-1301', 2051.8, '2026-09-10T17:00:00.000Z')],
  vacio: [],
};
// Octubre completo: de lunes a domingo 2, 3, 3, 4, 5, 6 y 6 tickets por día
// (131 en total: 3 páginas), el ticket i a las 8 + i locales (CDT: +5 = UTC).
const POR_DIA = [6, 2, 3, 3, 4, 5, 6]; // domingo..sábado
const OCT_GRANDE = [];
for (let d = 1; d <= 31; d++) {
  const dow = new Date(Date.UTC(2026, 9, d)).getUTCDay();
  for (let i = 0; i < POR_DIA[dow]; i++) {
    OCT_GRANDE.push(efectivo(`XAB-${2000 + d * 10 + i}`, 100 + 10 * i + d, new Date(Date.UTC(2026, 9, d, 8 + i + 5, 15)).toISOString(),
      ['Café', 'Pan', 'Jugo'][i % 3]));
  }
}
OCT_GRANDE.sort((a, b) => b.creado_at.localeCompare(a.creado_at)); // como la base: lo más reciente primero
const SEP_GRANDE = Array.from({ length: 30 }, (_, i) => efectivo(`XAB-${1500 + i}`, 100, new Date(Date.UTC(2026, 8, 1 + i, 15)).toISOString()));
const HOY_FILAS = [fila('XAB-2001', 'entregado', { canal: 'pos', subtotal: 99, total: 99, forma_pago: 'efectivo', modalidad: 'recoger en tienda', items: [] }, new Date().toISOString())];

const PETICIONES = [];
let zonaRespuesta = TZ;
let retrasoHoyMs = 0;
let conjunto = 'chico';
let previo = 'chico';
// Lo que contesta el servidor, con sus mismas funciones.
function reporte(query) {
  const p = new URLSearchParams(query);
  const q = (k) => (p.has(k) ? p.get(k) : undefined);
  const rango = rangoDeReporte({ periodo: q('periodo'), desde: q('desde'), hasta: q('hasta') }, HOY_NEGOCIO);
  if (rango.error) return [400, { error: rango.error }];
  const pag = paginaDeReporte({ pagina: q('pagina'), todas: q('todas') });
  if (pag.error) return [400, { error: pag.error }];
  const esHoy = q('periodo') === 'hoy';
  const filas = esHoy ? HOY_FILAS : conjunto === 'grande' ? OCT_GRANDE : OCT_CHICO;
  const filasAnteriores = esHoy ? [] : conjunto === 'grande' ? SEP_GRANDE : PREVIOS[previo];
  return [200, armarReporteVentas({ filas, filasAnteriores, ...rango, tz: zonaRespuesta, hoy: HOY_NEGOCIO, ...pag })];
}
const esperado = (query) => reporte(query)[1];
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
const c = (n) => Math.round(Number(n) * 100);
const consultas = () => PETICIONES.filter(p => p.url === '/api/reportes/ventas').map(p => p.query);
const OCT = 'desde=2026-10-01&hasta=2026-10-31';

const navegador = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await navegador.newPage();
await page.setViewport({ width: 1400, height: 900 });
// El navegador de la prueba vive en Tokio: si el panel cortara días o
// pintara horas con SU reloj, se notaría.
await page.emulateTimezone('Asia/Tokyo');
page.on('dialog', d => d.accept().catch(() => {}));
const erroresPagina = [];
page.on('pageerror', e => erroresPagina.push(e.message));

const leer = (pg = page) => pg.evaluate(() => ({
  total: document.getElementById('pos-total-val').textContent,
  pedidos: document.getElementById('pos-pedidos').textContent,
  filas: [...document.querySelectorAll('#ventas-body tr')].map(tr => [...tr.children].map(td => td.innerText.trim())),
  desglose: [...document.querySelectorAll('#ventas-desglose .vd-linea')].map(l => [...l.children].map(s => s.textContent.trim())),
  titulo: document.querySelector('#ventas-desglose .vd-titulo')?.textContent.replace(/\s+/g, ' ').trim() || '',
  notas: document.querySelector('#ventas-desglose .vd-notas')?.innerText || '',
  paginas: document.getElementById('ventas-paginas')?.innerText.replace(/\s+/g, ' ').trim() || '',
  analisis: document.getElementById('ventas-analisis')?.innerHTML.trim() || '',
  top: document.getElementById('top-productos')?.innerText || '',
}));
async function cargarRango(desde, hasta, filas, pg = page) {
  await pg.evaluate((d, h) => { document.getElementById('fecha-desde').value = d; document.getElementById('fecha-hasta').value = h; setPeriodoCustom(); }, desde, hasta);
  await pg.waitForFunction((n) => document.querySelectorAll('#ventas-body tr').length === n && !/Cargando/.test(document.getElementById('ventas-body').innerText), {}, filas);
  await esperar(50);
}
const cargarOctubre = () => { conjunto = 'chico'; return cargarRango('2026-10-01', '2026-10-31', 4); };
const cargarGrande = (pg = page) => { conjunto = 'grande'; return cargarRango('2026-10-01', '2026-10-31', 50, pg); };
// La ayuda flotante: primero a la vista (el scroll la cierra) y luego el mouse.
async function ayudaDe(el, pg = page) {
  await el.evaluate(e => e.scrollIntoView({ block: 'center' }));
  await esperar(150);
  await el.hover();
  await esperar(60);
  return pg.evaluate(() => { const t = document.getElementById('va-tip'); return t && !t.hidden ? t.innerText : null; });
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
    assert(consultas().includes(OCT), `el rango no salió como días: ${consultas()}`);
    assert(!consultas().some(q => /T\d\d:|Z/.test(q)), `se mandó un instante del navegador: ${consultas()}`);
  });

  await t('P2. tarjeta = Σ columna Total = venta neta del desglose; en la tabla solo hay ventas', async () => {
    const v = await leer();
    const suma = v.filas.reduce((s, f) => s + centavos(f[6]), 0);
    assert(centavos(v.total) === suma, `tarjeta ${v.total} ≠ Σ tabla ${suma / 100}`);
    assert(centavos(v.total) === c(esperado(OCT).resumen.total_ventas), `tarjeta ${v.total}`);
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
    try {
      await cargarOctubre();
      const h = (await leer()).filas.find(f => /rappi/i.test(f[4]));
      assert(/06\/10/.test(h[0]) && /10:30/.test(h[0]), `en Hermosillo: ${h[0]}`);
      // Y la barra de ese pedido se mueve al 6 con la zona del negocio.
      const barras = await page.$$eval('#va-por-dia .va-barra', bs => bs.map(b => b.classList.contains('con-venta')));
      assert(barras[5] && barras[6], `en Hermosillo el pedido de las 00:30 de Matamoros es del 6: ${barras.slice(4, 8)}`);
    } finally {
      zonaRespuesta = TZ;
    }
    await cargarOctubre();
  });

  await t('P5. el CSV pide TODAS al servidor, trae los mismos renglones y su Total suma la tarjeta', async () => {
    const r = await page.evaluate(async () => {
      const BlobReal = window.Blob;
      let csv = '', nombre = '';
      window.Blob = function (partes, opts) { csv = partes.join(''); return new BlobReal(partes, opts); };
      const clicReal = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () { nombre = this.download; };
      try { await exportarCSV(); } finally { window.Blob = BlobReal; HTMLAnchorElement.prototype.click = clicReal; }
      return { csv, nombre, total: document.getElementById('pos-total-val').textContent };
    });
    assert(consultas().includes(`${OCT}&todas=1`), `el CSV no pidió todas: ${consultas().slice(-3)}`);
    const lineas = r.csv.replace(/^﻿/, '').trim().split('\n');
    const cab = lineas[0].split(',').map(x => x.replace(/"/g, ''));
    assert(cab.join('|') === 'Fecha y hora|Folio|Cliente|Telefono|Canal|Modalidad|Pago|Items|Venta bruta|Descuento|Envio|Total', `cabecera: ${cab}`);
    assert(lineas.length - 1 === 4, `renglones: ${lineas.length - 1}`);
    const celdas = lineas.slice(1).map(l => l.match(/"((?:[^"]|"")*)"/g).map(x => x.slice(1, -1)));
    const suma = celdas.reduce((s, x) => s + centavos(x[11]), 0);
    assert(suma === centavos(r.total), `Σ CSV ${suma / 100} ≠ tarjeta ${r.total}`);
    for (const x of celdas) assert(centavos(x[8]) - centavos(x[9]) + centavos(x[10]) === centavos(x[11]), `renglón no cuadra: ${x}`);
    assert(r.nombre === 'ventas-xabor-2026-10-01_a_2026-10-31.csv', `nombre: ${r.nombre}`);
  });

  await t('P6. un error del servidor se muestra y no deja números viejos (ni gráficas ni páginas)', async () => {
    await page.evaluate(() => cargarVentas({ desde: '2026-13-01' }));
    await page.waitForFunction(() => /Fechas inválidas/.test(document.getElementById('ventas-body').innerText));
    const v = await leer();
    assert(v.total === '$0.00' && v.pedidos === '0' && v.desglose.length === 0, `quedó: ${JSON.stringify(v).slice(0, 200)}`);
    assert(v.analisis === '' && v.paginas === '', `quedaron gráficas o páginas: ${v.analisis.slice(0, 80)} | ${v.paginas}`);
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

  // ─── Fase 2 ───────────────────────────────────────────────────────────────
  await t('P9. ventas por día: una barra por día del filtro; la ayuda dice fecha, día, venta y tickets', async () => {
    await cargarOctubre();
    const barras = await page.$$('#va-por-dia .va-barra');
    assert(barras.length === 31, `barras: ${barras.length}`);
    const estilo = await page.$$eval('#va-por-dia .va-barra', bs => bs.map(b => [b.classList.contains('con-venta'), b.style.getPropertyValue('--h')]));
    assert(estilo[6][0] && estilo[6][1] === '100.0%', `el 7 es el único con venta y el más alto: ${estilo[6]}`);
    assert(estilo.filter(e => e[0]).length === 1 && estilo.every((e, i) => i === 6 || e[1] === '0.0%'), `hay barras con venta de más: ${estilo}`);
    const ayuda = await ayudaDe(barras[6]);
    assert(ayuda === 'Miércoles 7 de octubre de 2026\n$1,025.90 · 4 tickets', `ayuda: ${JSON.stringify(ayuda)}`);
    const sinVenta = await ayudaDe(barras[0]);
    assert(sinVenta === 'Jueves 1 de octubre de 2026\n$0.00 · 0 tickets', `día sin venta: ${JSON.stringify(sinVenta)}`);
    const etiqueta = await barras[6].evaluate(b => b.getAttribute('aria-label'));
    assert(/Miércoles 7 de octubre de 2026: \$1,025\.90/.test(etiqueta), `sin etiqueta para lector de pantalla: ${etiqueta}`);
    // Respeta el filtro: una semana son 7 barras.
    await cargarRango('2026-10-05', '2026-10-11', 4);
    assert((await page.$$('#va-por-dia .va-barra')).length === 7, 'la gráfica no siguió el filtro de fechas');
    await cargarOctubre();
  });

  await t('P10. la comparación contra el periodo anterior: sube, baja y sin ventas antes', async () => {
    const texto = () => page.$eval('#va-comparacion', e => [e.innerText.replace(/\s+/g, ' ').trim(), e.className]);
    const [sube, claseSube] = await texto();
    assert(sube === 'vs. septiembre: +105.2% (septiembre: $500.00)', `sube: ${sube}`);
    assert(esperado(OCT).comparacion.cambio_pct === 105.2 && /va-sube/.test(claseSube), `el número no es del servidor: ${claseSube}`);
    previo = 'mayor';
    await cargarOctubre();
    const [baja, claseBaja] = await texto();
    assert(baja === 'vs. septiembre: −50% (septiembre: $2,051.80)' && /va-baja/.test(claseBaja), `baja: ${baja}`);
    previo = 'vacio';
    await cargarOctubre();
    const [nada] = await texto();
    assert(nada === 'vs. septiembre: sin ventas registradas', `sin ventas antes: ${nada}`);
    previo = 'chico';
    await cargarRango('2026-10-05', '2026-10-11', 4);
    const [semana] = await texto();
    assert(/^vs\. 28\/09 al 04\/10: /.test(semana), `una semana se compara con la anterior: ${semana}`);
    await cargarOctubre();
  });

  await t('P11. promedio por día de la semana: lunes a domingo, días del tipo, promedios del servidor y marcas', async () => {
    await cargarGrande();
    const srv = esperado(OCT).analisis;
    const filas = await page.$$eval('#va-semana tbody tr', trs => trs.map(tr => ({
      dia: Number(tr.dataset.dia), clase: tr.className, celdas: [...tr.children].map(td => td.innerText.trim()),
    })));
    assert(filas.map(f => f.dia).join() === '1,2,3,4,5,6,0', `orden: ${filas.map(f => f.dia)}`);
    assert(filas.map(f => f.celdas[1]).join() === '4,4,4,5,5,5,4', `días por tipo: ${filas.map(f => f.celdas[1])}`);
    for (const f of filas) {
      const s = srv.por_dia_semana.find(x => x.dia_semana === f.dia);
      assert(centavos(f.celdas[2]) === c(s.venta_promedio), `${s.nombre}: venta prom. ${f.celdas[2]} ≠ ${s.venta_promedio}`);
      assert(Number(f.celdas[4]) === Math.round(s.tickets_promedio * 10) / 10, `${s.nombre}: tickets ${f.celdas[4]} ≠ ${s.tickets_promedio}`);
      assert(centavos(f.celdas[5]) === c(s.ticket_promedio), `${s.nombre}: ticket ${f.celdas[5]} ≠ ${s.ticket_promedio}`);
    }
    const bajo = filas.filter(f => /va-bajo/.test(f.clase)), alto = filas.filter(f => /va-alto/.test(f.clase));
    assert(bajo.length === 1 && bajo[0].dia === srv.mas_bajo && srv.mas_bajo === 1, `más bajo: ${bajo.map(f => f.dia)} (servidor ${srv.mas_bajo})`);
    assert(alto.length === 1 && alto[0].dia === srv.mas_alto && srv.mas_alto === 6, `más alto: ${alto.map(f => f.dia)} (servidor ${srv.mas_alto})`);
    assert(/▼/.test(bajo[0].celdas[0]) && /más bajo/.test(bajo[0].celdas[0]), `marca del bajo: ${bajo[0].celdas[0]}`);
    assert(/▲/.test(alto[0].celdas[0]) && /más alto/.test(alto[0].celdas[0]), `marca del alto: ${alto[0].celdas[0]}`);
    // Gráfica: la barra del más alto es la más larga.
    const anchos = await page.$$eval('#va-semana td.va-grafica > div', ds => ds.map(d => d.style.getPropertyValue('--w')));
    assert(anchos.length === 7 && anchos[5] === '100.0%', `barras de la semana: ${anchos}`);
  });

  await t('P12. mapa de calor: lunes a domingo × horas del servidor; la ayuda da venta y tickets promedio', async () => {
    const srv = esperado(OCT).analisis.mapa_calor;
    assert(srv.horas.join() === '8,9,10,11,12,13', `horas del servidor: ${srv.horas}`);
    const horas = await page.$$eval('#va-mapa .va-mapa > .va-eje:not(.fila)', es => es.slice(1).map(e => e.innerText.trim()));
    assert(horas.join('|') === '8 am|9 am|10 am|11 am|12 pm|1 pm', `encabezado: ${horas}`);
    const dias = await page.$$eval('#va-mapa .va-eje.fila', es => es.map(e => e.innerText.trim()));
    assert(dias.join() === 'Lun,Mar,Mié,Jue,Vie,Sáb,Dom', `filas: ${dias}`);
    const celdas = await page.$$('#va-mapa .va-celda');
    assert(celdas.length === 7 * srv.horas.length, `celdas: ${celdas.length}`);
    // Lunes a las 9: el segundo ticket de cada lunes.
    const lun9 = srv.filas[0].celdas[1];
    const ayuda = await ayudaDe(celdas[1]);
    assert(ayuda === `Lunes, 09:00 a 09:59\n$${(lun9.venta_promedio).toLocaleString('en-US', { minimumFractionDigits: 2 })} de venta promedio\n1 ticket en promedio`,
      `ayuda: ${JSON.stringify(ayuda)} (servidor ${JSON.stringify(lun9)})`);
    const vacia = await ayudaDe(celdas[2]);
    assert(vacia === 'Lunes, 10:00 a 10:59\n$0.00 de venta promedio\n0 tickets en promedio', `celda en cero: ${JSON.stringify(vacia)}`);
    // Color según la intensidad: la celda del máximo es la más intensa.
    const alfas = await page.$$eval('#va-mapa .va-celda', cs => cs.map(x => Number(x.style.getPropertyValue('--a'))));
    const iMax = alfas.indexOf(Math.max(...alfas));
    const fMax = srv.filas[Math.floor(iMax / srv.horas.length)].celdas[iMax % srv.horas.length];
    assert(alfas[iMax] === 1 && fMax.venta_promedio === srv.maximo, `la más intensa no es el máximo: ${alfas[iMax]} ${JSON.stringify(fMax)}`);
    assert(alfas.every(a => a >= 0.08 && a <= 1), 'intensidades fuera de escala');
  });

  await t('P13. la tabla va de 50 en 50; la tarjeta y los más vendidos son del periodo entero; el CSV trae todo', async () => {
    const srv1 = esperado(OCT);
    let v = await leer();
    assert(v.filas.length === 50, `página 1: ${v.filas.length} renglones`);
    assert(/^1–50 de 131/.test(v.paginas) && /Página 1 de 3/.test(v.paginas), `pie: ${v.paginas}`);
    assert(await page.$eval('#ventas-pag-ant', b => b.disabled), '«Anterior» activo en la página 1');
    assert(centavos(v.total) === c(srv1.resumen.total_ventas) && v.pedidos === '131', `tarjeta: ${v.total} / ${v.pedidos}`);
    const top1 = v.top;
    let suma = v.filas.reduce((s, f) => s + centavos(f[6]), 0);
    const vistos = new Set(v.filas.map(f => f[2]));
    for (const [n, renglones, pie] of [[2, 50, /^51–100 de 131/], [3, 31, /^101–131 de 131/]]) {
      await page.click('#ventas-pag-sig');
      await page.waitForFunction((r) => document.querySelectorAll('#ventas-body tr').length === r && !/Cargando/.test(document.getElementById('ventas-body').innerText), {}, renglones);
      await esperar(50);
      assert(consultas().at(-1) === `${OCT}&pagina=${n}`, `página ${n}: pidió ${consultas().at(-1)}`);
      v = await leer();
      assert(pie.test(v.paginas), `pie de la página ${n}: ${v.paginas}`);
      const srvN = esperado(`${OCT}&pagina=${n}`);
      assert(v.filas[0][2] === `Cliente ${srvN.ventas[0].folio}`, `página ${n} no empieza donde dice el servidor: ${v.filas[0][2]}`);
      assert(centavos(v.total) === c(srv1.resumen.total_ventas) && v.top === top1, `la tarjeta o los más vendidos cambiaron en la página ${n}`);
      for (const f of v.filas) { assert(!vistos.has(f[2]), `${f[2]} repetido`); vistos.add(f[2]); }
      suma += v.filas.reduce((s, f) => s + centavos(f[6]), 0);
    }
    assert(vistos.size === 131 && suma === centavos(v.total), `Σ de las 3 páginas ${suma / 100} ≠ tarjeta ${v.total}`);
    assert(await page.$eval('#ventas-pag-sig', b => b.disabled), '«Siguiente» activo en la última');
    const csv = await page.evaluate(async () => {
      const BlobReal = window.Blob; let txt = '';
      window.Blob = function (p, o) { txt = p.join(''); return new BlobReal(p, o); };
      const clicReal = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () {};
      try { await exportarCSV(); } finally { window.Blob = BlobReal; HTMLAnchorElement.prototype.click = clicReal; }
      return txt;
    });
    const lineas = csv.replace(/^﻿/, '').trim().split('\n').slice(1);
    const sumaCSV = lineas.reduce((s, l) => s + centavos(l.match(/"((?:[^"]|"")*)"/g).at(-1).slice(1, -1)), 0);
    assert(lineas.length === 131 && sumaCSV === centavos(v.total), `CSV: ${lineas.length} renglones, Σ ${sumaCSV / 100}`);
    // Volver a filtrar regresa a la página 1.
    await cargarGrande();
    assert(consultas().at(-1) === OCT, `filtrar de nuevo pidió ${consultas().at(-1)}`);
    assert(/^1–50 de 131/.test((await leer()).paginas), 'filtrar de nuevo no regresó a la página 1');
  });

  await t('P14. hoy (en curso): la barra de hoy va rayada y los promedios esperan a días cerrados', async () => {
    await page.evaluate(() => setPeriodo('hoy'));
    await page.waitForFunction(() => document.querySelectorAll('#va-por-dia .va-barra').length === 1);
    const r = await page.evaluate(() => ({
      barra: document.querySelector('#va-por-dia .va-barra').className,
      comp: document.getElementById('va-comparacion')?.innerText || '',
      nota: document.querySelector('#va-por-dia .va-nota')?.innerText || '',
      semana: document.querySelector('#va-semana')?.innerText || '',
      tablaSemana: !!document.querySelector('#va-semana table'),
      mapa: document.querySelector('#va-mapa')?.innerText || '',
      celdas: document.querySelectorAll('#va-mapa .va-celda').length,
    }));
    assert(/en-curso/.test(r.barra) && /con-venta/.test(r.barra), `barra de hoy: ${r.barra}`);
    assert(/sin ventas registradas/.test(r.comp), `comparación: ${r.comp}`);
    assert(/Hoy va en curso/.test(r.nota), `nota: ${r.nota}`);
    assert(!r.tablaSemana && /todavía no tiene ninguno/.test(r.semana), `semana: ${r.semana}`);
    assert(r.celdas === 0 && /todavía no tiene ninguno/.test(r.mapa), `mapa: ${r.mapa}`);
  });

  await t('P15. en celular (375 px): sin desbordar la página, todo cabe y la ayuda sale con un toque', async () => {
    const cel = await navegador.newPage();
    try {
      cel.on('pageerror', e => erroresPagina.push(`celular: ${e.message}`));
      await cel.setViewport({ width: 375, height: 812, isMobile: true, hasTouch: true });
      await cel.emulateTimezone('Asia/Tokyo');
      await cel.goto(`http://localhost:${puerto}/app#ventas`, { waitUntil: 'networkidle2' });
      await cel.waitForFunction(() => typeof cargarVentas === 'function');
      await cel.evaluate(() => mostrarTab('ventas'));
      await cel.waitForFunction(() => !/Cargando/.test(document.getElementById('ventas-body').innerText));
      await cargarGrande(cel);
      const m = await cel.evaluate(() => ({
        pagina: document.documentElement.scrollWidth, vista: innerWidth,
        scrolls: [...document.querySelectorAll('#ventas-analisis .va-scroll')].map(e => e.scrollWidth <= e.clientWidth + 1),
        grafica: getComputedStyle(document.querySelector('#va-semana td.va-grafica')).display,
        mini: getComputedStyle(document.querySelector('#va-semana .va-mini')).display,
        tarjetas: [...document.querySelectorAll('#ventas-analisis .va-card')].map(e => e.getBoundingClientRect().right <= innerWidth + 0.5),
      }));
      assert(m.pagina <= m.vista, `la página desborda: ${m.pagina} > ${m.vista}`);
      assert(m.scrolls.length === 3 && m.scrolls.every(Boolean), `alguna gráfica no cabe: ${m.scrolls}`);
      assert(m.tarjetas.every(Boolean), `alguna tarjeta se sale: ${m.tarjetas}`);
      assert(m.grafica === 'none' && m.mini !== 'none', `semana en celular: gráfica ${m.grafica}, mini ${m.mini}`);
      const barra = (await cel.$$('#va-por-dia .va-barra'))[19];
      await barra.evaluate(e => e.scrollIntoView({ block: 'center' }));
      await esperar(150);
      await barra.tap();
      await esperar(80);
      const tip = await cel.evaluate(() => {
        const t = document.getElementById('va-tip'); const r = t.getBoundingClientRect();
        return { visible: !t.hidden, texto: t.innerText, dentro: r.left >= 0 && r.right <= innerWidth };
      });
      assert(tip.visible && /^Martes 20 de octubre de 2026\n/.test(tip.texto), `toque: ${JSON.stringify(tip)}`);
      assert(tip.dentro, 'la ayuda se sale de la pantalla');
      // Hay navegadores táctiles que no simulan «pasar el mouse»: un clic solo también la abre.
      const otra = (await cel.$$('#va-por-dia .va-barra'))[4];
      await cel.evaluate(() => vaOcultarTip());
      await otra.evaluate(b => b.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      const porClic = await cel.evaluate(() => { const t = document.getElementById('va-tip'); return t.hidden ? null : t.innerText; });
      assert(porClic && /^Lunes 5 de octubre de 2026\n/.test(porClic), `un clic sin mouse no abre la ayuda: ${JSON.stringify(porClic)}`);
      await cel.tap('#tabla-ventas');
      await esperar(80);
      assert(await cel.evaluate(() => document.getElementById('va-tip').hidden), 'la ayuda no se cierra al tocar fuera');
    } finally {
      await cel.close().catch(() => {});
    }
  });

  await t('P16. sin errores de JavaScript en toda la corrida', async () => {
    assert(!erroresPagina.length, erroresPagina.join(' | '));
  });
} finally {
  await navegador.close().catch(() => {});
  server.close();
}

console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallidas) { console.log('Fallos:\n  · ' + fallos.join('\n  · ')); process.exit(1); }
process.exit(0);
