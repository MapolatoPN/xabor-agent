// El ticket de cliente sale solo al registrar el pago.
//
// Cerrar un pedido en el tablero es «cobrar → ticket → entregar», y el ticket
// era el unico paso que dependia de que alguien se acordara de apretar el
// boton. Esta suite protege que salga solo, y sobre todo las tres formas que
// tiene de salir MAL sin dar la cara:
//
//   · con la forma de pago VIEJA (el ticket se arma con la memoria del
//     tablero, y el 'actualizar_pago' del WebSocket puede llegar despues que
//     la respuesta del PATCH),
//   · con el total y el cambio de ANTES del cobro (el servidor devuelve total,
//     descuento y cambio, pero no el billete ni el desglose del mixto),
//   · sin salir en absoluto y en silencio, si el navegador bloquea la ventana
//     emergente — el operador entrega el pedido creyendo que hubo comprobante.
//
// No necesita Postgres: levanta un servidor estatico de juguete que sirve
// panel/ y contesta /api/* como el servidor real, y maneja el panel REAL con
// Puppeteer. Corre en cualquier maquina y en cualquier worktree.
//
// Uso: node test/fase-ticket-al-cobrar.mjs [--capturas]
//   --capturas escribe test/.preview-ticket-al-cobrar.html con el papel que
//   sale del cobro, para mirarlo sin gastar rollo
//   TEST_PORT_TICKET cambia el puerto (por omision 4838)
import http from 'node:http';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PANEL_DIR = join(__dirname, '..', 'panel');
const PUERTO = Number(process.env.TEST_PORT_TICKET || 4838);
const CAPTURAS = process.argv.includes('--capturas');

// ── Pedidos de prueba ───────────────────────────────────────────────────────
// XAB-0401 nace por cobrar (captura != cobro): se cierra con el modal Cobrar.
// XAB-0402 ya trae forma de pago: se corrige con el modal de pago del admin.
const PEDIDOS = {
  'XAB-0401': {
    id: 'XAB-0401', estado: 'nuevo', canal: 'presencial', modalidad: 'en tienda',
    total: 280, forma_pago: 'por_cobrar',
    timestamp: new Date(Date.now() - 6 * 60000).toISOString(),
    cliente: { nombre: 'MONSERRAT', telefono: '—' },
    items: [
      { nombre: 'Combito de Cuernito', cantidad: 1, precio_unitario: 225 },
      { nombre: 'Licuado', cantidad: 1, precio_unitario: 55 },
    ],
  },
  'XAB-0402': {
    id: 'XAB-0402', estado: 'listo', canal: 'whatsapp', modalidad: 'recoger en tienda',
    total: 150, forma_pago: 'efectivo', pago_confirmado: true,
    timestamp: new Date(Date.now() - 20 * 60000).toISOString(),
    cliente: { nombre: 'ALMA TORRES', telefono: '8787709470' },
    items: [{ nombre: 'Orden de gorditas', cantidad: 2, precio_unitario: 75 }],
  },
};

// ── Servidor de juguete ─────────────────────────────────────────────────────
// Solo lo justo para que el panel arranque (si /api/auth/me falla, el panel se
// va a login y no hay nada que medir) mas los dos endpoints de pago, que
// contestan lo MISMO que src/server.js: el de /cobro devuelve total, descuento
// y cambio pero nunca billete ni desglose del mixto, y el segundo intento
// sobre el mismo folio responde yaCobrado.
const API = {
  '/api/auth/me': { rol: 'admin', negocioId: 'neg-prueba', modulos: ['pos','whatsapp','menu'], whatsappConfigurado: true },
  '/api/config/operativa': { nombre: 'Restaurante Prueba', nombre_corto: 'XABOR', direccion: 'Calle 1', ciudad: 'Matamoros', rfc: 'XAXX010101000', telefono: '8781234567', whatsapp: '8781234567' },
  '/api/pedidos-programados': [],
  '/api/admin/checklist-activacion-bot': { automaticos: {}, manuales: {}, listoParaActivar: false },
};
const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.png':'image/png', '.svg':'image/svg+xml', '.json':'application/json' };
const cobrados = new Set();

const leerCuerpo = (req) => new Promise((resolve) => {
  let txt = '';
  req.on('data', (c) => { txt += c; });
  req.on('end', () => { try { resolve(JSON.parse(txt || '{}')); } catch { resolve({}); } });
});

