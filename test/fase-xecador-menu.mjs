// Xecador › Empleados en el menú del panel, manejado en un navegador de verdad.
//
// El directorio de empleados (/personal) se abre DENTRO del panel, en un
// marco, igual que Compras. Lo que esta suite protege:
//   · la entrada solo aparece con el módulo 'personal' encendido y solo para
//     el administrador del negocio; apagado o suspendido no aparece, ni en el
//     menú ni en el cajón «Más» del celular, y #empleados no carga nada; el
//     Superadmin (sesión normal o de soporte) tampoco la ve;
//   · abrirla no crea un segundo panel: ni otra pestaña, ni otra conexión
//     /ws/panel, ni otro /app dentro del marco, ni ventanas de impresión;
//   · se vuelve con el menú de siempre, y lo capturado en el marco no se
//     pierde;
//   · estando en Empleados, un pedido nuevo suena e imprime su comanda UNA
//     vez, y el tablero y «+ Nuevo pedido» siguen funcionando;
//   · si la sesión vence adentro, el login ocupa la ventana completa y
//     regresa a /app#empleados; si apagan el módulo a media sesión, el marco
//     lo dice en vez de aparentar que funciona.
// El rechazo del servidor (requireModulo + admin con sesión real) lo prueba
// fase-xecador-empleados (B1, B2, B6, B10, B13, B14) contra Postgres.
//
// No necesita Postgres: servidor de juguete que sirve panel/, contesta /api/*
// con datos fijos y abre un WebSocket /ws/panel para empujar un pedido.
//
// Uso: node test/fase-xecador-menu.mjs
//   TEST_PORT_XECADOR_MENU fija el puerto; sin él toma uno libre del sistema
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { WebSocketServer } from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PANEL_DIR = join(__dirname, '..', 'panel');
const PUERTO = Number(process.env.TEST_PORT_XECADOR_MENU || 0);

