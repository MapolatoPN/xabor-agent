// Caja en el panel REAL (Puppeteer), sin Postgres: un servidor de juguete
// sirve panel/ y contesta /api/* con un día con la forma de producción
// (Obispado, 25-sep-2026): Rappi capturado como "enlace de pago", un cobro
// mixto, mesas en $0, una cuenta abierta y un cobro de un día anterior.
//
// Lo que protege:
//   · las tarjetas por método suman EXACTAMENTE Ventas del día, con
//     Plataformas aparte de Clip / enlace;
//   · los filtros de Pedidos del día dan el mismo subtotal que su tarjeta;
//   · folio corto en pantalla (#813, #M-DB95) sin perder el completo;
//   · el arqueo por denominaciones suma solo, y el cierre pide confirmación
//     y manda el conteo;
//   · a ciegas no se asoma el esperado; un día cerrado no se edita;
//   · el aviso de fondo en $0 y la opción de propinas en Configuración.
//
// Uso: node test/fase-caja-mejoras-panel.mjs [--capturas]
//   --capturas escribe test/.preview-caja-{escritorio,movil}.png
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PANEL_DIR = join(__dirname, '..', 'panel');
const CAPTURAS = process.argv.includes('--capturas');
const PUERTO = Number(process.env.TEST_PORT_CAJA_PANEL || 0);

const hoyLocal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const HOY = hoyLocal();
const hora = (h, m = 0) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.toISOString(); };

// ── El día de prueba ─────────────────────────────────────────────────────────
const PEDIDOS = [
  { folio: 'XAB-0774', hora: hora(8, 10), cliente: 'Ana', forma_pago: 'efectivo', clase: 'efectivo', total: 735 },
  { folio: 'XAB-0775', hora: hora(8, 20), cliente: 'Elena', forma_pago: 'terminal (tarjeta presente)', clase: 'tarjeta', total: 99 },
  { folio: 'RM-DB954B9D-0', hora: hora(8, 40), cliente: 'Mesa 11', forma_pago: 'terminal', clase: 'tarjeta', total: 275 },
  { folio: 'XAB-0776', hora: hora(9, 0), cliente: 'Mario', forma_pago: 'enlace de pago', clase: 'enlace', total: 310 },
  { folio: 'XAB-0781', hora: hora(9, 30), cliente: 'RAPPI 9420', forma_pago: 'enlace de pago', clase: 'plataformas', total: 279, plataforma: 'rappi', plataforma_nombre: 'Rappi' },
  { folio: 'XAB-0790', hora: hora(9, 45), cliente: 'RAPPI 1111', forma_pago: 'efectivo', clase: 'efectivo', total: 90, plataforma: 'rappi', plataforma_nombre: 'Rappi' },
  { folio: 'RM-EACA4369-0', hora: hora(10, 0), cliente: 'Mesa 40', forma_pago: 'sin pago', clase: 'sin_cobro', total: 0, estado_cuenta: 'cancelada', monto_real: 0, detalle_cuenta: 'sin consumo' },
  { folio: 'RM-E0ECC16C-0', hora: hora(10, 30), cliente: 'Mesa 3', forma_pago: 'sin pago', clase: 'sin_cobro', total: 0, estado_cuenta: 'cortesia', monto_real: 185, detalle_cuenta: 'descuento del 100 %' },
  { folio: 'RM-6C79200A-0', hora: hora(11, 0), cliente: 'Mesa 10', forma_pago: 'mixto', clase: 'mixto', total: 599, partes: [{ clase: 'efectivo', monto: 465 }, { clase: 'tarjeta', monto: 134 }] },
  { folio: 'XAB-0812', hora: hora(11, 20), cliente: 'Beto', forma_pago: 'enlace_pago', clase: 'enlace', total: 340 },
  { folio: 'XAB-0813', hora: hora(11, 40), cliente: 'RAPPI 0745', forma_pago: 'enlace de pago', clase: 'plataformas', total: 140, plataforma: 'rappi', plataforma_nombre: 'Rappi' },
];
// Lo que las tarjetas DEBEN decir, calculado a mano (no con el código que se prueba).
const ESPERADO = {
  efectivo: 735 + 90 + 465, tarjeta: 99 + 275 + 134, enlace: 310 + 340 + 200, plataformas: 279 + 140, otros: 0,
  porCobrar: 78 + 1399,
};
ESPERADO.total = ESPERADO.efectivo + ESPERADO.tarjeta + ESPERADO.enlace + ESPERADO.plataformas;

