// Historial por modalidad y lo que no fue venta, separado.
//
// Auditoría del 28-sep-2026 (Mapolato Obispado): el historial eran «los
// últimos 100 por última edición», sin fechas, y solo distinguía Domicilio y
// Recoger: las 276 ventas de mesa salían como «Recoger». Las 29 órdenes que el
// sistema canceló solo (enlace de pago vencido) aparecían como «🚫 Cancelado»
// sin motivo, y 60 mesas cerradas en $0 se veían como ventas. Envíos activos
// mezclaba los envíos del día con cancelados de semanas atrás, y la pestaña
// Domicilio pintaba un cancelado como «✅ Entregado».
//
// Panel real con Puppeteer y un servidor de juguete (sin Postgres), como
// fase-comanda-plegada.
//
// Uso: node test/fase-historial-modalidad.mjs
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PANEL_DIR = join(__dirname, '..', 'panel');
const PUERTO = Number(process.env.TEST_PORT_HISTORIAL || 0);

const ahora = Date.now();
const hace = (min) => new Date(ahora - min * 60000).toISOString();
const HISTORIAL = [
  { id: 'RM-A1110001-0', canal: 'restaurante_mesa', modalidad: 'mesa', mesa: 5, mesero: 'Luis', cliente: { nombre: 'Mesa 5' },
    total: 300, subtotal: 300, forma_pago: 'efectivo', items: [{ nombre: 'Chilaquiles', cantidad: 1, precio_unitario: 300 }],
    _estado: 'entregado', _creado_at: hace(10), _cuenta: { n: 1, cancelados: 0, monto_cancelado: 0 } },
  { id: 'RM-B2220002-0', canal: 'restaurante_mesa', modalidad: 'mesa', mesa: 1, cliente: { nombre: 'Mesa 1' },
    total: 0, subtotal: 0, forma_pago: 'sin pago', items: [],
    _estado: 'entregado', _creado_at: hace(20), _cuenta: { n: 0, cancelados: 0, monto_cancelado: 0 } },
  { id: 'RM-C3330003-0', canal: 'restaurante_mesa', modalidad: 'mesa', mesa: 7, cliente: { nombre: 'Mesa 7' },
    total: 0, subtotal: 0, forma_pago: 'sin pago', items: [],
    _estado: 'entregado', _creado_at: hace(30), _cuenta: { n: 2, cancelados: 2, monto_cancelado: 80 } },
  { id: 'RM-D4440004-0', canal: 'restaurante_mesa', modalidad: 'mesa', mesa: 2, mesero: 'Ana', cliente: { nombre: 'Mesa 2' },
    total: 0, subtotal: 209, descuento: 209, motivo_descuento: 'Cumpleaños', forma_pago: 'sin pago',
    items: [{ nombre: 'Pastel', cantidad: 1, precio_unitario: 209 }],
    _estado: 'entregado', _creado_at: hace(40), _cuenta: { n: 1, cancelados: 0, monto_cancelado: 0 } },
  { id: 'XAB-0901', canal: 'pos', modalidad: 'recoger en tienda', cliente: { nombre: 'Rosa', telefono: '—' },
    total: 120, forma_pago: 'efectivo', items: [{ nombre: 'Licuado', cantidad: 2, precio_unitario: 60 }], _estado: 'entregado', _creado_at: hace(50) },
  { id: 'XAB-0902', canal: 'tienda_online', modalidad: 'entrega a domicilio', cliente: { nombre: 'Pedro', telefono: '8780000000' },
    total: 250, forma_pago: 'enlace_pago', pago_confirmado: true, items: [{ nombre: 'Torta', cantidad: 1, precio_unitario: 250 }], _estado: 'entregado', _creado_at: hace(60) },
  { id: 'XAB-0903', canal: 'tienda_online', modalidad: 'entrega a domicilio', cliente: { nombre: 'Katia', telefono: '8780000001' },
    total: 294, forma_pago: 'enlace_pago', items: [{ nombre: 'Enchiladas', cantidad: 1, precio_unitario: 294 }],
    _estado: 'cancelado', expirado_por_pago: true, expirado_at: hace(65), motivo_cancelacion: 'no se recibio el pago dentro de la ventana', _creado_at: hace(95) },
  { id: 'XAB-0904', canal: 'whatsapp', modalidad: 'recoger en tienda', cliente: { nombre: 'Omar', telefono: '8780000002' },
    total: 90, forma_pago: 'efectivo', items: [{ nombre: 'Café', cantidad: 3, precio_unitario: 30 }],
    _estado: 'cancelado', cancelacion: { motivo: 'Duplicado', por: 'u1' }, _cancelado_por_nombre: 'Mario', _creado_at: hace(100) },
  { id: 'XAB-0905', canal: 'whatsapp', modalidad: 'consumo en sitio', cliente: { nombre: 'Eva', telefono: '8780000003' },
    total: 80, forma_pago: 'efectivo', items: [{ nombre: 'Hotcakes', cantidad: 1, precio_unitario: 80 }], _estado: 'entregado', _creado_at: hace(110) },
  // Mesa liberada sin venta (102): no tiene folio ni fila en pedidos_activos.
  { id: null, cuenta_id: 'c-liberada', canal: 'restaurante_mesa', modalidad: 'mesa', mesa: 9, mesero: 'Luis', cliente: { nombre: 'Mesa 9' },
    total: 0, subtotal: 0, items: [], liberada_motivo: 'Mesa abierta por error', _liberada_por_nombre: 'Ana',
    _estado: 'liberada', _creado_at: hace(45), _cuenta: { n: 1, cancelados: 1, monto_cancelado: 35 } },
  // Cortesía de mostrador: descuento del 100 %, no es mesa.
  { id: 'XAB-0906', canal: 'pos', modalidad: 'recoger en tienda', cliente: { nombre: 'Nico', telefono: '—' },
    total: 0, subtotal: 55, descuento: 55, motivo_descuento: 'Queja atendida', forma_pago: 'efectivo',
    items: [{ nombre: 'Café', cantidad: 1, precio_unitario: 55 }], _estado: 'entregado', _creado_at: hace(120) },
];
const VENTAS = [
  { folio: 'RM-A1110001-0', created_at: hace(10), nombre_cliente: 'Mesa 5', modalidad: 'mesa', canal: 'restaurante_mesa', forma_pago: 'efectivo', total: 300, items: [] },
  { folio: 'XAB-0901', created_at: hace(50), nombre_cliente: 'Rosa', modalidad: 'recoger en tienda', canal: 'pos', forma_pago: 'efectivo', total: 120, items: [] },
];
const ENVIOS = [
  { folio: 'XAB-0950', creadoAt: hace(15), modalidad: 'entrega a domicilio', canal: 'pos', estado: 'nuevo', entregaEstado: 'sin_repartidor', cliente: 'Hoy Uno', telefono: '8781111111', colonia: 'Centro', total: 150, formaPago: 'efectivo', deHoy: true },
  { folio: 'XAB-0308', creadoAt: '2026-09-11T16:50:32.000Z', modalidad: 'entrega a domicilio', canal: 'tienda_online', estado: 'nuevo', entregaEstado: 'sin_repartidor', cliente: 'Viejo Pagado', telefono: '8782222222', colonia: 'Norte', total: 450, formaPago: 'enlace_pago', pagoConfirmado: true, deHoy: false },
];
const DOMICILIO = [{ nombre: 'Rafa', pedidos: [
  { folio: 'XAB-0960', hora: '10:00', estado: 'entregado', total: 100, cliente: 'Lupe', calle: 'Olmo', colonia: 'Centro' },
  { folio: 'XAB-0961', hora: '10:30', estado: 'cancelado', total: 294, cliente: 'Katia', calle: 'Pino', colonia: 'Sur' },
] }];