// ── Servidor de juguete ─────────────────────────────────────────────────────
const SIN_PERSONAL = ['pos', 'caja', 'menu', 'whatsapp', 'restaurante', 'rewards', 'cotizaciones', 'voz', 'usuarios', 'tienda_online', 'facturacion'];
const CON_PERSONAL = [...SIN_PERSONAL, 'personal'];
let sesion = { rol: 'admin', modulos: CON_PERSONAL };
// Lo que pide el marco de Empleados: la página, su API y si la sesión venció
// o el módulo se suspendió a media sesión.
const pedidas = { app: 0, personal: 0, apiPersonal: 0 };
let vencidaPersonal = false;
let suspendidoPersonal = false;
let conexionesWs = 0;
const EMPLEADOS = [
  { id: '00000000-0000-4000-8000-000000000007', numero_empleado: 7, nombre: 'Juana Prueba', puesto: 'Cocina', telefono: null, estatus: 'activo' },
  { id: '00000000-0000-4000-8000-000000000008', numero_empleado: 8, nombre: 'Pedro Prueba', puesto: 'Barra', telefono: '8781234567', estatus: 'activo' },
];
const menuPOS = () => [{ id: 1, nombre: 'Pollo', activa: true, orden: 1, productos: [
  { id: 11, nombre: 'Chicken Louisiana', precio: 180, descripcion: 'Pechuga empanizada', disponible: true, agotado: false, destacado: false, imagen: null, categoria_id: 1 },
] }];
// Lo que contesta /api/auth/me, con la misma regla que el servidor real
// (personalRutas.js › puedeAdministrarPersonal): el Superadmin, con su sesión
// normal o en soporte, no administra empleados. sinPermisoXecador simula un
// servidor que no manda el dato.
const me = () => ({
  rol: sesion.rol, negocioId: 'neg-prueba', modulos: sesion.modulos, whatsappConfigurado: true,
  ...(sesion.sinPermisoXecador ? {} : { puedeAdministrarPersonal: sesion.rol === 'admin' && !sesion.soporte && !sesion.superadmin
    && sesion.modulos.includes('personal') }),
  ...(sesion.soporte ? { soporte: { activo: true, negocioNombre: 'Restaurante Prueba' } } : {}),
});
const API = () => ({
  '/api/auth/me': me(),
  '/api/config/operativa': { nombre: 'Restaurante Prueba', nombre_corto: 'XABOR', direccion: 'Calle 1', ciudad: 'Matamoros', rfc: 'XAXX010101000', telefono: '8781234567', whatsapp: '8781234567' },
  '/api/pedidos-programados': [],
  '/api/admin/checklist-activacion-bot': { automaticos: {}, manuales: {}, listoParaActivar: false },
  '/api/ventas/resumen': { total_ventas: 0, num_pedidos: 0 },
  '/api/impresion/self-service': { hayEquipo: false, cobertura: {} },
  '/api/conversaciones': [],
  '/api/bot-whatsapp': { botWhatsappActivo: false },
  '/api/admin/clientes/oportunidades': [],
  '/api/admin/campanas': [],
  '/api/ventas': [],
  '/api/restaurante/meseros': { sesionMesero: false, negocio: 'Restaurante Prueba', meseros: [] },
  '/api/restaurante/mesas': { mesas: [{ mesa: 1, ocupada: false }] },
  '/api/menu': menuPOS(),
  '/api/admin/menu': menuPOS(),
  '/api/personal/empleados': { empleados: EMPLEADOS, siguienteNumero: 9 },
});
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  if (url.startsWith('/api/')) {
    const delMarco = (req.headers.referer || '').includes('/personal');
    if (url.startsWith('/api/personal/')) pedidas.apiPersonal++;
    // Sesión vencida dentro del marco: solo lo que pide esa página (el panel
    // de afuera sigue con sesión, como cuando vence la del marco primero).
    if (vencidaPersonal && delMarco && (url === '/api/auth/me' || url.startsWith('/api/personal/'))) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end('{"error":"sesión vencida"}');
    }
    if (suspendidoPersonal && url.startsWith('/api/personal/')) {
      res.writeHead(403, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Este módulo está temporalmente suspendido.', codigo: 'modulo_suspendido' }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(API()[url] ?? {}));
  }
  if (url === '/' || url === '/app') pedidas.app++;
  if (url === '/personal') pedidas.personal++;
  const archivo = (url === '/' || url === '/app') ? join(PANEL_DIR, 'index.html')
    : url === '/personal' ? join(PANEL_DIR, 'personal.html')
    : url === '/restaurante' ? join(PANEL_DIR, 'mesas.html')
    : join(PANEL_DIR, url.replace(/^\//, ''));
  if (archivo.startsWith(PANEL_DIR) && existsSync(archivo) && extname(archivo)) {
    res.writeHead(200, { 'content-type': MIME[extname(archivo)] || 'application/octet-stream' });
    return res.end(readFileSync(archivo));
  }
  res.writeHead(404); res.end('no');
});
const wss = new WebSocketServer({ server, path: '/ws/panel' });
wss.on('connection', () => { conexionesWs++; });
await new Promise(r => server.listen(PUERTO, r));
const base = `http://localhost:${server.address().port}`;

function empujarPedido(id) {
  const pedido = {
    id, estado: 'nuevo', canal: 'whatsapp', modalidad: 'recoger en tienda', total: 180, forma_pago: 'efectivo',
    timestamp: new Date().toISOString(), cliente: { nombre: 'Cliente Simulado', telefono: '8780000000' },
    items: [{ nombre: 'Chicken Louisiana', cantidad: 1, precio_unitario: 180 }],
  };
  const msg = JSON.stringify({ tipo: 'nuevo_pedido', pedido, eventId: `sim-${id}-${Date.now()}` });
  let n = 0;
  wss.clients.forEach(c => { if (c.readyState === 1) { c.send(msg); n++; } });
  return n;
}
const abiertasWs = () => [...wss.clients].filter(c => c.readyState === 1).length;
const reiniciarCuentas = () => { pedidas.app = 0; pedidas.personal = 0; pedidas.apiPersonal = 0; conexionesWs = 0; };

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(nombre); }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const pausa = (ms) => new Promise(r => setTimeout(r, ms));

