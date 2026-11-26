// Reportes › Ventas se ve bien (Fase A, 26-nov-2026). Pedido del dueño con
// captura: el total se cortaba en su tarjeta, las 7 tarjetas iban apretadas,
// en «quién vendió» los nombres se partían letra por letra y la última
// columna se salía de la caja.
//
//   · Tarjetas: el total va grande en su tarjeta (con los envíos que incluye)
//     y las demás bajan en 2, 4 o 6 columnas según el ancho de la caja. En
//     ningún ancho se corta un número ni la página se desplaza de lado; el
//     total mide al menos 24 px y es el número más grande. Con 7 columnas
//     (como antes) se cortaría: testigo.
//   · Los conteos llevan separador de miles, como las tablas («12,345»).
//   · Quién vendió: un nombre TODO EN MAYÚSCULAS sale en tipo título; uno con
//     minúsculas, igual; el HTML de un nombre sale como texto. «Cuentas que
//     cerró» y su monto en columnas aparte. Ningún nombre se parte a media
//     palabra, en ningún ancho (testigo: con las reglas de antes, sí).
//   · Las dos tablas lado a lado solo si caben; en el celular la de usuarios
//     se desliza dentro de su caja y lo dice.
//   · La huella ?v= y cero errores de JavaScript.
//   · Sin «Lo que te diría un consejero» (se quitó el 26-nov-2026), aunque el
//     servidor mande sus banderas.
// Los importes y nombres son inventados: el repo es público.
//
// Uso: node test/fase-reportes-ventas-visual-panel.mjs
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import puppeteer from 'puppeteer';

