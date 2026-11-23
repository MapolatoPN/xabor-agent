// El ticket del cliente y la tarjeta del tablero solo enseñan datos de verdad.
//
// Fase 0.4 (23-nov-2026). Tres cosas salían en el papel y en la tarjeta:
//   - «Tel: pos-…»: el mostrador sin cliente guarda como teléfono un
//     identificador técnico (idClienteTecnicoPresencial en server.js); Rappi
//     guarda «rappi-…». Ninguno es un número al que se pueda llamar.
//   - «WhatsApp:» suelto al pie: ningún negocio tiene esa clave en
//     Configuración. Igual «RFC:» o «TEL:» vacíos en el membrete.
//   - En la tarjeta, los modificadores dos veces: la lista por grupo y otra
//     vez en la nota, que POS y tienda arman pegándolos.
//
// No necesita Postgres: servidor estático de juguete + panel real con
// Puppeteer, igual que fase-panel-escapa-cliente.
//
// Uso: node test/fase-ticket-datos-limpios.mjs   (CASOS=A,B para filtrar)
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PANEL_DIR = join(__dirname, '..', 'panel');
const FILTRO = (process.env.CASOS || '').split(',').map(s => s.trim()).filter(Boolean);

const NEGOCIO = { nombre: 'Restaurante Prueba', nombre_corto: 'XABOR', direccion: 'Calle 1', ciudad: 'Matamoros', rfc: 'XAXX010101000', telefono: '8781234567', whatsapp: '' };
const API = {
  '/api/auth/me': { rol: 'admin', negocioId: 'neg-prueba', modulos: ['pos', 'whatsapp', 'menu', 'restaurante', 'caja'], whatsappConfigurado: true },
  '/api/config/operativa': NEGOCIO,
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
  const clave = nombre.split('.')[0].trim();
  if (FILTRO.length && !FILTRO.includes(clave) && !FILTRO.includes(clave.replace(/\d+$/, ''))) return;
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(nombre); }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const veces = (texto, aguja) => texto.split(aguja).length - 1;

const TEL_POS = 'pos-0a1b2c3d4e5f';
const TEL_RAPPI = 'rappi-778899';
const TEL_REAL = '8781112233';
const pedido = (id, extra = {}) => ({
  id, estado: 'nuevo', canal: 'presencial', modalidad: 'recoger en tienda', total: 100, forma_pago: 'efectivo',
  timestamp: new Date().toISOString(),
  cliente: { nombre: 'Mostrador', telefono: TEL_POS },
  items: [{ nombre: 'Café', cantidad: 1, precio_unitario: 100 }],
  ...extra,
});
const domicilio = (id, telefono) => pedido(id, {
  canal: 'tienda_online', modalidad: 'entrega a domicilio',
  cliente: { nombre: 'Ana', telefono, direccion: 'Calle 2 #10', colonia: 'Centro' },
});

const navegador = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await navegador.newPage();
await page.setViewport({ width: 1400, height: 900 });
page.on('dialog', d => d.dismiss().catch(() => {}));

const ticket = (p) => page.evaluate((x) => ticketHTML(x), p);
const tarjeta = (p) => page.evaluate((x) => renderComanda(x), p);
// `negocio` es un `let` del script del panel: se cambia para cada caso y se
// deja como lo sirvió /api/config/operativa al terminar.
const conNegocio = (cambios) => page.evaluate((c) => { negocio = { ...negocio, ...c }; }, cambios);

