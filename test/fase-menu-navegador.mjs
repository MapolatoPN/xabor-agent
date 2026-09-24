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
//   · que el cajón "Más" del móvil siga el orden del menú.
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
const API = () => ({
  '/api/auth/me': { rol: sesion.rol, negocioId: 'neg-prueba', modulos: sesion.modulos, whatsappConfigurado: true },
  '/api/config/operativa': { nombre: 'Restaurante Prueba', nombre_corto: 'XABOR', direccion: 'Calle 1', ciudad: 'Matamoros', rfc: 'XAXX010101000', telefono: '8781234567', whatsapp: '8781234567' },
  '/api/pedidos-programados': [],
  '/api/admin/checklist-activacion-bot': { automaticos: {}, manuales: {}, listoParaActivar: false },
  '/api/ventas/resumen': { total_ventas: 0, num_pedidos: 0 },
  '/api/impresion/self-service': { hayEquipo: false, cobertura: {} },
  '/api/conversaciones': [],
});
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url.startsWith('/api/')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(API()[url] ?? {}));
  }
  const archivo = (url === '/' || url === '/app') ? join(PANEL_DIR, 'index.html') : join(PANEL_DIR, url.replace(/^\//, ''));
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
          destinos: [...document.querySelectorAll('#tabs-nav .tab-btn, #tabs-nav .nav-nuevo-pedido')].filter(vis).map(b => b.textContent.trim().replace(/\s+/g, ' ')),
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

  await t('B1. estando en Inicio, un pedido nuevo suena, imprime su comanda y sube los contadores', async () => {
    await abrir('/app');
    await page.evaluate(() => {
      window.__sonidos = 0; window.__impresiones = 0;
      sonarAlerta = function () { window.__sonidos++; };
      abrirPopupImpresion = function () { window.__impresiones++; return true; };
    });
    // El panel ignora los avisos de los primeros 3 s tras conectar (replay).
    await page.waitForFunction(() => panelListo === true, { timeout: 10000 });
    assert(empujarPedido('XAB-0777') >= 1, 'el panel no tiene WebSocket abierto');
    await page.waitForFunction(() => window.__impresiones > 0, { timeout: 5000 }).catch(() => {});
    const r = await page.evaluate(() => ({
      sonidos: window.__sonidos, impresiones: window.__impresiones,
      tarjeta: !!document.getElementById('comanda-XAB-0777'),
      inicio: document.getElementById('inicio-activos').textContent,
      contador: document.getElementById('contador').textContent,
      sigueEnInicio: getComputedStyle(document.getElementById('vista-inicio')).display !== 'none',
    }));
    assert(r.sonidos === 1, `sonidos: ${r.sonidos}`);
    assert(r.impresiones === 1, `impresiones de comanda: ${r.impresiones}`);
    assert(r.tarjeta, 'el pedido no entró al tablero');
    assert(r.inicio === '1' && r.contador === '1 activo', `contadores: Inicio=${r.inicio}, encabezado=${r.contador}`);
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
    await t(`C${alto === 768 ? 1 : 2}. a 1366×${alto} Día a día se ve completo sin scroll (7 destinos)`, async () => {
      await abrir('/app', { alto });
      const m = await medirDiaADia();
      assert(m.items.length === 7, `destinos visibles en Día a día: ${m.items.map(i => i.id).join(', ')}`);
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
      cajon: [...document.querySelectorAll('#mas-lista > *')].map(e =>
        e.classList.contains('mas-grupo') ? '# ' + e.textContent.trim()
          : e.classList.contains('mas-separador') ? '---' : e.textContent.trim()),
    }));
    assert(r.sidebar === 'none', 'el menú lateral se ve en el móvil');
    assert(r.barraCaja === 'Caja', `la barra inferior dice ${r.barraCaja}`);
    const esperado = ['# Día a día', 'Inicio', 'Mesas', 'Historial', 'Repartidores',
      '# Negocio', 'Clientes', 'Rewards', 'Cotizaciones', 'Menú', 'Tienda en línea', 'Asistente', 'Llamadas',
      '# Finanzas', 'Ventas', 'Facturación', 'Correcciones de venta', 'Compras y fondos', '---', 'Configuración'];
    assert(JSON.stringify(r.cajon) === JSON.stringify(esperado), `cajón: ${r.cajon.join(' · ')}`);
  });

  await t('E2. en el celular, el operador solo tiene Comandas, Nuevo y Más (con Mesas)', async () => {
    sesion = { rol: 'staff', modulos: TODOS_LOS_MODULOS };
    try {
      await abrir('/app', { ancho: 375, alto: 812 });
      const r = await page.evaluate(() => ({
        barra: [...document.querySelectorAll('#bottom-nav .bnav-item')]
          .filter(b => getComputedStyle(b).display !== 'none')
          .map(b => [...b.querySelectorAll('span')].map(s => s.textContent.trim()).filter(t => t && !/^\d+$/.test(t)).pop()),
        cajon: [...document.querySelectorAll('#mas-lista .mas-item')].map(e => e.textContent.trim()),
      }));
      assert(JSON.stringify(r.barra) === JSON.stringify(['Comandas', 'Nuevo', 'Más']), `barra: ${r.barra.join(' · ')}`);
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
