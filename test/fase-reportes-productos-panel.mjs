// Reportes → Productos, Transacciones y el detalle de Ventas en el navegador
// (Fase 3). Sin Postgres: un servidor estático sirve panel/ y contesta las
// rutas con las funciones REALES del servidor (armarReporteVentas,
// construirReporteProductos, detalleDeSucursal), así el panel y el servidor
// no pueden divergir sin que esta suite lo note. Ver fase-reportes-productos
// (servidor, con base).
//
//   · Sin la bandera, Reportes queda como estaba: Ventas con su tabla de
//     Transacciones, sin pestañas nuevas y sin pedir el reporte.
//   · Con la bandera: las pestañas Productos y Transacciones, la tabla mudada,
//     el periodo compartido, el cuadre igual a la tarjeta de Ventas, filtros,
//     vistas, orden, búsqueda, CSV de cada vista, sucursales y celular.
//
// Los importes y nombres son inventados: el repo es público.
//
// Uso: node test/fase-reportes-productos-panel.mjs
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const { armarReporteVentas, rangoDeReporte, fechaYHoraLocal } = await import('../src/services/reporteVentas.js');
const { construirReporteProductos, filtrosDeReporte } = await import('../src/services/reporteProductos.js');
const { detalleDeSucursal, sumarSucursales } = await import('../src/services/reporteVentasDetalle.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const PANEL_DIR = join(__dirname, '..', 'panel');
const TZ = 'America/Matamoros';
const HOY = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());

// ─── Datos inventados: octubre de 2026 (CDT, local + 5 = UTC) ──────────────
const it = (producto_id, nombre, cantidad, precio_unitario, extra = {}) => ({ producto_id, nombre, cantidad, precio_unitario, ...extra });
const fila = (folio, estado, datos, creado_at) => ({ folio, estado, datos, creado_at, registro: 'vigente' });
const XSS = '<img src=x onerror="window.__xss=1">';
const FILAS_A = [
  fila('PA-1', 'entregado', { canal: 'pos', modalidad: 'recoger en tienda', forma_pago: 'efectivo', subtotal: 300, descuento: 30, total: 270,
    items: [it(1, 'Chilaquiles', 2, 135), it(2, 'Agua de horchata', 1, 30)] }, '2026-10-07T13:30:00.000Z'),
  fila('PA-2', 'entregado', { canal: 'whatsapp', modalidad: 'entrega a domicilio', forma_pago: 'terminal (tarjeta presente)', subtotal: 120, costo_envio: 40, total: 160,
    items: [it(1, 'Chilaquiles', 1, 120)] }, '2026-10-08T15:00:00.000Z'),
  fila('PA-3', 'entregado', { canal: 'rappi', pago: 'rappi_pay', modalidad: 'entrega a domicilio', subtotal: 145, total: 145,
    items: [it(1, 'Chilaquiles', 1, 120)] }, '2026-10-09T17:15:00.000Z'),
  fila('RM-PA000001-0', 'entregado', { canal: 'restaurante_mesa', modalidad: 'mesa', mesero: 'Mesero Uno', forma_pago: 'efectivo', subtotal: 95, total: 95,
    items: [{ nombre: 'Agua de horchata', cantidad: 1, precio_unitario: 30 }, { nombre: XSS, cantidad: 1, precio_unitario: 65 }] }, '2026-10-10T19:00:00.000Z'),
  fila('PA-5', 'cancelado', { canal: 'pos', forma_pago: 'efectivo', subtotal: 999, total: 999, items: [it(1, 'Chilaquiles', 1, 999)] }, '2026-10-10T14:00:00.000Z'),
];
const LINEAS_A = new Map([
  ['PA-1', [it(1, 'Chilaquiles', 2, 135, { tipo: 'platillo', modificadores: [{ orden: 1, grupo_id: 9, grupo: 'Salsa', opcion_id: 91, opcion: 'Mole', cantidad: 1, precio_extra: 15 }] }),
    it(2, 'Agua de horchata', 1, 30, { tipo: 'bebida', modificadores: [] })]],
  ['PA-2', [it(1, 'Chilaquiles', 1, 120, { tipo: 'platillo', modificadores: [{ orden: 1, grupo_id: 9, grupo: 'Salsa', opcion_id: 92, opcion: 'Verde', cantidad: 1, precio_extra: 0 }] })]],
  ['PA-3', [it(1, 'Chilaquiles', 1, 120, { tipo: 'platillo', modificadores: [] })]],
  ['RM-PA000001-0', [it(2, 'Agua de horchata', 1, 30, { tipo: 'bebida', modificadores: [] }), it(null, XSS, 1, 65, { tipo: 'platillo', modificadores: [] })]],
]);
const CATALOGO_A = [
  { id: 1, nombre: 'Chilaquiles', tipo: 'platillo', disponible: true, categoria_id: 5, categoria: 'Desayunos', categoria_activa: true },
  // La categoría empieza con «=»: en el CSV debe salir como texto, no como fórmula.
  { id: 2, nombre: 'Agua de horchata', tipo: 'bebida', disponible: true, categoria_id: 6, categoria: '=Bebidas', categoria_activa: true },
  { id: 3, nombre: 'Molletes', tipo: 'platillo', disponible: true, categoria_id: 5, categoria: 'Desayunos', categoria_activa: true },
];
const FILAS_B = [fila('PB-1', 'entregado', { canal: 'pos', modalidad: 'recoger en tienda', forma_pago: 'efectivo', subtotal: 100, total: 100,
  items: [it(11, 'Chilaquiles', 1, 100)] }, '2026-10-07T15:00:00.000Z')];
