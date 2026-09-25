// El menú reorganizado, manejado en un navegador de verdad.
//
// fase-sidebar-plegable y fase-menu-inicio ejecutan las funciones del panel
// contra un DOM mínimo. Esta suite comprueba lo que solo un navegador puede
// medir:
//   · que "Día a día" completo se vea SIN scroll en una pantalla de 768 px
//     de alto (con y sin la barra del navegador y la de tareas),
//   · que /app entre a Inicio, que las direcciones (#pedidos, #caja...)
//     sobrevivan a una recarga y que un operador no abra #caja,
//   · que un pedido que llega estando en Inicio suene e imprima igual,
//   · que el plegado de Negocio/Finanzas se recuerde y Día a día no se pliegue,
//   · que el cajón "Más" del móvil siga el orden del menú,
//   · que Mesas y Compras se abran dentro del panel (Fase 3.1),
//   · que Tienda › Productos marque el agotado y lleve a editar al Menú (3.2).
//
// No necesita Postgres: servidor de juguete que sirve panel/, contesta /api/*
// con datos fijos y abre un WebSocket /ws/panel para empujar un pedido.
//
// Uso: node test/fase-menu-navegador.mjs
//   TEST_PORT_MENU fija el puerto; sin él toma uno libre del sistema
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { WebSocketServer } from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PANEL_DIR = join(__dirname, '..', 'panel');
const PUERTO = Number(process.env.TEST_PORT_MENU || 0);

// ── Servidor de juguete ─────────────────────────────────────────────────────
const TODOS_LOS_MODULOS = ['pos', 'caja', 'menu', 'whatsapp', 'restaurante', 'rewards', 'cotizaciones', 'voz', 'usuarios', 'tienda_online', 'facturacion'];
let sesion = { rol: 'admin', modulos: TODOS_LOS_MODULOS };
// Bandeja de WhatsApp simulada (contador "sin responder" de Chats).
let conversaciones = [];
// Mesas y Compras dentro del panel (Fase 3.1): cuántas veces se pidió el
// tablero de mesas, y sesiones vencidas a propósito (401) en cada página.
let pedidasMesas = 0;
const CUENTA_MESA = (() => {
  const hora = new Date().toISOString();
  const item = (id, producto, cantidad, precio, estado, comanda_num, notas = null) =>
    ({ id, producto, cantidad, precio_unitario: precio, estado, comanda_num, created_at: hora, notas, modificadores: [] });
  return {
    id: 'c5', mesa: 5, mesero: { nombre: 'Ana' }, personas: 4, pagos: [], descuento: null,
    subtotal: 1110, total: 1110, pagado: 0, saldo: 1110, propinas: 0, ventaFolio: null,
    items: [
      item('i1', 'Chicken Louisiana', 2, 180, 'enviado', 1), item('i2', 'Alitas BBQ', 1, 150, 'enviado', 1, 'Salsa aparte'),
      item('i3', 'Limonada', 3, 45, 'enviado', 1), item('i4', 'Hamburguesa Clásica', 1, 165, 'pendiente', null, 'Sin cebolla'),
      item('i5', 'Papas Gajo', 2, 60, 'pendiente', null), item('i6', 'Pastel de Chocolate', 1, 90, 'pendiente', null),
    ],
  };
})();
const vencida = { mesas: false, compras: false };
// Tienda › Productos (Fase 3.2): cuántas veces se publicó o despublicó.
let publicaciones = 0;
// La categoría Postres empieza oculta. El editor administrativo debe seguir
// recibiéndola y el PATCH de su casilla debe poder reactivarla.
let categoriaPostresActiva = false;
let fallaPatchCategoria = false;
let lecturasMenuAdmin = 0;
const cambiosCategoria = [];
const categoriaPollo = () => ({ id: 1, nombre: 'Pollo', activa: true, orden: 1, productos: [
  { id: 11, nombre: 'Chicken Louisiana', precio: 180, descripcion: 'Pechuga empanizada', disponible: true, agotado: false, destacado: false, imagen: null, categoria_id: 1 },
  { id: 12, nombre: 'Alitas BBQ', precio: 150, descripcion: '', disponible: true, agotado: true, destacado: false, imagen: null, categoria_id: 1 },
] });
const categoriaPostres = () => ({ id: 2, nombre: 'Postres', activa: categoriaPostresActiva, orden: 2, productos: [
  { id: 13, nombre: 'Postre del mes', precio: 60, descripcion: 'Especial de temporada', disponible: true, agotado: false, destacado: false, imagen: null, categoria_id: 2 },
] });
const menuOperativo = () => [categoriaPollo(), ...(categoriaPostresActiva ? [categoriaPostres()] : [])];
const menuAdministrable = () => [categoriaPollo(), categoriaPostres()];
const API = () => ({
  '/api/auth/me': { rol: sesion.rol, negocioId: 'neg-prueba', modulos: sesion.modulos, whatsappConfigurado: true },
  '/api/config/operativa': { nombre: 'Restaurante Prueba', nombre_corto: 'XABOR', direccion: 'Calle 1', ciudad: 'Matamoros', rfc: 'XAXX010101000', telefono: '8781234567', whatsapp: '8781234567' },
  '/api/pedidos-programados': [],
  '/api/admin/checklist-activacion-bot': { automaticos: {}, manuales: {}, listoParaActivar: false },
  '/api/ventas/resumen': { total_ventas: 0, num_pedidos: 0 },
  '/api/impresion/self-service': { hayEquipo: false, cobertura: {} },
  '/api/conversaciones': conversaciones,
  '/api/bot-whatsapp': { botWhatsappActivo: false },
  // Clientes y Campañas (Fase 2.3) esperan listas, no objetos.
  '/api/admin/clientes/oportunidades': [],
  '/api/admin/campanas': [],
  // Reportes (Fase 2.4): Ventas es una lista; Correcciones, una semana vacía.
  '/api/ventas': [],
  '/api/admin/ajustes-cierre/semana': {
    semana: { lunes: '2026-09-21', domingo: '2026-09-27', timezone: 'America/Matamoros' },
    cutoff: { configurada: true }, ventas: [],
    resumen: { ventas_count: 0, total_original: 0, facturadas_count: 0, facturadas_total: 0, no_facturadas_count: 0, no_facturadas_total: 0,
      historicas_no_verificables_count: 0, historicas_no_verificables_total: 0, ajustado_total: 0, ajustadas_count: 0, sin_ajustes_count: 0, neto_total: 0 },
  },
  // Mesas (Fase 3.1): /restaurante pregunta quién es y pinta dos mesas libres.
  '/api/restaurante/meseros': { sesionMesero: false, negocio: 'Restaurante Prueba', meseros: [] },
  '/api/restaurante/mesas': { mesas: [{ mesa: 1, ocupada: false }, { mesa: 2, ocupada: false }] },
  // Una cuenta con 6 platillos (3 enviados, 3 pendientes) para medir que se
  // vean en pantallas bajas (K9).
  '/api/restaurante/cuentas/c5': CUENTA_MESA,
  // Compras (Fase 3.1): contexto, resumen y lista vacíos.
  '/api/admin/compras': { total: 0, compras: [] },
  '/api/admin/compras/contexto': { rol: sesion.rol, responsables: [] },
  '/api/admin/compras/categorias': { categorias: [] },
  '/api/admin/compras/whatsapp': { autorizados: [] },
  '/api/admin/compras/resumen': { desde: '2026-09-01', hasta: '2026-09-24', hoy: '2026-09-24', comprobado: 0, pagado_periodo: 0, saldo_fondo: 0,
    deuda_proveedores: 0, sin_factura_count: 0, sin_factura_monto: 0, compras_sin_revisar: 0, fondos_sin_responsable: 0,
    responsables: [], fondos: [], pendientes: [] },
  '/api/admin/sat/credenciales/info': { info: null },
  // Tienda › Productos (Fase 3.2): el 12 está agotado; el 13 no aparece en el
  // Menú (como si su categoría estuviera desactivada).
  '/api/admin/tienda/productos': { productos: [
    { id: 11, nombre: 'Chicken Louisiana', categoria: 'Pollo', categoriaActiva: true, precio: 180, publicado: true, destacado: false, badge: null, precioTienda: null, agotado: false },
    { id: 12, nombre: 'Alitas BBQ', categoria: 'Pollo', categoriaActiva: true, precio: 150, publicado: false, destacado: false, badge: null, precioTienda: null, agotado: true },
    { id: 13, nombre: 'Postre del mes', categoria: 'Postres', categoriaActiva: categoriaPostresActiva, precio: 60, publicado: false, destacado: false, badge: null, precioTienda: null, agotado: false },
  ] },
  // /api/menu sigue siendo el catálogo operativo: no expone categorías
  // ocultas al POS/mesas. Solo el endpoint admin alimenta al editor.
  '/api/menu': menuOperativo(),
  '/api/admin/menu': menuAdministrable(),
});
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  if (url.startsWith('/api/')) {
    if (url === '/api/restaurante/mesas') pedidasMesas++;
    if (url === '/api/admin/tienda/productos/publicar') publicaciones++;
    if (url === '/api/admin/menu' && req.method === 'GET') lecturasMenuAdmin++;
    const patchCategoria = url.match(/^\/api\/admin\/menu\/categorias\/(\d+)$/);
    if (patchCategoria && req.method === 'PATCH') {
      let texto = '';
      for await (const trozo of req) texto += trozo;
      const cuerpo = JSON.parse(texto || '{}');
      const id = Number(patchCategoria[1]);
      cambiosCategoria.push({ id, ...cuerpo });
      if (fallaPatchCategoria) {
        res.writeHead(500, { 'content-type': 'application/json' });
        return res.end('{"error":"Fallo simulado al actualizar la categoría"}');
      }
      if (id === 2 && typeof cuerpo.activa === 'boolean') categoriaPostresActiva = cuerpo.activa;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"ok":true}');
    }
    // Sesión vencida dentro del marco: solo lo que pide esa página (el panel
    // de afuera sigue con sesión, como cuando vence la del marco primero).
    const deMesas = (req.headers.referer || '').includes('/restaurante');
    if ((vencida.compras && /^\/api\/admin\/(compras|sat)/.test(url)) ||
        (vencida.mesas && deMesas && (url === '/api/auth/me' || url.startsWith('/api/restaurante/')))) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end('{"error":"sesión vencida"}');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(API()[url] ?? {}));
  }
  const archivo = (url === '/' || url === '/app') ? join(PANEL_DIR, 'index.html')
    : url === '/restaurante' ? join(PANEL_DIR, 'mesas.html')
    : join(PANEL_DIR, url.replace(/^\//, ''));
  if (archivo.startsWith(PANEL_DIR) && existsSync(archivo) && extname(archivo)) {
    res.writeHead(200, { 'content-type': MIME[extname(archivo)] || 'application/octet-stream' });
    return res.end(readFileSync(archivo));
  }
  res.writeHead(404); res.end('no');
});
const wss = new WebSocketServer({ server, path: '/ws/panel' });
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

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(nombre); }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