const { armarReporteVentas, rangoDeReporte } = await import('../src/services/reporteVentas.js');
const { detalleDeSucursal } = await import('../src/services/reporteVentasDetalle.js');
const { instanteLocal } = await import('../src/services/cortesCaja.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const PANEL_DIR = join(__dirname, '..', 'panel');
const TZ = 'America/Matamoros';
const HOY = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const XSS = 'LUIS <IMG SRC=X ONERROR="WINDOW.__XSS=1">';

// ─── Datos inventados ──────────────────────────────────────────────────────
const SUC = {
  a: { id: '11111111-1111-4111-8111-111111111111', nombre: 'Sucursal Uno' },
  b: { id: '22222222-2222-4222-8222-222222222222', nombre: 'Sucursal Dos' },
};
const MESEROS = [
  { cuenta: 'c1', mesero: 'JUAN DE LA CRUZ PÉREZ', n: 6, cerro: 'MARÍA GUADALUPE HERNÁNDEZ DE LA GARZA' },
  { cuenta: 'c2', mesero: 'Mesera Uno', n: 4, cerro: 'MARÍA GUADALUPE HERNÁNDEZ DE LA GARZA' },
  { cuenta: 'c3', mesero: "ANA-SOFÍA O'BRIEN", n: 3, cerro: null },
  { cuenta: 'c4', mesero: XSS, n: 2, cerro: null },
];
const [Y, M, D] = HOY.split('-').map(Number);
const filas = [];
let i = 0;
const fila = (datos) => {
  i++;
  filas.push({ folio: `VV-${i}`, estado: 'entregado', registro: 'vigente', creado_at: instanteLocal(Y, M, D, 9, i % 50, 0, TZ).toISOString(), datos });
};
for (const m of MESEROS) for (let k = 0; k < m.n; k++) fila({ modalidad: 'mesa', cuenta_id: m.cuenta, forma_pago: 'tarjeta', subtotal: 450, total: 450, items: [{ nombre: 'Platillo', cantidad: 1, precio_unitario: 450 }] });
for (let k = 0; k < 5; k++) fila({ canal: 'pos', modalidad: 'recoger en tienda', forma_pago: 'efectivo', subtotal: 180, total: 180, items: [{ nombre: 'Platillo', cantidad: 1, precio_unitario: 180 }] });
for (let k = 0; k < 4; k++) fila({ canal: 'pos', modalidad: 'a domicilio', forma_pago: 'efectivo', subtotal: 220, total: 240, costo_envio: 20, items: [{ nombre: 'Platillo', cantidad: 1, precio_unitario: 220 }] });
const CUENTAS = new Map(MESEROS.map((m, j) => [m.cuenta, { mesero_id: `m${j}`, mesero: m.mesero, cerro_id: m.cerro ? 'cerro1' : null, cerro: m.cerro }]));

// Con GRANDES encendido la tarjeta recibe cifras de siete dígitos.
let GRANDES = false;
let pidioConsejero = 0;
const RESUMEN_GRANDE = { total_ventas: 8888888.88, num_pedidos: 12345, promedio: 9999.99, domicilios: 1234, recoger: 5678, restaurante: 5433, total_envios: 123456.78 };
const params = (query) => Object.fromEntries(new URLSearchParams(query));
const listaSucursales = () => [{ ...SUC.a, actual: true }, { ...SUC.b, actual: false }];
function responder(url, query) {
  const p = params(query);
  if (url === '/api/reportes/ventas') {
    const rango = rangoDeReporte(p, HOY);
    if (rango.error) return [400, { error: rango.error }];
    const r = armarReporteVentas({ filas, filasAnteriores: [], ...rango, tz: TZ, hoy: HOY, pagina: 1 });
    return [200, GRANDES ? { ...r, resumen: { ...r.resumen, ...RESUMEN_GRANDE } } : r];
  }
  if (url === '/api/reportes/ventas/detalle') {
    const rango = rangoDeReporte(p, HOY);
    return [200, { timezone: TZ, hoy: HOY, sucursal: 'actual', sucursales: listaSucursales(), rango,
      detalles: [detalleDeSucursal({ id: SUC.a.id, nombre: SUC.a.nombre }, filas, { cuentas: CUENTAS })] }];
  }
  // Las banderas del consejero, como las manda el servidor de antes del
  // 26-nov-2026: el panel ya no las lee (VV9).
  if (url === '/api/reportes/productos/estado') return [200, { activo: true, sucursales: listaSucursales(), consejero: true, consejero_v2: true }];
  if (url === '/api/reportes/consejero') {
    pidioConsejero++;
    return [200, { timezone: TZ, hoy: HOY, sucursal: 'actual', sucursales: listaSucursales(), elegidas: [SUC.a.id],
      ventana: { desde: HOY, hasta: HOY, etiqueta: 'Hoy' }, tarjetas: [{ tipo: 'motor', titulo: 'Tu motor: Platillo', texto: 'Prueba' }], tabla: [] }];
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

const navegador = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const erroresPagina = [];
// Las pantallas: celulares, tableta, la computadora del dueño (≈1152 px con
// Windows al 125 %, y la misma a 842) y escritorios.
const PANTALLAS = [
  { ancho: 375, escala: 2 }, { ancho: 390, escala: 2 }, { ancho: 768, escala: 1 }, { ancho: 842, escala: 1.25 },
  { ancho: 1024, escala: 1 }, { ancho: 1152, escala: 1.25 }, { ancho: 1280, escala: 1 }, { ancho: 1366, escala: 1 }, { ancho: 1440, escala: 1 },
  { ancho: 1600, escala: 1 }, { ancho: 1920, escala: 1 },
];
async function abrirPanel(ancho = 1440, escala = 1) {
  const page = await navegador.newPage();
  await page.setViewport({ width: ancho, height: 900, deviceScaleFactor: escala });
  page.on('pageerror', (e) => erroresPagina.push(e.message));
  page.on('dialog', (d) => d.accept().catch(() => {}));
  await page.goto(`http://localhost:${puerto}/app#reportes`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => typeof cargarVentas === 'function' && window.XaborReportes);
  await page.waitForFunction(() => /Formas de pago/.test(document.getElementById('ventas-detalle')?.innerText || ''), { timeout: 8000 });
  return page;
}
async function recargarVentas(page) {
  await page.evaluate(() => setPeriodo('hoy'));
  await page.waitForFunction(() => document.getElementById('pos-total-val').textContent !== '$0', { timeout: 8000 });
  await esperar(150);
}
const medirTarjetas = (page) => page.evaluate(() => {
  const caja = document.querySelector('[data-tarjetas-ventas]');
  const g = caja.getBoundingClientRect();
  const valores = [...caja.querySelectorAll('.pos-card-value, .vk-canal-valor')];
  const total = document.getElementById('pos-total-val');
  return {
    pagina: document.documentElement.scrollWidth, vista: document.documentElement.clientWidth,
    caja: Math.round(caja.clientWidth),
    columnas: getComputedStyle(caja.querySelector('.vk')).gridTemplateColumns.split(' ').length,
    cortados: valores.filter((v) => v.scrollWidth > v.clientWidth + 1 || v.getBoundingClientRect().right > v.closest('.pos-card').getBoundingClientRect().right + 1
      || v.closest('.pos-card').getBoundingClientRect().right > g.right + 1).map((v) => `${v.id}=${v.textContent}`),
    total: parseFloat(getComputedStyle(total).fontSize),
    otras: Math.max(...valores.filter((v) => v !== total).map((v) => parseFloat(getComputedStyle(v).fontSize))),
  };
});
// Una palabra partida entre dos renglones tiene dos rectángulos.
const palabrasPartidas = (page) => page.evaluate(() => {
  const malas = [];
  for (const td of document.querySelectorAll('#ventas-detalle .rp-usuarios td.rp-nombre')) {
    const walker = document.createTreeWalker(td, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const re = /\S+/g;
      for (let m = re.exec(n.data); m; m = re.exec(n.data)) {
        const r = document.createRange();
        r.setStart(n, m.index); r.setEnd(n, m.index + m[0].length);
        const lineas = new Set([...r.getClientRects()].filter((x) => x.width > 0).map((x) => Math.round(x.top)));
        if (lineas.size > 1) malas.push(m[0]);
      }
    }
  }
  return malas;
});

try {
  await t('VV1. tarjetas: en ningún ancho se corta un número ni la página se desplaza de lado; 2, 4 o 6 columnas según la caja; el total es el número más grande (≥ 24 px)', async () => {
    GRANDES = true;
    const p = await abrirPanel(1440);
    await recargarVentas(p);
    const vistos = [];
    const revisar = async (cuales) => {
      for (const s of PANTALLAS) {
        await p.setViewport({ width: s.ancho, height: 900, deviceScaleFactor: s.escala });
        await esperar(200);
        const m = await medirTarjetas(p);
        const esperadas = m.caja < 760 ? 2 : m.caja < 1200 ? 4 : 6;
        assert(!m.cortados.length, `${cuales}: a ${s.ancho}px (caja de ${m.caja}px, ${m.columnas} columnas) se cortan: ${m.cortados.join(', ')}`);
        assert(m.pagina <= m.vista, `${cuales}: a ${s.ancho}px la página se desplaza de lado (${m.pagina} > ${m.vista})`);
        assert(m.columnas === esperadas, `${cuales}: a ${s.ancho}px (caja de ${m.caja}px) hay ${m.columnas} columnas, no ${esperadas}`);
        assert(m.total >= 24 && m.total > m.otras, `${cuales}: a ${s.ancho}px el total mide ${m.total}px y el mayor de los demás ${m.otras}px`);
        if (cuales === 'del servidor') vistos.push(`${s.ancho}:${m.caja}/${m.columnas}`);
      }
    };
    await revisar('del servidor');
    // El peor caso: seis cifras con centavos en cada tarjeta y en cada canal.
    await p.evaluate(() => {
      for (const id of ['pos-pedidos', 'pos-promedio']) document.getElementById(id).textContent = '$888,888.88';
      for (const id of ['pos-domicilios', 'pos-recoger', 'pos-restaurante']) document.getElementById(id).textContent = '888,888';
    });
    await revisar('cifras de seis dígitos');
    // Testigo: con 7 columnas, como antes, las mismas cifras se cortan.
    await p.evaluate(() => {
      const st = document.createElement('style'); st.id = 'siete';
      st.textContent = '.vk { grid-template-columns: repeat(7, minmax(0, 1fr)) !important; } .vk-hero, .vk-canales { grid-column: auto !important; } .vk-canales-fila { grid-template-columns: 1fr !important; }';
      document.head.appendChild(st);
    });
    const con7 = [];
    for (const ancho of [1024, 1280, 1440]) {
      await p.setViewport({ width: ancho, height: 900 });
      await esperar(150);
      if ((await medirTarjetas(p)).cortados.length) con7.push(ancho);
    }
    assert(con7.length, 'con 7 columnas tampoco se corta: la prueba no prueba nada');
    console.log(`        (pantalla:caja/columnas ${vistos.join(' ')}; con 7 columnas se cortaría a ${con7.join(', ')} px)`);
    await p.close();
    GRANDES = false;
  });

  await t('VV2. los conteos llevan separador de miles; los envíos van dentro del total; etiquetas sin emojis', async () => {
    GRANDES = true;
    const p = await abrirPanel(1440);
    await recargarVentas(p);
    const v = await p.evaluate(() => ({
      total: document.getElementById('pos-total-val').textContent,
      pedidos: document.getElementById('pos-pedidos').textContent,
      promedio: document.getElementById('pos-promedio').textContent,
      domicilios: document.getElementById('pos-domicilios').textContent,
      recoger: document.getElementById('pos-recoger').textContent,
      restaurante: document.getElementById('pos-restaurante').textContent,
      hero: document.querySelector('.vk-hero').innerText.replace(/\s+/g, ' ').trim(),
      etiquetas: [...document.querySelectorAll('[data-tarjetas-ventas] .pos-card-label, [data-tarjetas-ventas] .vk-canal-label')].map((x) => x.textContent.trim()),
    }));
    assert(v.total === '$8,888,888.88' && v.promedio === '$9,999.99', `montos: ${v.total} / ${v.promedio}`);
    assert(v.pedidos === '12,345' && v.domicilios === '1,234' && v.recoger === '5,678' && v.restaurante === '5,433', `conteos: ${JSON.stringify(v)}`);
    assert(v.hero === 'Total ventas $8,888,888.88 Incluye $123,456.78 de envíos cobrados', `tarjeta del total: «${v.hero}»`);
    assert(JSON.stringify(v.etiquetas) === JSON.stringify(['Total ventas', 'Pedidos', 'Ticket promedio', 'Pedidos por canal', 'A domicilio', 'Para recoger', 'Restaurante']), `etiquetas: ${v.etiquetas}`);
    assert(!v.etiquetas.some((x) => /\p{Extended_Pictographic}/u.test(x)), 'una etiqueta trae emoji');
    await p.close();
    GRANDES = false;
  });

  await t('VV3. quién vendió: MAYÚSCULAS en tipo título, minúsculas igual, el HTML como texto; cuentas y monto en columnas aparte; la nota de «Sin registrar» debajo', async () => {
    const p = await abrirPanel(1440);
    const srv = detalleDeSucursal({ id: SUC.a.id, nombre: SUC.a.nombre }, filas, { cuentas: CUENTAS }).por_usuario;
    const r = await p.evaluate(() => {
      const tabla = document.querySelector('#ventas-detalle .rp-usuarios');
      return {
        cab: [...tabla.querySelectorAll('thead th')].map((x) => x.textContent.trim()),
        filas: [...tabla.querySelectorAll('tbody tr')].map((tr) => [...tr.children].map((td) => td.textContent.trim())),
        nota: tabla.closest('.rp-tabla-env').nextElementSibling?.textContent.trim(),
        xss: window.__xss === 1, imgs: document.querySelectorAll('#ventas-detalle img').length,
      };
    });
    assert(JSON.stringify(r.cab) === JSON.stringify(['Usuario', 'Mesas atendidas', 'Venta', '%', 'Cuentas que cerró', 'Monto de esas cuentas']), `encabezados: ${r.cab}`);
    const nombres = r.filas.map((f) => f[0]);
    for (const n of ['Juan de la Cruz Pérez', 'Mesera Uno', "Ana-Sofía O'Brien", 'María Guadalupe Hernández de la Garza', 'Luis <img Src=x Onerror="window.__xss=1">']) {
      assert(nombres.includes(n), `falta «${n}» en ${JSON.stringify(nombres)}`);
    }
    assert(!r.xss && !r.imgs, 'el HTML de un nombre se ejecutó');
    const pesos = (n) => `$${Number(n).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    for (const u of srv.usuarios) {
      const f = r.filas.find((x) => x[0].toLowerCase() === u.nombre.toLowerCase());
      assert(f, `no está ${u.nombre}`);
      assert(f[4] === String(u.cerradas.tickets) && f[5] === pesos(u.cerradas.venta), `${u.nombre}: cerró ${f[4]} / ${f[5]}, el servidor ${u.cerradas.tickets} / ${u.cerradas.venta}`);
    }
    const sin = r.filas[r.filas.length - 1];
    assert(sin[0] === 'Sin registrar' && sin[1] === String(srv.sin_registrar.tickets), `renglón Sin registrar: ${sin}`);
    assert(/^Sin registrar: el mostrador, WhatsApp, la tienda y Rappi aún no guardan quién vendió\.$/.test(r.nota || ''), `nota: «${r.nota}»`);
    await p.close();
  });

  await t('VV4. ningún nombre se parte a media palabra, en ningún ancho (con las reglas de antes, sí)', async () => {
    const p = await abrirPanel(1440);
    for (const s of PANTALLAS) {
      await p.setViewport({ width: s.ancho, height: 900, deviceScaleFactor: s.escala });
      await esperar(150);
      const malas = await palabrasPartidas(p);
      assert(!malas.length, `a ${s.ancho}px se parten: ${malas.join(', ')}`);
    }
    // Testigo: las dos tablas lado a lado y los nombres que se parten donde sea.
    await p.setViewport({ width: 1152, height: 900, deviceScaleFactor: 1.25 });
    await p.evaluate(() => {
      const st = document.createElement('style'); st.id = 'antes';
      st.textContent = '.rp-detalle-cols { grid-template-columns: minmax(0,1fr) minmax(0,1fr) !important; } .rp-usuarios td.rp-nombre { min-width: 0 !important; overflow-wrap: anywhere !important; } .rp-usuarios th { white-space: nowrap !important; }';
      document.head.appendChild(st);
    });
    await esperar(150);
    const antes = await palabrasPartidas(p);
    assert(antes.length, 'con las reglas de antes tampoco se parte ninguno: la prueba no prueba nada');
    console.log(`        (con las reglas de antes se partían: ${antes.slice(0, 4).join(', ')}…)`);
    await p.close();
  });

  await t('VV5. las dos tablas van lado a lado solo si caben; si no, una debajo de la otra', async () => {
    const p = await abrirPanel(1920);
    const medir = () => p.evaluate(() => {
      const cols = document.querySelector('#ventas-detalle .rp-detalle-cols');
      const [a, b] = cols.children;
      return { caja: Math.round(cols.closest('.rp-caja').clientWidth), lado: Math.abs(a.getBoundingClientRect().top - b.getBoundingClientRect().top) < 2,
        tablas: [...cols.querySelectorAll('.rp-tabla-env, .rp-formas')].filter((x) => x.scrollWidth > x.clientWidth + 1).length };
    });
    const a1920 = await medir();
    assert(a1920.lado && a1920.caja >= 1040, `a 1920px: ${JSON.stringify(a1920)}`);
    assert(!a1920.tablas, `a 1920px una tabla no cabe: ${JSON.stringify(a1920)}`);
    for (const s of [{ ancho: 1152, escala: 1.25 }, { ancho: 1024, escala: 1 }, { ancho: 390, escala: 2 }]) {
      await p.setViewport({ width: s.ancho, height: 900, deviceScaleFactor: s.escala });
      await esperar(150);
      const m = await medir();
      assert(!m.lado, `a ${s.ancho}px siguen lado a lado en una caja de ${m.caja}px`);
    }
    await p.close();
  });

  await t('VV6. en el celular la tabla de usuarios se desliza dentro de su caja y lo dice; en la computadora no hace falta', async () => {
    const p = await abrirPanel(390, 2);
    const medir = () => p.evaluate(() => {
      const env = document.querySelector('#ventas-detalle [data-env-usuarios]');
      return { pagina: document.documentElement.scrollWidth, vista: document.documentElement.clientWidth,
        desliza: env.scrollWidth > env.clientWidth + 1, overflow: getComputedStyle(env).overflowX,
        aviso: !document.querySelector('#ventas-detalle [data-desliza-usuarios]').hidden,
        caja: env.clientWidth, tabla: env.scrollWidth,
        columnas: [...env.querySelectorAll('thead th')].map((th) => `${th.textContent.trim()}=${Math.round(th.getBoundingClientRect().width)}`).join(' ') };
    });
    const cel = await medir();
    assert(cel.pagina <= cel.vista, `la página se desplaza de lado (${cel.pagina} > ${cel.vista})`);
    assert(cel.desliza && cel.overflow === 'auto' && cel.aviso, `celular: ${JSON.stringify(cel)}`);
    for (const s of [{ ancho: 1152, escala: 1.25 }, { ancho: 1280, escala: 1 }, { ancho: 1440, escala: 1 }, { ancho: 1920, escala: 1 }]) {
      await p.setViewport({ width: s.ancho, height: 900, deviceScaleFactor: s.escala });
      await esperar(200);
      const pc = await medir();
      assert(!pc.desliza && !pc.aviso, `computadora a ${s.ancho}px: ${JSON.stringify(pc)}`);
    }
    await p.close();
  });

  await t('VV7. la huella ?v= de index.html es la de cada archivo (la caché no sirve uno viejo)', async () => {
    const html = readFileSync(join(PANEL_DIR, 'index.html'), 'utf8');
    for (const archivo of ['reportes-productos.js']) {
      const h = createHash('sha256').update(readFileSync(join(PANEL_DIR, archivo))).digest('hex').slice(0, 8);
      assert(html.includes(`<script src="/${archivo}?v=${h}"></script>`), `index.html no trae ${archivo}?v=${h}`);
    }
  });

  // Fase 0 del asistente (26-nov-2026): «Lo que te diría un consejero» se
  // quitó. Aunque el servidor mande sus banderas encendidas, Ventas no lo pinta
  // ni lo pide.
  await t('VV9. Ventas ya no muestra ni pide «Lo que te diría un consejero»', async () => {
    const antes = pidioConsejero;
    const p = await abrirPanel(1440, 1);
    await recargarVentas(p);
    await esperar(600);
    const r = await p.evaluate(() => ({
      caja: !!document.getElementById('ventas-consejero'),
      global: typeof window.XaborConsejero,
      texto: /consejero/i.test(document.getElementById('vista-reportes')?.innerText || document.body.innerText),
      script: [...document.scripts].some((s) => /reportes-consejero/.test(s.src)),
    }));
    await p.close();
    assert(!r.caja && r.global === 'undefined' && !r.texto && !r.script, `quedó el consejero: ${JSON.stringify(r)}`);
    assert(pidioConsejero === antes, `el panel pidió /api/reportes/consejero ${pidioConsejero - antes} vez/veces`);
  });

  await t('VV8. sin errores de JavaScript en toda la corrida', async () => {
    assert(!erroresPagina.length, erroresPagina.join(' | '));
  });
} finally {
  await navegador.close();
  server.close();
}

console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallidas) { console.log(`FALLOS:\n${fallos.map((f) => ` - ${f}`).join('\n')}`); process.exit(1); }
