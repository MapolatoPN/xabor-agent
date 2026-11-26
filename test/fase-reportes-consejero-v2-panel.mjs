// Reportes › Ventas: el consejero, VERSIÓN 2, en el navegador.
// Sin Postgres: un servidor estático sirve panel/ y contesta las rutas con
// las funciones REALES del servidor (construirReporteProductos con el resumen
// por ticket, periodoDelConsejero, consejosV2), así el panel y el servidor no
// pueden divergir sin que esta suite lo note. Ver fase-reportes-consejero-v2
// (servidor, con base) y fase-reportes-consejero-panel (la versión 1).
//
//   · Sin `consejero_v2` en el estado, el panel pide y pinta la versión 1.
//   · Con ella manda el periodo de arriba; junto al título dice qué días
//     mira y, si el periodo es corto, que usó los últimos 28.
//   · Cada tarjeta: qué cambió (con ▲/▼, no solo color), la acción y qué
//     revisar en 2 semanas; todo igual a lo que dice el servidor.
//   · La tabla: el lift, «Otras», el HTML de un nombre como texto; en el
//     celular se desliza y lo dice; en la computadora cabe.
//   · Cambiar el periodo o la sucursal lo vuelve a pedir con los dos.
//   · El total de Ventas («$888,888.88») cabe en su tarjeta en cualquier
//     ancho, y sin la línea de CSS no cabría (testigo).
//   · La huella ?v= y cero errores de JavaScript.
//
// Los importes y nombres son inventados: el repo es público.
//
// Uso: node test/fase-reportes-consejero-v2-panel.mjs
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import puppeteer from 'puppeteer';