const resumenFinanciero = {
  venta_bruta_productos: ESPERADO.total, venta_bruta_antes_descuentos: ESPERADO.total, venta_bruta_completa: true,
  ventas_sin_bruto_determinable: 0, envio_base: 0, envio_cobrado: 0, promociones_total: 0, promociones_automaticas: 0,
  promociones_codigo: 0, promociones_sin_clasificar: 0, descuentos_manuales: 0, descuentos_no_clasificados: 0,
  promociones_y_descuentos: 0, rewards: 0, venta_neta: ESPERADO.total, propinas: 30, devoluciones: 0,
  ajustes_posteriores: 0, neto_conciliado: ESPERADO.total,
};
const VIVO = {
  cerrado: false, fecha_operativa: HOY, timezone: 'America/Matamoros',
  fondo_inicial: 0, fondo_registrado: false,
  ventas_totales: ESPERADO.total, ventas_efectivo: ESPERADO.efectivo, ventas_tarjeta: ESPERADO.tarjeta,
  ventas_enlace: ESPERADO.enlace, ventas_plataformas: ESPERADO.plataformas, ventas_otros: 0,
  plataformas: [{ clave: 'rappi', nombre: 'Rappi', num: 2, total: ESPERADO.plataformas }],
  entradas: 0, retiros: 0, gastos: 0, devoluciones_efectivo: 0,
  propinas_tarjeta: 30, propinas_tarjeta_en_efectivo: false, propinas_pagadas_efectivo: 0,
  efectivo_esperado: ESPERADO.efectivo,
  pedidos_count: PEDIDOS.length, cancelaciones_count: 0, devoluciones_total: 0,
  descuento_manual: 0, descuento_promocional: 0, rewards_canjeados: 0,
  pendiente: { num: 1, total: 78 },
  cuentas_abiertas: { num: 1, total: 1399, pagado: 0, saldo: 1399, abonos_efectivo: 0 },
  por_cobrar: { num: 2, total: ESPERADO.porCobrar },
  pedidos: PEDIDOS,
  pendientes: [{ folio: 'XAB-0811', hora: hora(11, 50), cliente: 'Toño', forma_pago: 'por_cobrar', clase: 'por_cobrar', total: 78, estado: 'nuevo' }],
  cuentas_mesa: [
    { cuenta_id: 'c-1', mesa: 12, hora: hora(11, 55), cliente: 'Mesa 12', estado_cuenta: 'abierta', clase: 'por_cobrar',
      subtotal: 1399, descuento: 0, total: 1399, cancelado: 0, n_items: 3, pagado: 0, pagado_efectivo: 0, saldo: 1399, monto_real: 1399 },
    { cuenta_id: 'c-2', mesa: 5, hora: hora(7, 50), cliente: 'Mesa 5', estado_cuenta: 'cancelada', clase: 'sin_cobro',
      subtotal: 90, descuento: 0, total: 90, cancelado: 0, n_items: 1, pagado: 0, pagado_efectivo: 0, saldo: 0, monto_real: 90 },
  ],
  movimientos: [],
  cobros_dias_anteriores: [{ folio: 'XAB-0700', monto: 200, proveedor: 'clip', confirmado_at: hora(10, 15), fecha_original: '2026-09-24' }],
  reporte_financiero: { resumen: resumenFinanciero, calidad: { completa: 11, parcial: 0, no_determinable: 0, avisos: [] }, descuentos_por_concepto: [], aplicaciones: [] },
  usuario_actual: 'Mario',
};
const ESCENARIOS = {
  vivo: VIVO,
  fondo: { ...VIVO, fondo_inicial: 500, fondo_registrado: true, efectivo_esperado: ESPERADO.efectivo + 500 },
  ciego: { ...VIVO, efectivo_esperado: null, esperado_oculto: true },
  cerrado: {
    ...VIVO, cerrado: true, folio: 'COR-000009', usuario: 'Mario', cerrado_at: new Date().toISOString(),
    fondo_inicial: 500, efectivo_esperado: ESPERADO.efectivo + 500, efectivo_contado: ESPERADO.efectivo + 490, diferencia: -10,
    nota: 'faltó cambio', arqueo: { modo: 'denominaciones', denominaciones: { 1000: 1, 500: 1, 200: 1, 50: 1, 20: 2 }, monedas: 0, total: 1790, a_ciegas: false },
  },
};
let ESCENARIO = 'vivo';
const PETICIONES = [];