const LINEAS_B = new Map([['PB-1', [it(11, 'Chilaquiles', 1, 100, { tipo: 'platillo', modificadores: [] })]]]);
const CATALOGO_B = [{ id: 11, nombre: 'Chilaquiles', tipo: 'platillo', disponible: true, categoria_id: 15, categoria: 'Desayunos', categoria_activa: true }];
const SUC = {
  a: { id: '11111111-1111-4111-8111-111111111111', nombre: 'Sucursal Uno', filas: FILAS_A, lineas: LINEAS_A, catalogo: CATALOGO_A },
  b: { id: '22222222-2222-4222-8222-222222222222', nombre: 'Sucursal Dos', filas: FILAS_B, lineas: LINEAS_B, catalogo: CATALOGO_B },
};

let BANDERA = false;
const PETICIONES = [];
const delRango = (filas, { desde, hasta }) => filas.filter((x) => { const l = fechaYHoraLocal(x.creado_at, TZ); return l && l.fecha >= desde && l.fecha <= hasta; });
const params = (query) => Object.fromEntries(new URLSearchParams(query));
const listaSucursales = () => [{ id: SUC.a.id, nombre: SUC.a.nombre, actual: true }, { id: SUC.b.id, nombre: SUC.b.nombre, actual: false }];
function elegidas(p) {
  if (!p.sucursal || p.sucursal === 'actual') return [SUC.a];
  if (p.sucursal === 'todas') return [SUC.a, SUC.b];
  const s = Object.values(SUC).find((x) => x.id === p.sucursal);
  return s ? [s] : null;
}
function responder(url, query) {
  const p = params(query);
  if (url === '/api/reportes/ventas') {
    const rango = rangoDeReporte(p, HOY);
    if (rango.error) return [400, { error: rango.error }];
    return [200, armarReporteVentas({ filas: delRango(FILAS_A, rango), filasAnteriores: [], ...rango, tz: TZ, hoy: HOY, pagina: Number(p.pagina || 1), todas: p.todas === '1' })];
  }
  if (url === '/api/reportes/productos/estado') return [200, BANDERA ? { activo: true, sucursales: listaSucursales() } : { activo: false, sucursales: [] }];
  if (url === '/api/reportes/productos' || url === '/api/reportes/ventas/detalle') {
    if (!BANDERA) return [403, { error: 'apagado', code: 'REPORTE_APAGADO' }];
    const rango = rangoDeReporte(p, HOY);
    if (rango.error) return [400, { error: rango.error }];
    const sucs = elegidas(p);
    if (!sucs) return [403, { error: 'No tienes acceso a esa sucursal' }];
    if (url === '/api/reportes/ventas/detalle') {
      const detalles = sucs.map((s) => detalleDeSucursal({ id: s.id, nombre: s.nombre }, delRango(s.filas, rango)));
      return [200, { timezone: TZ, hoy: HOY, sucursal: sucs.length > 1 ? 'todas' : 'actual', sucursales: listaSucursales(), rango, detalles,
        ...(detalles.length > 1 ? { total: sumarSucursales(detalles) } : {}) }];
    }
    const fl = filtrosDeReporte(p);
    if (fl.error) return [400, { error: fl.error }];
    const fuentes = sucs.map((s) => ({ negocio: { id: s.id, nombre: s.nombre }, tz: TZ, catalogo: s.catalogo,
      actual: { ventas: delRango(s.filas, rango), lineas: s.lineas }, anterior: { ventas: [], lineas: new Map() } }));
    return [200, { timezone: TZ, hoy: HOY, sucursal: sucs.length > 1 ? 'todas' : 'actual', sucursales: listaSucursales(),
      rango, periodo_anterior: { desde: '2026-09-01', hasta: '2026-09-30', etiqueta: 'septiembre' }, registro_disponible: true,
      ...construirReporteProductos({ fuentes, filtros: fl.filtros, minimo: fl.minimo }) }];
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
const centavos = (texto) => Math.round(Number(String(texto).replace(/[^0-9.\-]/g, '')) * 100);
const pedidas = (ruta) => PETICIONES.filter((x) => x.url === ruta).map((x) => x.query);

const navegador = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const erroresPagina = [];
async function abrirPanel(hash = '#reportes', ancho = 1400) {
  const page = await navegador.newPage();
  await page.setViewport({ width: ancho, height: 900 });
  await page.emulateTimezone('Asia/Tokyo');
  page.on('pageerror', (e) => erroresPagina.push(e.message));
  page.on('dialog', (d) => d.accept().catch(() => {}));
  await page.goto(`http://localhost:${puerto}/app${hash}`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => typeof cargarVentas === 'function' && window.XaborReportes);
  return page;
}
const estadoReportes = (page) => page.evaluate(() => {
  const barra = document.getElementById('pestanas-reportes');
  const ver = (id) => { const el = document.getElementById(id); return !!el && getComputedStyle(el).display !== 'none' && !el.hidden; };
  return {
    botones: [...barra.querySelectorAll('.seccion-pestana')].filter((b) => b.style.display !== 'none').map((b) => b.textContent.trim()),
    activa: barra.querySelector('.seccion-pestana.activa')?.textContent.trim(),
    transEn: document.getElementById('ventas-transacciones')?.parentElement?.id,
    periodoEn: document.getElementById('reportes-periodo')?.parentElement?.id,
    detalle: ver('ventas-detalle'), ventas: ver('vista-ventas'), productos: ver('vista-productos'), transacciones: ver('vista-transacciones'),
    hash: location.hash,
  };
});
async function rangoOctubre(page) {
  await page.evaluate(() => { document.getElementById('fecha-desde').value = '2026-10-01'; document.getElementById('fecha-hasta').value = '2026-10-31'; setPeriodoCustom(); });
  await esperar(400);
}
const cuadre = (page) => page.evaluate(() => document.getElementById('rp-cuadre')?.innerText.replace(/\s+/g, ' ').trim() || '');

try {
  await t('P1. sin la bandera Reportes queda como estaba: sin pestañas nuevas, Transacciones en Ventas, sin pedir el reporte', async () => {
    BANDERA = false;
    PETICIONES.length = 0;
    const page = await abrirPanel('#reportes');
    await esperar(500);
    const e = await estadoReportes(page);
    assert(JSON.stringify(e.botones) === '["Ventas","Correcciones"]', `pestañas: ${e.botones}`);
    assert(e.transEn === 'vista-ventas', `Transacciones está en ${e.transEn}`);
    assert(!e.detalle, 'el detalle de Ventas se ve sin la bandera');
    assert(!pedidas('/api/reportes/productos').length && !pedidas('/api/reportes/ventas/detalle').length, 'pidió el reporte sin la bandera');
    await page.evaluate(() => bnavTab('productos'));
    await esperar(300);
    const e2 = await estadoReportes(page);
    assert(e2.ventas && !e2.productos, 'sin la bandera #productos debe caer en Ventas');
    await page.close();
  });

  BANDERA = true;
  PETICIONES.length = 0;
  const page = await abrirPanel('#reportes');
  await page.waitForFunction(() => document.getElementById('pest-productos').style.display !== 'none');
  await rangoOctubre(page);

  await t('P2. con la bandera: Ventas, Productos, Transacciones y Correcciones; la tabla se muda y Ventas gana el detalle', async () => {
    const e = await estadoReportes(page);
    assert(JSON.stringify(e.botones) === '["Ventas","Productos","Transacciones","Correcciones"]', `pestañas: ${e.botones}`);
    assert(e.activa === 'Ventas', `activa: ${e.activa}`);
    assert(e.transEn === 'vista-transacciones', `Transacciones está en ${e.transEn}`);
    assert(e.detalle, 'falta el detalle de Ventas');
    await page.waitForFunction(() => /Formas de pago/.test(document.getElementById('ventas-detalle').innerText));
    const r = await page.evaluate(() => ({
      total: document.getElementById('pos-total-val').textContent,
      detalle: document.getElementById('ventas-detalle').innerText,
    }));
    assert(centavos(r.total) === 67000, `tarjeta: ${r.total}`);
    assert(/Efectivo/.test(r.detalle) && /Plataformas/.test(r.detalle) && /Tarjeta/.test(r.detalle), r.detalle);
    assert(/Mesero Uno/.test(r.detalle) && /Sin registrar/.test(r.detalle), 'falta quién vendió');
    assert(pedidas('/api/reportes/ventas/detalle').some((x) => /desde=2026-10-01&hasta=2026-10-31/.test(x)), 'el detalle no usó los días de Ventas');
  });

  await t('P3. Productos: dirección propia, el periodo arriba y el cuadre igual a la tarjeta de Ventas', async () => {
    const total = await page.evaluate(() => document.getElementById('pos-total-val').textContent);
    await page.click('#pest-productos');
    await page.waitForFunction(() => document.getElementById('rp-cuadre'));
    const e = await estadoReportes(page);
    assert(e.productos && !e.ventas && e.activa === 'Productos' && e.hash === '#reportes/productos', JSON.stringify(e));
    assert(e.periodoEn === 'vista-productos', `el periodo quedó en ${e.periodoEn}`);
    const k = await cuadre(page);
    assert(/✓ cuadra/.test(k), k);
    const neta = k.match(/Venta neta (\$[\d,.]+)/);
    assert(neta && centavos(neta[1]) === centavos(total), `cuadre ${neta && neta[1]} ≠ tarjeta ${total}`);
    assert(/misma venta neta de la pestaña Ventas/.test(k), k);
    assert(pedidas('/api/reportes/productos').some((x) => /desde=2026-10-01&hasta=2026-10-31/.test(x)), 'no usó el periodo elegido en Ventas');
  });

  await t('P4. la tabla: Σ venta = Productos del cuadre, orden por columna, búsqueda y el nombre con HTML sale como texto', async () => {
    const r = await page.evaluate(() => ({
      filas: [...document.querySelectorAll('#reportes-productos .rp-tabla tbody tr')].map((tr) => [...tr.children].map((td) => td.innerText.trim())),
      xss: window.__xss === 1,
    }));
    assert(!r.xss, 'se ejecutó el HTML de un nombre');
    assert(r.filas.length === 3, `renglones: ${r.filas.length}`);
    assert(r.filas[0][0] === 'Chilaquiles', `el primero por venta: ${r.filas[0][0]}`);
    const suma = r.filas.reduce((s, x) => s + centavos(x[3].split('\n')[0]), 0);
    const k = await cuadre(page);
    assert(suma === centavos(k.match(/Productos (\$[\d,.]+)/)[1]), `Σ ${suma} ≠ cuadre ${k}`);
    await page.click('#reportes-productos th[data-orden="nombre"]');
    const nombres = await page.evaluate(() => [...document.querySelectorAll('#reportes-productos .rp-tabla tbody tr td:first-child')].map((td) => td.innerText.split('\n')[0]));
    assert(nombres[0].startsWith('<img') && nombres[1] === 'Agua de horchata', `orden por nombre: ${nombres}`);
    await page.type('#reportes-productos [data-busca]', 'horch');
    const tras = await page.evaluate(() => ({
      filas: [...document.querySelectorAll('#reportes-productos .rp-tabla tbody tr')].length,
      foco: document.activeElement?.hasAttribute('data-busca'),
    }));
    assert(tras.filas === 1 && tras.foco, `búsqueda: ${JSON.stringify(tras)}`);
    await page.evaluate(() => { const b = document.querySelector('#reportes-productos [data-busca]'); b.value = ''; b.dispatchEvent(new Event('input', { bubbles: true })); });
  });

  await t('P5. cambiar el periodo en Productos pide Productos, no Ventas; los filtros viajan al servidor', async () => {
    const antesVentas = pedidas('/api/reportes/ventas').length;
    await page.evaluate(() => setPeriodo('mes'));
    await esperar(400);
    assert(pedidas('/api/reportes/productos').at(-1).includes('periodo=mes'), `última: ${pedidas('/api/reportes/productos').at(-1)}`);
    assert(pedidas('/api/reportes/ventas').length === antesVentas, 'pidió Ventas desde Productos');
    await rangoOctubre(page);
    await page.select('#reportes-productos select[data-filtro="canal"]', 'rappi');
    await esperar(400);
    assert(/canal=rappi/.test(pedidas('/api/reportes/productos').at(-1)), 'el canal no viajó');
    const k = await cuadre(page);
    assert(/Venta neta \$145\.00/.test(k) && /filtros elegidos/.test(k) && /✓ cuadra/.test(k), k);
    assert(/repartidos/.test(k), 'no explica los toppings repartidos');
    await page.select('#reportes-productos select[data-filtro="canal"]', '');
    await esperar(400);
    await page.select('#reportes-productos select[data-filtro="franja"]', '7-9');
    await esperar(400);
    assert(/franja=7-9/.test(pedidas('/api/reportes/productos').at(-1)), 'la franja no viajó');
    await page.select('#reportes-productos select[data-filtro="franja"]', '');
    await esperar(400);
  });

  await t('P6. las vistas: categorías (con sus productos), opciones, combinaciones y pares, sin movimiento y por hora', async () => {
    const vista = async (v) => { await page.click(`#reportes-productos [data-vista="${v}"]`); await esperar(100); return page.evaluate(() => document.getElementById('reportes-productos').innerText); };
    let txt = await vista('categorias');
    assert(/Desayunos/.test(txt) && /Bebidas/.test(txt), txt.slice(0, 300));
    await page.click('#reportes-productos [data-categoria]');
    txt = await page.evaluate(() => document.getElementById('reportes-productos').innerText);
    assert(/de la categoría/.test(txt), 'la categoría no se abrió');
    txt = await vista('modificadores');
    assert(/Salsa/.test(txt) && /Mole/.test(txt) && /Verde/.test(txt), 'faltan las opciones');
    txt = await vista('combinaciones');
    assert(/Salsa: Mole/.test(txt) && /más se venden juntos/.test(txt) && /Agua de horchata \+ Chilaquiles|Chilaquiles \+ Agua de horchata/.test(txt), txt.slice(0, 600));
    txt = await vista('sin_movimiento');
    assert(/Molletes/.test(txt), 'Molletes no salió sin movimiento');
    await page.$eval('#reportes-productos [data-minimo]', (el) => { el.value = '9'; el.dispatchEvent(new Event('change', { bubbles: true })); });
    await esperar(400);
    assert(/minimo=9/.test(pedidas('/api/reportes/productos').at(-1)), 'el mínimo no viajó');
    txt = await vista('por_franja');
    assert(/7 a 9/.test(txt) && /Otras horas/.test(txt), 'faltan las franjas');
  });

  await t('P7. cada vista baja su CSV, con nombre de los días y sin fórmulas', async () => {
    const csvDe = (v) => page.evaluate(async (vista) => {
      document.querySelector(`#reportes-productos [data-vista="${vista}"]`).click();
      const BlobReal = window.Blob;
      let csv = '', nombre = '';
      window.Blob = function (partes, opts) { csv = partes.join(''); return new BlobReal(partes, opts); };
      const clicReal = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () { nombre = this.download; };
      try { document.querySelector('#reportes-productos [data-csv]').click(); } finally { window.Blob = BlobReal; HTMLAnchorElement.prototype.click = clicReal; }
      return { csv, nombre };
    }, v);
    for (const v of ['productos', 'categorias', 'modificadores', 'combinaciones', 'sin_movimiento', 'por_franja']) {
      const r = await csvDe(v);
      assert(r.nombre === `productos-${v}-2026-10-01_2026-10-31.csv`, `${v}: ${r.nombre}`);
      assert(r.csv.split('\n').length >= 2, `${v}: CSV vacío`);
    }
    const p = await csvDe('productos');
    assert(p.csv.includes(`"'<img`) === false && p.csv.includes('"<img'), 'el nombre con < no es fórmula y se conserva');
    assert(p.csv.includes(`"'=Bebidas"`) && !p.csv.includes('"=Bebidas"'), 'una celda que empieza con = sale como texto');
    const lineas = p.csv.replace(/^﻿/, '').trim().split('\n');
    assert(lineas[0].startsWith('"Producto","Categoria"'), lineas[0]);
  });

  await t('P8. Transacciones: su pestaña, el periodo arriba y la tabla de siempre', async () => {
    await page.click('#pest-transacciones');
    await page.waitForFunction(() => document.querySelectorAll('#ventas-body tr').length >= 1 && !/Cargando/.test(document.getElementById('ventas-body').innerText));
    const e = await estadoReportes(page);
    assert(e.transacciones && e.hash === '#reportes/transacciones' && e.activa === 'Transacciones' && e.periodoEn === 'vista-transacciones', JSON.stringify(e));
    const filas = await page.evaluate(() => document.querySelectorAll('#ventas-body tr').length);
    assert(filas === 4, `renglones: ${filas}`);
    assert(/desde=2026-10-01&hasta=2026-10-31/.test(pedidas('/api/reportes/ventas').at(-1)), 'no usó el periodo compartido');
  });

  await t('P9. Ventas → sucursales lado a lado, y de vuelta a una', async () => {
    await page.click('#pest-ventas');
    await page.waitForFunction(() => /Formas de pago/.test(document.getElementById('ventas-detalle').innerText));
    const e = await estadoReportes(page);
    assert(e.ventas && e.periodoEn === 'vista-ventas' && e.transEn === 'vista-transacciones', JSON.stringify(e));
    await page.select('#ventas-detalle [data-sucursal-ventas]', 'todas');
    await page.waitForFunction(() => /Sucursal Dos/.test(document.getElementById('ventas-detalle').innerText));
    assert(/sucursal=todas/.test(pedidas('/api/reportes/ventas/detalle').at(-1)), 'no pidió todas');
    const t2 = await page.evaluate(() => document.getElementById('ventas-detalle').innerText);
    assert(/Sucursal Uno/.test(t2) && /Todas/.test(t2) && /Venta neta/.test(t2), t2.slice(0, 400));
    await page.select('#ventas-detalle [data-sucursal-ventas]', 'actual');
    await page.waitForFunction(() => !/Sucursal Dos/.test(document.querySelector('#ventas-detalle table')?.innerText || 'Sucursal Dos'));
  });

  await t('P10. Productos con «Todas» junta las sucursales y lo dice en el cuadre', async () => {
    await page.click('#pest-productos');
    await page.waitForFunction(() => document.getElementById('rp-cuadre'));
    await esperar(400);
    await page.select('#reportes-productos select[data-filtro="sucursal"]', 'todas');
    await esperar(400);
    assert(/sucursal=todas/.test(pedidas('/api/reportes/productos').at(-1)), 'no pidió todas');
    const k = await cuadre(page);
    assert(/Suma de 2 sucursales/.test(k) && /Sucursal Dos/.test(k), k);
    await page.select('#reportes-productos select[data-filtro="sucursal"]', 'actual');
    await esperar(300);
  });
  await page.close();

  await t('P11. entrar directo a #reportes/productos o /transacciones lleva ahí, sin «No tienes acceso»', async () => {
    for (const [hash, vista] of [['#reportes/productos', 'vista-productos'], ['#reportes/transacciones', 'vista-transacciones']]) {
      const p2 = await abrirPanel(hash);
      await p2.waitForFunction((v) => document.getElementById(v).style.display === 'block', { timeout: 5000 }, vista);
      const r = await p2.evaluate(() => ({ hash: location.hash, aviso: /No tienes acceso/.test(document.body.innerText) }));
      assert(r.hash === hash && !r.aviso, `${hash}: ${JSON.stringify(r)}`);
      await p2.close();
    }
    BANDERA = false;
    const p3 = await abrirPanel('#reportes/productos');
    await esperar(600);
    const r = await p3.evaluate(() => ({ ventas: document.getElementById('vista-ventas').style.display, aviso: /No tienes acceso/.test(document.body.innerText) }));
    BANDERA = true;
    assert(r.ventas === 'block' && !r.aviso, `sin la bandera debe quedar en Ventas: ${JSON.stringify(r)}`);
    await p3.close();
  });

  await t('P12. en el celular la pestaña Productos no desborda la página', async () => {
    const cel = await abrirPanel('#reportes/productos', 375);
    await cel.waitForFunction(() => document.getElementById('rp-cuadre'), { timeout: 5000 });
    const m = await cel.evaluate(() => ({ pagina: document.documentElement.scrollWidth, vista: window.innerWidth }));
    assert(m.pagina <= m.vista, `la página desborda: ${m.pagina} > ${m.vista}`);
    await cel.close();
  });

  await t('P13. la huella ?v= de index.html es la del archivo (la caché no sirve uno viejo)', async () => {
    const { createHash } = await import('node:crypto');
    const h = createHash('sha256').update(readFileSync(join(PANEL_DIR, 'reportes-productos.js'))).digest('hex').slice(0, 8);
    const html = readFileSync(join(PANEL_DIR, 'index.html'), 'utf8');
    assert(html.includes(`<script src="/reportes-productos.js?v=${h}"></script>`), `index.html no trae ?v=${h}`);
  });

  await t('P14. sin errores de JavaScript en toda la corrida', async () => {
    assert(!erroresPagina.length, erroresPagina.join(' | '));
  });
} finally {
  await navegador.close().catch(() => {});
  server.close();
}

console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallidas) { console.log('Fallos:\n  · ' + fallos.join('\n  · ')); process.exit(1); }
process.exit(0);
