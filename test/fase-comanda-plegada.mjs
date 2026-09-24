// Tarjeta plegable del tablero de comandas.
//
// El tablero enseña de entrada solo lo que identifica al pedido —folio,
// nombre, modalidad y total— y despliega el pedido completo al hacer clic.
// Lo que esta suite protege no es el aspecto, son tres cosas que se rompen
// sin dar la cara:
//   · que el detalle ESTÉ ahí aunque no se vea (cocina e impresión),
//   · que una tarjeta abierta NO se cierre sola cuando el WebSocket repinta
//     la tarjeta (pasa en cada 'actualizar_pago' y 'repartidor_asignado'),
//   · que el estado se actualice en las DOS etiquetas, la del resumen y la
//     del detalle, y no solo en la primera.
//
// No necesita Postgres: levanta un servidor estático de juguete que sirve
// panel/ y contesta /api/* con datos canónicos, y maneja el panel REAL con
// Puppeteer. Corre en cualquier máquina.
//
// Uso: node test/fase-comanda-plegada.mjs [--capturas]
//   --capturas escribe test/.preview-comanda-{plegada,abierta,movil}.png
//   TEST_PORT_PLEGADA fija el puerto; sin él toma uno libre del sistema
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PANEL_DIR = join(__dirname, '..', 'panel');
const CAPTURAS = process.argv.includes('--capturas');
// Puerto 0 = el sistema da uno libre. En esta máquina hay puertos ocupados por
// servicios ajenos y por otras sesiones corriendo suites: un puerto fijo por
// omisión solo sirve para que la suite muera con EADDRINUSE sin haber probado
// nada.
const PUERTO = Number(process.env.TEST_PORT_PLEGADA || 0);

// ── Servidor de juguete ─────────────────────────────────────────────────────
// Solo lo justo para que el panel arranque: si /api/auth/me falla, el panel se
// va a login y no hay nada que medir.
const API = {
  '/api/auth/me': { rol: 'admin', negocioId: 'neg-prueba', modulos: ['pos','whatsapp','menu'], whatsappConfigurado: true },
  '/api/config/operativa': { nombre: 'Restaurante Prueba', nombre_corto: 'XABOR', direccion: 'Calle 1', ciudad: 'Matamoros', rfc: 'XAXX010101000', telefono: '8781234567', whatsapp: '8781234567' },
  '/api/pedidos-programados': [],
  '/api/admin/checklist-activacion-bot': { automaticos: {}, manuales: {}, listoParaActivar: false },
};
const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.png':'image/png', '.svg':'image/svg+xml', '.json':'application/json' };

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
await new Promise(r => server.listen(PUERTO, r));
const puerto = server.address().port;

// ── Pedidos de prueba ───────────────────────────────────────────────────────
const pedido = (id, nombre, total, modalidad, extra = {}) => ({
  id, estado: 'nuevo', canal: 'whatsapp', modalidad, total, forma_pago: 'efectivo',
  timestamp: new Date(Date.now() - 7 * 60000).toISOString(),
  cliente: { nombre, telefono: '8781579883' },
  items: [
    { nombre: 'Combito de Cuernito', cantidad: 1, precio_unitario: 225,
      modificadores: [{ grupo: 'Cuernito', opcion: 'Bacon Cheese' }, { grupo: 'Topping', opcion: 'Hershey´s' }] },
    { nombre: 'Licuado', cantidad: 1, precio_unitario: 55,
      modificadores: [{ grupo: 'Sabor', opcion: 'Fresa' }, { grupo: 'Tipo de Leche', opcion: 'Deslactosada' }] },
  ],
  ...extra,
});
const PEDIDOS = [
  pedido('XAB-0382', 'ALMA TORRES', 280, 'recoger en tienda'),
  pedido('XAB-0381', 'pedro', 225, 'entrega a domicilio', { cliente: { nombre: 'pedro', telefono: '8787913410', calle: 'Av. Siempre Viva 123', colonia: 'Centro' } }),
  pedido('XAB-0380', 'monserrat', 335, 'en tienda', { canal: 'presencial', forma_pago: 'por_cobrar', cliente: { nombre: 'monserrat', telefono: '—' } }),
];

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