const json = (res, codigo, cuerpo) => {
  res.writeHead(codigo, { 'content-type': 'application/json' });
  res.end(JSON.stringify(cuerpo));
};

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  const cobro = url.match(/^\/pedidos\/([^/]+)\/cobro$/);
  if (cobro) {
    const folio = decodeURIComponent(cobro[1]);
    const body = await leerCuerpo(req);
    if (folio === 'XAB-RECHAZADO') return json(res, 409, { error: 'El pedido esta cancelado' });
    if (cobrados.has(folio)) return json(res, 200, { ok: true, yaCobrado: true, folio, forma_pago: 'efectivo', total: 280 });
    cobrados.add(folio);
    const items = PEDIDOS[folio]?.items || [];
    const subtotal = items.reduce((s, i) => s + i.precio_unitario * i.cantidad, 0);
    const desc = Number(body.descuento) || 0;
    const total = Math.max(0, subtotal - desc);
    const cambio = body.forma_pago === 'mixto'
      ? Math.max(0, (Number(body.mixto_efectivo) || 0) + (Number(body.mixto_terminal) || 0) - total)
      : (Number(body.billete) > 0 ? Number(body.billete) - total : 0);
    return json(res, 200, { ok: true, folio, forma_pago: body.forma_pago, subtotal, descuento: desc, canje: null, total, cambio });
  }

  const pago = url.match(/^\/api\/admin\/pedido\/([^/]+)\/pago$/);
  if (pago) {
    await leerCuerpo(req);
    if (decodeURIComponent(pago[1]) === 'XAB-RECHAZADO') return json(res, 404, { error: 'Pedido no encontrado' });
    return json(res, 200, { ok: true });
  }

  if (url.startsWith('/api/')) return json(res, 200, API[url] ?? {});

  const archivo = (url === '/' || url === '/app') ? join(PANEL_DIR, 'index.html') : join(PANEL_DIR, url.replace(/^\//, ''));
  if (archivo.startsWith(PANEL_DIR) && existsSync(archivo) && extname(archivo)) {
    res.writeHead(200, { 'content-type': MIME[extname(archivo)] || 'application/octet-stream' });
    return res.end(readFileSync(archivo));
  }
  res.writeHead(404); res.end('no');
});
await new Promise(r => server.listen(PUERTO, r));

// ── Arnes ───────────────────────────────────────────────────────────────────
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

// Toda ventana de impresion queda registrada en window.__papeles con su HTML.
// Es la unica forma de ver "que salio por la impresora" sin impresora: el
// panel imprime abriendo un popup aislado y escribiendo el documento dentro.
const espiarImpresion = () => page.evaluate(() => {
  window.__papeles = [];
  window.__bloquearPopup = false;
  window.__avisos = [];
  window.alert = (txt) => window.__avisos.push(String(txt));
  window.open = function () {
    if (window.__bloquearPopup) return null;
    const papel = { html: '' };
    window.__papeles.push(papel);
    return {
      document: { write(h) { papel.html += h; }, close() {} },
      print() {}, close() {}, onload: null,
    };
  };
});
const papeles = () => page.evaluate(() => window.__papeles.map(p => p.html));
// Los avisos del panel viven 30 s en el DOM: sin barrerlos, el de un caso se
// cuela en la medicion del siguiente y el fallo apunta al sitio equivocado.
const limpiar = () => page.evaluate(() => {
  window.__papeles = []; window.__avisos = [];
  document.querySelectorAll('#avisos-panel [role=alert]').forEach(e => e.remove());
});
const avisos = () => page.evaluate(() =>
  window.__avisos.concat([...document.querySelectorAll('#avisos-panel [role=alert]')].map(e => e.textContent)));
const sembrar = (folio) => page.evaluate((f, lista) => {
  document.querySelectorAll('.comanda').forEach(c => c.remove());
  Object.keys(pedidos).forEach(k => delete pedidos[k]);
  upsertPedidoEnTablero(JSON.parse(JSON.stringify(lista[f])));
}, folio, PEDIDOS);

// Cobra por el camino real: abre el modal, elige forma de pago con el mismo
// boton que toca el operador, llena los campos y aprieta Confirmar cobro.
const cobrar = (folio, { pago = 'efectivo', billete = '', descuento = '', motivo = '', mixtoEfectivo = '', mixtoTerminal = '' } = {}) =>
  page.evaluate(async (f, op) => {
    abrirCobro(f);
    document.querySelector(`[data-cobro-pago="${op.pago}"]`).click();
    const set = (id, v) => { if (v !== '') document.getElementById(id).value = v; };
    set('cobro-billete', op.billete);
    set('cobro-desc-val', op.descuento);
    set('cobro-desc-motivo', op.motivo);
    set('cobro-mixto-efectivo', op.mixtoEfectivo);
    set('cobro-mixto-terminal', op.mixtoTerminal);
    cobroRender();
    await confirmarCobro();
  }, folio, { pago, billete, descuento, motivo, mixtoEfectivo, mixtoTerminal });

const registrarPago = (folio, forma) => page.evaluate(async (f, fp) => {
  abrirModalPago(f);
  await confirmarPago(fp);
}, folio, forma);