const navegador = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await navegador.newPage();
const errores = [];
page.on('pageerror', e => errores.push(e.message));
page.on('dialog', d => d.dismiss().catch(() => {}));

const abrir = async (ruta, { ancho = 1366, alto = 768 } = {}) => {
  await page.setViewport({ width: ancho, height: alto });
  // about:blank primero: ir de /app a /app#x es navegación DENTRO del mismo
  // documento (no recarga), y aquí se quiere una entrada nueva al panel.
  await page.goto('about:blank');
  await page.goto(base + ruta, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => typeof mostrarTab === 'function' && typeof ROL !== 'undefined' && document.querySelector('.tab-btn.activo'));
  // La sesión simulada responde al instante, pero el panel decide la pantalla
  // de entrada DESPUÉS de /api/auth/me: se espera a que ya haya decidido.
  await page.waitForFunction(() => typeof MODULOS !== 'undefined' && MODULOS.length > 0);
};
const estado = () => page.evaluate(() => {
  const vis = (el) => !!el && getComputedStyle(el).display !== 'none';
  return {
    hash: location.hash,
    activo: document.querySelector('.tab-btn.activo')?.id,
    inicio: vis(document.getElementById('vista-inicio')) && vis(document.getElementById('vistas-extra')),
    tablero: vis(document.querySelector('main')) && vis(document.getElementById('vista-comandas')),
    caja: vis(document.getElementById('vista-corte')) && vis(document.getElementById('vistas-extra')),
  };
});