const PETICIONES = [];
const API = {
  '/api/auth/me': { rol: 'admin', negocioId: 'neg-prueba', modulos: ['pos', 'caja', 'menu', 'restaurante'], whatsappConfigurado: false },
  '/api/config/operativa': { nombre: 'Restaurante Prueba', nombre_corto: 'XABOR' },
  '/api/pedidos-programados': [],
  '/api/admin/checklist-activacion-bot': { automaticos: {}, manuales: {}, listoParaActivar: false },
  '/api/historial': HISTORIAL,
  '/api/ventas': VENTAS,
  '/api/ventas/resumen': { total_ventas: 420, num_pedidos: 2, promedio: 210, domicilios: 0, recoger: 1, restaurante: 1, total_envios: 0 },
  '/api/pos/envios': { envios: ENVIOS },
  '/api/admin/repartidores/estado': DOMICILIO,
  '/api/admin/repartidores/candidatos': [],
};
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const [url, query = ''] = req.url.split('?');
  if (url.startsWith('/api/') || url.startsWith('/pedidos/')) {
    let cuerpo = '';
    req.on('data', c => { cuerpo += c; });
    req.on('end', () => {
      PETICIONES.push({ metodo: req.method, url, query, cuerpo: cuerpo ? JSON.parse(cuerpo) : null });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(url.startsWith('/pedidos/') ? { ok: true } : (API[url] ?? {})));
    });
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