try {
  await page.goto(`http://localhost:${PUERTO}/app`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => typeof renderComanda === 'function' && typeof confirmarCobro === 'function');
  await page.waitForFunction(() => typeof negocio !== 'undefined' && negocio.nombre_corto === 'XABOR');
  await espiarImpresion();

  // ── A. Cobrar un pedido abierto imprime el ticket ─────────────────────────
  await sembrar('XAB-0401');
  await limpiar();
  await cobrar('XAB-0401', { billete: 300 });
  let papel = await papeles();

  await t('A1. confirmar el cobro imprime exactamente un papel', () =>
    assert(papel.length === 1, `salieron ${papel.length}`));
  await t('A1b. si el ticket salio, no se avisa de nada', async () => {
    const a = await avisos();
    assert(a.length === 0, `aviso de sobra con el ticket impreso: ${JSON.stringify(a)}`);
  });
  await t('A2. el papel es el ticket de cliente, no la comanda de cocina', () => {
    assert(/TICKET DE CLIENTE/.test(papel[0]), 'no dice TICKET DE CLIENTE');
    assert(!/— COMANDA/.test(papel[0]), 'salio la comanda de cocina');
  });
  await t('A3. lleva la forma de pago con la que se acaba de cobrar', () =>
    assert(/Forma de pago:[\s\S]{0,120}?Efectivo/i.test(papel[0]), 'no aparece la forma de pago cobrada'));
  await t('A4. lleva el billete y el cambio que calculo el servidor', () => {
    assert(/Billete[\s\S]{0,80}?\$300/.test(papel[0]), 'sin el billete recibido');
    assert(/Cambio[\s\S]{0,80}?\$20/.test(papel[0]), 'sin el cambio ($300 - $280)');
  });
  await t('A5. el total del ticket es el que registro el servidor', () =>
    assert(/Gran Total[\s\S]{0,120}?\$280\.00/.test(papel[0]), 'el gran total no es el cobrado'));

  if (CAPTURAS && papel[0]) {
    writeFileSync(join(__dirname, '.preview-ticket-al-cobrar.html'), papel[0]);
    console.log('  ·   capturado test/.preview-ticket-al-cobrar.html');
  }

  // Descuento: el ticket tiene que traer el renglon, y con su motivo.
  await sembrar('XAB-0401');
  await limpiar();
  cobrados.delete('XAB-0401');
  await cobrar('XAB-0401', { billete: 300, descuento: 30, motivo: 'Cliente frecuente' });
  papel = await papeles();
  await t('A6. el descuento aplicado al cobrar sale en el ticket, con su motivo', () => {
    assert(papel.length === 1, `salieron ${papel.length} papeles`);
    assert(/Descuento \(Cliente frecuente\)[\s\S]{0,80}?-\$30/.test(papel[0]), 'sin el renglon de descuento');
    assert(/Gran Total[\s\S]{0,120}?\$250\.00/.test(papel[0]), 'el total no descuenta');
  });
  await t('A7. el cambio se recalcula contra el total con descuento', () =>
    assert(/Cambio[\s\S]{0,80}?\$50/.test(papel[0]), 'el cambio sigue siendo el de antes del descuento'));

  // Mixto: el desglose no viene en la respuesta del servidor, sale de lo enviado.
  await sembrar('XAB-0401');
  await limpiar();
  cobrados.delete('XAB-0401');
  await cobrar('XAB-0401', { pago: 'mixto', mixtoEfectivo: 100, mixtoTerminal: 180 });
  papel = await papeles();
  await t('A8. el pago mixto sale desglosado en efectivo y terminal', () => {
    assert(papel.length === 1, `salieron ${papel.length} papeles`);
    assert(/TOTAL POR FORMA DE PAGO/.test(papel[0]), 'sin la seccion de formas de pago');
    assert(/Efectivo[\s\S]{0,60}?\$100/.test(papel[0]), 'sin la parte en efectivo');
    assert(/Terminal[\s\S]{0,60}?\$180/.test(papel[0]), 'sin la parte en terminal');
  });

  // Reintento: el pedido ya estaba cobrado, el papel ya salio.
  await limpiar();
  await cobrar('XAB-0401', { pago: 'mixto', mixtoEfectivo: 100, mixtoTerminal: 180 });
  await t('A9. un reintento sobre un pedido ya cobrado no reimprime', async () =>
    assert((await papeles()).length === 0, 'reimprimio un pedido ya cobrado'));

  // Cobro rechazado por el servidor: no hay papel.
  await page.evaluate((p) => { pedidos['XAB-RECHAZADO'] = { ...p, id: 'XAB-RECHAZADO' }; }, PEDIDOS['XAB-0401']);
  await limpiar();
  await cobrar('XAB-RECHAZADO', { billete: 300 });
  await t('A10. un cobro que el servidor rechaza no imprime nada', async () =>
    assert((await papeles()).length === 0, 'imprimio un cobro fallido'));

  // ── B. Corregir/registrar la forma de pago desde la comanda ───────────────
  await sembrar('XAB-0402');
  await limpiar();
  await registrarPago('XAB-0402', 'terminal (tarjeta presente)');
  papel = await papeles();

  await t('B1. registrar el pago desde la comanda imprime un ticket', () =>
    assert(papel.length === 1, `salieron ${papel.length}`));
  await t('B2. el ticket trae la forma de pago NUEVA, no la anterior', () => {
    assert(/Forma de pago:[\s\S]{0,120}?Terminal/i.test(papel[0]), 'sigue saliendo la forma de pago vieja');
    assert(!/Forma de pago:[\s\S]{0,120}?Efectivo/i.test(papel[0]), 'imprimio Efectivo, que es la vieja');
  });
  await t('B3. la comanda del tablero queda con la forma de pago nueva', async () =>
    assert(await page.evaluate(() => /Terminal/i.test(document.getElementById('comanda-XAB-0402').innerText)),
      'la tarjeta no refleja el cambio'));

  // El mismo modal se abre desde el Historial, donde el pedido ya esta cerrado
  // y no vive en memoria: ahi corregir una captura vieja no debe escupir papel.
  await limpiar();
  await registrarPago('XAB-0399', 'efectivo');
  await t('B4. corregir el pago de un pedido que no esta en el tablero no imprime', async () =>
    assert((await papeles()).length === 0, 'imprimio un pedido del historial'));
  await t('B4b. y tampoco avisa de un ticket bloqueado que nunca se intento', async () => {
    const a = await avisos();
    assert(a.length === 0, `aviso falso de impresion: ${JSON.stringify(a)}`);
  });

  // Un pedido que SI esta en el tablero pero cuyo PATCH rechaza el servidor:
  // si no se cortara ahi, saldria un ticket de un pago que nunca se registro.
  await page.evaluate((p) => { pedidos['XAB-RECHAZADO'] = { ...p, id: 'XAB-RECHAZADO' }; }, PEDIDOS['XAB-0402']);
  await limpiar();
  await registrarPago('XAB-RECHAZADO', 'terminal (tarjeta presente)');
  await t('B5. un PATCH de pago que falla no imprime', async () =>
    assert((await papeles()).length === 0, 'imprimio pese al error del servidor'));
  await t('B5b. y tampoco cambia la forma de pago en memoria', async () =>
    assert(await page.evaluate(() => pedidos['XAB-RECHAZADO'].forma_pago === 'efectivo'),
      'el tablero se quedo con un pago que el servidor rechazo'));

  // ── C. Ventana bloqueada: el ticket NO salio y hay que decirlo ────────────
  await sembrar('XAB-0402');
  await limpiar();
  await page.evaluate(() => { window.__bloquearPopup = true; });
  await registrarPago('XAB-0402', 'efectivo');
  const avisados = await avisos();
  await page.evaluate(() => { window.__bloquearPopup = false; });

  await t('C1. si el navegador bloquea la ventana, el operador se entera', () =>
    assert(avisados.some(a => /bloque/i.test(a) && /XAB-0402/.test(a)),
      `sin aviso de ticket bloqueado: ${JSON.stringify(avisados)}`));
  await t('C2. el aviso dice como reimprimirlo a mano', () =>
    assert(avisados.some(a => /Ticket/.test(a)), 'el aviso no dice que use el boton Ticket'));

  // ── D. Lo que ya funcionaba sigue igual ──────────────────────────────────
  await sembrar('XAB-0402');
  await limpiar();
  await page.evaluate(() => imprimirTicketCliente('XAB-0402'));
  await t('D1. el boton manual de ticket sigue imprimiendo', async () => {
    const p = await papeles();
    assert(p.length === 1 && /TICKET DE CLIENTE/.test(p[0]), 'el boton manual dejo de imprimir');
  });

  await limpiar();
  await page.evaluate(() => imprimirComanda('XAB-0402'));
  await t('D2. la comanda de cocina sigue siendo la de cocina (sin precios)', async () => {
    const p = await papeles();
    assert(p.length === 1 && /— COMANDA/.test(p[0]), 'la comanda dejo de imprimirse');
    assert(!/Gran Total/.test(p[0]), 'la comanda de cocina salio con precios');
  });

  await limpiar();
  await page.evaluate(() => imprimirTicketCliente('XAB-0000'));
  await t('D3. imprimir un folio inexistente no revienta ni imprime', async () =>
    assert((await papeles()).length === 0, 'imprimio un folio que no existe'));

} finally {
  await navegador.close();
  server.close();
}

console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallos.length) console.log('Fallaron: ' + fallos.join(', '));
process.exit(fallidas ? 1 : 0);