const API = {
  '/api/auth/me': { rol: 'admin', negocioId: 'neg-prueba', modulos: ['pos', 'caja', 'menu', 'restaurante'], whatsappConfigurado: false },
  '/api/config/operativa': { nombre: 'Mapolato Prueba', nombre_corto: 'MAPOLATO' },
  '/api/corte-caja/historial': [
    { id: 'h1', fecha_operativa: '2026-09-24', folio: 'COR-000008', ventas_totales: 1205, ventas_efectivo: 1000, ventas_tarjeta: 0,
      ventas_enlace: 0, ventas_otros: 0, ventas_plataformas: 205, efectivo_esperado: 1300, efectivo_contado: 1290, diferencia: -10,
      descuento_manual: 0, descuento_promocional: 0, rewards_canjeados: 0, usuario_nombre: 'Mario' },
    // Cerrado antes de Plataformas: su Rappi quedó en enlace, como se firmó.
    { id: 'h0', fecha_operativa: '2026-09-23', folio: 'COR-000007', ventas_totales: 484, ventas_efectivo: 205, ventas_tarjeta: 0,
      ventas_enlace: 279, ventas_otros: 0, ventas_plataformas: 0, efectivo_esperado: 205, efectivo_contado: 205, diferencia: 0,
      descuento_manual: 0, descuento_promocional: 0, rewards_canjeados: 0, usuario_nombre: 'Mario' },
  ],
  '/api/pedidos-programados': [],
  '/api/admin/checklist-activacion-bot': { automaticos: {}, manuales: {}, listoParaActivar: false },
  '/api/admin/metodos-pago': { metodos: [] },
  '/api/config': { caja_propinas_tarjeta_efectivo: 'false' },
};
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url.startsWith('/api/')) {
    let cuerpo = '';
    req.on('data', c => { cuerpo += c; });
    req.on('end', () => {
      if (req.method !== 'GET') PETICIONES.push({ metodo: req.method, url, cuerpo: cuerpo ? JSON.parse(cuerpo) : null });
      let respuesta = API[url] ?? {};
      if (url === '/api/corte-caja') respuesta = ESCENARIOS[ESCENARIO];
      if (url === '/api/corte-caja/cerrar') respuesta = { ok: true, ya_existia: false, corte: { folio: 'COR-000010' }, impresion: { enviados: 1 } };
      if (url === '/api/config' && req.method === 'PUT') respuesta = { ok: true };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(respuesta));
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
const pesos = (n) => '$' + Number(n).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dinero = (txt) => Number(String(txt).replace(/[^0-9.-]/g, ''));

const navegador = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await navegador.newPage();
const erroresJs = [];
page.on('pageerror', e => erroresJs.push(e.message));
await page.setViewport({ width: 1400, height: 900 });

async function cargar(escenario) {
  ESCENARIO = escenario;
  await page.evaluate(() => cargarCorte());
  await page.waitForFunction(() => CORTE_DATA && document.querySelectorAll('#corte-filtros .corte-chip').length > 0);
}

try {
  await page.goto(`http://localhost:${puerto}/app#caja`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => typeof cargarCorte === 'function' && CORTE_DATA);
  await cargar('vivo');

  // ── Tarjetas ─────────────────────────────────────────────────────────────
  const tarjetas = await page.evaluate(() => [...document.querySelectorAll('#corte-pagos .pos-card')].map(c => ({
    etiqueta: c.querySelector('.pos-card-label').innerText.trim(), valor: c.querySelector('.pos-card-value').innerText.trim(),
    texto: c.innerText.replace(/\s+/g, ' ') })));
  const tarjeta = (prefijo) => tarjetas.find(x => x.etiqueta.includes(prefijo));

  await t('1. Plataformas (Rappi) tiene su tarjeta y Clip / enlace ya no la incluye', () => {
    assert(tarjeta('Plataformas (Rappi)'), `no está: ${tarjetas.map(x => x.etiqueta).join(' | ')}`);
    assert(dinero(tarjeta('Plataformas').valor) === ESPERADO.plataformas, tarjeta('Plataformas').valor);
    assert(dinero(tarjeta('Clip / enlace').valor) === ESPERADO.enlace, tarjeta('Clip / enlace').valor);
  });

  await t('2. VENTAS DEL DÍA = suma de las tarjetas por método', async () => {
    const total = dinero(await page.$eval('#corte-total', e => e.innerText));
    const suma = ['Efectivo', 'Tarjeta', 'Clip / enlace', 'Plataformas', 'Otros']
      .map(tarjeta).filter(Boolean).reduce((s, x) => s + dinero(x.valor), 0);
    assert(total === ESPERADO.total, `ventas del día ${total}`);
    assert(Math.round(suma * 100) === Math.round(total * 100), `tarjetas suman ${suma} y ventas dice ${total}`);
  });

  await t('3. Por cobrar incluye la cuenta de mesa abierta', () => {
    const x = tarjeta('Por cobrar');
    assert(x && dinero(x.valor) === ESPERADO.porCobrar, x?.valor);
    assert(/1 pedido sin cobrar/.test(x.texto) && /1 cuenta de mesa abierta/.test(x.texto), x.texto);
  });

  await t('4. fondo en $0 con el día abierto: aviso amarillo con botón para registrarlo', async () => {
    const aviso = await page.$eval('#corte-aviso-fondo', e => ({ visible: e.getBoundingClientRect().height > 0, texto: e.innerText, fondo: getComputedStyle(e).backgroundColor }));
    assert(aviso.visible, 'el aviso no se ve');
    assert(/Fondo inicial en \$0/.test(aviso.texto) && /Registrar fondo/.test(aviso.texto), aviso.texto);
    assert(aviso.fondo === 'rgb(255, 251, 235)', `no es amarillo: ${aviso.fondo}`);
  });

  // ── Pedidos del día ──────────────────────────────────────────────────────
  const chips = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#corte-filtros .corte-chip')]
    .map(b => [b.dataset.filtro, b.querySelector('b').innerText])));

  await t('5. chips Todos/Efectivo/Tarjeta/Clip/Plataformas/Por cobrar, cada uno con su subtotal', () => {
    for (const f of ['todos', 'efectivo', 'tarjeta', 'enlace', 'plataformas', 'por_cobrar']) assert(f in chips, `falta el filtro ${f}`);
    assert(!('otros' in chips), '"Otros" no debe aparecer si ese día no hubo nada en Otros');
  });

  await t('6. el subtotal de cada filtro es exactamente su tarjeta (y Todos, las ventas del día)', () => {
    const pares = { todos: ESPERADO.total, efectivo: ESPERADO.efectivo, tarjeta: ESPERADO.tarjeta, enlace: ESPERADO.enlace,
      plataformas: ESPERADO.plataformas, por_cobrar: ESPERADO.porCobrar };
    for (const [f, v] of Object.entries(pares)) assert(dinero(chips[f]) === v, `${f}: chip ${chips[f]} ≠ ${pesos(v)}`);
  });

  await t('7. filtrar por Plataformas muestra solo lo de plataformas', async () => {
    await page.click('[data-filtro="plataformas"]');
    const filas = await page.$$eval('#corte-lista .corte-fila', fs => fs.map(f => f.innerText.replace(/\s+/g, ' ')));
    assert(filas.length === 2, `hay ${filas.length}: ${filas.join(' / ')}`);
    assert(filas.every(f => /Rappi/.test(f)), filas.join(' / '));
    await page.click('[data-filtro="efectivo"]');
    const efectivo = await page.$$eval('#corte-lista .corte-fila', fs => fs.map(f => f.innerText.replace(/\s+/g, ' ')));
    assert(efectivo.length === 3 && efectivo.some(f => /Mixto/.test(f)), `el mixto debe salir en Efectivo: ${efectivo.join(' / ')}`);
    await page.click('[data-filtro="por_cobrar"]');
    const pc = await page.$$eval('#corte-lista .corte-fila', fs => fs.map(f => f.innerText.replace(/\s+/g, ' ')));
    assert(pc.length === 2 && pc.some(f => /Abierta/.test(f)) && pc.some(f => /Por cobrar/.test(f)), pc.join(' / '));
    await page.click('[data-filtro="todos"]');
  });

  const lista = await page.$eval('#corte-lista', e => e.innerText);
  await t('8. folio corto en pantalla: #813 y #M-DB95, con el completo en el tooltip', async () => {
    assert(/#813\b/.test(lista) && /#M-DB95\b/.test(lista), lista.slice(0, 300));
    assert(!/XAB-\d/.test(lista) && !/RM-[0-9A-F]{8}/.test(lista), 'quedó un folio largo a la vista');
    const titulo = await page.evaluate(() => [...document.querySelectorAll('#corte-lista span[title]')].map(s => s.title));
    assert(titulo.includes('XAB-0813') && titulo.includes('RM-DB954B9D-0'), 'el folio completo no quedó en el tooltip');
  });

  await t('9. "terminal" y "terminal (tarjeta presente)" se leen igual: "Tarjeta (terminal)"', () => {
    assert(!/tarjeta presente/i.test(lista), 'quedó la etiqueta vieja');
    assert((lista.match(/Tarjeta \(terminal\)/g) || []).length >= 2, lista);
  });

  await t('10. mesas: cancelada sin consumo, cortesía con su monto real, abierta con su cuenta', () => {
    assert(/Cancelada[\s\S]*sin consumo/.test(lista), 'la cuenta vacía no dice "Cancelada · sin consumo"');
    assert(/Cortesía[\s\S]*\$185\.00/.test(lista), 'la cortesía no muestra su monto real');
    assert(/Abierta[\s\S]*\$1,399\.00/.test(lista), 'la cuenta abierta no muestra su monto');
    assert(!/sin pago/i.test(lista), 'quedó "sin pago"');
  });

  // ── Promociones y descuentos ─────────────────────────────────────────────
  await t('11. sin descuentos: una sola venta, sin tarjetas en $0 y una línea que se despliega', async () => {
    const v = await page.evaluate(() => {
      const cont = document.getElementById('corte-financiero');
      const det = document.getElementById('corte-sin-descuentos');
      const visibles = [...cont.querySelectorAll(':scope > div > div')].filter(d => !d.closest('details'))
        .map(d => d.innerText.replace(/\s+/g, ' '));
      return { visibles, resumen: det?.querySelector('summary')?.innerText, abierto: det?.open,
        dentro: det ? det.querySelectorAll('div > div').length : 0 };
    });
    assert(v.resumen === 'Sin promociones ni descuentos hoy', `línea: ${v.resumen}`);
    assert(v.abierto === false, 'debe iniciar plegada');
    assert(!v.visibles.some(x => /\$0\.00/.test(x)), `tarjeta en $0 visible: ${v.visibles.join(' | ')}`);
    assert(v.visibles.filter(x => /venta (bruta|neta)|neto conciliado/i.test(x)).length === 1, `ventas: ${v.visibles.join(' | ')}`);
    assert(v.dentro >= 11, 'al desplegar deben estar todas las tarjetas');
  });

  // ── Arqueo ───────────────────────────────────────────────────────────────
  await t('12. el admin ve el esperado y de dónde sale', async () => {
    const esperado = await page.$eval('#arq-esperado', e => e.innerText);
    assert(dinero(esperado) === ESPERADO.efectivo, esperado);
    const desglose = await page.$eval('#arq-desglose', e => e.innerText);
    assert(/Fondo inicial/.test(desglose) && /Ventas en efectivo/.test(desglose), desglose);
    assert(/Propinas cobradas con tarjeta: \$30\.00/.test(desglose), 'no informa las propinas con tarjeta');
  });

  await t('13. conteo por denominaciones: la suma sale sola y la diferencia se calcula', async () => {
    const celdas = await page.$$eval('#arq-denominaciones input', is => is.map(i => i.id));
    assert(celdas.length === 7, `casillas: ${celdas.join(',')}`);
    await page.type('#arq-den-1000', '1');
    await page.type('#arq-den-200', '1');
    await page.type('#arq-den-50', '1');
    await page.type('#arq-den-20', '1');
    await page.type('#arq-monedas', '10');
    const v = await page.evaluate(() => ({ contado: document.getElementById('arq-contado').value, soloLectura: document.getElementById('arq-contado').readOnly,
      dif: document.getElementById('arq-diferencia').innerText }));
    assert(v.contado === '1280.00', `contado ${v.contado}`);
    assert(v.soloLectura, 'en modo denominaciones el total no se teclea');
    assert(/\$-10\.00/.test(v.dif) && /FALTANTE/.test(v.dif), v.dif);
  });

  await t('14. "Cerrar corte" pide confirmación con fondo, esperado, contado, diferencia, usuario y hora', async () => {
    const antes = PETICIONES.length;
    await page.click('#btn-cerrar-corte');
    await page.waitForSelector('#modal-cierre-corte');
    const texto = await page.$eval('#modal-cierre-corte', e => e.innerText);
    for (const x of ['Fondo inicial', 'Efectivo esperado', 'Efectivo contado', 'Diferencia', 'Usuario', 'Mario', 'Hora', '$1,280.00', 'FALTANTE', '1×$1000'])
      assert(texto.includes(x), `falta "${x}" en: ${texto}`);
    await page.click('#modal-cierre-corte button');   // Cancelar
    assert(!(await page.$('#modal-cierre-corte')), 'Cancelar no cerró la confirmación');
    assert(PETICIONES.length === antes, 'Cancelar mandó algo al servidor');
  });

  await t('15. confirmar manda el conteo por denominaciones al servidor', async () => {
    await page.click('#btn-cerrar-corte');
    await page.waitForSelector('#btn-confirmar-cierre-corte');
    await page.click('#btn-confirmar-cierre-corte');
    await page.waitForFunction(() => /Corte cerrado/.test(document.getElementById('corte-fb').innerText));
    const p = PETICIONES.find(x => x.url === '/api/corte-caja/cerrar');
    assert(p, 'no llegó el cierre');
    assert(p.cuerpo.efectivo_contado === 1280, `contado ${p.cuerpo.efectivo_contado}`);
    assert(JSON.stringify(p.cuerpo.arqueo) === JSON.stringify({ modo: 'denominaciones', denominaciones: { 20: 1, 50: 1, 200: 1, 1000: 1 }, monedas: 10 }),
      JSON.stringify(p.cuerpo.arqueo));
    const fb = await page.$eval('#corte-fb', e => e.innerText);
    assert(/Ticket enviado a la impresora/.test(fb), `el aviso de impresión se borró: "${fb}"`);
  });

  await t('16. "Solo el total" deja teclear el total', async () => {
    // Al centro de la pantalla: pegado arriba, el encabezado fijo del panel
    // queda encima del botón y el clic cae en el encabezado.
    await page.$eval('#arq-modo-total', b => b.scrollIntoView({ block: 'center' }));
    await page.click('#arq-modo-total');
    const v = await page.evaluate(() => ({ soloLectura: document.getElementById('arq-contado').readOnly,
      grid: getComputedStyle(document.getElementById('arq-denominaciones')).display, modo: ARQ_MODO }));
    assert(!v.soloLectura && v.grid === 'none', JSON.stringify(v));
    await page.click('#arq-modo-denominaciones');
  });

  await t('17. a ciegas: ni el esperado ni la diferencia se asoman antes de cerrar', async () => {
    await cargar('ciego');
    await page.type('#arq-den-500', '2');
    const v = await page.evaluate(() => ({
      esperado: document.getElementById('arq-esperado').innerText, arriba: document.getElementById('corte-efectivo').innerText,
      dif: document.getElementById('arq-diferencia').innerText, arqueo: document.getElementById('corte-arqueo').innerText }));
    assert(/Oculto/.test(v.esperado) && /🔒/.test(v.arriba) && /🔒/.test(v.dif), JSON.stringify(v));
    assert(!v.arqueo.includes(pesos(ESPERADO.efectivo)), 'el esperado se ve en el arqueo');
    await page.click('#btn-cerrar-corte');
    await page.waitForSelector('#modal-cierre-corte');
    const modal = await page.$eval('#modal-cierre-corte', e => e.innerText);
    assert(/Se revela al cerrar/.test(modal) && !modal.includes(pesos(ESPERADO.efectivo)), modal);
    await page.click('#modal-cierre-corte button');
  });

  await t('18. con fondo registrado no hay aviso', async () => {
    await cargar('fondo');
    const visible = await page.$eval('#corte-aviso-fondo', e => e.getBoundingClientRect().height > 0);
    assert(!visible, 'el aviso sigue a la vista con fondo de $500');
  });

  await t('19. un corte cerrado se lee: quién y cuándo, conteo guardado y nada editable', async () => {
    await cargar('cerrado');
    const v = await page.evaluate(() => ({
      estado: document.getElementById('corte-estado').innerText,
      den: [...document.querySelectorAll('#arq-denominaciones input')].map(i => [i.id, i.value, i.disabled]),
      modos: getComputedStyle(document.getElementById('arq-modos')).display,
      aviso: document.getElementById('corte-aviso-fondo').getBoundingClientRect().height,
      cerrar: getComputedStyle(document.getElementById('btn-cerrar-corte')).display }));
    assert(/CERRADO · COR-000009/.test(v.estado) && /por Mario/.test(v.estado), v.estado);
    assert(v.den.every(([, , d]) => d), 'una casilla del conteo quedó editable');
    assert(v.den.find(([id]) => id === 'arq-den-500')[1] === '1', 'no muestra el conteo guardado');
    assert(v.modos === 'none' && v.cerrar === 'none' && v.aviso === 0, JSON.stringify(v));
  });

  await t('19b. el historial de cortes trae Plataformas; uno viejo la deja en "—" y no se toca', async () => {
    await page.waitForFunction(() => document.querySelectorAll('#corte-historial tbody tr').length === 2);
    const v = await page.evaluate(() => {
      const heads = [...document.querySelectorAll('#corte-historial thead th')].map(th => th.innerText.trim());
      const col = heads.indexOf('Plataformas');
      const filas = [...document.querySelectorAll('#corte-historial tbody tr')].map(tr => [...tr.children].map(td => td.innerText.trim()));
      return { heads, col, filas };
    });
    assert(v.col > -1, `sin columna: ${v.heads.join(',')}`);
    assert(v.filas[0][v.col] === '$205.00' && v.filas[1][v.col] === '—', JSON.stringify(v.filas.map(f => f[v.col])));
    // En el corte viejo, "Electrónico" sigue incluyendo el Rappi que se firmó como enlace.
    assert(v.filas[1][v.heads.indexOf('Electrónico')] === '$279.00', v.filas[1].join(' | '));
  });

  // ── Configuración › Pagos ────────────────────────────────────────────────
  await t('20. Configuración › Pagos: "Las propinas con tarjeta se pagan en efectivo desde caja"', async () => {
    await page.evaluate(() => { mostrarTab('config'); cfgIr('pagos'); });
    await page.waitForSelector('#cfg-propinas-tarjeta-efectivo');
    const etiqueta = await page.$eval('#cfg-propinas-tarjeta-efectivo', e => e.closest('label').innerText.trim());
    assert(etiqueta === 'Las propinas con tarjeta se pagan en efectivo desde caja', etiqueta);
    await page.click('#cfg-propinas-tarjeta-efectivo');
    await page.waitForFunction(() => /Guardado/.test(document.getElementById('cfg-propinas-fb').innerText));
    const put = PETICIONES.filter(x => x.url === '/api/config' && x.metodo === 'PUT').pop();
    assert(put && put.cuerpo.caja_propinas_tarjeta_efectivo === 'true', JSON.stringify(put));
  });

  // ── Folio corto en todos lados, y sin pisar funciones existentes ─────────
  await t('21. mesas.html usa exactamente el mismo folio corto', () => {
    const extraer = (html) => { const i = html.indexOf('function folioCorto(folio) {'); return html.slice(i, html.indexOf('\n}\n', i) + 2); };
    const a = extraer(readFileSync(join(PANEL_DIR, 'index.html'), 'utf8'));
    const b = extraer(readFileSync(join(PANEL_DIR, 'mesas.html'), 'utf8'));
    assert(a.length > 50 && a === b, 'las dos copias de folioCorto difieren');
    const f = new Function(`${a}\nreturn folioCorto;`)();
    const casos = [['XAB-0813', '#813'], ['RM-DB954B9D-0', '#M-DB95'], ['RM-db954b9d-2', '#M-DB95-2'], ['COR-000001', 'COR-000001'], [null, '']];
    for (const [entrada, salida] of casos) assert(f(entrada) === salida, `${entrada} → ${f(entrada)}`);
  });

  await t('22. las funciones nuevas no pisan ninguna existente (etiquetaFormaPago sigue siendo la de la comanda)', () => {
    const html = readFileSync(join(PANEL_DIR, 'index.html'), 'utf8');
    for (const fn of ['etiquetaFormaPago', 'etiquetaPagoCorte', 'folioCorto', 'folioHTML', 'pintarPedidosDelDia', 'arqModo', 'confirmarCierreCorte', 'cargarPropinasCaja'])
      assert((html.match(new RegExp(`function ${fn}\\(`, 'g')) || []).length === 1, `${fn} está declarada más de una vez (o ninguna)`);
    assert(/function etiquetaFormaPago\(p\) \{\s*const crudo = getFormaPago\(p\);/.test(html), 'etiquetaFormaPago(p) dejó de ser la de la comanda');
  });

  await t('23. en el celular la Caja no se sale de la pantalla', async () => {
    await page.evaluate(() => mostrarTab('corte'));
    await page.setViewport({ width: 375, height: 812 });
    await cargar('vivo');
    const v = await page.evaluate(() => {
      // Además del scroll de la página: dentro de cada renglón, la parte de
      // "quién" y la de "cuánto" no se pueden encimar (así se veía el mixto).
      const encimados = [...document.querySelectorAll('#corte-lista .corte-fila')].filter(f => {
        const a = f.querySelector('.corte-fila-izq').getBoundingClientRect();
        const b = f.querySelector('.corte-fila-der').getBoundingClientRect();
        const cruzan = a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
        const izq = f.querySelector('.corte-fila-izq');
        return cruzan || izq.scrollWidth > izq.clientWidth + 1;
      }).map(f => f.innerText.replace(/\s+/g, ' ').slice(0, 60));
      return { ancho: document.documentElement.scrollWidth, ventana: window.innerWidth, encimados };
    });
    if (CAPTURAS) await page.screenshot({ path: join(__dirname, '.preview-caja-movil.png'), fullPage: true });
    assert(v.ancho <= v.ventana + 1, `scroll horizontal: ${v.ancho} > ${v.ventana}`);
    assert(!v.encimados.length, `renglones encimados: ${v.encimados.join(' | ')}`);
    await page.setViewport({ width: 1400, height: 900 });
    if (CAPTURAS) { await cargar('vivo'); await page.screenshot({ path: join(__dirname, '.preview-caja-escritorio.png'), fullPage: true }); }
  });

  await t('24. ningún error de JavaScript en toda la corrida', () => {
    assert(!erroresJs.length, erroresJs.join(' | '));
  });
} catch (e) {
  console.error('ERROR FATAL EN LA SUITE:', e);
  fallidas++; fallos.push(`fatal: ${e.message}`);
} finally {
  await navegador.close();
  server.close();
}

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallos.length) { console.log('FALLOS:'); fallos.forEach(f => console.log(' - ' + f)); }
process.exit(fallidas ? 1 : 0);