const navegador = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await navegador.newPage();
await page.setViewport({ width: 1400, height: 900 });
page.on('dialog', d => d.accept().catch(() => {}));

const chips = () => page.evaluate(() => [...document.querySelectorAll('#hist-chips .corte-chip')]
  .map(b => ({ filtro: b.dataset.filtro, texto: b.innerText.replace(/\s+/g, ' ').trim(), activo: b.classList.contains('activo') })));
const filasHistorial = () => page.evaluate(() => [...document.querySelectorAll('#historial-lista > div')]
  .map(d => d.innerText.replace(/\s+/g, ' ').trim()));
const filaDe = async (folioCorto) => (await filasHistorial()).find(f => f.includes(folioCorto)) || '';

try {
  await page.goto(`http://localhost:${puerto}/app#pedidos/historial`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => typeof cargarHistorial === 'function');
  await page.evaluate(() => mostrarTab('historial'));
  await page.waitForFunction(() => document.querySelectorAll('#hist-chips .corte-chip').length === 5);

  await t('H1. el historial pide el periodo «hoy» al servidor, no «los últimos 100»', async () => {
    const pedido = PETICIONES.filter(p => p.url === '/api/historial').pop();
    assert(pedido && /periodo=hoy/.test(pedido.query), `consulta: ${pedido?.query}`);
  });
  await t('H2. cinco pestañas: Todas, Restaurante, Domicilio, Recoger y Canceladas, con cuántos y cuánto', async () => {
    const c = await chips();
    const por = Object.fromEntries(c.map(x => [x.filtro, x.texto]));
    assert(/^Todas 6 · \$750/.test(por.todas), `Todas: ${por.todas}`);
    assert(/^Restaurante 3 · \$380/.test(por.restaurante), `Restaurante: ${por.restaurante}`);
    assert(/^Domicilio 1 · \$250/.test(por.domicilio), `Domicilio: ${por.domicilio}`);
    assert(/^Recoger 2 · \$120/.test(por.recoger), `Recoger: ${por.recoger}`);
    assert(/^Canceladas y sin venta 5$/.test(por.no_venta), `Canceladas: ${por.no_venta}`);
    assert(c.find(x => x.filtro === 'todas').activo, 'Todas empieza activa');
  });
  await t('H3. una venta de mesa dice «Restaurante» y quién la atendió, nunca «Recoger»', async () => {
    const f = await filaDe('#M-A111');
    assert(/Mesa 5 · Luis/.test(f), `renglón: ${f}`);
    assert(/Restaurante/.test(f) && !/Recoger/.test(f), `renglón: ${f}`);
  });
  await t('H4. «consumo en sitio» de WhatsApp cuenta como Restaurante', async () => {
    await page.evaluate(() => histFiltrar('restaurante'));
    const filas = await filasHistorial();
    assert(filas.length === 3 && filas.some(f => /Eva/.test(f)), `restaurante: ${filas.length}`);
  });
  await t('H5. la cortesía está en ventas con su valor real y su motivo', async () => {
    const filas = await filasHistorial();
    const f = filas.find(x => /Mesa 2/.test(x)) || '';
    assert(/Cortesía/.test(f) && /\$209/.test(f) && /Cumpleaños/.test(f), `cortesía: ${f}`);
  });
  await t('H5b. una cortesía de mostrador (100 % de descuento) también dice «Cortesía»', async () => {
    await page.evaluate(() => histFiltrar('recoger'));
    const f = (await filasHistorial()).find(x => /Nico/.test(x)) || '';
    assert(/Cortesía/.test(f) && /\$55/.test(f) && /Queja atendida/.test(f), `cortesía de mostrador: ${f}`);
  });
  await t('H6. el canal del pedido se ve: Mostrador, Tienda en línea, WhatsApp', async () => {
    await page.evaluate(() => histFiltrar('todas'));
    const texto = (await filasHistorial()).join(' | ');
    for (const canal of ['Mostrador', 'Tienda en línea', 'WhatsApp']) assert(texto.includes(canal), `falta ${canal}`);
  });
  await t('H7. en Ventas no aparece nada cancelado, no pagado ni sin consumo', async () => {
    const texto = (await filasHistorial()).join(' | ');
    assert(!/Pago no recibido|Sin consumo|🚫 Cancelado/.test(texto), 'se colaron no-ventas en Todas');
  });
  await t('H8. «Canceladas y sin venta» explica cada caso: enlace vencido, cancelado con motivo y quién, mesa sin consumo', async () => {
    await page.evaluate(() => histFiltrar('no_venta'));
    const filas = await filasHistorial();
    assert(filas.length === 5, `hay ${filas.length}`);
    const txt = filas.join(' | ');
    assert(/Pago no recibido/.test(txt) && /enlace de pago venció/.test(txt) && /Nadie lo canceló a mano/.test(txt), 'falta el caso del enlace vencido');
    assert(/Motivo: Duplicado · canceló Mario/.test(txt), 'falta el motivo y quién canceló');
    assert(/se cerró sin productos/.test(txt), 'falta la mesa sin productos');
    assert(/se cancelaron 2 productos \(\$80/.test(txt), 'falta la mesa con productos cancelados');
    assert(/Mesa liberada sin venta: Mesa abierta por error · liberó Ana · 1 producto quitado \(\$35\.00\)/.test(txt), 'falta la mesa liberada con motivo y quién');
  });
  await t('H9. ✏️ Pago solo en ventas (no en cortesías ni en cancelados)', async () => {
    await page.evaluate(() => histFiltrar('todas'));
    const botones = await page.evaluate(() => [...document.querySelectorAll('#historial-lista button')]
      .filter(b => /Pago/.test(b.textContent)).map(b => b.getAttribute('onclick')));
    assert(botones.includes("abrirModalPago('XAB-0901')") && botones.includes("abrirModalPago('RM-A1110001-0')"), `botones: ${botones}`);
    assert(!botones.includes("abrirModalPago('RM-D4440004-0')"), 'la cortesía no lleva ✏️ Pago');
  });
  await t('H10. los periodos piden al servidor: Ayer, 7 días y un rango', async () => {
    await page.evaluate(() => histPeriodo('ayer'));
    await esperar(200);
    await page.evaluate(() => histPeriodo('7'));
    await esperar(200);
    await page.evaluate(() => {
      document.getElementById('hist-desde').value = '2026-09-20';
      document.getElementById('hist-hasta').value = '2026-09-15';
      histPeriodoRango();
    });
    await esperar(200);
    const q = PETICIONES.filter(p => p.url === '/api/historial').map(p => p.query);
    assert(q.includes('periodo=ayer') && q.includes('periodo=7'), `consultas: ${q}`);
    assert(q.includes('desde=2026-09-15&hasta=2026-09-20'), `el rango se ordena: ${q}`);
    const titulo = await page.evaluate(() => document.getElementById('hist-titulo').textContent);
    assert(/2026-09-15 a 2026-09-20/.test(titulo), `título: ${titulo}`);
  });

  // ── Ventas ─────────────────────────────────────────────────────────────────
  await t('V1. el reporte de Ventas pinta la mesa como Restaurante y cuenta restaurante aparte', async () => {
    await page.evaluate(() => cargarVentas('2026-09-28', '2026-09-28'));
    await page.waitForFunction(() => document.querySelectorAll('#ventas-body tr').length === 2);
    const filas = await page.evaluate(() => [...document.querySelectorAll('#ventas-body tr')].map(tr => tr.innerText.replace(/\s+/g, ' ')));
    assert(/Mesa 5/.test(filas[0]) && /Restaurante/.test(filas[0]) && !/Recoger/.test(filas[0]), `fila: ${filas[0]}`);
    const tarjeta = await page.evaluate(() => document.getElementById('pos-restaurante')?.textContent);
    assert(tarjeta === '1', `tarjeta Restaurante: ${tarjeta}`);
  });

  // ── Envíos activos ─────────────────────────────────────────────────────────
  await t('E1. Envíos activos: lo del día arriba y lo viejo sin cerrar aparte, plegado', async () => {
    await page.evaluate(() => cargarEnviosActivos());
    await page.waitForFunction(() => document.querySelector('#env-tabla-activos details'));
    const hoy = await page.evaluate(() => document.querySelector('#env-tabla-activos > table')?.innerText || '');
    assert(/Hoy Uno/.test(hoy) && !/Viejo Pagado/.test(hoy), `tabla del día: ${hoy.slice(0, 120)}`);
    const viejos = await page.evaluate(() => document.querySelector('#env-tabla-activos details').innerText);
    assert(/Sin cerrar de días anteriores \(1\)/.test(viejos), `plegado: ${viejos.slice(0, 80)}`);
  });
  await t('E2. el admin cierra un envío viejo con «📦 Entregado»', async () => {
    await page.evaluate(() => { document.querySelector('#env-tabla-activos details').open = true; });
    await page.evaluate(() => [...document.querySelectorAll('#env-tabla-activos details button')].find(b => /Entregado/.test(b.textContent)).click());
    await esperar(300);
    const patch = PETICIONES.find(p => p.metodo === 'PATCH' && p.url === '/pedidos/XAB-0308/estado');
    assert(patch && patch.cuerpo?.estado === 'entregado', `petición: ${JSON.stringify(patch)}`);
  });

  // ── Domicilio ──────────────────────────────────────────────────────────────
  await t('D1. Domicilio: un cancelado dice «Cancelado» y no suma al repartidor', async () => {
    await page.evaluate(() => cargarRepartidores());
    await page.waitForFunction(() => /Rafa/.test(document.getElementById('tabla-repartidores').innerText));
    const txt = await page.evaluate(() => document.getElementById('tabla-repartidores').innerText.replace(/\s+/g, ' '));
    assert(/Cancelado/.test(txt), 'el cancelado no dice Cancelado');
    assert(/\$100 MXN/.test(txt) && !/\$394 MXN/.test(txt), `total del repartidor: ${txt.slice(0, 160)}`);
  });

  await t('Z1. las funciones nuevas están declaradas una sola vez', async () => {
    const html = readFileSync(join(PANEL_DIR, 'index.html'), 'utf8');
    for (const nombre of ['grupoModalidad', 'claseHistorial', 'canalCortoPedido', 'histPeriodo', 'histPeriodoRango', 'histFiltrar', 'pintarHistorial', 'histFila', 'cargarHistorial', 'cargarEnviosActivos', 'envMarcarEntregado']) {
      const n = (html.match(new RegExp(`function ${nombre}\\(`, 'g')) || []).length;
      assert(n === 1, `${nombre} declarada ${n} veces`);
    }
  });
} finally {
  await navegador.close();
  server.close();
}

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallidas) { console.log('Fallos:\n  · ' + fallos.join('\n  · ')); process.exit(1); }