const { armarReporteVentas, rangoDeReporte, fechaYHoraLocal, periodoAnterior } = await import('../src/services/reporteVentas.js');
const { construirReporteProductos } = await import('../src/services/reporteProductos.js');
const { detalleDeSucursal, sumarSucursales } = await import('../src/services/reporteVentasDetalle.js');
const { consejosDeReporte, ventanaDelConsejero } = await import('../src/services/reporteConsejero.js');
const { consejosV2, periodoDelConsejero } = await import('../src/services/reporteConsejeroV2.js');
const { instanteLocal } = await import('../src/services/cortesCaja.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const PANEL_DIR = join(__dirname, '..', 'panel');
const TZ = 'America/Matamoros';
const HOY = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const V = ventanaDelConsejero(HOY);
const XSS = '<img src=x onerror="window.__xss=1">';
const sumarDias = (fecha, dias) => new Date(Date.parse(`${fecha}T00:00:00Z`) + dias * 86400000).toISOString().slice(0, 10);

// ─── Datos inventados ──────────────────────────────────────────────────────
// 28 días con menos tickets para recoger que los 28 anteriores (sale la
// tarjeta de Canal); los combitos van solos; el café va con los chilaquiles
// (lift); NONNA MAYE vende menos del 1 % («Otras»).
const PRODS = {
  chil: { id: 1, nombre: 'Chilaquiles', precio: 150, cat: 'CHILAQUILES', catId: 1 },
  taco: { id: 2, nombre: 'Taco de guisado', precio: 25, cat: `TACOS ${XSS}`, catId: 2 },
  cafe: { id: 3, nombre: 'Café', precio: 40, cat: 'BEBIDAS', catId: 3 },
  combo: { id: 4, nombre: 'Combito', precio: 120, cat: 'Combitos', catId: 4 },
  pan: { id: 5, nombre: 'Pan', precio: 10, cat: 'NONNA MAYE', catId: 5 },
};
const MODALIDAD = { domicilio: 'a domicilio', recoger: 'recoger en tienda' };
function sucursal(pre, porDia) {
  const filas = [], lineas = new Map();
  let i = 0;
  for (let d = 0; d <= 56; d++) {
    const fecha = sumarDias(HOY, -d);
    for (const g of porDia(d)) {
      for (let k = 0; k < g.n; k++, i++) {
        const folio = `${pre}-${i + 1}`;
        const total = g.items.reduce((s, [p, n]) => s + PRODS[p].precio * n, 0);
        const [y, m, dd] = fecha.split('-').map(Number);
        const creado_at = instanteLocal(y, m, dd, 10, k % 50, 0, TZ).toISOString();
        const items = g.items.map(([p, n]) => ({ producto_id: PRODS[p].id, nombre: PRODS[p].nombre, cantidad: n, precio_unitario: PRODS[p].precio }));
        filas.push({ folio, estado: 'entregado', creado_at, registro: 'vigente',
          datos: { canal: 'pos', modalidad: MODALIDAD[g.modalidad || 'recoger'], forma_pago: 'efectivo', subtotal: total, total, items } });
        lineas.set(folio, items.map((x) => ({ ...x, tipo: 'platillo', modificadores: [] })));
      }
    }
  }
  const catalogo = Object.values(PRODS).map((p) => ({ id: p.id, nombre: p.nombre, tipo: 'platillo', disponible: true,
    categoria_id: p.catId, categoria: p.cat, categoria_activa: true }));
  return { filas, lineas, catalogo };
}
const UNO = (d) => {
  if (d === 0) return [{ n: 2, items: [['chil', 1]] }];
  const reciente = d <= 28;
  return [
    { n: reciente ? 4 : 6, items: [['chil', 1], ['cafe', 1]] },
    { n: 1, items: [['chil', 1], ['taco', 3]] },
    { n: 4, modalidad: 'domicilio', items: [['combo', 1]] },
    ...(reciente && d % 7 === 0 ? [{ n: 1, items: [['chil', 1], ['pan', 1]] }] : []),
  ];
};
const SUC = {
  a: { id: '11111111-1111-4111-8111-111111111111', nombre: 'Sucursal Uno', ...sucursal('CA', UNO) },
  b: { id: '22222222-2222-4222-8222-222222222222', nombre: 'Sucursal Dos', ...sucursal('CB', (d) => (d && d <= 28 ? [{ n: 1, items: [['chil', 1]] }] : [])) },
};

let CONSEJERO_V2 = true;
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
const fuentesDe = (sucs, actual, anterior) => sucs.map((s) => ({ negocio: { id: s.id, nombre: s.nombre }, tz: TZ, catalogo: s.catalogo,
  actual: { ventas: delRango(s.filas, actual), lineas: s.lineas }, anterior: anterior ? { ventas: delRango(s.filas, anterior), lineas: s.lineas } : null }));
// Lo mismo que /api/reportes/consejero (reporteProductosRutas.js), sin base.
function consejero(query) {
  const p = params(query);
  const e = elegidas(p);
  if (!e) return [403, { error: 'No tienes acceso a esa sucursal', code: 'SUCURSAL_NO_PERMITIDA' }];
  const cab = { timezone: TZ, hoy: HOY, sucursal: e.modo, sucursales: listaSucursales(), elegidas: e.sucs.map((s) => s.id) };
  if (!CONSEJERO_V2) return [200, { ...cab, ...consejosDeReporte(construirReporteProductos({ fuentes: fuentesDe(e.sucs, V, null) }), { ventana: V }) }];
  let pedido = null;
  if ([p.periodo, p.desde, p.hasta].some((x) => typeof x === 'string' && x.trim())) {
    const r = rangoDeReporte(p, HOY);
    if (r.error) return [400, { error: r.error }];
    pedido = r;
  }
  const periodo = periodoDelConsejero(pedido, HOY);
  const ant = periodoAnterior(periodo.desde, periodo.hasta);
  const reporte = { ...construirReporteProductos({ fuentes: fuentesDe(e.sucs, periodo, ant), conTickets: true }),
    periodo_anterior: { desde: ant.desde, hasta: ant.hasta, corte: null } };
  return [200, { ...cab, ...consejosV2(reporte, { periodo, hoy: HOY }) }];
}
function responder(url, query) {
  const p = params(query);
  if (url === '/api/reportes/ventas') {
    const rango = rangoDeReporte(p, HOY);
    if (rango.error) return [400, { error: rango.error }];
    return [200, armarReporteVentas({ filas: delRango(SUC.a.filas, rango), filasAnteriores: [], ...rango, tz: TZ, hoy: HOY, pagina: Number(p.pagina || 1), todas: p.todas === '1' })];
  }
  if (url === '/api/reportes/productos/estado') return [200, { activo: true, sucursales: listaSucursales(), consejero: true, consejero_v2: CONSEJERO_V2 }];
  if (url === '/api/reportes/consejero') return consejero(query);
  if (url === '/api/reportes/ventas/detalle') {
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
const pedidas = () => PETICIONES.filter((x) => x.url === '/api/reportes/consejero').map((x) => x.query);
const esperado = (query) => consejero(query)[1];
const igual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const navegador = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const erroresPagina = [];
async function abrirPanel(ancho = 1400) {
  const page = await navegador.newPage();
  await page.setViewport({ width: ancho, height: 900 });
  page.on('pageerror', (e) => erroresPagina.push(e.message));
  page.on('dialog', (d) => d.accept().catch(() => {}));
  await page.goto(`http://localhost:${puerto}/app#reportes`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => typeof cargarVentas === 'function' && window.XaborReportes && window.XaborConsejero);
  return page;
}
const recuadro = (page) => page.evaluate(() => {
  const el = document.getElementById('ventas-consejero');
  const txt = (sel) => el.querySelector(sel)?.textContent.replace(/\s+/g, ' ').trim() ?? null;
  return {
    visible: !el.hidden && el.getBoundingClientRect().height > 0,
    periodo: txt('[data-periodo]'), ventana: txt('[data-ventana]'), contra: txt('[data-contra]'), corto: txt('[data-periodo-corto]'),
    sucursales: txt('[data-sucursales]'), aviso: txt('[data-aviso]'),
    consejos: [...el.querySelectorAll('[data-consejo]')].map((x) => ({
      tipo: x.dataset.consejo, titulo: x.querySelector('.rc-tit').textContent.replace(/ /g, ' ').trim(), texto: x.querySelector('p').textContent.replace(/ /g, ' ').trim(),
      // El texto tal cual: un «%» separado de su número por un espacio normal se puede ir solo al otro renglón.
      sueltos: [x.querySelector('.rc-tit'), x.querySelector('p'), x.querySelector('[data-revisar]'), ...x.querySelectorAll('[data-cambio-de] .rc-sube, [data-cambio-de] .rc-baja')]
        .filter(Boolean).map((n) => n.textContent).filter((s) => /\d %/.test(s)),
      conPct: /\d[  ]%/.test(x.querySelector('p').textContent),
      accion: x.querySelector('[data-accion]')?.textContent.trim(), revisar: x.querySelector('[data-revisar]')?.textContent.replace(/\s+/g, ' ').trim(),
      chips: [...x.querySelectorAll('[data-cambio-de]')].map((c) => ({
        de: c.dataset.cambioDe, texto: c.textContent.replace(/\s+/g, ' ').trim(), clase: c.querySelector('.rc-sube, .rc-baja')?.className || '' })),
    })),
    filas: [...el.querySelectorAll('tr[data-arrastre]')].map((tr) => ({ clave: tr.dataset.arrastre, celdas: [...tr.children].map((td) => td.textContent.replace(/\s+/g, ' ').trim()) })),
    notas: [...el.querySelectorAll('[data-nota]')].map((n) => n.textContent.trim()),
  };
});
const esperarConsejos = (page) => page.waitForFunction(() => document.querySelector('#ventas-consejero [data-consejo]'), { timeout: 5000 });
const pct = (n) => `${Number(n || 0).toLocaleString('es-MX', { maximumFractionDigits: 1 })} %`;
const signo = (p) => { if (p === null || p === undefined) return 'sin dato'; const x = Math.round(Number(p) * 10) / 10; return `${x > 0 ? '+' : x < 0 ? '−' : ''}${pct(Math.abs(x))}`; };
// Lo que debe decir cada tarjeta, armado desde la respuesta del servidor.
const comoPantalla = (cs) => cs.map((c) => ({
  tipo: c.tipo, titulo: c.titulo, texto: c.texto, accion: `👉 ${c.accion}`,
  revisar: `📅 Revisa el ${c.revisar.etiqueta}: ${c.revisar.numero}. Hoy: ${c.revisar.valor}; ${c.revisar.meta}.`,
}));
const sinChips = (cs) => cs.map(({ chips, sueltos, conPct, ...resto }) => resto);
async function capturar(page, nombre) {
  if (!process.env.CAPTURA) return;
  const el = await page.$('#ventas-consejero');
  if (el) await el.screenshot({ path: join(process.env.CAPTURA, nombre) });
}

try {
  await t('V1. sin consejero_v2 en el estado: pide sin periodo y pinta la versión 1', async () => {
    CONSEJERO_V2 = false;
    PETICIONES.length = 0;
    const page = await abrirPanel();
    await esperarConsejos(page);
    const r = await recuadro(page);
    assert(igual(pedidas(), ['sucursal=actual']), `peticiones: ${JSON.stringify(pedidas())}`);
    assert(r.ventana === `Últimos 28 días: ${V.etiqueta}` && r.periodo === null, JSON.stringify([r.ventana, r.periodo]));
    await page.close();
    CONSEJERO_V2 = true;
  });

  PETICIONES.length = 0;
  const page = await abrirPanel();
  await esperarConsejos(page);
  const qHoy = `sucursal=actual&desde=${HOY}&hasta=${HOY}`;

  await t('V2. con consejero_v2: manda el periodo de arriba (Hoy) y avisa que usó los últimos 28 días', async () => {
    assert(igual(pedidas(), [qHoy]), `peticiones: ${JSON.stringify(pedidas())}`);
    const s = esperado(qHoy);
    const r = await recuadro(page);
    assert(s.version === 2 && s.periodo.motivo === 'corto', `el servidor: ${JSON.stringify(s.periodo)}`);
    assert(r.visible && r.periodo === `Últimos 28 días: ${s.periodo.etiqueta}`, `etiqueta: «${r.periodo}»`);
    assert(r.contra === `Comparado con ${s.anterior.etiqueta}`, `«${r.contra}»`);
    assert(r.corto === 'El periodo de arriba tiene menos de 14 días: aquí uso los últimos 28, sin contar hoy.', `aviso: «${r.corto}»`);
    assert(igual(r.notas, s.notas) && r.notas.length === 3, JSON.stringify(r.notas));
    // La etiqueta va junto al título, en el mismo renglón.
    const junto = await page.evaluate(() => {
      const t = document.querySelector('#ventas-consejero .rp-titulo');
      return !!t && t.contains(document.querySelector('#ventas-consejero [data-periodo]'));
    });
    assert(junto, 'la etiqueta del periodo no está junto al título');
  });

  await t('V3. cada tarjeta: igual al servidor, con qué cambió (▲/▼), la acción y qué revisar', async () => {
    const s = esperado(qHoy);
    const r = await recuadro(page);
    assert(s.estado === 'ok' && s.consejos.length >= 2, `el servidor dio ${s.consejos.length} tarjetas: la prueba no prueba nada`);
    assert(s.consejos.some((c) => c.tipo === 'canal'), `falta la tarjeta de Canal: ${s.consejos.map((c) => c.tipo)}`);
    assert(igual(sinChips(r.consejos), comoPantalla(s.consejos)), `pantalla ${JSON.stringify(sinChips(r.consejos))} ≠ servidor ${JSON.stringify(comoPantalla(s.consejos))}`);
    assert(r.consejos.some((c) => c.conPct), 'ninguna tarjeta trae un «%»: la prueba del renglón no prueba nada');
    const sueltos = r.consejos.flatMap((c) => c.sueltos);
    assert(sueltos.length === 0, `un «%» puede quedar solo en el otro renglón: ${JSON.stringify(sueltos.slice(0, 3))}`);
    r.consejos.forEach((c, i) => {
      const cm = s.consejos[i].cambio;
      assert(igual(c.chips.map((x) => x.de), ['venta', 'tickets', 'promedio']), `${c.titulo}: chips ${JSON.stringify(c.chips)}`);
      for (const x of c.chips) {
        const v = cm[x.de];
        const flecha = v.pct > 0 ? '▲ ' : v.pct < 0 ? '▼ ' : '';
        assert(x.texto.startsWith(`${v.etiqueta}: ${flecha}${signo(v.pct)} (`), `${c.titulo}/${x.de}: «${x.texto}»`);
        assert(x.clase === (v.pct > 0 ? 'rc-sube' : v.pct < 0 ? 'rc-baja' : ''), `${c.titulo}/${x.de}: clase «${x.clase}»`);
      }
    });
    await capturar(page, 'consejero-v2-escritorio.png');
  });

  await t('V4. la tabla: el lift, «Otras» y el HTML de un nombre como texto', async () => {
    await page.click('#ventas-consejero details[data-tabla-arrastre] summary');
    await esperar(150);
    const s = esperado(qHoy);
    const r = await recuadro(page);
    assert(s.otras && s.tabla.some((f) => f.junto.length) && s.tabla.some((f) => !f.junto.length), 'los datos no traen lift, celdas vacías u «Otras»');
    assert(igual(r.filas.map((f) => f.clave), [...s.tabla.map((f) => f.clave), 'otras']), JSON.stringify(r.filas.map((f) => f.clave)));
    for (const f of s.tabla) {
      const celdas = r.filas.find((x) => x.clave === f.clave).celdas;
      const junto = f.junto.map((x) => `${x.nombre} ×${Number(x.lift).toLocaleString('es-MX', { maximumFractionDigits: 1 })}`).join(', ');
      assert(celdas[0] === f.nombre && celdas[1] === pct(f.pct_venta) && celdas[6] === junto, `${f.nombre}: ${JSON.stringify(celdas)} (junto «${junto}»)`);
      assert(celdas[2] === (f.cambio_venta_pct === null ? '—' : signo(f.cambio_venta_pct)), `${f.nombre}: cambio «${celdas[2]}»`);
    }
    const otras = r.filas.find((x) => x.clave === 'otras').celdas;
    assert(otras[0] === 'Otras Nonna Maye' && otras[1] === pct(s.otras.pct_venta), JSON.stringify(otras));
    const nombres = r.filas.map((f) => f.celdas[0]);
    assert(nombres.includes('Chilaquiles') && nombres.includes('Bebidas') && nombres.includes(`TACOS ${XSS}`), `nombres: ${JSON.stringify(nombres)}`);
    const xss = await page.evaluate(() => window.__xss === 1 || !!document.querySelector('#ventas-consejero img'));
    assert(!xss, 'se ejecutó o se insertó el HTML de un nombre');
    const enc = await page.evaluate(() => [...document.querySelectorAll('#ventas-consejero .rc-tabla2 th')].map((th) => th.textContent.trim()));
    assert(igual(enc, ['Categoría', '% de la venta', 'Cambio de su venta', 'Tickets que la llevan', 'Dinero de esos tickets', 'Va sola', 'Se acompaña con (más de lo normal)']), JSON.stringify(enc));
  });

  await t('V5. en la computadora la tabla cabe y no muestra el aviso de deslizar', async () => {
    const m = await page.evaluate(() => {
      const env = document.querySelector('#ventas-consejero .rc-tabla-env');
      return { cabe: env.scrollWidth <= env.clientWidth + 1, aviso: !document.querySelector('#ventas-consejero [data-desliza]').hidden };
    });
    assert(m.cabe && !m.aviso, JSON.stringify(m));
  });

  await t('V6. un periodo de 14 días o más: lo vuelve a pedir y lo usa', async () => {
    const desde = sumarDias(HOY, -20);
    const antes = pedidas().length;
    await page.evaluate((d, h) => { document.getElementById('fecha-desde').value = d; document.getElementById('fecha-hasta').value = h; setPeriodoCustom(); }, desde, HOY);
    const q = `sucursal=actual&desde=${desde}&hasta=${HOY}`;
    await page.waitForFunction((p) => /^Periodo: /.test(document.querySelector('#ventas-consejero [data-periodo]')?.textContent || ''), { timeout: 5000 }, q);
    assert(pedidas().length === antes + 1 && pedidas().at(-1) === q, `peticiones: ${JSON.stringify(pedidas().slice(antes))}`);
    const s = esperado(q);
    const r = await recuadro(page);
    assert(s.periodo.origen === 'periodo' && r.periodo === `Periodo: ${s.periodo.etiqueta}` && r.corto === null, JSON.stringify([r.periodo, r.corto]));
    assert(igual(sinChips(r.consejos), comoPantalla(s.consejos)), 'las tarjetas no son las del periodo nuevo');
  });

  await t('V7. la sucursal: «Todas» lo pide con el mismo periodo y dice cuáles junta', async () => {
    const desde = sumarDias(HOY, -20);
    await page.waitForFunction(() => /Formas de pago/.test(document.getElementById('ventas-detalle')?.innerText || ''), { timeout: 5000 });
    await page.select('#ventas-detalle [data-sucursal-ventas]', 'todas');
    await page.waitForFunction(() => /Sucursal Dos/.test(document.querySelector('#ventas-consejero [data-sucursales]')?.textContent || ''), { timeout: 5000 });
    const q = `sucursal=todas&desde=${desde}&hasta=${HOY}`;
    assert(pedidas().at(-1) === q, `última: ${pedidas().at(-1)}`);
    const r = await recuadro(page);
    assert(r.sucursales === 'Sucursal Uno + Sucursal Dos', `«${r.sucursales}»`);
    assert(igual(sinChips(r.consejos), comoPantalla(esperado(q).consejos)), 'las tarjetas no son las de las dos');
    await page.select('#ventas-detalle [data-sucursal-ventas]', 'actual');
    await esperar(400);
  });
  await page.close();

  await t('V8. en el celular: la tabla se desliza, lo dice y la página no se desborda', async () => {
    const cel = await abrirPanel(375);
    await esperarConsejos(cel);
    await cel.click('#ventas-consejero details[data-tabla-arrastre] summary');
    await esperar(200);
    const m = await cel.evaluate(() => {
      const caja = document.getElementById('ventas-consejero');
      const env = caja.querySelector('.rc-tabla-env');
      return {
        pagina: document.documentElement.scrollWidth, vista: window.innerWidth, caja: Math.round(caja.getBoundingClientRect().right),
        desliza: env.scrollWidth > env.clientWidth, overflow: getComputedStyle(env).overflowX,
        aviso: !caja.querySelector('[data-desliza]').hidden, barra: getComputedStyle(env).scrollbarWidth,
        tarjetas: [...caja.querySelectorAll('[data-consejo]')].filter((x) => x.scrollWidth > x.clientWidth + 1).length,
      };
    });
    assert(m.pagina <= m.vista && m.caja <= m.vista && !m.tarjetas, `desborda: ${JSON.stringify(m)}`);
    assert(m.desliza && m.overflow === 'auto' && m.aviso, `la tabla no se desliza o no lo dice: ${JSON.stringify(m)}`);
    assert(m.barra === 'thin', `la barra no se ve: ${m.barra}`);
    await capturar(cel, 'consejero-v2-celular.png');
    await cel.close();
  });

  // 26-nov-2026: las tarjetas se rehicieron (fase-reportes-ventas-visual-panel
  // las prueba a fondo). Aquí queda lo que toca al consejero: el total cabe y es
  // el número más grande, y sin la rejilla nueva (7 columnas) se cortaría.
  await t('V9. el total de Ventas («$888,888.88») cabe en su tarjeta en cualquier ancho y es el número más grande; con 7 columnas no cabría', async () => {
    const p = await abrirPanel(1400);
    const medir = () => p.evaluate(() => {
      const caja = document.querySelector('[data-tarjetas-ventas]');
      const vals = [...caja.querySelectorAll('.pos-card-value')];
      for (const v of vals) v.textContent = '$888,888.88';
      const g = caja.getBoundingClientRect();
      const total = document.getElementById('pos-total-val');
      return {
        desbordan: vals.filter((v) => v.scrollWidth > v.clientWidth + 1 || v.closest('.pos-card').getBoundingClientRect().right > g.right + 1).length,
        rejilla: caja.scrollWidth > caja.clientWidth + 1,
        total: parseFloat(getComputedStyle(total).fontSize),
        otras: Math.max(...vals.filter((v) => v !== total).map((v) => parseFloat(getComputedStyle(v).fontSize))),
      };
    });
    const sinArreglo = [];
    for (const ancho of [1024, 1280, 1366, 1440, 1920, 768, 375]) {
      await p.setViewport({ width: ancho, height: 900 });
      await esperar(150);
      const m = await medir();
      assert(!m.desbordan && !m.rejilla, `a ${ancho}px se corta: ${JSON.stringify(m)}`);
      assert(m.total >= 24 && m.total > m.otras, `a ${ancho}px el total mide ${m.total}px y los demás ${m.otras}px`);
      // Testigo: con las 7 columnas de antes, ¿se cortaría?
      await p.evaluate(() => {
        const s = document.createElement('style'); s.id = 'sin-arreglo';
        s.textContent = '.vk { grid-template-columns: repeat(7, minmax(0, 1fr)) !important; } .vk-hero, .vk-canales { grid-column: auto !important; }';
        document.head.appendChild(s);
      });
      const antes = await medir();
      if (antes.desbordan || antes.rejilla) sinArreglo.push(ancho);
      await p.evaluate(() => document.getElementById('sin-arreglo').remove());
    }
    assert(sinArreglo.length, 'con 7 columnas tampoco se corta: la prueba no prueba nada');
    console.log(`        (con 7 columnas se cortaría a ${sinArreglo.join(', ')} px)`);
    await p.close();
  });

  await t('V10. la huella ?v= de index.html es la de cada archivo (la caché no sirve uno viejo)', async () => {
    const html = readFileSync(join(PANEL_DIR, 'index.html'), 'utf8');
    for (const archivo of ['reportes-productos.js', 'reportes-consejero.js']) {
      const h = createHash('sha256').update(readFileSync(join(PANEL_DIR, archivo))).digest('hex').slice(0, 8);
      assert(html.includes(`<script src="/${archivo}?v=${h}"></script>`), `index.html no trae ${archivo}?v=${h}`);
    }
  });

  await t('V11. sin errores de JavaScript en toda la corrida', async () => {
    assert(!erroresPagina.length, erroresPagina.join(' | '));
  });
} finally {
  await navegador.close().catch(() => {});
  server.close();
}

console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallidas) { console.log('Fallos:\n  · ' + fallos.join('\n  · ')); process.exit(1); }
process.exit(0);