try {
  // /app a secas abre Inicio; esta suite mide el tablero, así que entra
  // directo a él por su dirección.
  await page.goto(`http://localhost:${puerto}/app#pedidos`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => typeof renderComanda === 'function');
  await page.evaluate((lista) => lista.forEach(p => upsertPedidoEnTablero(p)), PEDIDOS);

  const medir = () => page.evaluate(() => [...document.querySelectorAll('.comanda')].map(c => {
    const det = c.querySelector('.comanda-detalle'), res = c.querySelector('.comanda-resumen');
    return {
      id: c.id,
      alto: Math.round(c.getBoundingClientRect().height),
      detalleVisible: !!det && det.getBoundingClientRect().height > 0,
      resumenVisible: !!res && res.getBoundingClientRect().height > 0,
      aria: res?.getAttribute('aria-expanded'),
      texto: res?.innerText.replace(/\s+/g, ' ').trim(),
      altoGrid: Math.round(document.getElementById('grid-pedidos').getBoundingClientRect().height),
    };
  }));
  const de = (lista, id) => lista.find(c => c.id === `comanda-${id}`);

  // ── A. Plegada por omisión ────────────────────────────────────────────────
  let est = await medir();
  await t('A1. las tres tarjetas se proyectan en el tablero', () => assert(est.length === 3, `hay ${est.length}`));
  await t('A2. el detalle no se ve', () => assert(est.every(c => !c.detalleVisible), 'algún detalle quedó visible'));
  await t('A3. el resumen sí se ve', () => assert(est.every(c => c.resumenVisible), 'algún resumen quedó oculto'));
  await t('A4. el resumen lleva folio, nombre, modalidad, estado y total', () => {
    const c = de(est, 'XAB-0382');
    for (const txt of ['#382', 'ALMA TORRES', '$280', 'RECOGER EN TIENDA', 'Nuevo'])
      assert(c.texto.includes(txt), `falta "${txt}" en: ${c.texto}`);
  });
  await t('A5. el cronómetro se puebla al pintar, no 30s después', () => {
    const c = de(est, 'XAB-0382');
    assert(/7m/.test(c.texto), `sin cronómetro: ${c.texto}`);
  });
  await t('A6. una tarjeta plegada mide menos de 130px', () => {
    const altos = est.map(c => c.alto);
    assert(altos.every(a => a < 130), `altos: ${altos.join(', ')}`);
  });
  await t('A7. un pedido por cobrar avisa sin abrirlo', () => {
    assert(de(est, 'XAB-0380').texto.includes('Por cobrar'), de(est, 'XAB-0380').texto);
  });
  await t('A8. "sin comanda en Edge" se ve con la tarjeta plegada', async () => {
    // La cocina sin papel es lo único que no puede esperar a que alguien abra
    // la tarjeta. En ramas sin impresión Edge el caso no aplica.
    const hayEdge = await page.evaluate(() => typeof badgeImpresionEdge === 'function');
    if (!hayEdge) { console.log('       (no aplica: esta rama no tiene impresión Edge)'); return; }
    const v = await page.evaluate(() => {
      const p = pedidos['XAB-0381'];
      p.impresion_edge = { estado: 'sin_trabajos', alerta: true, sin_ruta: ['COCINA'], avisos: [] };
      upsertPedidoEnTablero(p);
      const res = document.querySelector('#comanda-XAB-0381 .comanda-resumen');
      const rutina = { ...p, impresion_edge: { estado: 'ok', impresoras: ['COCINA'], trabajos: 1 } };
      document.getElementById('comanda-XAB-0381').innerHTML = renderComanda(rutina);
      const tras = document.querySelector('#comanda-XAB-0381 .comanda-resumen').innerText;
      p.impresion_edge = null; upsertPedidoEnTablero(p);
      return { alerta: res.innerText, rutina: tras };
    });
    assert(/Sin comanda/i.test(v.alerta), `la alerta no subió al resumen: ${v.alerta}`);
    assert(!/Edge/.test(v.rutina), `el distintivo de rutina no debe ensuciar el resumen: ${v.rutina}`);
  });

  // ── B. El clic despliega ──────────────────────────────────────────────────
  await t('B1. el detalle aparece con un clic', async () => {
    const hay = await page.$('#comanda-XAB-0382 .comanda-resumen');
    assert(hay, 'la tarjeta no tiene resumen en el que hacer clic');
    await page.click('#comanda-XAB-0382 .comanda-resumen');
    est = await medir();
    assert(de(est, 'XAB-0382').detalleVisible, 'sigue oculto tras el clic');
  });
  await t('B2. aria-expanded acompaña al despliegue', () => assert(de(est, 'XAB-0382').aria === 'true', `aria=${de(est, 'XAB-0382').aria}`));
  await t('B3. las demás no se abren solas', () => assert(est.filter(c => c.id !== 'comanda-XAB-0382').every(c => !c.detalleVisible), 'se abrieron otras'));
  await t('B4. el detalle trae items, modificadores, total y botones', async () => {
    const txt = await page.$eval('#comanda-XAB-0382 .comanda-detalle', el => el.innerText);
    for (const s of ['Combito de Cuernito', 'Bacon Cheese', 'Licuado', 'Gran Total', '$280', 'Comanda', 'Ticket', 'Preparando', 'Entregado'])
      assert(txt.includes(s), `falta "${s}" en el detalle`);
  });
  await t('B5. el detalle no repite lo que ya dice el resumen', async () => {
    const v = await page.evaluate(() => {
      const d = document.querySelector('#comanda-XAB-0382 .comanda-detalle');
      const oculto = s => getComputedStyle(d.querySelector(s)).display === 'none';
      return { nombre: oculto('.comanda-nombre'), modalidad: oculto('.badge-modalidad'),
               estado: oculto('.badge-estado-pedido'), pago: d.innerText.includes('Pago: Efectivo') };
    });
    assert(v.nombre && v.modalidad && v.estado, `se repiten: ${JSON.stringify(v)}`);
    assert(v.pago, 'se perdió la forma de pago, que el resumen NO muestra');
  });

  // ── C. El repintado del WebSocket no la cierra ────────────────────────────
  const repintar = (id) => page.evaluate((f) => {
    document.getElementById(`comanda-${f}`).innerHTML = renderComanda(pedidos[f]);
  }, id);
  await repintar('XAB-0382');
  est = await medir();
  await t('C1. sigue abierta tras repintar la tarjeta (actualizar_pago, repartidor)', () =>
    assert(de(est, 'XAB-0382').detalleVisible, 'el repintado cerró el pedido que el cajero estaba mirando'));
  await t('C2. las plegadas siguen plegadas tras repintar', () =>
    assert(est.filter(c => c.id !== 'comanda-XAB-0382').every(c => !c.detalleVisible), 'se abrieron solas'));
  await t('C3. MORDIDA: sin el registro de abiertas, C1 falla', async () => {
    await page.evaluate(() => comandasAbiertas.clear());
    await repintar('XAB-0382');
    const v = await medir();
    assert(!de(v, 'XAB-0382').detalleVisible,
      'apagando el registro la tarjeta sigue abierta: C1 no estaba probando nada');
    await page.evaluate(() => comandasAbiertas.add('XAB-0382'));
    await repintar('XAB-0382');
  });

  // ── D. El estado, en las dos etiquetas ────────────────────────────────────
  await t('D1. cada pedido tiene dos etiquetas de estado', async () => {
    const n = await page.evaluate(() => document.querySelectorAll('[data-pedido-estado="XAB-0382"]').length);
    assert(n === 2, `hay ${n}`);
  });
  await t('D2. cambiar el estado las actualiza a las dos', async () => {
    await page.evaluate(() => actualizarEstadoUI('XAB-0382', 'listo'));
    const txt = await page.evaluate(() => [...document.querySelectorAll('[data-pedido-estado="XAB-0382"]')].map(e => e.textContent));
    assert(txt.length === 2 && txt.every(s => s === 'Listo para recoger'), JSON.stringify(txt));
  });
  await t('D3. el borde de la tarjeta sigue al estado', async () => {
    const cls = await page.evaluate(() => document.getElementById('comanda-XAB-0382').className);
    assert(cls.includes('listo'), cls);
  });
  await t('D4. MORDIDA: actualizando solo la primera, D2 falla', async () => {
    const distintas = await page.evaluate(() => {
      document.querySelectorAll('[data-pedido-estado="XAB-0382"]').forEach(e => { e.textContent = 'Nuevo'; });
      document.querySelector('[data-pedido-estado="XAB-0382"]').textContent = 'Listo para recoger'; // querySelector, el de antes
      const t = [...document.querySelectorAll('[data-pedido-estado="XAB-0382"]')].map(e => e.textContent);
      return t[0] !== t[1];
    });
    assert(distintas, 'las dos etiquetas no se distinguen: D2 no estaría probando nada');
    await page.evaluate(() => actualizarEstadoUI('XAB-0382', 'listo'));
  });

  // ── E. Los botones no pliegan ─────────────────────────────────────────────
  await t('E1. tocar "Preparando" no cierra la tarjeta', async () => {
    await page.click('#comanda-XAB-0382 .btn-preparando');
    await new Promise(r => setTimeout(r, 300));
    const v = await medir();
    assert(de(v, 'XAB-0382').detalleVisible, 'el clic en un botón del detalle la cerró');
  });

  // ── F. Impresión ──────────────────────────────────────────────────────────
  await page.emulateMediaType('print');
  await t('F1. en papel sale el pedido completo aunque esté plegado', async () => {
    const v = await page.evaluate(() => {
      const c = document.getElementById('comanda-XAB-0381');  // plegada
      return {
        detalle: getComputedStyle(c.querySelector('.comanda-detalle')).display,
        resumen: getComputedStyle(c.querySelector('.comanda-resumen')).display,
        header:  getComputedStyle(c.querySelector('.comanda-header')).display,
        items:   c.querySelector('.comanda-items').getBoundingClientRect().height > 0,
      };
    });
    assert(v.detalle === 'block', `detalle=${v.detalle}`);
    assert(v.resumen === 'none', `el resumen de pantalla no va en el papel: ${v.resumen}`);
    assert(v.header === 'block', `el membrete del ticket no salió: ${v.header}`);
    assert(v.items, 'los items no miden nada en papel');
  });
  await t('F2. en papel vuelven el nombre y la modalidad del ticket', async () => {
    const v = await page.evaluate(() => {
      const d = document.querySelector('#comanda-XAB-0381 .comanda-detalle');
      return { nombre: getComputedStyle(d.querySelector('.comanda-nombre')).display,
               modalidad: getComputedStyle(d.querySelector('.badge-modalidad')).display,
               texto: d.innerText };
    });
    assert(v.nombre === 'block' && v.modalidad === 'block', JSON.stringify(v).slice(0, 120));
    // El bloque de impresión pone el nombre en mayúsculas.
    assert(/pedro/i.test(v.texto) && v.texto.includes('ENTREGA A DOMICILIO'), `el ticket perdió datos: ${v.texto.slice(0, 160)}`);
  });
  await page.emulateMediaType('screen');

  // ── G. Espacio ganado ─────────────────────────────────────────────────────
  const plegarTodo = (abrir) => page.evaluate((a) => {
    comandasAbiertas.clear();
    Object.values(pedidos).forEach(p => {
      if (a) comandasAbiertas.add(p.id);
      document.getElementById(`comanda-${p.id}`).innerHTML = renderComanda(p);
    });
    return Math.round(document.getElementById('grid-pedidos').getBoundingClientRect().height);
  }, abrir);
  const altoPlegado = await plegarTodo(false);
  const altoAbierto = await plegarTodo(true);
  await t(`G1. el tablero plegado ocupa menos de la mitad (${altoPlegado}px vs ${altoAbierto}px)`, () =>
    assert(altoPlegado < altoAbierto / 2, `${altoPlegado} vs ${altoAbierto}`));

  // ── H. Móvil y nombres largos ─────────────────────────────────────────────
  await plegarTodo(false);
  await page.evaluate(() => upsertPedidoEnTablero({ ...pedidos['XAB-0382'], id: 'XAB-0383', total: 1240,
    cliente: { nombre: 'MARÍA DE LOS ÁNGELES HERNÁNDEZ DE LA GARZA', telefono: '8781112233' } }));
  await page.setViewport({ width: 390, height: 844 });
  await new Promise(r => setTimeout(r, 200));
  await t('H1. el resumen no desborda a lo ancho en móvil', async () => {
    const malas = await page.evaluate(() => [...document.querySelectorAll('.comanda-resumen')]
      .filter(r => r.scrollWidth > r.clientWidth + 1).map(r => r.closest('.comanda').id));
    assert(malas.length === 0, `desbordan: ${malas.join(', ')}`);
  });
  await t('H2. un nombre kilométrico se recorta y el total sigue a la vista', async () => {
    const v = await page.evaluate(() => {
      const c = document.getElementById('comanda-XAB-0383');
      const n = c.querySelector('.resumen-nombre'), tot = c.querySelector('.resumen-total');
      return { recortado: n.scrollWidth > n.clientWidth, total: tot.innerText,
               dentro: tot.getBoundingClientRect().right <= c.getBoundingClientRect().right + 1 };
    });
    assert(v.recortado, 'el nombre no se recortó: empujaría el total fuera');
    assert(v.total === '$1240' && v.dentro, `total fuera de la tarjeta: ${JSON.stringify(v)}`);
  });
  if (CAPTURAS) await page.screenshot({ path: join(__dirname, '.preview-comanda-movil.png') });
  await page.setViewport({ width: 1400, height: 900 });

  if (CAPTURAS) {
    await page.evaluate(() => { document.getElementById('comanda-XAB-0383')?.remove(); delete pedidos['XAB-0383']; });
    await plegarTodo(false);
    await page.screenshot({ path: join(__dirname, '.preview-comanda-plegada.png') });
    await page.evaluate(() => toggleComanda('XAB-0382'));
    await page.screenshot({ path: join(__dirname, '.preview-comanda-abierta.png') });
  }
} catch (e) {
  // Un fallo fuera de un caso (un selector que ya no existe, por ejemplo) no
  // puede dejar a la suite sin línea de resumen: el runner que las corre
  // todas la busca con /(\d+) pasadas, (\d+) fallidas/.
  console.log(`FALLO fatal, la suite se detuvo: ${e.message}`);
  fallidas++; fallos.push(`fatal: ${e.message}`);
} finally {
  await navegador.close();
  server.close();
}

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallos.length) fallos.forEach(f => console.log(` - ${f}`));
process.exit(fallidas > 0 ? 1 : 0);