const navegador = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await navegador.newPage();
// Cualquier pestaña o ventana nueva (window.open, target=_blank) cuenta aquí.
let pestanasNuevas = 0;
navegador.on('targetcreated', (objetivo) => { if (objetivo.type() === 'page') pestanasNuevas++; });
const errores = [];
page.on('pageerror', e => errores.push(e.message));
page.on('dialog', d => d.dismiss().catch(() => {}));

const abrir = async (ruta, { ancho = 1366, alto = 768 } = {}) => {
  await page.setViewport({ width: ancho, height: alto });
  // about:blank primero: ir de /app a /app#x es navegación DENTRO del mismo
  // documento (no recarga), y aquí se quiere una entrada nueva al panel.
  await page.goto('about:blank');
  reiniciarCuentas();
  await page.goto(base + ruta, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => typeof mostrarTab === 'function' && typeof ROL !== 'undefined' && document.querySelector('.tab-btn.activo'));
  await page.waitForFunction(() => typeof MODULOS !== 'undefined' && MODULOS.length > 0);
};
// Empleados vive en "Negocio", que de entrada viene plegado: como una
// persona, primero se abre el grupo.
const pulsarMenu = async (id) => {
  const grupo = await page.evaluate((id) => {
    const sec = document.getElementById(id).closest('[id^="navsec-"]');
    return sec && sec.hidden ? sec.id.replace('navsec-', 'navgrp-') : null;
  }, id);
  if (grupo) await page.click('#' + grupo);
  await page.click('#' + id);
};
const marco = () => page.evaluate(() => {
  const f = document.getElementById('marco-personal');
  let d = null;
  try { d = f.contentDocument; } catch { /* otro origen: no pasa aquí */ }
  const vis = (el) => !!el && getComputedStyle(el).display !== 'none';
  const r = f.getBoundingClientRect();
  return {
    src: f.getAttribute('src') || '',
    visible: vis(f) && vis(f.closest('.vista-marco')) && vis(document.getElementById('vistas-extra')),
    menuLateral: vis(document.getElementById('tabs-nav')),
    tablero: vis(document.querySelector('main')) && vis(document.getElementById('vista-comandas')),
    activo: document.querySelector('.tab-btn.activo')?.id, hash: location.hash,
    rutaMarco: d?.location?.pathname || '',
    panelAdentro: !!d && !!d.getElementById('tabs-nav'),
    enPanel: !!d && d.documentElement.classList.contains('en-panel'),
    encabezado: !!d && vis(d.querySelector('header.xb')),
    empleados: d ? [...d.querySelectorAll('#lista .emp .nom')].map(e => e.textContent.trim()) : [],
    estadoMarco: d?.getElementById('estado')?.innerText?.trim() || '',
    directorio: !!d && vis(d.getElementById('directorio')),
    sinScrollHorizontal: !d || d.documentElement.scrollWidth <= d.defaultView.innerWidth,
    alto: Math.round(r.height), abajo: Math.round(r.bottom), alturaVentana: innerHeight,
  };
});
const esperarDirectorio = () => page.waitForFunction(
  () => document.getElementById('marco-personal')?.contentDocument?.querySelectorAll('#lista .emp').length === 2, { timeout: 10000 });
const entrada = () => page.evaluate(() => {
  const vis = (el) => !!el && getComputedStyle(el).display !== 'none';
  return { menu: vis(document.getElementById('tab-personal')), vista: vis(document.getElementById('vista-personal')),
    src: document.getElementById('marco-personal').getAttribute('src') || '', activo: document.querySelector('.tab-btn.activo')?.id, hash: location.hash };
});