try {
  await page.goto(`http://localhost:${puerto}/app#pedidos`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => typeof ticketHTML === 'function' && typeof renderComanda === 'function' && typeof negocio === 'object' && negocio.rfc);

  // ── A. Teléfono del cliente ───────────────────────────────────────────────
  await t('A1. ticket de mostrador: no imprime el teléfono técnico pos-', async () => {
    const html = await ticket(pedido('XAB-9201'));
    assert(!html.includes('pos-'), 'el ticket imprime «pos-…»');
    assert(!html.includes('>Teléfono<'), 'el ticket imprime el renglón «Teléfono» sin número');
  });
  await t('A2. tarjeta de mostrador: no enseña «Tel: pos-»', async () => {
    const html = await tarjeta(pedido('XAB-9202'));
    assert(!html.includes('pos-'), 'la tarjeta enseña «pos-…»');
    assert(!/Tel:|Cel:/.test(html), 'la tarjeta enseña «Tel:»/«Cel:» sin número');
  });
  await t('A3. Rappi: ni ticket ni tarjeta enseñan «rappi-»', async () => {
    const p = pedido('XAB-9203', { canal: 'rappi', cliente: { nombre: 'Rappi', telefono: TEL_RAPPI } });
    const [tk, tj] = [await ticket(p), await tarjeta(p)];
    assert(!tk.includes(TEL_RAPPI), 'el ticket imprime «rappi-…»');
    assert(!tj.includes(TEL_RAPPI), 'la tarjeta enseña «rappi-…»');
  });
  await t('A4. un teléfono real se sigue imprimiendo (recoger)', async () => {
    const p = pedido('XAB-9204', { canal: 'whatsapp', cliente: { nombre: 'Luis', telefono: TEL_REAL } });
    const [tk, tj] = [await ticket(p), await tarjeta(p)];
    assert(tk.includes('>Teléfono<') && tk.includes(TEL_REAL), 'el ticket perdió el teléfono real');
    assert(tj.includes(`Tel: ${TEL_REAL}`), 'la tarjeta perdió el teléfono real');
  });
  await t('A5. un teléfono real se sigue imprimiendo (domicilio)', async () => {
    const p = domicilio('XAB-9205', TEL_REAL);
    const [tk, tj] = [await ticket(p), await tarjeta(p)];
    assert(tk.includes('DATOS DEL CLIENTE') && tk.includes('>Teléfono<') && tk.includes(TEL_REAL), 'el ticket de domicilio perdió el teléfono');
    assert(tj.includes(`Cel: ${TEL_REAL}`), 'la tarjeta de domicilio perdió el teléfono');
  });
  await t('A6. domicilio sin teléfono: el ticket no deja «Teléfono» vacío ni «—»', async () => {
    for (const tel of ['', '—', TEL_POS]) {
      const html = await ticket(domicilio('XAB-9206', tel));
      assert(html.includes('DATOS DEL CLIENTE') && html.includes('Calle 2'), 'se perdieron los datos del cliente');
      assert(!html.includes('>Teléfono<'), `con teléfono ${JSON.stringify(tel)} el ticket deja el renglón «Teléfono»`);
    }
  });

  // ── B. Membrete y pie del ticket ──────────────────────────────────────────
  await t('B1. sin WhatsApp del negocio: ni el ticket ni la tarjeta dicen «WhatsApp:»', async () => {
    for (const w of ['', '   ', null, undefined]) {
      await conNegocio({ whatsapp: w });
      const [tk, tj] = [await ticket(pedido('XAB-9211')), await tarjeta(pedido('XAB-9211'))];
      assert(!tk.includes('WhatsApp:'), `ticket con whatsapp=${JSON.stringify(w)} dice «WhatsApp:»`);
      assert(!tj.includes('WhatsApp:'), `tarjeta con whatsapp=${JSON.stringify(w)} dice «WhatsApp:»`);
      assert(tk.includes('Gracias por su visita'), 'se perdió el pie del ticket');
    }
  });
  await t('B2. con WhatsApp del negocio: sale en el ticket y en la tarjeta', async () => {
    await conNegocio({ whatsapp: '8789990000' });
    const [tk, tj] = [await ticket(pedido('XAB-9212')), await tarjeta(pedido('XAB-9212'))];
    assert(tk.includes('WhatsApp: 8789990000'), 'el ticket no imprime el WhatsApp del negocio');
    assert(tj.includes('WhatsApp: 8789990000'), 'la tarjeta no enseña el WhatsApp del negocio');
  });
  await t('B3. sin RFC ni teléfono del negocio: no salen «RFC:» ni «TEL:»', async () => {
    await conNegocio({ rfc: '', telefono: '' });
    const [tk, tj] = [await ticket(pedido('XAB-9213')), await tarjeta(pedido('XAB-9213'))];
    assert(!tk.includes('RFC:') && !tk.includes('TEL:'), 'el ticket deja «RFC:»/«TEL:» vacíos');
    assert(!tj.includes('RFC:'), 'la tarjeta deja «RFC:» vacío');
  });
  await t('B4. solo RFC o solo teléfono: sale nada más el que hay', async () => {
    await conNegocio({ rfc: 'XAXX010101000', telefono: '' });
    let [tk, tj] = [await ticket(pedido('XAB-9214')), await tarjeta(pedido('XAB-9214'))];
    assert(tk.includes('RFC: XAXX010101000') && !tk.includes('TEL:'), 'ticket con solo RFC');
    assert(tj.includes('RFC: XAXX010101000') && !tj.includes('XAXX010101000 ·'), 'tarjeta con solo RFC deja el separador');
    await conNegocio({ rfc: '', telefono: '8781234567' });
    [tk, tj] = [await ticket(pedido('XAB-9214')), await tarjeta(pedido('XAB-9214'))];
    assert(tk.includes('TEL: 8781234567') && !tk.includes('RFC:'), 'ticket con solo teléfono');
    assert(tj.includes('8781234567') && !tj.includes('RFC:'), 'tarjeta con solo teléfono');
  });
  await t('B5. con los dos: el membrete queda como antes', async () => {
    await conNegocio({ rfc: 'XAXX010101000', telefono: '8781234567' });
    const [tk, tj] = [await ticket(pedido('XAB-9215')), await tarjeta(pedido('XAB-9215'))];
    assert(tk.includes('RFC: XAXX010101000 &nbsp;&nbsp; TEL: 8781234567'), 'el membrete del ticket cambió');
    assert(tj.includes('RFC: XAXX010101000 · 8781234567'), 'el membrete de la tarjeta cambió');
  });
  await t('B6. los datos del negocio se escapan', async () => {
    await conNegocio({ whatsapp: '878<b>x</b>', rfc: 'X<i>' });
    const [tk, tj] = [await ticket(pedido('XAB-9216')), await tarjeta(pedido('XAB-9216'))];
    assert(!tk.includes('<b>x</b>') && tk.includes('878&lt;b&gt;'), 'el WhatsApp del negocio no se escapa en el ticket');
    assert(!tj.includes('X<i>') && tj.includes('X&lt;i&gt;'), 'el RFC no se escapa en la tarjeta');
    await conNegocio(NEGOCIO);
  });

  // ── C. Modificadores en la tarjeta ────────────────────────────────────────
  const mods = [{ grupo: 'Salsa', opcion: 'Roja' }, { grupo: 'Proteína', opcion: 'Pollo' }];
  const conItem = (id, item) => pedido(id, { items: [{ nombre: 'Chilaquiles', cantidad: 1, precio_unitario: 100, ...item }] });
  await t('C1. nota que solo repite los modificadores: no sale otra vez', async () => {
    for (const notas of ['Salsa: Roja · Proteína: Pollo', 'Salsa: Roja, Proteína: Pollo']) {
      const html = await tarjeta(conItem('XAB-9221', { modificadores: mods, notas }));
      assert(veces(html, 'Roja') === 1 && veces(html, 'Pollo') === 1, `«${notas}»: los modificadores salen ${veces(html, 'Roja')} veces`);
      assert(!html.includes('item-nota'), `«${notas}»: queda una nota vacía o repetida`);
    }
  });
  await t('C2. nota con texto propio: se queda lo que escribió el cliente', async () => {
    const html = await tarjeta(conItem('XAB-9222', { modificadores: mods, notas: 'Salsa: Roja · Proteína: Pollo · sin cebolla' }));
    assert(veces(html, 'Roja') === 1, 'los modificadores se repiten');
    assert(/class="item-nota">sin cebolla</.test(html), 'se perdió «sin cebolla»');
  });
  await t('C3. nota escrita a mano sin modificadores: sale completa', async () => {
    const html = await tarjeta(conItem('XAB-9223', { notas: 'sin cebolla, bien dorado' }));
    assert(html.includes('class="item-nota">sin cebolla, bien dorado<'), 'la nota a mano se recortó');
  });
  await t('C4. el ticket del cliente sigue imprimiendo la nota una vez', async () => {
    const html = await ticket(conItem('XAB-9224', { modificadores: mods, notas: 'Salsa: Roja · Proteína: Pollo' }));
    assert(veces(html, 'Roja') === 1, `el ticket imprime los modificadores ${veces(html, 'Roja')} veces`);
  });

  // ── D. Historial ──────────────────────────────────────────────────────────
  await t('D1. historial: el detalle no enseña «Tel: pos-»', async () => {
    const lista = [
      { ...pedido('XAB-9231'), _estado: 'entregado', entregado_at: new Date().toISOString() },
      { ...pedido('XAB-9232', { canal: 'whatsapp', cliente: { nombre: 'Luis', telefono: TEL_REAL } }), _estado: 'entregado', entregado_at: new Date().toISOString() },
    ];
    await page.evaluate((resp) => {
      window.apiFetch = async (url) => {
        const ruta = String(url).split('?')[0];
        const cuerpo = ruta === '/api/historial' ? resp : {};
        return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(cuerpo)), clone() { return this; } };
      };
    }, lista);
    await page.evaluate(() => cargarHistorial());
    await page.waitForFunction(() => (document.getElementById('historial-lista')?.innerHTML || '').includes('XAB-923'), { timeout: 5000 }).catch(() => {});
    const html = await page.evaluate(() => document.getElementById('historial-lista')?.innerHTML || '');
    assert(html.includes('Luis') || html.includes(TEL_REAL), 'el historial no se pintó');
    assert(!html.includes('pos-'), 'el historial enseña «pos-…»');
    assert(html.includes(`Tel: ${TEL_REAL}`), 'el historial perdió el teléfono real');
  });

  // ── Z. Guardas ────────────────────────────────────────────────────────────
  await t('Z1. los ayudantes nuevos están declarados una sola vez', async () => {
    const html = readFileSync(join(PANEL_DIR, 'index.html'), 'utf8');
    for (const nombre of ['telefonoImprimible', 'whatsappDelNegocio', 'membreteFiscal', 'getTelefono', 'notaSinMods']) {
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