try {
  // ── A. Entrada y direcciones ──────────────────────────────────────────────
  await abrir('/app');
  await page.evaluate(() => localStorage.clear());
  await t('A1. /app entra a Inicio, con Inicio marcado y sin dirección', async () => {
    await abrir('/app');
    const e = await estado();
    assert(e.inicio && !e.tablero, `pantallas visibles: ${JSON.stringify(e)}`);
    assert(e.activo === 'tab-inicio', `marcado: ${e.activo}`);
    assert(e.hash === '', `dirección: ${e.hash}`);
  });

  await t('A2. /app#pedidos entra directo al tablero', async () => {
    await abrir('/app#pedidos');
    const e = await estado();
    assert(e.tablero && !e.inicio, `pantallas visibles: ${JSON.stringify(e)}`);
    assert(e.activo === 'tab-comandas', `marcado: ${e.activo}`);
  });

  await t('A2b. con el panel ya abierto, un marcador a #pedidos lleva al tablero sin recargar', async () => {
    await abrir('/app');
    await page.evaluate(() => { window.__sinRecargar = true; location.hash = '#pedidos'; });
    await page.waitForFunction(() => document.querySelector('.tab-btn.activo')?.id === 'tab-comandas', { timeout: 3000 }).catch(() => {});
    const e = await estado();
    assert(e.tablero && e.activo === 'tab-comandas', `pantallas visibles: ${JSON.stringify(e)}`);
    assert(await page.evaluate(() => window.__sinRecargar === true), 'la página se recargó');
  });

  await t('A3. la dirección sigue a la pantalla y sobrevive a la recarga (#caja)', async () => {
    await abrir('/app');
    await page.click('#tab-corte');
    assert((await estado()).hash === '#caja', `tras abrir Caja la dirección es ${(await estado()).hash}`);
    await page.reload({ waitUntil: 'networkidle2' });
    await page.waitForFunction(() => typeof MODULOS !== 'undefined' && MODULOS.length > 0);
    const e = await estado();
    assert(e.caja && e.activo === 'tab-corte', `tras recargar: ${JSON.stringify(e)}`);
  });

  // El operador (staff) solo genera pedidos y opera mesas (regla del dueño,
  // 2026-09-24): no tiene Inicio, entra al tablero, y una sección ajena le
  // dice "No tienes acceso a esta sección".
  const avisos = () => page.evaluate(() => [...document.querySelectorAll('#avisos-panel [role="alert"]')].map(a => a.textContent));
  await t('A4. un operador que teclea #caja cae en Pedidos, con aviso de que no tiene acceso', async () => {
    sesion = { rol: 'staff', modulos: TODOS_LOS_MODULOS };
    try {
      await abrir('/app#caja');
      let e = await estado();
      assert(e.tablero && !e.caja && !e.inicio, `al entrar: ${JSON.stringify(e)}`);
      assert(e.hash === '#pedidos', `dirección al entrar: ${e.hash}`);
      assert((await avisos()).includes('No tienes acceso a esta sección'), `avisos: ${JSON.stringify(await avisos())}`);
      // Y con el panel ya abierto, tampoco.
      await page.evaluate(() => { document.getElementById('avisos-panel')?.remove(); location.hash = '#chats'; });
      await new Promise(r => setTimeout(r, 300));
      e = await estado();
      assert(e.tablero && !e.caja, `con el panel abierto: ${JSON.stringify(e)}`);
      assert(e.hash === '#pedidos', `la barra quedó diciendo ${e.hash}`);
      assert((await avisos()).includes('No tienes acceso a esta sección'), 'con el panel abierto no se avisó');
    } finally { sesion = { rol: 'admin', modulos: TODOS_LOS_MODULOS }; }
  });

  await t('A5. el operador ve solo "+ Nuevo pedido", Pedidos y Mesas, y entra al tablero', async () => {
    sesion = { rol: 'staff', modulos: TODOS_LOS_MODULOS };
    try {
      await abrir('/app');
      const r = await page.evaluate(() => {
        const vis = (el) => !!el && getComputedStyle(el).display !== 'none' && el.offsetParent !== null;
        return {
          // El rótulo sin el contador de pedidos activos.
          destinos: [...document.querySelectorAll('#tabs-nav .tab-btn, #tabs-nav .nav-nuevo-pedido')].filter(vis)
            .map(b => [...b.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim().replace(/\s+/g, ' ')),
          encabezados: [...document.querySelectorAll('#tabs-nav .nav-grupo')].filter(vis).map(g => g.textContent.trim()),
          pie: vis(document.querySelector('.nav-pie')),
        };
      });
      assert(JSON.stringify(r.destinos) === JSON.stringify(['+ Nuevo pedido', 'Pedidos', 'Mesas']), `destinos: ${r.destinos.join(' · ')}`);
      assert(JSON.stringify(r.encabezados) === JSON.stringify(['Día a día']), `encabezados: ${r.encabezados.join(' · ')}`);
      assert(!r.pie, 'al operador le quedó el pie (Configuración o su línea)');
      const e = await estado();
      assert(e.tablero && e.activo === 'tab-comandas' && e.hash === '#pedidos', `entrada del operador: ${JSON.stringify(e)}`);
    } finally { sesion = { rol: 'admin', modulos: TODOS_LOS_MODULOS }; }
  });

  // ── B. Un pedido que llega estando en Inicio ──────────────────────────────
  // Facturación (de Codex) guarda su sub-pantalla en la dirección. Al juntarla
  // con el menú, entrar por /app#facturacion/clientes caía en Inicio.
  const facturacion = () => page.evaluate(() => ({
    hash: location.hash,
    activo: document.querySelector('.tab-btn.activo')?.id,
    config: getComputedStyle(document.getElementById('vista-config')).display !== 'none',
    sub: [...document.querySelectorAll('[data-facturacion-section]')].filter(el => !el.hidden).map(el => el.dataset.facturacionSection),
  }));
  await t('A6. /app#facturacion/clientes entra a Facturación en Clientes, y la dirección se conserva', async () => {
    await abrir('/app#facturacion/clientes');
    let f = await facturacion();
    assert(f.activo === 'tab-facturacion' && f.config, `al entrar: ${JSON.stringify(f)}`);
    assert(JSON.stringify(f.sub) === '["clientes"]', `sub-pantalla: ${JSON.stringify(f.sub)}`);
    assert(f.hash === '#facturacion/clientes', `dirección: ${f.hash}`);
    // La dirección vieja también entra.
    await abrir('/app#config/facturacion');
    f = await facturacion();
    assert(f.activo === 'tab-facturacion' && JSON.stringify(f.sub) === '["facturas"]', `dirección vieja: ${JSON.stringify(f)}`);
    // Con Facturación abierta, cambiar la sub-pantalla en la dirección la cambia.
    await page.evaluate(() => { location.hash = '#facturacion/configuracion'; });
    await new Promise(r => setTimeout(r, 300));
    f = await facturacion();
    assert(f.activo === 'tab-facturacion' && JSON.stringify(f.sub) === '["configuracion"]', `al cambiar de sub-pantalla: ${JSON.stringify(f)}`);
  });

  await t('A7. el operador que teclea #facturacion cae en Pedidos, con aviso', async () => {
    sesion = { rol: 'staff', modulos: TODOS_LOS_MODULOS };
    try {
      await abrir('/app#facturacion/clientes');
      const e = await estado();
      assert(e.tablero && e.activo === 'tab-comandas', `al entrar: ${JSON.stringify(e)}`);
      assert(e.hash === '#pedidos', `dirección al entrar: ${e.hash}`);
      assert((await avisos()).includes('No tienes acceso a esta sección'), `avisos: ${JSON.stringify(await avisos())}`);
      // Y con el panel ya abierto, tampoco se le abre.
      await page.evaluate(() => { document.getElementById('avisos-panel')?.remove(); location.hash = '#facturacion'; });
      await new Promise(r => setTimeout(r, 300));
      const f = await facturacion();
      assert(f.activo === 'tab-comandas' && !f.config, `con el panel abierto: ${JSON.stringify(f)}`);
      assert((await avisos()).includes('No tienes acceso a esta sección'), 'con el panel abierto no se avisó');
    } finally { sesion = { rol: 'admin', modulos: TODOS_LOS_MODULOS }; }
  });

  // ── G. Fase 2.1: Pedidos agrupa En curso, Domicilio e Historial ──────────
  const pestanas = () => page.evaluate(() => {
    const barra = document.getElementById('pestanas-pedidos');
    return {
      visible: !!barra && !barra.hidden && getComputedStyle(barra).display !== 'none',
      dentroDe: barra?.parentElement?.id,
      arriba: barra?.parentElement?.firstElementChild === barra,
      botones: [...(barra?.querySelectorAll('.seccion-pestana') || [])].filter(b => b.style.display !== 'none').map(b => b.textContent.trim()),
      activa: barra?.querySelector('.seccion-pestana.activa')?.textContent.trim(),
      menu: document.querySelector('.tab-btn.activo')?.id,
      hash: location.hash,
    };
  });
  await t('G1. Pedidos tiene pestañas En curso, Domicilio e Historial, y la dirección las sigue', async () => {
    await abrir('/app#pedidos');
    let p = await pestanas();
    assert(p.visible && p.dentroDe === 'vista-comandas' && p.arriba, `en En curso: ${JSON.stringify(p)}`);
    assert(JSON.stringify(p.botones) === '["En curso","Domicilio","Historial"]', `pestañas: ${p.botones.join(', ')}`);
    assert(p.activa === 'En curso' && p.menu === 'tab-comandas', `marcas: ${JSON.stringify(p)}`);
    await page.click('#pest-historial');
    p = await pestanas();
    assert(p.dentroDe === 'vista-historial' && p.arriba && p.activa === 'Historial', `en Historial: ${JSON.stringify(p)}`);
    assert(p.menu === 'tab-comandas', `en Historial el menú marca ${p.menu} y no Pedidos`);
    assert(p.hash === '#pedidos/historial', `dirección en Historial: ${p.hash}`);
    assert(await page.evaluate(() => getComputedStyle(document.getElementById('vista-historial')).display !== 'none'), 'no se ve el Historial');
    await page.click('#pest-repartidores');
    p = await pestanas();
    assert(p.dentroDe === 'vista-repartidores' && p.activa === 'Domicilio' && p.hash === '#pedidos/domicilio', `en Domicilio: ${JSON.stringify(p)}`);
    // Recargar deja al usuario en la misma pestaña.
    await page.reload({ waitUntil: 'networkidle2' });
    await page.waitForFunction(() => typeof MODULOS !== 'undefined' && MODULOS.length > 0);
    p = await pestanas();
    assert(p.activa === 'Domicilio' && p.menu === 'tab-comandas', `tras recargar: ${JSON.stringify(p)}`);
    // Fuera de Pedidos la barra no se ve.
    await page.click('#tab-corte');
    assert(!(await pestanas()).visible, 'la barra de Pedidos se ve en Caja');
  });

  await t('G2. los marcadores viejos #historial y #repartidores siguen entrando', async () => {
    await abrir('/app#historial');
    let p = await pestanas();
    assert(p.activa === 'Historial' && p.hash === '#pedidos/historial', `#historial: ${JSON.stringify(p)}`);
    await abrir('/app#repartidores');
    p = await pestanas();
    assert(p.activa === 'Domicilio' && p.hash === '#pedidos/domicilio', `#repartidores: ${JSON.stringify(p)}`);
  });

  await t('G3. el operador no ve la barra (solo tiene En curso) ni entra a Historial', async () => {
    sesion = { rol: 'staff', modulos: TODOS_LOS_MODULOS };
    try {
      await abrir('/app');
      let p = await pestanas();
      assert(!p.visible && p.menu === 'tab-comandas', `el operador ve: ${JSON.stringify(p)}`);
      await abrir('/app#pedidos/historial');
      p = await pestanas();
      assert(p.menu === 'tab-comandas' && p.hash === '#pedidos', `el operador entró a Historial: ${JSON.stringify(p)}`);
      assert((await avisos()).includes('No tienes acceso a esta sección'), 'al operador no se le avisó');
    } finally { sesion = { rol: 'admin', modulos: TODOS_LOS_MODULOS }; }
  });

  // ── H. Fase 2.2: Chats agrupa Conversaciones y el Bot ────────────────────
  const chats = () => page.evaluate(() => {
    const barra = document.getElementById('pestanas-chats');
    return {
      visible: !!barra && !barra.hidden && getComputedStyle(barra).display !== 'none',
      dentroDe: barra?.parentElement?.id,
      botones: [...(barra?.querySelectorAll('.seccion-pestana') || [])].filter(b => b.style.display !== 'none').map(b => b.textContent.trim()),
      activa: barra?.querySelector('.seccion-pestana.activa')?.textContent.trim(),
      menu: document.querySelector('.tab-btn.activo')?.id,
      hash: location.hash,
      bot: getComputedStyle(document.getElementById('vista-entrenamiento')).display !== 'none',
    };
  });
  await t('H1. Chats tiene pestañas Conversaciones y Bot, y #asistente sigue entrando', async () => {
    await abrir('/app#chats');
    let c = await chats();
    assert(c.visible && c.dentroDe === 'vista-chats', `en Conversaciones: ${JSON.stringify(c)}`);
    assert(JSON.stringify(c.botones) === '["Conversaciones","Bot"]', `pestañas: ${c.botones.join(', ')}`);
    assert(c.activa === 'Conversaciones' && c.menu === 'tab-chats', `marcas: ${JSON.stringify(c)}`);
    // La barra no empuja la conversación (y su caja de escribir) hacia abajo.
    const abajo = await page.evaluate(() => {
      const split = document.querySelector('#vista-chats .chats-split');
      const barra = document.getElementById('pestanas-chats');
      const con = split.getBoundingClientRect().bottom;
      barra.hidden = true; barra.parentElement.classList.remove('con-pestanas');
      const sin = split.getBoundingClientRect().bottom;
      barra.hidden = false; barra.parentElement.classList.add('con-pestanas');
      return { con: Math.round(con), sin: Math.round(sin) };
    });
    assert(abajo.con <= abajo.sin + 2, `con la barra la conversación termina en ${abajo.con}px; sin ella, en ${abajo.sin}px`);
    await page.click('#pest-entrenamiento');
    c = await chats();
    assert(c.bot && c.dentroDe === 'vista-entrenamiento' && c.activa === 'Bot', `en Bot: ${JSON.stringify(c)}`);
    assert(c.menu === 'tab-chats' && c.hash === '#chats/bot', `marca y dirección en Bot: ${JSON.stringify(c)}`);
    await abrir('/app#asistente');
    c = await chats();
    assert(c.bot && c.hash === '#chats/bot', `#asistente: ${JSON.stringify(c)}`);
  });

  await t('H2. el aviso de atención automática pausada lleva a la pestaña Bot', async () => {
    await abrir('/app#chats');
    await page.waitForSelector('#chats-configurar-bot', { visible: true, timeout: 5000 });
    await page.click('#chats-configurar-bot');
    const c = await chats();
    assert(c.bot && c.activa === 'Bot' && c.hash === '#chats/bot', `tras "Configurar bot": ${JSON.stringify(c)}`);
  });

  await t('H3. junto a Chats se ven las conversaciones sin responder, en el menú y en el celular', async () => {
    const ahora = new Date().toISOString();
    conversaciones = [
      { telefono: '5218780000001', nombre: 'Uno', texto: '¿Tienen mesa?', direccion: 'entrante', timestamp: ahora },
      { telefono: '5218780000002', nombre: 'Dos', texto: 'Hola', direccion: 'entrante', timestamp: ahora },
      { telefono: '5218780000003', nombre: 'Tres', texto: 'Gracias', direccion: 'saliente', timestamp: ahora },
    ];
    const contador = () => page.evaluate(() => {
      const ver = (id) => { const el = document.getElementById(id); return getComputedStyle(el).display !== 'none' ? el.textContent : 'oculto'; };
      return { menu: ver('badge-chats'), cel: ver('bnav-badge') };
    });
    try {
      await abrir('/app');
      await page.waitForFunction(() => document.getElementById('badge-chats').textContent === '2', { timeout: 5000 }).catch(() => {});
      let r = await contador();
      assert(r.menu === '2' && r.cel === '2', `contador en el menú ${r.menu}, en el celular ${r.cel}`);
      // Entrar a Chats ya no lo apaga: siguen sin responder.
      await page.click('#tab-chats');
      await new Promise(res => setTimeout(res, 500));
      r = await contador();
      assert(r.menu === '2', `al entrar a Chats el contador quedó en ${r.menu}`);
    } finally { conversaciones = []; }
  });

  await t('H4. un admin sin WhatsApp: Chats le abre el Bot, sin barra de una sola pestaña', async () => {
    sesion = { rol: 'admin', modulos: TODOS_LOS_MODULOS.filter(m => m !== 'whatsapp') };
    try {
      await abrir('/app');
      assert(await page.evaluate(() => document.getElementById('tab-chats').style.display !== 'none'),
        'sin WhatsApp desapareció Chats, y con él el Bot');
      await page.click('#tab-chats');
      const c = await chats();
      assert(c.bot && !c.visible && c.menu === 'tab-chats' && c.hash === '#chats/bot', `sin WhatsApp: ${JSON.stringify(c)}`);
      // En el celular la barra no tiene Chats: el cajón "Más" se lo da, con su
      // nombre limpio (sin el contador).
      await abrir('/app', { ancho: 375, alto: 812 });
      const cajon = await page.evaluate(() => [...document.querySelectorAll('#mas-lista .mas-item')].map(e => e.textContent.trim()));
      assert(cajon.includes('Chats'), `cajón sin WhatsApp: ${cajon.join(' · ')}`);
    } finally { sesion = { rol: 'admin', modulos: TODOS_LOS_MODULOS }; }
  });

  // ── I. Fase 2.3: Clientes agrupa Lista, Rewards, Campañas y Datos fiscales ─
  const clientes = () => page.evaluate(() => {
    const barra = document.getElementById('pestanas-clientes');
    const ver = (id) => { const el = document.getElementById(id); return !!el && getComputedStyle(el).display !== 'none'; };
    return {
      visible: !!barra && !barra.hidden && getComputedStyle(barra).display !== 'none',
      dentroDe: barra?.parentElement?.id,
      botones: [...(barra?.querySelectorAll('.seccion-pestana') || [])].filter(b => b.style.display !== 'none').map(b => b.textContent.trim()),
      activa: barra?.querySelector('.seccion-pestana.activa')?.textContent.trim(),
      menu: document.querySelector('.tab-btn.activo')?.id,
      hash: location.hash,
      lista: ver('vista-clientes'), rewards: ver('vista-rewards'), campanas: ver('vista-campanas'),
    };
  });
  await t('I1. Clientes tiene pestañas Lista, Rewards, Campañas y Datos fiscales', async () => {
    await abrir('/app#clientes');
    let c = await clientes();
    assert(c.visible && c.dentroDe === 'vista-clientes' && c.lista, `en Lista: ${JSON.stringify(c)}`);
    assert(JSON.stringify(c.botones) === '["Lista","Rewards","Campañas","Datos fiscales"]', `pestañas: ${c.botones.join(', ')}`);
    assert(c.activa === 'Lista' && c.menu === 'tab-clientes', `marcas: ${JSON.stringify(c)}`);
    await page.click('#pest-rewards');
    c = await clientes();
    assert(c.rewards && c.dentroDe === 'vista-rewards' && c.activa === 'Rewards' && c.menu === 'tab-clientes' && c.hash === '#clientes/rewards',
      `en Rewards: ${JSON.stringify(c)}`);
    await page.click('#pest-campanas');
    c = await clientes();
    assert(c.campanas && c.activa === 'Campañas' && c.hash === '#clientes/campanas', `en Campañas: ${JSON.stringify(c)}`);
    // El botón abre su formulario desde la pestaña: el modal ya no vive dentro
    // de una vista oculta.
    await page.click('#vista-campanas button[onclick="abrirModalCampana()"]');
    const modal = await page.evaluate(() => {
      const m = document.getElementById('campana-modal'); const r = m.getBoundingClientRect();
      return getComputedStyle(m).display !== 'none' && r.width > 0 && r.height > 0;
    });
    assert(modal, 'el formulario de campaña no se ve desde la pestaña Campañas');
    await page.evaluate(() => cerrarModalCampana());
    // Marcador viejo.
    await abrir('/app#rewards');
    c = await clientes();
    assert(c.rewards && c.hash === '#clientes/rewards', `#rewards: ${JSON.stringify(c)}`);
  });

  await t('I2. "Datos fiscales" lleva a Facturación › Clientes', async () => {
    await abrir('/app#clientes');
    await page.click('#pest-datosfiscales');
    await new Promise(r => setTimeout(r, 300));
    const f = await facturacion();
    assert(f.activo === 'tab-facturacion' && JSON.stringify(f.sub) === '["clientes"]' && f.hash === '#facturacion/clientes',
      `tras Datos fiscales: ${JSON.stringify(f)}`);
  });

  // ── J. Fase 2.4: Reportes agrupa Ventas y Correcciones ──────────────────
  const reportes = () => page.evaluate(() => {
    const barra = document.getElementById('pestanas-reportes');
    const ver = (id) => getComputedStyle(document.getElementById(id)).display !== 'none';
    return {
      visible: !!barra && !barra.hidden && getComputedStyle(barra).display !== 'none',
      botones: [...(barra?.querySelectorAll('.seccion-pestana') || [])].filter(b => b.style.display !== 'none').map(b => b.textContent.trim()),
      activa: barra?.querySelector('.seccion-pestana.activa')?.textContent.trim(),
      menu: document.querySelector('.tab-btn.activo')?.id,
      rotulo: document.getElementById('tab-ventas').textContent.trim(),
      hash: location.hash, ventas: ver('vista-ventas'), correcciones: ver('vista-ajustes'),
    };
  });
  await t('J1. Reportes tiene pestañas Ventas y Correcciones; #ventas y #correcciones siguen entrando', async () => {
    await abrir('/app#reportes');
    let r = await reportes();
    assert(r.visible && r.ventas && r.activa === 'Ventas' && r.menu === 'tab-ventas' && r.rotulo === 'Reportes', `en Ventas: ${JSON.stringify(r)}`);
    assert(JSON.stringify(r.botones) === '["Ventas","Correcciones"]', `pestañas: ${r.botones.join(', ')}`);
    await page.click('#pest-ajustes');
    r = await reportes();
    assert(r.correcciones && r.activa === 'Correcciones' && r.menu === 'tab-ventas' && r.hash === '#reportes/correcciones', `en Correcciones: ${JSON.stringify(r)}`);
    await abrir('/app#ventas');
    r = await reportes();
    assert(r.ventas && r.hash === '#reportes', `#ventas: ${JSON.stringify(r)}`);
    await abrir('/app#correcciones');
    r = await reportes();
    assert(r.correcciones && r.hash === '#reportes/correcciones', `#correcciones: ${JSON.stringify(r)}`);
  });

  await t('J2. con Caja y sin POS, Reportes abre Correcciones (sin barra de una sola pestaña)', async () => {
    sesion = { rol: 'admin', modulos: TODOS_LOS_MODULOS.filter(m => m !== 'pos') };
    try {
      await abrir('/app#reportes');
      const r = await reportes();
      assert(r.correcciones && !r.ventas && !r.visible && r.menu === 'tab-ventas' && r.hash === '#reportes/correcciones', `sin POS: ${JSON.stringify(r)}`);
    } finally { sesion = { rol: 'admin', modulos: TODOS_LOS_MODULOS }; }
  });

  // ── K. Fase 3.1: Mesas y Compras dentro del panel ─────────────────────────
  // Antes eran páginas aparte y el menú lateral desaparecía. Ahora se abren en
  // un marco dentro del panel; sus direcciones viejas siguen abriendo solas.
  const marco = (id) => page.evaluate((id) => {
    const f = document.getElementById(id);
    let d = null;
    try { d = f.contentDocument; } catch { /* otro origen: no pasa aquí */ }
    const vis = (el) => !!el && getComputedStyle(el).display !== 'none';
    const r = f.getBoundingClientRect();
    return {
      src: f.getAttribute('src') || '',
      visible: vis(f) && vis(f.closest('.vista-marco')) && vis(document.getElementById('vistas-extra')),
      menuLateral: vis(document.getElementById('tabs-nav')),
      activo: document.querySelector('.tab-btn.activo')?.id, hash: location.hash,
      enPanel: !!d && d.documentElement.classList.contains('en-panel'),
      encabezado: !!d && vis(d.querySelector('header')),
      letra: d && d.body ? getComputedStyle(d.body).fontFamily : '',
      alto: Math.round(r.height), abajo: Math.round(r.bottom), ancho: Math.round(r.width),
      alturaVentana: innerHeight, anchoVentana: innerWidth,
    };
  }, id);
  const esperarMesas = () => page.waitForFunction(
    () => document.getElementById('marco-mesas')?.contentDocument?.querySelectorAll('#grid .mesa').length === 2, { timeout: 10000 });
  const esperarCompras = () => page.waitForFunction(() => {
    const m = document.getElementById('marco-compras')?.contentDocument?.getElementById('m-fondo');
    return !!m && m.textContent.trim() !== '—' && m.textContent.trim() !== '';
  }, { timeout: 10000 });
  // Compras vive en "Finanzas", que de entrada viene plegado: como una
  // persona, primero se abre el grupo.
  const pulsarMenu = async (id) => {
    const grupo = await page.evaluate((id) => {
      const sec = document.getElementById(id).closest('[id^="navsec-"]');
      return sec && sec.hidden ? sec.id.replace('navsec-', 'navgrp-') : null;
    }, id);
    if (grupo) await page.click('#' + grupo);
    await page.click('#' + id);
  };
  const verEfirma = () => page.waitForFunction(
    () => document.getElementById('marco-compras')?.contentDocument?.getElementById('view-sat')?.hidden === false, { timeout: 5000 });

  await t('K1. Mesas se abre dentro del panel, con el menú a la vista, y #mesas sobrevive a la recarga', async () => {
    await abrir('/app');
    await page.click('#tab-restaurante');
    await esperarMesas();
    let m = await marco('marco-mesas');
    assert(m.visible && m.menuLateral && m.activo === 'tab-restaurante' && m.hash === '#mesas', `vista: ${JSON.stringify(m)}`);
    assert(m.src === '/restaurante' && m.enPanel && !m.encabezado, `marco: ${JSON.stringify(m)}`);
    // Cabe en la pantalla: el tablero se desplaza dentro del marco, no la página.
    assert(m.abajo <= m.alturaVentana && m.alto >= 450, `medidas: ${JSON.stringify(m)}`);
    await abrir('/app#mesas');
    await esperarMesas();
    m = await marco('marco-mesas');
    assert(m.visible && m.activo === 'tab-restaurante' && m.hash === '#mesas', `recarga: ${JSON.stringify(m)}`);
  });

  await t('K2. "Pantalla completa" esconde el menú lateral; salir de Mesas lo devuelve', async () => {
    await abrir('/app#mesas');
    await esperarMesas();
    const rotulo = () => page.$eval('#btn-pantalla-completa', b => b.textContent.trim());
    await page.click('#btn-pantalla-completa');
    let m = await marco('marco-mesas');
    let r = await rotulo();
    assert(!m.menuLateral && m.ancho >= m.anchoVentana - 80 && r === 'Salir de pantalla completa', `encendida: ${JSON.stringify({ ...m, r })}`);
    await page.click('#btn-pantalla-completa');
    m = await marco('marco-mesas');
    r = await rotulo();
    assert(m.menuLateral && r === 'Pantalla completa', `apagada: ${JSON.stringify({ ...m, r })}`);
    // Encendida y, desde otra parte (una notificación, el encabezado), a Pedidos.
    await page.click('#btn-pantalla-completa');
    await page.evaluate(() => mostrarTab('comandas'));
    const e = await page.evaluate(() => ({ clase: document.body.classList.contains('pantalla-completa'), menu: getComputedStyle(document.getElementById('tabs-nav')).display }));
    assert(!e.clase && e.menu !== 'none', `al salir de Mesas: ${JSON.stringify(e)}`);
  });

  await t('K3. al volver a Mesas el tablero se actualiza en el acto y no se recarga (lo capturado no se pierde)', async () => {
    await abrir('/app#mesas');
    await esperarMesas();
    await page.evaluate(() => { document.getElementById('marco-mesas').contentWindow.__sigue = true; });
    await page.click('#tab-comandas');
    const antes = pedidasMesas;
    await page.click('#tab-restaurante');
    const limite = Date.now() + 5000;
    while (pedidasMesas === antes && Date.now() < limite) await new Promise(r => setTimeout(r, 50));
    const sigue = await page.evaluate(() => document.getElementById('marco-mesas').contentWindow.__sigue === true);
    assert(pedidasMesas === antes + 1, `consultas al volver: ${pedidasMesas - antes}`);
    assert(sigue, 'el marco se recargó: se perdería lo que se estaba capturando');
  });

  await t('K4. Compras se abre dentro del panel con la letra del panel; el enlace de la e.firma la abre en su pestaña', async () => {
    await abrir('/app');
    await pulsarMenu('tab-compras');
    await esperarCompras();
    let m = await marco('marco-compras');
    assert(m.visible && m.menuLateral && m.activo === 'tab-compras' && m.hash === '#compras', `vista: ${JSON.stringify(m)}`);
    assert(m.src === '/compras.html' && m.enPanel && !m.encabezado && /Inter/.test(m.letra), `marco: ${JSON.stringify(m)}`);
    assert(m.abajo <= m.alturaVentana && m.alto >= 500, `medidas: ${JSON.stringify(m)}`);
    // El aviso de Facturación enlaza #compras/sat: con Compras ya cargada,
    // cambia de pestaña adentro y la dirección vuelve a #compras.
    await page.evaluate(() => mostrarTab('facturacion'));
    await page.evaluate(() => document.querySelector('a[href="#compras/sat"]').click());
    await verEfirma();
    m = await marco('marco-compras');
    assert(m.visible && m.activo === 'tab-compras' && m.hash === '#compras', `e.firma con Compras cargada: ${JSON.stringify(m)}`);
    // Entrando directo por la dirección, con el marco todavía sin cargar.
    await abrir('/app#compras/sat');
    await esperarCompras();
    await verEfirma();
    m = await marco('marco-compras');
    assert(m.src === '/compras.html#sat' && m.hash === '#compras', `e.firma directa: ${JSON.stringify(m)}`);
    // Volver a Compras desde el menú no la regresa a la e.firma.
    await page.evaluate(() => document.getElementById('marco-compras').contentDocument.querySelector('[data-view="compras"]').click());
    await page.click('#tab-comandas');
    await pulsarMenu('tab-compras');
    const sat = await page.evaluate(() => document.getElementById('marco-compras').contentDocument.getElementById('view-sat').hidden);
    assert(sat === true, 'volver a Compras desde el menú abrió otra vez la e.firma');
  });

  await t('K5. el operador ve Mesas y no Compras; #compras lo deja en Pedidos sin cargar Compras', async () => {
    sesion = { rol: 'staff', modulos: TODOS_LOS_MODULOS };
    try {
      await abrir('/app');
      const menu = await page.evaluate(() => ({
        mesas: getComputedStyle(document.getElementById('tab-restaurante')).display !== 'none',
        compras: getComputedStyle(document.getElementById('tab-compras')).display !== 'none',
      }));
      assert(menu.mesas && !menu.compras, `menú del operador: ${JSON.stringify(menu)}`);
      await page.click('#tab-restaurante');
      await esperarMesas();
      const m = await marco('marco-mesas');
      assert(m.visible && m.activo === 'tab-restaurante', `Mesas del operador: ${JSON.stringify(m)}`);
      await abrir('/app#compras');
      const c = await page.evaluate(() => ({
        activo: document.querySelector('.tab-btn.activo')?.id,
        src: document.getElementById('marco-compras').getAttribute('src'),
        vista: getComputedStyle(document.getElementById('vista-compras')).display,
      }));
      assert(c.activo === 'tab-comandas' && !c.src && c.vista === 'none', `#compras del operador: ${JSON.stringify(c)}`);
    } finally { sesion = { rol: 'admin', modulos: TODOS_LOS_MODULOS }; }
    // Un negocio sin el módulo Restaurante no ve Mesas ni la carga por dirección.
    sesion = { rol: 'admin', modulos: TODOS_LOS_MODULOS.filter(m => m !== 'restaurante') };
    try {
      await abrir('/app#mesas');
      const r = await page.evaluate(() => ({
        boton: getComputedStyle(document.getElementById('tab-restaurante')).display,
        src: document.getElementById('marco-mesas').getAttribute('src'),
        vista: getComputedStyle(document.getElementById('vista-restaurante')).display,
      }));
      assert(r.boton === 'none' && !r.src && r.vista === 'none', `sin el módulo: ${JSON.stringify(r)}`);
    } finally { sesion = { rol: 'admin', modulos: TODOS_LOS_MODULOS }; }
  });

  await t('K6. si la sesión vence adentro, el login sale en la ventana completa y regresa a la misma pantalla', async () => {
    const loginDeLaVentana = () => page.waitForRequest(
      r => r.isNavigationRequest() && r.frame() === page.mainFrame() && /\/login/.test(r.url()), { timeout: 10000 });
    await abrir('/app');
    vencida.compras = true;
    try {
      const pedida = loginDeLaVentana();
      await pulsarMenu('tab-compras');
      const url = (await pedida).url();
      assert(url === base + '/login?redirect=' + encodeURIComponent('/app#compras'), `Compras: ${url}`);
    } finally { vencida.compras = false; }
    await abrir('/app');
    vencida.mesas = true;
    try {
      const pedida = loginDeLaVentana();
      await page.click('#tab-restaurante');
      const url = (await pedida).url();
      assert(url === base + '/login-negocio.html?redirect=' + encodeURIComponent('/app#mesas'), `Mesas: ${url}`);
    } finally { vencida.mesas = false; }
  });

  await t('K7. las direcciones viejas siguen abriendo solas, con su encabezado y enlaces de regreso al panel', async () => {
    await page.setViewport({ width: 1366, height: 768 });
    await page.goto('about:blank');
    await page.goto(base + '/compras.html', { waitUntil: 'networkidle2' });
    await page.waitForFunction(() => { const m = document.getElementById('m-fondo'); return !!m && m.textContent.trim() !== '—'; }, { timeout: 10000 });
    const c = await page.evaluate(() => ({
      url: location.pathname, enPanel: document.documentElement.classList.contains('en-panel'),
      encabezado: getComputedStyle(document.querySelector('header')).display !== 'none',
      enlaces: [...document.querySelectorAll('header a')].map(a => a.getAttribute('href')),
    }));
    assert(c.url === '/compras.html' && !c.enPanel && c.encabezado, `Compras sola: ${JSON.stringify(c)}`);
    assert(JSON.stringify(c.enlaces) === '["/app","/app#compras"]', `enlaces de Compras: ${c.enlaces.join(', ')}`);
    await page.goto(base + '/restaurante', { waitUntil: 'networkidle2' });
    await page.waitForFunction(() => document.querySelectorAll('#grid .mesa').length === 2, { timeout: 10000 });
    const r = await page.evaluate(() => ({
      url: location.pathname, enPanel: document.documentElement.classList.contains('en-panel'),
      encabezado: getComputedStyle(document.querySelector('header.xb')).display !== 'none',
      panel: document.getElementById('link-panel').getAttribute('href'),
    }));
    assert(r.url === '/restaurante' && !r.enPanel && r.encabezado && r.panel === '/app#mesas', `Mesas sola: ${JSON.stringify(r)}`);
  });

  await t('K8. "+ Nuevo pedido › Mesas" y el cajón del celular abren Mesas dentro del panel; en el celular nada queda bajo la barra de abajo', async () => {
    await abrir('/app#pedidos');
    await page.evaluate(() => abrirNuevoPedido());
    const tarjeta = await page.evaluate(() => {
      const b = document.querySelector('#modal-modalidad .modalidad-card[data-modulo="restaurante"]');
      return b ? { modal: getComputedStyle(document.getElementById('modal-modalidad')).display, tarjeta: getComputedStyle(b).display, alto: b.getBoundingClientRect().height } : null;
    });
    assert(tarjeta && tarjeta.modal !== 'none' && tarjeta.tarjeta !== 'none' && tarjeta.alto > 0, `la tarjeta Restaurante de Nuevo pedido no se ve: ${JSON.stringify(tarjeta)}`);
    await page.click('#modal-modalidad .modalidad-card[data-modulo="restaurante"]');
    await esperarMesas();
    let m = await marco('marco-mesas');
    assert(m.visible && m.activo === 'tab-restaurante' && m.hash === '#mesas', `desde Nuevo pedido: ${JSON.stringify(m)}`);
    await abrir('/app', { ancho: 375, alto: 812 });
    await page.evaluate(() => abrirMasSheet());
    const rotulos = await page.evaluate(() => [...document.querySelectorAll('#mas-lista .mas-item')].map(e => e.textContent.trim()));
    const i = rotulos.indexOf('Mesas');
    assert(i >= 0, `el cajón no trae Mesas: ${rotulos.join(' · ')}`);
    await page.waitForFunction((i) => {
      const r = document.querySelectorAll('#mas-lista .mas-item')[i].getBoundingClientRect();
      // El cajón entra deslizándose desde la derecha: se pulsa ya quieto.
      return r.height > 0 && r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
    }, { timeout: 5000 }, i);
    await (await page.$$('#mas-lista .mas-item'))[i].click();
    await esperarMesas();
    m = await marco('marco-mesas');
    const barra = await page.evaluate(() => Math.round(document.getElementById('bottom-nav').getBoundingClientRect().top));
    assert(m.visible && m.hash === '#mesas', `desde el cajón: ${JSON.stringify(m)}`);
    // En el celular el marco termina antes de la barra de abajo (Mesas y Compras).
    assert(m.abajo <= barra && m.alto >= 450, `medidas en el celular: ${JSON.stringify({ ...m, barra })}`);
    await page.evaluate(() => mostrarTab('compras'));
    await esperarCompras();
    const c = await marco('marco-compras');
    assert(c.visible && c.abajo <= barra && c.alto >= 450, `Compras en el celular: ${JSON.stringify({ ...c, barra })}`);
  });

  await t('K9. en pantallas bajas, con Mesas dentro del panel, la cuenta muestra lo que se va capturando', async () => {
    // Reporte del 25-sep: en laptops (1366×768, 1280×800, 1536×864) la lista
    // de la cuenta quedaba en 0 px -- el total y los botones de abajo se
    // comían todo el alto -- y el mesero no veía lo que capturaba.
    const medir = async (ancho, alto, { hoja = false } = {}) => {
      await abrir('/app#mesas', { ancho, alto });
      await esperarMesas();
      const mesas = page.frames().find(f => f.url().endsWith('/restaurante'));
      await mesas.evaluate(() => abrirCuenta('c5'));
      await mesas.waitForFunction(() => document.querySelectorAll('#cu-lineas .linea').length === 6, { timeout: 8000 });
      return mesas.evaluate((hoja) => {
        if (hoja) alternarCuenta();
        const cuenta = document.getElementById('cuenta');
        const dentro = (el, caja) => { const b = el.getBoundingClientRect(); return b.height > 0 && b.top >= Math.max(0, caja.top) - 1 && b.bottom <= Math.min(innerHeight, caja.bottom) + 1; };
        const lista = document.getElementById('cu-lineas').getBoundingClientRect();
        const pendientes = [...document.querySelectorAll('#cu-lineas .ronda.pend .linea')];
        const r = {
          hoja: cuenta.classList.contains('abierta'),
          altoLista: Math.round(lista.height),
          ultimaPendiente: dentro(pendientes[pendientes.length - 1], lista),
          enviar: dentro(document.getElementById('btn-comanda'), cuenta.getBoundingClientRect()),
        };
        // Los botones de abajo (Registrar pago, Cerrar cuenta…) se alcanzan
        // deslizando la cuenta hasta el final, y «Enviar a cocina» no se pierde.
        cuenta.scrollTop = cuenta.scrollHeight;
        const acciones = [...document.querySelectorAll('#cu-secundarias button')];
        r.ultimaAccion = dentro(acciones[acciones.length - 1], cuenta.getBoundingClientRect());
        r.enviarAlFinal = dentro(document.getElementById('btn-comanda'), cuenta.getBoundingClientRect());
        return r;
      }, hoja);
    };
    const bien = (r) => r.altoLista >= 150 && r.ultimaPendiente && r.enviar && r.ultimaAccion && r.enviarAlFinal;
    // Laptop 1366×768 (ventana útil 657) y una aún más baja (600: barra de
    // favoritos o zoom): cuenta al lado.
    for (const [ancho, alto] of [[1366, 657], [1366, 600]]) {
      const r = await medir(ancho, alto);
      assert(!r.hoja && bien(r), `${ancho}×${alto}: ${JSON.stringify(r)}`);
    }
    // Tablet horizontal dentro del panel: la cuenta es la hoja «Ver cuenta».
    const h = await medir(1024, 700, { hoja: true });
    assert(h.hoja && bien(h), `hoja «Ver cuenta» 1024×700: ${JSON.stringify(h)}`);
  });

  // ── L. Fase 3.2: Tienda › Productos ───────────────────────────────────────
  // El producto se edita en el Menú (no hay catálogo aparte): cada fila lleva
  // "Editar en Menú", fuera de la casilla de publicar.
  const abrirProductosTienda = async () => {
    await page.evaluate(() => { TND.seccion = 'productos'; mostrarTab('tienda'); });
    await page.waitForFunction(() => document.querySelectorAll('#tnd-sec-productos .tnd-prod').length === 3, { timeout: 5000 });
  };
  const filasTienda = () => page.evaluate(() => [...document.querySelectorAll('#tnd-sec-productos .tnd-prod-fila')].map(f => ({
    nombre: f.querySelector('.nom').textContent.replace(/\s+/g, ' ').trim(),
    editar: !!f.querySelector('.tnd-editar-menu'),
    publicado: f.querySelector('input[type=checkbox]').checked,
    categoriaOculta: (() => {
      const aviso = f.querySelector('.tnd-cat-oculta');
      return !!aviso && getComputedStyle(aviso).display !== 'none'
        && /categoría oculta:\s*no sale en la tienda/i.test(aviso.textContent);
    })(),
  })));

  await t('L1. Tienda › Productos marca el agotado y "Editar en Menú" abre ese producto en el Menú sin tocar su publicación', async () => {
    await abrir('/app');
    await abrirProductosTienda();
    const filas = await filasTienda();
    assert(filas.length === 3 && filas.every(f => f.editar), `filas: ${JSON.stringify(filas)}`);
    assert(/agotado en menú/.test(filas[1].nombre) && !/agotado/.test(filas[0].nombre + filas[2].nombre), `agotado: ${JSON.stringify(filas)}`);
    const antes = publicaciones;
    await page.click('button.tnd-editar-menu[onclick="tndEditarEnMenu(12)"]');
    await page.waitForFunction(() => document.getElementById('mp-nombre')?.value === 'Alitas BBQ', { timeout: 5000 });
    const r = await page.evaluate(() => ({
      activo: document.querySelector('.tab-btn.activo')?.id, hash: location.hash,
      menu: getComputedStyle(document.getElementById('vista-menu')).display,
      categoria: document.getElementById('mp-cat')?.value,
    }));
    assert(r.activo === 'tab-menu' && r.hash === '#menu' && r.menu !== 'none' && r.categoria === '1', `Menú: ${JSON.stringify(r)}`);
    assert(publicaciones === antes, 'pulsar "Editar en Menú" publicó o despublicó el producto');
    await page.evaluate(() => document.getElementById('modal-producto')?.remove());
  });

  await t('L2. la categoría oculta se ve gris en el editor, abre su producto y se puede reactivar', async () => {
    categoriaPostresActiva = false;
    cambiosCategoria.length = 0;
    try {
      await abrir('/app');
      await abrirProductosTienda();
      const filas = await filasTienda();
      const postre = filas.find(f => /Postre del mes/.test(f.nombre));
      assert(postre?.categoriaOculta, `Tienda no avisó que Postres está oculta: ${JSON.stringify(filas)}`);
      assert(filas.filter(f => f.categoriaOculta).length === 1,
        `el aviso de categoría oculta apareció en filas equivocadas: ${JSON.stringify(filas)}`);

      const lecturasAntes = lecturasMenuAdmin;
      await page.click('button.tnd-editar-menu[onclick="tndEditarEnMenu(13)"]');
      await page.waitForFunction(() => document.getElementById('mp-nombre')?.value === 'Postre del mes', { timeout: 5000 });
      await page.waitForSelector('[data-categoria-id="2"]');
      const oculta = await page.evaluate(() => {
        const tarjeta = document.querySelector('[data-categoria-id="2"]');
        const activa = document.querySelector('[data-categoria-id="1"]');
        const estilo = getComputedStyle(tarjeta);
        const estiloActiva = getComputedStyle(activa);
        const check = tarjeta.querySelector('[data-accion="toggle-categoria"]');
        return {
          dataActiva: tarjeta.dataset.activa,
          claseInactiva: tarjeta.classList.contains('menu-editor-categoria--inactiva'),
          checked: check?.checked,
          badge: /categoría oculta/i.test(tarjeta.textContent),
          gris: Number(estilo.opacity) < Number(estiloActiva.opacity)
            || estilo.backgroundColor !== estiloActiva.backgroundColor
            || (estilo.filter !== 'none' && estilo.filter !== estiloActiva.filter),
          modal: document.getElementById('mp-nombre')?.value,
          categoriaModal: document.getElementById('mp-cat')?.value,
        };
      });
      assert(lecturasMenuAdmin > lecturasAntes, 'el editor no pidió el menú administrativo');
      assert(oculta.dataActiva === 'false' && oculta.claseInactiva,
        `la tarjeta no quedó marcada como inactiva: ${JSON.stringify(oculta)}`);
      assert(oculta.checked === false, `la casilla de Postres quedó marcada: ${JSON.stringify(oculta)}`);
      assert(oculta.badge, `la categoría inactiva no trae su badge: ${JSON.stringify(oculta)}`);
      assert(oculta.gris, `la categoría inactiva no se ve atenuada/gris: ${JSON.stringify(oculta)}`);
      assert(oculta.modal === 'Postre del mes' && oculta.categoriaModal === '2',
        `«Editar en Menú» no abrió el producto oculto: ${JSON.stringify(oculta)}`);

      await page.evaluate(() => document.getElementById('modal-producto')?.remove());
      const patch = page.waitForResponse(r => r.request().method() === 'PATCH'
        && /\/api\/admin\/menu\/categorias\/2$/.test(new URL(r.url()).pathname));
      const recargaToggle = page.waitForResponse(r => r.request().method() === 'GET'
        && /\/api\/admin\/menu$/.test(new URL(r.url()).pathname));
      await page.click('[data-categoria-id="2"] [data-accion="toggle-categoria"]');
      const respuestaPatch = await patch;
      assert(respuestaPatch.ok(), `reactivar respondió ${respuestaPatch.status()}`);
      assert(JSON.stringify(cambiosCategoria.at(-1)) === JSON.stringify({ id: 2, activa: true }),
        `PATCH inesperado: ${JSON.stringify(cambiosCategoria.at(-1))}`);
      assert((await recargaToggle).ok(), 'el toggle no recargó el menú administrativo');
      await page.waitForFunction(() => {
        const tarjeta = document.querySelector('[data-categoria-id="2"]');
        return tarjeta?.dataset.activa === 'true'
          && !tarjeta.classList.contains('menu-editor-categoria--inactiva')
          && tarjeta.querySelector('[data-accion="toggle-categoria"]')?.checked === true;
      }, { timeout: 5000 });

      // Además de la recarga canónica del toggle, una recarga COMPLETA debe
      // conservar la reactivación: es la reproducción exacta del bug original.
      await page.reload({ waitUntil: 'networkidle2' });
      await page.waitForFunction(() => typeof MODULOS !== 'undefined' && MODULOS.length > 0);
      await page.waitForSelector('[data-categoria-id="2"]');
      const reactivada = await page.$eval('[data-categoria-id="2"]', tarjeta => ({
        dataActiva: tarjeta.dataset.activa,
        claseInactiva: tarjeta.classList.contains('menu-editor-categoria--inactiva'),
        checked: tarjeta.querySelector('[data-accion="toggle-categoria"]')?.checked,
        badge: /categoría oculta/i.test(tarjeta.textContent),
      }));
      assert(reactivada.dataActiva === 'true' && reactivada.checked === true,
        `Postres no persistió reactivada: ${JSON.stringify(reactivada)}`);
      assert(!reactivada.claseInactiva && !reactivada.badge,
        `Postres conservó el estado visual oculto: ${JSON.stringify(reactivada)}`);

      // Camino que originó el incidente: al desmarcar, la recarga automática
      // debe conservar la tarjeta (gris y desmarcada), no borrarla del editor.
      const patchOcultar = page.waitForResponse(r => r.request().method() === 'PATCH'
        && /\/api\/admin\/menu\/categorias\/2$/.test(new URL(r.url()).pathname));
      const recargaOcultar = page.waitForResponse(r => r.request().method() === 'GET'
        && /\/api\/admin\/menu$/.test(new URL(r.url()).pathname));
      await page.click('[data-categoria-id="2"] [data-accion="toggle-categoria"]');
      assert((await patchOcultar).ok(), 'ocultar la categoría no respondió OK');
      assert(JSON.stringify(cambiosCategoria.at(-1)) === JSON.stringify({ id: 2, activa: false }),
        `PATCH al ocultar inesperado: ${JSON.stringify(cambiosCategoria.at(-1))}`);
      assert((await recargaOcultar).ok(), 'ocultar no recargó el menú administrativo');
      await page.waitForFunction(() => {
        const tarjeta = document.querySelector('[data-categoria-id="2"]');
        return tarjeta?.dataset.activa === 'false'
          && tarjeta.classList.contains('menu-editor-categoria--inactiva')
          && tarjeta.querySelector('[data-accion="toggle-categoria"]')?.checked === false;
      }, { timeout: 5000 });

      // Si el PATCH falla, la recarga canónica revierte el estado optimista de
      // la casilla y mantiene visible la categoría que sigue oculta en DB.
      fallaPatchCategoria = true;
      const patchFallido = page.waitForResponse(r => r.request().method() === 'PATCH'
        && /\/api\/admin\/menu\/categorias\/2$/.test(new URL(r.url()).pathname));
      const recargaTrasFallo = page.waitForResponse(r => r.request().method() === 'GET'
        && /\/api\/admin\/menu$/.test(new URL(r.url()).pathname));
      await page.click('[data-categoria-id="2"] [data-accion="toggle-categoria"]');
      assert((await patchFallido).status() === 500, 'el mock no produjo el PATCH fallido');
      assert((await recargaTrasFallo).ok(), 'el fallo del PATCH no recargó el estado canónico');
      await page.waitForFunction(() => {
        const tarjeta = document.querySelector('[data-categoria-id="2"]');
        return tarjeta?.dataset.activa === 'false'
          && tarjeta.classList.contains('menu-editor-categoria--inactiva')
          && tarjeta.querySelector('[data-accion="toggle-categoria"]')?.checked === false
          && /Fallo simulado al actualizar/.test(document.getElementById('avisos-panel')?.textContent || '');
      }, { timeout: 5000 });
    } finally {
      categoriaPostresActiva = false;
      fallaPatchCategoria = false;
    }
  });

  await t('L3. sin el módulo Menú, Tienda no ofrece "Editar en Menú"', async () => {
    sesion = { rol: 'admin', modulos: TODOS_LOS_MODULOS.filter(m => m !== 'menu') };
    try {
      await abrir('/app');
      await abrirProductosTienda();
      const filas = await filasTienda();
      assert(filas.length === 3 && filas.every(f => !f.editar), `sin Menú: ${JSON.stringify(filas)}`);
    } finally { sesion = { rol: 'admin', modulos: TODOS_LOS_MODULOS }; }
  });

  await t('B1. estando en Inicio, un pedido nuevo suena, imprime su comanda y sube los contadores', async () => {
    await abrir('/app');
    await page.evaluate(() => {
      window.__sonidos = 0; window.__impresiones = 0;
      sonarAlerta = function () { window.__sonidos++; };
      abrirPopupImpresion = function () { window.__impresiones++; return true; };
    });
    // El panel ignora los avisos de los primeros 3 s tras conectar (replay).
    await page.waitForFunction(() => panelListo === true, { timeout: 10000 });
    const antes = await page.evaluate(() => document.getElementById('nav-contador-pedidos').hidden);
    assert(antes, 'el contador de Pedidos en el menú se ve con cero pedidos');
    assert(empujarPedido('XAB-0777') >= 1, 'el panel no tiene WebSocket abierto');
    await page.waitForFunction(() => window.__impresiones > 0, { timeout: 5000 }).catch(() => {});
    const r = await page.evaluate(() => ({
      sonidos: window.__sonidos, impresiones: window.__impresiones,
      tarjeta: !!document.getElementById('comanda-XAB-0777'),
      inicio: document.getElementById('inicio-activos').textContent,
      contador: document.getElementById('contador').textContent,
      menu: document.getElementById('nav-contador-pedidos').hidden ? 'oculto' : document.getElementById('nav-contador-pedidos').textContent,
      sigueEnInicio: getComputedStyle(document.getElementById('vista-inicio')).display !== 'none',
    }));
    assert(r.sonidos === 1, `sonidos: ${r.sonidos}`);
    assert(r.impresiones === 1, `impresiones de comanda: ${r.impresiones}`);
    assert(r.tarjeta, 'el pedido no entró al tablero');
    assert(r.inicio === '1' && r.contador === '1 activo', `contadores: Inicio=${r.inicio}, encabezado=${r.contador}`);
    assert(r.menu === '1', `contador junto a Pedidos en el menú: ${r.menu}`);
    assert(r.sigueEnInicio, 'el pedido sacó al usuario de Inicio');
  });

  // ── C. Día a día cabe entero en una pantalla de 768 px ────────────────────
  // 1366×768 es la ventana completa; 1366×625 es lo que queda en esa misma
  // pantalla con la barra de tareas de Windows y la del navegador.
  const medirDiaADia = () => page.evaluate(() => {
    const nav = document.getElementById('tabs-nav');
    const caja = nav.getBoundingClientRect();
    const tope = Math.min(caja.bottom, innerHeight);
    const items = [...document.querySelectorAll('#navsec-diadia .tab-btn')]
      .filter(b => getComputedStyle(b).display !== 'none')
      .map(b => ({ id: b.id, arriba: b.getBoundingClientRect().top, abajo: b.getBoundingClientRect().bottom }));
    return { scrollTop: nav.scrollTop, tope, items, fuera: items.filter(i => i.abajo > tope || i.arriba < caja.top).map(i => i.id) };
  });
  for (const alto of [768, 625]) {
    await t(`C${alto === 768 ? 1 : 2}. a 1366×${alto} Día a día se ve completo sin scroll (5 destinos)`, async () => {
      await abrir('/app', { alto });
      const m = await medirDiaADia();
      // Inicio, Pedidos, Mesas, Chats y Caja: Historial y Repartidores son
      // pestañas de Pedidos desde la Fase 2.
      assert(m.items.length === 5, `destinos visibles en Día a día: ${m.items.map(i => i.id).join(', ')}`);
      assert(m.scrollTop === 0, 'el menú arrancó desplazado');
      assert(m.fuera.length === 0, `quedan fuera de la vista: ${m.fuera.join(', ')} (tope ${m.tope}px)`);
    });
  }
  await t('C3. con Negocio y Finanzas abiertos, Día a día sigue a la vista', async () => {
    await abrir('/app', { alto: 625 });
    await page.evaluate(() => { for (const g of NAV_GRUPOS) aplicarGrupoNav(g, true); });
    const m = await medirDiaADia();
    assert(m.fuera.length === 0, `quedan fuera de la vista: ${m.fuera.join(', ')}`);
    await page.evaluate(() => localStorage.clear());
  });

  // ── D. Plegado ────────────────────────────────────────────────────────────
  await t('D1. de entrada Negocio y Finanzas vienen cerrados y Día a día abierto', async () => {
    await page.evaluate(() => localStorage.clear());
    await abrir('/app');
    const r = await page.evaluate(() => ({
      negocio: document.getElementById('navgrp-negocio').getAttribute('aria-expanded'),
      finanzas: document.getElementById('navgrp-finanzas').getAttribute('aria-expanded'),
      diadia: document.getElementById('navsec-diadia').hidden,
    }));
    assert(r.negocio === 'false' && r.finanzas === 'false' && r.diadia === false, JSON.stringify(r));
  });

  await t('D2. lo que el usuario abre se recuerda al recargar', async () => {
    await page.click('#navgrp-negocio');
    await page.reload({ waitUntil: 'networkidle2' });
    await page.waitForFunction(() => typeof MODULOS !== 'undefined' && MODULOS.length > 0);
    const r = await page.evaluate(() => ({
      negocio: document.getElementById('navgrp-negocio').getAttribute('aria-expanded'),
      finanzas: document.getElementById('navgrp-finanzas').getAttribute('aria-expanded'),
    }));
    assert(r.negocio === 'true' && r.finanzas === 'false', JSON.stringify(r));
  });

  await t('D3. hacer clic en "Día a día" no la pliega', async () => {
    await page.click('#navgrp-diadia');
    const oculta = await page.evaluate(() => document.getElementById('navsec-diadia').hidden
      || getComputedStyle(document.getElementById('navsec-diadia')).display === 'none');
    assert(!oculta, 'Día a día se plegó');
    await page.evaluate(() => localStorage.clear());
  });

  // ── E. Móvil ──────────────────────────────────────────────────────────────
  await t('E1. en el móvil, el cajón "Más" sigue el orden del menú y Caja se llama Caja', async () => {
    await abrir('/app', { ancho: 375, alto: 812 });
    const r = await page.evaluate(() => ({
      sidebar: getComputedStyle(document.getElementById('tabs-nav')).display,
      barraCaja: document.querySelector('#bnav-corte span').textContent.trim(),
      barraPedidos: document.querySelector('#bnav-comandas span').textContent.trim(),
      cajon: [...document.querySelectorAll('#mas-lista > *')].map(e =>
        e.classList.contains('mas-grupo') ? '# ' + e.textContent.trim()
          : e.classList.contains('mas-separador') ? '---' : e.textContent.trim()),
    }));
    assert(r.sidebar === 'none', 'el menú lateral se ve en el móvil');
    assert(r.barraCaja === 'Caja', `la barra inferior dice ${r.barraCaja}`);
    assert(r.barraPedidos === 'Pedidos', `en el celular el tablero se llama ${r.barraPedidos}, en el menú Pedidos`);
    // Historial y Repartidores ya no están en el menú: son pestañas de Pedidos.
    const esperado = ['# Día a día', 'Inicio', 'Mesas',
      '# Negocio', 'Clientes', 'Cotizaciones', 'Menú', 'Tienda en línea', 'Llamadas',
      '# Finanzas', 'Reportes', 'Facturación', 'Compras y gastos', '---', 'Configuración'];
    assert(JSON.stringify(r.cajon) === JSON.stringify(esperado), `cajón: ${r.cajon.join(' · ')}`);
  });

  await t('E2. en el celular, el operador solo tiene Pedidos, Nuevo y Más (con Mesas)', async () => {
    sesion = { rol: 'staff', modulos: TODOS_LOS_MODULOS };
    try {
      await abrir('/app', { ancho: 375, alto: 812 });
      const r = await page.evaluate(() => ({
        barra: [...document.querySelectorAll('#bottom-nav .bnav-item')]
          .filter(b => getComputedStyle(b).display !== 'none')
          .map(b => [...b.querySelectorAll('span')].map(s => s.textContent.trim()).filter(t => t && !/^\d+$/.test(t)).pop()),
        cajon: [...document.querySelectorAll('#mas-lista .mas-item')].map(e => e.textContent.trim()),
      }));
      assert(JSON.stringify(r.barra) === JSON.stringify(['Pedidos', 'Nuevo', 'Más']), `barra: ${r.barra.join(' · ')}`);
      assert(JSON.stringify(r.cajon) === JSON.stringify(['Mesas']), `cajón: ${r.cajon.join(' · ')}`);
    } finally { sesion = { rol: 'admin', modulos: TODOS_LOS_MODULOS }; }
  });

  await t('F1. ningún error de JavaScript en todo el recorrido', async () => {
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