try {
  await abrir('/app');
  await page.evaluate(() => localStorage.clear());

  // ── V. Visibilidad ────────────────────────────────────────────────────────
  await t('V1. con el módulo encendido, el administrador ve «Empleados» en Negocio', async () => {
    await abrir('/app');
    const r = await page.evaluate(() => {
      const b = document.getElementById('tab-personal');
      return { visible: getComputedStyle(b).display !== 'none', seccion: b.closest('[id^="navsec-"]')?.id, texto: b.textContent.trim() };
    });
    assert(r.visible && r.seccion === 'navsec-negocio' && r.texto === 'Empleados', JSON.stringify(r));
    // Abrir el panel no carga Empleados: el marco espera a que lo pidan.
    assert(pedidas.personal === 0 && pedidas.apiPersonal === 0, `cargas sin pedirlo: ${JSON.stringify(pedidas)}`);
  });

  await t('V2. con el módulo apagado o suspendido (fuera de /api/auth/me) no hay entrada, y #empleados no carga nada', async () => {
    sesion = { rol: 'admin', modulos: SIN_PERSONAL };
    try {
      await abrir('/app#empleados');
      const e = await entrada();
      assert(!e.menu && !e.vista && !e.src && e.activo === 'tab-inicio' && e.hash !== '#empleados', `entrando por la dirección: ${JSON.stringify(e)}`);
      // Con el panel ya abierto, teclear la dirección tampoco la abre.
      await page.evaluate(() => { location.hash = '#empleados'; });
      await pausa(400);
      const e2 = await entrada();
      assert(!e2.vista && !e2.src && e2.activo === 'tab-inicio' && e2.hash !== '#empleados', `con el panel abierto: ${JSON.stringify(e2)}`);
      assert(pedidas.personal === 0 && pedidas.apiPersonal === 0, `se pidió Empleados: ${JSON.stringify(pedidas)}`);
    } finally { sesion = { rol: 'admin', modulos: CON_PERSONAL }; }
  });

  await t('V3. el operador no ve Empleados aunque el módulo esté encendido; #empleados lo deja en Pedidos', async () => {
    sesion = { rol: 'staff', modulos: CON_PERSONAL };
    try {
      await abrir('/app#empleados');
      const e = await entrada();
      assert(!e.menu && !e.vista && !e.src && e.activo === 'tab-comandas', `operador: ${JSON.stringify(e)}`);
      assert(pedidas.personal === 0 && pedidas.apiPersonal === 0, `se pidió Empleados: ${JSON.stringify(pedidas)}`);
    } finally { sesion = { rol: 'admin', modulos: CON_PERSONAL }; }
  });

  // Superadmin (decisión del dueño, 5-nov-2026): no administra empleados, así
  // que tampoco ve la entrada. El servidor lo rechaza con 403 de todos modos
  // (fase-xecador-empleados B17-B19); esto es la visibilidad.
  const sinEntrada = async (etiqueta) => {
    const e = await entrada();
    assert(!e.menu && !e.vista && !e.src && e.hash !== '#empleados', `${etiqueta}: ${JSON.stringify(e)}`);
    await page.evaluate(() => { location.hash = '#empleados'; });
    await pausa(400);
    const e2 = await entrada();
    assert(!e2.vista && !e2.src && e2.hash !== '#empleados', `${etiqueta}, tecleando #empleados: ${JSON.stringify(e2)}`);
    assert(pedidas.personal === 0 && pedidas.apiPersonal === 0, `${etiqueta}: se pidió Empleados ${JSON.stringify(pedidas)}`);
  };

  await t('V4. el Superadmin con su sesión normal (admin, módulo encendido) no ve Empleados ni la abre por dirección', async () => {
    sesion = { rol: 'admin', modulos: CON_PERSONAL, superadmin: true };
    try {
      await abrir('/app#empleados');
      await sinEntrada('Superadmin');
      // El resto de su menú de administrador sigue: Clientes, en el mismo grupo.
      assert(await page.evaluate(() => getComputedStyle(document.getElementById('tab-clientes')).display !== 'none'), 'se escondió más de la cuenta');
    } finally { sesion = { rol: 'admin', modulos: CON_PERSONAL }; }
  });

  await t('V5. en una sesión de soporte (barra del Superadmin visible) no hay Empleados, ni en el menú ni en el cajón del celular', async () => {
    sesion = { rol: 'admin', modulos: CON_PERSONAL, soporte: true };
    try {
      await abrir('/app#empleados');
      assert(await page.evaluate(() => !!document.getElementById('barra-soporte')), 'precondición: el panel reconoció la sesión de soporte');
      await sinEntrada('soporte');
      await abrir('/app', { ancho: 375, alto: 812 });
      const cajon = await page.evaluate(() => [...document.querySelectorAll('#mas-lista .mas-item')].map(e => e.textContent.trim()));
      assert(!cajon.includes('Empleados') && cajon.includes('Clientes'), `cajón en soporte: ${cajon.join(' · ')}`);
    } finally { sesion = { rol: 'admin', modulos: CON_PERSONAL }; }
  });

  await t('V6. si el servidor no dice que la sesión puede administrar empleados, la entrada no aparece', async () => {
    sesion = { rol: 'admin', modulos: CON_PERSONAL, sinPermisoXecador: true };
    try {
      await abrir('/app');
      const e = await entrada();
      assert(!e.menu, `sin el dato del servidor: ${JSON.stringify(e)}`);
    } finally { sesion = { rol: 'admin', modulos: CON_PERSONAL }; }
  });

  // ── N. Navegación dentro del panel ────────────────────────────────────────
  await t('N1. pulsar Empleados abre /personal en un marco del MISMO panel: sin pestaña, conexión ni /app de más', async () => {
    await abrir('/app');
    const pestanasAntes = pestanasNuevas;
    await page.waitForFunction(() => panelListo === true, { timeout: 10000 });
    const wsAntes = abiertasWs();
    await pulsarMenu('tab-personal');
    await esperarDirectorio();
    await pausa(500);
    const m = await marco();
    assert(m.visible && m.menuLateral && !m.tablero && m.activo === 'tab-personal' && m.hash === '#empleados', `vista: ${JSON.stringify(m)}`);
    assert(m.src === '/personal' && m.rutaMarco === '/personal' && !m.panelAdentro, `marco: ${JSON.stringify(m)}`);
    assert(m.enPanel && !m.encabezado, `dentro del panel se esconde el encabezado propio: ${JSON.stringify(m)}`);
    assert(JSON.stringify(m.empleados) === '["Juana Prueba","Pedro Prueba"]', `directorio: ${m.empleados.join(', ')}`);
    assert(m.abajo <= m.alturaVentana && m.alto >= 450, `medidas: ${JSON.stringify(m)}`);
    assert(pestanasNuevas === pestanasAntes, `se abrieron ${pestanasNuevas - pestanasAntes} pestañas o ventanas`);
    assert(wsAntes === 1 && abiertasWs() === 1 && conexionesWs === 1, `conexiones /ws/panel: antes ${wsAntes}, ahora ${abiertasWs()}, en total ${conexionesWs}`);
    assert(pedidas.app === 1 && pedidas.personal === 1, `cargas: ${JSON.stringify(pedidas)}`);
  });

  await t('N2. /app#empleados abre Empleados directo (con Negocio plegado) y sobrevive a la recarga', async () => {
    await page.evaluate(() => localStorage.clear());
    await abrir('/app#empleados');
    await esperarDirectorio();
    let m = await marco();
    const negocio = await page.evaluate(() => document.getElementById('navsec-negocio').hidden);
    assert(m.visible && m.activo === 'tab-personal' && m.hash === '#empleados' && negocio === false, `entrada directa: ${JSON.stringify({ ...m, negocio })}`);
    await page.reload({ waitUntil: 'networkidle2' });
    await page.waitForFunction(() => typeof MODULOS !== 'undefined' && MODULOS.length > 0);
    await esperarDirectorio();
    m = await marco();
    assert(m.visible && m.activo === 'tab-personal' && m.hash === '#empleados', `recarga: ${JSON.stringify(m)}`);
  });

  await t('N3. se vuelve con el menú de siempre; el marco se conserva (no se recarga ni se pide otra vez)', async () => {
    await abrir('/app');
    await pulsarMenu('tab-personal');
    await esperarDirectorio();
    await page.evaluate(() => { document.getElementById('marco-personal').contentWindow.__sigue = true; });
    await page.click('#tab-comandas');
    let m = await marco();
    assert(!m.visible && m.tablero && m.activo === 'tab-comandas' && m.hash === '#pedidos', `de regreso en Pedidos: ${JSON.stringify(m)}`);
    await page.click('#tab-inicio');
    await pulsarMenu('tab-personal');
    m = await marco();
    const sigue = await page.evaluate(() => document.getElementById('marco-personal').contentWindow.__sigue === true);
    assert(m.visible && m.activo === 'tab-personal' && sigue, `al volver a Empleados: ${JSON.stringify({ ...m, sigue })}`);
    assert(pedidas.personal === 1, `la página se pidió ${pedidas.personal} veces`);
  });

  // ── P. Regresión de comandas y POS ────────────────────────────────────────
  await t('P1. estando en Empleados, un pedido nuevo suena e imprime su comanda UNA vez; el tablero y «+ Nuevo pedido» siguen', async () => {
    await abrir('/app');
    await page.evaluate(() => {
      window.__sonidos = 0; window.__impresiones = 0;
      sonarAlerta = function () { window.__sonidos++; };
      abrirPopupImpresion = function () { window.__impresiones++; return true; };
    });
    // El panel ignora los avisos de los primeros 3 s tras conectar (replay).
    await page.waitForFunction(() => panelListo === true, { timeout: 10000 });
    await pulsarMenu('tab-personal');
    await esperarDirectorio();
    const pestanasAntes = pestanasNuevas;
    assert(abiertasWs() === 1, `conexiones /ws/panel abiertas: ${abiertasWs()}`);
    assert(empujarPedido('XAB-0778') === 1, 'el pedido no llegó a exactamente un panel');
    await page.waitForFunction(() => window.__impresiones > 0, { timeout: 5000 }).catch(() => {});
    await pausa(1500);
    const r = await page.evaluate(() => ({
      sonidos: window.__sonidos, impresiones: window.__impresiones,
      tarjeta: !!document.getElementById('comanda-XAB-0778'),
      contador: document.getElementById('contador').textContent,
    }));
    let m = await marco();
    assert(r.sonidos === 1 && r.impresiones === 1, `sonidos ${r.sonidos}, comandas impresas ${r.impresiones}`);
    assert(r.tarjeta && r.contador === '1 activo', `tablero: ${JSON.stringify(r)}`);
    assert(m.visible && m.activo === 'tab-personal', `el pedido sacó al usuario de Empleados: ${JSON.stringify(m)}`);
    // De vuelta en Pedidos, la comanda está; «+ Nuevo pedido» abre la captura.
    await page.click('#tab-comandas');
    m = await marco();
    const enTablero = await page.evaluate(() => !!document.getElementById('comanda-XAB-0778')?.offsetParent);
    assert(m.tablero && enTablero, `tablero: ${JSON.stringify({ tablero: m.tablero, enTablero })}`);
    await page.click('#btn-nuevo-pedido');
    await page.click('#modal-modalidad .modalidad-card[onclick*="recoger"]');
    await page.waitForFunction(() => /Pollo/.test(document.getElementById('pos-menu-cats')?.textContent || ''), { timeout: 5000 });
    const pos = await page.evaluate(() => ({
      captura: getComputedStyle(document.getElementById('vista-presencial')).display !== 'none',
      empleados: getComputedStyle(document.getElementById('vista-personal')).display !== 'none',
      hash: location.hash,
    }));
    assert(pos.captura && !pos.empleados, `captura del POS: ${JSON.stringify(pos)}`);
    // Y Empleados sigue a un clic, sin recargarse.
    await pulsarMenu('tab-personal');
    m = await marco();
    assert(m.visible && pedidas.personal === 1, `regreso a Empleados: ${JSON.stringify({ visible: m.visible, cargas: pedidas.personal })}`);
    assert(pestanasNuevas === pestanasAntes && abiertasWs() === 1 && conexionesWs === 1,
      `pestañas nuevas ${pestanasNuevas - pestanasAntes}, conexiones abiertas ${abiertasWs()}, en total ${conexionesWs}`);
  });

  // ── R. Rechazo dentro del marco ───────────────────────────────────────────
  await t('R1. si la sesión vence adentro, el login sale en la ventana completa y regresa a /app#empleados', async () => {
    const loginDeLaVentana = () => page.waitForRequest(
      r => r.isNavigationRequest() && r.frame() === page.mainFrame() && /\/login/.test(r.url()), { timeout: 10000 });
    await abrir('/app');
    vencidaPersonal = true;
    try {
      const pedida = loginDeLaVentana();
      await pulsarMenu('tab-personal');
      const url = (await pedida).url();
      assert(url === base + '/login?redirect=' + encodeURIComponent('/app#empleados'), `login: ${url}`);
    } finally { vencidaPersonal = false; }
  });

  await t('R2. abierta sola (fuera del panel), sin sesión manda al login y regresa a /personal', async () => {
    await page.setViewport({ width: 390, height: 844 });
    await page.goto('about:blank');
    vencidaPersonal = true;
    try {
      const pedida = page.waitForRequest(r => r.isNavigationRequest() && /\/login/.test(r.url()), { timeout: 10000 });
      await page.goto(base + '/personal');
      const url = (await pedida).url();
      assert(url === base + '/login?redirect=' + encodeURIComponent('/personal'), `login: ${url}`);
    } finally { vencidaPersonal = false; }
    // Y sola conserva su encabezado (no está dentro del panel).
    await page.goto(base + '/personal', { waitUntil: 'networkidle2' });
    await page.waitForFunction(() => document.querySelectorAll('#lista .emp').length === 2, { timeout: 10000 });
    const r = await page.evaluate(() => ({ enPanel: document.documentElement.classList.contains('en-panel'),
      encabezado: getComputedStyle(document.querySelector('header.xb')).display !== 'none' }));
    assert(!r.enPanel && r.encabezado, `sola: ${JSON.stringify(r)}`);
  });

  await t('R3. si suspenden el módulo a media sesión, el marco lo dice y el panel sigue igual', async () => {
    await abrir('/app');
    await page.waitForFunction(() => panelListo === true, { timeout: 10000 });
    await pulsarMenu('tab-personal');
    await esperarDirectorio();
    suspendidoPersonal = true;
    sesion = { rol: 'admin', modulos: SIN_PERSONAL };
    try {
      // Ya abierto: la siguiente consulta (mostrar bajas) recibe el 403.
      await page.evaluate(() => document.getElementById('marco-personal').contentDocument.getElementById('ver-bajas').click());
      await page.waitForFunction(() => /no está habilitado/.test(document.getElementById('marco-personal').contentDocument.getElementById('estado').innerText), { timeout: 5000 });
      const m = await marco();
      assert(m.visible && !m.directorio && m.activo === 'tab-personal', `marco: ${JSON.stringify(m)}`);
      assert(m.menuLateral && abiertasWs() === 1, `panel: ${JSON.stringify({ menu: m.menuLateral, ws: abiertasWs() })}`);
      // Recién abierto ya suspendido: tampoco aparenta estar disponible.
      // El documento viejo ya dice «no está habilitado»: se marca para esperar
      // al NUEVO, ya cargado, y no leer uno a medio cargar.
      await page.evaluate(() => {
        const f = document.getElementById('marco-personal');
        f.contentDocument.documentElement.dataset.viejo = '1';
        f.contentWindow.location.reload();
      });
      await page.waitForFunction(() => {
        const d = document.getElementById('marco-personal').contentDocument;
        return !!d && d.readyState === 'complete' && !d.documentElement.dataset.viejo
          && /no está habilitado/.test(d.getElementById('estado')?.innerText || '');
      }, { timeout: 5000 });
      const boton = await page.evaluate(() => {
        const b = document.getElementById('marco-personal').contentDocument.getElementById('btn-nuevo');
        return !!b && !!(b.offsetWidth || b.offsetHeight);
      });
      assert(!boton, 'el botón de alta se ve con el módulo suspendido');
    } finally { suspendidoPersonal = false; sesion = { rol: 'admin', modulos: CON_PERSONAL }; }
  });

  // ── M. Celular ────────────────────────────────────────────────────────────
  await t('M1. en el celular, «Más» trae Empleados en Negocio y lo abre dentro del panel, sobre la barra de abajo', async () => {
    await abrir('/app', { ancho: 375, alto: 812 });
    await page.evaluate(() => abrirMasSheet());
    const rotulos = await page.evaluate(() => [...document.querySelectorAll('#mas-lista > *')].map(e =>
      e.classList.contains('mas-grupo') ? '# ' + e.textContent.trim() : e.textContent.trim()));
    const i = rotulos.indexOf('Empleados');
    assert(i > rotulos.indexOf('# Negocio') && i < rotulos.indexOf('# Finanzas') && rotulos[i - 1] === 'Clientes', `cajón: ${rotulos.join(' · ')}`);
    const k = await page.evaluate(() => [...document.querySelectorAll('#mas-lista .mas-item')].findIndex(e => e.textContent.trim() === 'Empleados'));
    await page.waitForFunction((k) => {
      const r = document.querySelectorAll('#mas-lista .mas-item')[k].getBoundingClientRect();
      // El cajón entra deslizándose desde la derecha: se pulsa ya quieto.
      return r.height > 0 && r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
    }, { timeout: 5000 }, k);
    await (await page.$$('#mas-lista .mas-item'))[k].click();
    await esperarDirectorio();
    const m = await marco();
    const barra = await page.evaluate(() => Math.round(document.getElementById('bottom-nav').getBoundingClientRect().top));
    assert(m.visible && m.hash === '#empleados' && m.enPanel && !m.encabezado, `desde el cajón: ${JSON.stringify(m)}`);
    assert(m.abajo <= barra && m.alto >= 450 && m.sinScrollHorizontal, `medidas en el celular: ${JSON.stringify({ ...m, barra })}`);
    // Sin el módulo, el cajón no la trae.
    sesion = { rol: 'admin', modulos: SIN_PERSONAL };
    try {
      await abrir('/app', { ancho: 375, alto: 812 });
      const sin = await page.evaluate(() => [...document.querySelectorAll('#mas-lista .mas-item')].map(e => e.textContent.trim()));
      assert(!sin.includes('Empleados') && sin.includes('Clientes'), `cajón sin el módulo: ${sin.join(' · ')}`);
    } finally { sesion = { rol: 'admin', modulos: CON_PERSONAL }; }
  });

  await t('Z1. ningún error de JavaScript en todo el recorrido (panel y marco)', async () => {
    assert(errores.length === 0, errores.slice(0, 3).join(' | '));
  });
} finally {
  await navegador.close();
  wss.close();
  server.close();
}

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallos.length) { console.log('FALLOS:'); fallos.forEach(f => console.log(' - ' + f)); }
process.exit(fallidas ? 1 : 0);
