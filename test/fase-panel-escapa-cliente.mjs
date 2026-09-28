// Textos que llegan de afuera no se ejecutan en el panel.
//
// El nombre del cliente, sus notas, su dirección, el nombre de un repartidor
// o el texto de una llamada los escribe cualquiera: la tienda en línea es
// pública, el nombre de WhatsApp lo pone el cliente en su perfil y los
// repartidores se registran solos. El panel los pinta con innerHTML dentro de
// la sesión del administrador, así que un `<img onerror>` en cualquiera de
// ellos corría con sus permisos (auditoría del 28-sep, reproducido con el
// panel de producción 7a933eb).
//
// Esta suite mete código en cada campo, recorre cada vista que los pinta y
// exige dos cosas: que nada se ejecute y que el texto se vea tal cual (un
// escape que se come el texto también es un bug). Para los manejadores en
// línea (onclick="f('…')") exige además que la función reciba el valor EXACTO.
//
// No necesita Postgres: servidor estático de juguete + panel real con
// Puppeteer, igual que fase-comanda-plegada.
//
// Uso: node test/fase-panel-escapa-cliente.mjs   (CASOS=A,B para filtrar)
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PANEL_DIR = join(__dirname, '..', 'panel');
const PUERTO = Number(process.env.TEST_PORT_ESCAPA || 0);
const FILTRO = (process.env.CASOS || '').split(',').map(s => s.trim()).filter(Boolean);

const API = {
  '/api/auth/me': { rol: 'admin', negocioId: 'neg-prueba', modulos: ['pos', 'whatsapp', 'menu', 'restaurante', 'caja'], whatsappConfigurado: true },
  '/api/config/operativa': { nombre: 'Restaurante Prueba', nombre_corto: 'XABOR', direccion: 'Calle 1', ciudad: 'Matamoros', rfc: 'XAXX010101000', telefono: '8781234567', whatsapp: '8781234567' },
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
await new Promise(r => server.listen(PUERTO, r));
const puerto = server.address().port;

// Carga que delata su ejecución: suma el lugar en window.__xss de la página
// principal (también desde un iframe o una ventana de impresión).
const X = (lugar) => `<img src=x onerror="(window.top||window).__xss=((window.top||window).__xss||[]).concat('${lugar}')">`;
// Para atributos: cierra la comilla y la etiqueta antes de inyectar. No lleva
// comillas propias (el lugar viaja como /regex/.source): el código viejo solo
// escapaba la comilla simple, y una carga con comillas simples se rompía sola
// y pasaba por inofensiva cuando no lo era.
const XA = (lugar) => `"><img src=x onerror=(window.top||window).__xss=((window.top||window).__xss||[]).concat(/${lugar}/.source)>`;

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  const clave = nombre.split('.')[0].trim();
  if (FILTRO.length && !FILTRO.includes(clave) && !FILTRO.includes(clave.replace(/\d+$/, ''))) return;
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(nombre); }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const esperar = (ms) => new Promise(r => setTimeout(r, ms));

const navegador = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await navegador.newPage();
await page.setViewport({ width: 1400, height: 900 });
page.on('dialog', d => d.dismiss().catch(() => {}));

async function limpiarXss() { await page.evaluate(() => { window.__xss = []; }); }
async function xss() { return page.evaluate(() => window.__xss || []); }
// Cambia las respuestas de apiFetch en la página para la vista que se mide.
async function simularApi(respuestas) {
  await page.evaluate((resp) => {
    window.__respuestas = resp;
    window.apiFetch = async (url) => {
      const ruta = String(url).split('?')[0];
      const cuerpo = Object.prototype.hasOwnProperty.call(window.__respuestas, ruta) ? window.__respuestas[ruta] : {};
      return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(cuerpo)), clone() { return this; } };
    };
  }, respuestas);
}
async function sinEjecucion(lugar) {
  await esperar(400);
  const corrido = await xss();
  assert(!corrido.length, `se ejecutó código en: ${corrido.join(', ')}`);
}
async function textoVisible(selector, literal) {
  const txt = await page.evaluate((s) => document.querySelector(s)?.textContent || '', selector);
  assert(txt.includes(literal), `no se ve el texto literal en ${selector}`);
}

const pedidoMalo = (id) => ({
  id, estado: 'nuevo', canal: 'tienda_online', modalidad: 'entrega a domicilio', total: 150, forma_pago: 'vales ' + X('forma-pago'),
  timestamp: new Date().toISOString(), descuento: 10, motivo_descuento: 'promo ' + X('motivo-descuento'),
  repartidor_nombre: 'Beto ' + X('repartidor'),
  cliente: { nombre: 'Ana ' + X('nombre'), telefono: '878' + X('telefono'), direccion: 'Calle 1 ' + X('direccion'), referencias: 'Casa azul ' + X('referencias') },
  items: [{ nombre: 'Licuado ' + X('item-nombre'), cantidad: 1, precio_unitario: 160, notas: 'sin hielo ' + X('item-nota') }],
});

try {
  await page.goto(`http://localhost:${puerto}/app#pedidos`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => typeof upsertPedidoEnTablero === 'function' && typeof esc === 'function');
  await limpiarXss();

  // ── A. Tablero de comandas ────────────────────────────────────────────────
  await t('A1. tarjeta del tablero: nada del cliente se ejecuta', async () => {
    await limpiarXss();
    await page.evaluate((p) => upsertPedidoEnTablero(p), pedidoMalo('XAB-9101'));
    await page.evaluate(() => toggleComanda('XAB-9101'));
    await sinEjecucion('tablero');
  });
  await t('A2. tarjeta del tablero: el nombre y la nota se leen tal cual', async () => {
    await textoVisible('#comanda-XAB-9101 .comanda-nombre', `Ana <img src=x onerror=`);
    await textoVisible('#comanda-XAB-9101 .item-nota', 'sin hielo <img src=x');
    await textoVisible('#comanda-XAB-9101 .comanda-pago', 'vales <img');
  });
  await t('A3. tarjeta para recoger: el teléfono no se ejecuta', async () => {
    await limpiarXss();
    await page.evaluate((p) => upsertPedidoEnTablero(p), { ...pedidoMalo('XAB-9109'), modalidad: 'recoger en tienda' });
    await sinEjecucion('tablero-recoger');
  });

  // ── B. Papel: comanda y ticket del cliente ────────────────────────────────
  await t('B1. comanda impresa: el HTML no trae la etiqueta cruda', async () => {
    const html = await page.evaluate((p) => comandaHTML(p), pedidoMalo('XAB-9102'));
    assert(!html.includes('<img src=x'), 'la comanda impresa trae <img crudo');
    assert(html.includes('Ana &lt;img src=x'), 'el nombre no quedó escapado en la comanda');
  });
  await t('B2. ticket del cliente: el HTML no trae la etiqueta cruda', async () => {
    const html = await page.evaluate((p) => ticketHTML(p), pedidoMalo('XAB-9103'));
    assert(!html.includes('<img src=x'), 'el ticket trae <img crudo');
    for (const literal of ['Ana &lt;img', 'Licuado &lt;img', 'sin hielo &lt;img', 'promo &lt;img', '878&lt;img', 'vales &lt;img']) {
      assert(html.includes(literal), `falta escapado: ${literal}`);
    }
  });
  await t('B3. ticket del cliente: un canal desconocido también se escapa', async () => {
    const html = await page.evaluate((p) => ticketHTML(p), { ...pedidoMalo('XAB-9104'), canal: 'otro' + X('canal') });
    assert(!html.includes('<img src=x'), 'el canal desconocido trae <img crudo');
  });
  await t('B4. ticket para recoger: el teléfono se escapa', async () => {
    const html = await page.evaluate((p) => ticketHTML(p), { ...pedidoMalo('XAB-9110'), modalidad: 'recoger en tienda' });
    assert(!html.includes('<img src=x'), 'el ticket para recoger trae <img crudo');
    assert(html.includes('878&lt;img'), 'el teléfono no quedó escapado');
  });

  // ── C. Historial ──────────────────────────────────────────────────────────
  await t('C1. historial: nada del pedido se ejecuta', async () => {
    await limpiarXss();
    const p = pedidoMalo('XAB-9105');
    await simularApi({ '/api/historial': [
      { ...p, _estado: 'entregado', entregado_at: new Date().toISOString(), devolucion: { monto: 5, motivo: 'frío ' + X('devolucion') } },
      { ...pedidoMalo('XAB-9106'), _estado: 'cancelado', entregado_at: new Date().toISOString(), cancelacion: { motivo: 'duplicado ' + X('cancelacion') } },
    ] });
    await page.evaluate(() => cargarHistorial());
    await sinEjecucion('historial');
  });
  await t('C2. historial: el motivo de cancelación se lee tal cual', async () => {
    await textoVisible('#historial-lista', 'duplicado <img src=x');
  });

  // ── D. Reporte de ventas ──────────────────────────────────────────────────
  await t('D1. ventas: cliente, pago y productos no se ejecutan', async () => {
    await limpiarXss();
    await simularApi({
      '/api/ventas': [{ folio: 'XAB-9107', created_at: new Date().toISOString(), nombre_cliente: 'Luis ' + X('ventas-cliente'), forma_pago: 'efectivo ' + X('ventas-pago'),
        modalidad: 'recoger en tienda', total: 90, items: [{ nombre: 'Pan ' + X('ventas-item'), cantidad: 1 }] }],
      '/api/ventas/resumen': { total_ventas: 90, num_pedidos: 1, promedio: 90, domicilios: 0, recoger: 1, total_envios: 0 },
    });
    await page.evaluate(() => cargarVentas('2026-09-01', '2026-09-02'));
    await sinEjecucion('ventas');
    await textoVisible('#ventas-body', 'Luis <img');
  });
  await t('D2. CSV de ventas: un nombre que empieza con = no llega como fórmula', async () => {
    const csv = await page.evaluate(() => {
      const BlobReal = window.Blob;
      let capturado = '';
      window.Blob = function (partes, opts) { capturado = partes.join(''); return new BlobReal(partes, opts); };
      const clicReal = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {};
      try {
        ventasData = [{ created_at: new Date().toISOString(), folio: 'XAB-9111', nombre_cliente: '=HYPERLINK("http://x")', telefono: '+528780000000', modalidad: 'recoger en tienda', forma_pago: '@SUM(1)', items: [], total: 10 }];
        exportarCSV();
      } finally {
        window.Blob = BlobReal;
        HTMLAnchorElement.prototype.click = clicReal;
      }
      return capturado;
    });
    assert(csv.includes(`"'=HYPERLINK(""http://x"")"`), 'el nombre con = salió como fórmula');
    assert(csv.includes(`"'@SUM(1)"`), 'la forma de pago con @ salió como fórmula');
    assert(csv.includes(`"'+528780000000"`), 'el teléfono con + salió como fórmula');
    assert(/"10"\s*$/.test(csv.trim().split('\n').pop()), 'el total perdió su valor');
  });

  // ── E. Pedidos › Domicilio ────────────────────────────────────────────────
  await t('E1. domicilio: repartidor, cliente y dirección no se ejecutan', async () => {
    await limpiarXss();
    await simularApi({
      '/api/admin/repartidores/estado': [{ nombre: 'Rafa ' + X('dom-repartidor'), pedidos: [
        { folio: 'XAB-9108', hora: '10:00', estado: 'nuevo', total: 50, cliente: 'Eva ' + X('dom-cliente'), calle: 'Olmo ' + X('dom-calle'), colonia: 'Centro', entre_calles: 'A y B ' + X('dom-entre') },
      ] }],
      '/api/admin/repartidores/candidatos': [],
    });
    await page.evaluate(() => cargarRepartidores());
    await sinEjecucion('domicilio');
    await textoVisible('#tabla-repartidores', 'Eva <img');
  });
  await t('E2. domicilio: un repartidor sin nombre no tumba la pestaña', async () => {
    await simularApi({
      '/api/admin/repartidores/estado': [{ nombre: '', pedidos: [{ folio: 'XAB-9113', hora: '10:05', estado: 'nuevo', total: 60, cliente: 'Iris', calle: 'Pino', colonia: 'Centro' }] }],
      '/api/admin/repartidores/candidatos': [],
    });
    await page.evaluate(() => cargarRepartidores());
    await esperar(300);
    const txt = await page.evaluate(() => document.getElementById('tabla-repartidores').textContent);
    assert(!/Error al cargar/.test(txt) && /Iris/.test(txt), `la pestaña quedó: ${txt.trim().slice(0, 80)}`);
  });

  // ── F. Chats ──────────────────────────────────────────────────────────────
  await t('F1. chats: un nombre de perfil con comillas no rompe el renglón', async () => {
    await limpiarXss();
    const nombre = 'Karla' + XA('chat-nombre');
    await page.evaluate((n) => {
      window.__abiertos = [];
      window.abrirConversacion = (tel, nom) => { window.__abiertos.push([tel, nom]); };
      _conversaciones = [{ telefono: '5218780000001', nombre: n, texto: 'hola', direccion: 'entrante', timestamp: new Date().toISOString() }];
      renderConversaciones();
    }, nombre);
    await sinEjecucion('chats');
  });
  await t('F2. chats: al abrir, la conversación recibe el nombre exacto', async () => {
    const nombre = 'Karla' + XA('chat-nombre');
    await page.evaluate(() => document.querySelector('#contactos-lista .chat-row').click());
    const abiertos = await page.evaluate(() => window.__abiertos);
    assert(abiertos.length === 1, `se abrió ${abiertos.length} veces`);
    assert(abiertos[0][0] === '5218780000001' && abiertos[0][1] === nombre, `recibió ${JSON.stringify(abiertos[0])}`);
  });

  // ── G. Pedidos programados ────────────────────────────────────────────────
  await t('G1. programados: cliente y productos no se ejecutan', async () => {
    await limpiarXss();
    await simularApi({ '/api/pedidos-programados': [{ programado_para: new Date().toISOString(), cliente: 'Mia ' + X('prog-cliente'), total: 80,
      items: [{ cantidad: 1, nombre: 'Taco ' + X('prog-item') }] }] });
    await page.evaluate(() => cargarProgramados());
    await sinEjecucion('programados');
    await textoVisible('#grid-programados', 'Mia <img');
  });

  // ── H. Llamadas ───────────────────────────────────────────────────────────
  await t('H1. llamadas: el número y la transcripción no se ejecutan', async () => {
    await limpiarXss();
    await simularApi({
      '/api/llamadas': [{ call_sid: 'CA1', inicio: new Date().toISOString(), from_num: '878' + XA('llamada-num'), num_mensajes: 2 }],
      '/api/llamadas/CA1': [{ rol: 'cliente', created_at: new Date().toISOString(), texto: 'quiero ' + X('llamada-texto') }],
    });
    await page.evaluate(() => cargarLlamadas());
    await page.evaluate(() => verTranscripcion('CA1', 'hoy', '878'));
    await sinEjecucion('llamadas');
    await textoVisible('#transcripcion-mensajes', 'quiero <img');
  });

  // ── I. Rewards ────────────────────────────────────────────────────────────
  await t('I0. rewards: el perfil del cliente no se ejecuta', async () => {
    await limpiarXss();
    await simularApi({
      '/api/rewards/cliente/8780000007': { nombre: 'Rita ' + X('rw-perfil-nombre'), telefono: '8780000007' + XA('rw-perfil-tel'), puntos_balance: 5, puntos_acumulados_total: 5 },
      '/api/rewards/cliente/8780000007/movimientos': [{ tipo: 'ajuste', puntos: 5, motivo: 'regalo ' + X('rw-perfil-motivo'), created_at: new Date().toISOString() }],
    });
    await page.evaluate(() => verPerfilRewards('8780000007'));
    await sinEjecucion('rewards-perfil');
    await textoVisible('#rw-perfil-contenido', 'regalo <img');
  });
  await t('I3. rewards: los movimientos recientes no se ejecutan', async () => {
    await limpiarXss();
    await simularApi({
      '/api/rewards/config': { activo: true, nombre_programa: 'Puntos' },
      '/api/rewards/resumen': { clientes_inscritos: 1, puntos_emitidos: 5, saldo_total: 5, puntos_canjeados: 0 },
      '/api/rewards/movimientos': [{ created_at: new Date().toISOString(), nombre: 'Rosa ' + X('rw-mov'), telefono: '878', tipo: 'acumulacion', puntos: 5 }],
    });
    await page.evaluate(() => cargarRewards());
    await esperar(500);
    await sinEjecucion('rewards-movimientos');
  });
  await t('I4. rewards: la tabla de movimientos no se ejecuta', async () => {
    await limpiarXss();
    await simularApi({ '/api/rewards/movimientos': [{ created_at: new Date().toISOString(), nombre: 'Nora ' + X('rw-tabla'), telefono: '878', tipo: 'acumulacion', puntos: 5 }] });
    await page.evaluate(() => cargarMovimientosRewards());
    await sinEjecucion('rewards-tabla');
    await textoVisible('#rw-tabla-movimientos', 'Nora <img');
  });
  await t('I1. rewards: lista de clientes no se ejecuta y abre el perfil exacto', async () => {
    await limpiarXss();
    const tel = '878' + XA('rw-tel');
    await page.evaluate((telefono, x) => {
      window.__perfiles = [];
      window.verPerfilRewards = (t) => { window.__perfiles.push(t); };
      renderListaClientesRewards([{ telefono, nombre: 'Rosa ' + x, puntos_balance: 10, puntos_acumulados_total: 10, rewards_desde: new Date().toISOString() }]);
    }, tel, X('rw-nombre'));
    await sinEjecucion('rewards-lista');
    await page.evaluate(() => document.querySelector('#rw-lista-clientes tbody tr').click());
    const perfiles = await page.evaluate(() => window.__perfiles);
    assert(perfiles.length === 1 && perfiles[0] === tel, `abrió ${JSON.stringify(perfiles)}`);
  });
  await t('I2. rewards: la búsqueda del POS no se ejecuta y asigna el cliente exacto', async () => {
    await limpiarXss();
    const nombre = 'Sofi' + XA('rw-pos-nombre');
    await simularApi({ '/api/rewards/clientes/buscar': [{ telefono: '8780000009', nombre, puntos_balance: 3, puntos_acumulados_total: 7 }] });
    await page.evaluate(() => {
      window.__asignados = [];
      window.rwPosAsignar = (...a) => { window.__asignados.push(a); };
      rwPosBuscar('so');
    });
    await esperar(700);
    await sinEjecucion('rewards-pos');
    await page.evaluate(() => document.querySelector('#rw-pos-resultados > div').click());
    const asignados = await page.evaluate(() => window.__asignados);
    assert(asignados.length === 1 && asignados[0][1] === nombre && asignados[0][2] === 3, `recibió ${JSON.stringify(asignados)}`);
  });

  // ── J. Caja y cierre ──────────────────────────────────────────────────────
  await t('J1. movimientos de caja: motivo y usuario no se ejecutan', async () => {
    await limpiarXss();
    await page.evaluate((x) => pintarMovimientosCorte({ movimientos: [{ tipo: 'retiro', monto: 20, motivo: 'gas ' + x, usuario: 'Ana ' + x }] }), X('mov'));
    await sinEjecucion('movimientos');
    await textoVisible('#corte-movimientos', 'gas <img');
  });
  await t('J3. ajustes de cierre: cliente, pago, motivo y usuario no se ejecutan', async () => {
    await limpiarXss();
    await simularApi({ '/api/admin/ajustes-cierre/semana': {
      semana: { lunes: '2026-09-21', domingo: '2026-09-27', timezone: 'America/Matamoros' },
      cutoff: { configurada: true },
      resumen: { ventas_count: 1, total_original: 100, facturadas_count: 0, facturadas_total: 0, no_facturadas_count: 1, no_facturadas_total: 100, ajustes_count: 1, ajustes_total: 10, neto_total: 90 },
      ventas: [{ folio: 'XAB-9112', fecha_operativa: '2026-09-22', cliente: 'Omar ' + X('aj-cliente'), forma_pago: 'efectivo ' + X('aj-pago'), total_original: 100, total_neto: 90, ajustes_total: 10, elegible: true }],
      ajustes: [{ id: 'a1', folio: 'XAB-9112', tipo: 'descuento', modo: 'monto', monto_ajuste: 10, monto_neto: 90, motivo: 'error ' + X('aj-motivo'), estado: 'revertido', motivo_reversion: 'no ' + X('aj-reversion'), usuario: 'Ana ' + X('aj-usuario') }],
    } });
    await page.evaluate(() => cargarAjustes());
    await sinEjecucion('ajustes');
    await textoVisible('#aj-ventas', 'Omar <img');
  });
  await t('J4. cortes cerrados: el nombre de quien cerró no se ejecuta', async () => {
    await limpiarXss();
    await simularApi({ '/api/corte-caja/historial': [{ fecha_operativa: '2026-09-27', folio: 'C-1', ventas_totales: 10, ventas_efectivo: 10, ventas_tarjeta: 0, ventas_enlace: 0, ventas_otros: 0, ventas_plataformas: 0,
      efectivo_esperado: 10, efectivo_contado: 10, diferencia: 0, usuario_nombre: 'Juan ' + X('corte-usuario') }] });
    await page.evaluate(() => cargarHistorialCortes());
    await sinEjecucion('cortes');
  });
  await t('J2. oportunidades: nombre e intenciones no se ejecutan', async () => {
    await limpiarXss();
    // Las intenciones pasan por .replace(/_/g, ' '): la carga no lleva guiones
    // bajos, o el propio reemplazo la desarmaría y la prueba no probaría nada.
    const sinGuiones = '<img src=x onerror="(window.top||window).xssIntenciones=1">';
    await page.evaluate(() => { window.xssIntenciones = 0; });
    await page.evaluate((x, sg) => renderOportunidades([{ nombre: 'Leo ' + x, telefono: '878', minutos_inactiva: 5, intents_detectados: ['precio ' + sg], segmento: 'raro ' + x }]), X('oportunidad'), sinGuiones);
    await sinEjecucion('oportunidades');
    assert(await page.evaluate(() => window.xssIntenciones) === 0, 'las intenciones ejecutaron código');
    await textoVisible('#cli-oportunidades', 'Leo <img');
  });

  // ── K. Menú (lo escribe el admin, pero una comilla rompía el botón) ──────
  await t('K1. menú: un producto con comillas se pinta y se edita con su nombre exacto', async () => {
    await limpiarXss();
    const nombre = 'Pay "de la casa" ' + X('menu-nombre');
    const imagen = 'x.png' + XA('menu-imagen');
    await page.evaluate((n, x, img) => {
      window.__editados = [];
      window.__modificadores = [];
      window.__abrirEditarReal = window.__abrirEditarReal || abrirModalEditarProducto;
      window.__abrirModsReal = window.__abrirModsReal || abrirModalModificadores;
      window.abrirModalEditarProducto = (...a) => { window.__editados.push(a); };
      window.abrirModalModificadores = (...a) => { window.__modificadores.push(a); };
      menuData = [{ id: 1, nombre: 'Postres', activa: true, productos: [{ id: 9, nombre: n, descripcion: 'dulce ' + x, precio: 50, disponible: true, imagen: img }] }];
      renderMenuEditor();
    }, nombre, X('menu-desc'), imagen);
    await sinEjecucion('menu');
    await page.evaluate(() => [...document.querySelectorAll('#menu-editor button')].find(b => b.textContent.includes('✏️')).click());
    await page.evaluate(() => document.querySelector('#menu-editor button[title="Modificadores"]').click());
    const editados = await page.evaluate(() => window.__editados);
    const mods = await page.evaluate(() => window.__modificadores);
    assert(editados.length === 1 && editados[0][1] === nombre && editados[0][3] === 'dulce ' + X('menu-desc') && editados[0][6] === imagen,
      `editar recibió ${JSON.stringify(editados)}`);
    assert(mods.length === 1 && mods[0][1] === nombre, `modificadores recibió ${JSON.stringify(mods)}`);
    await page.evaluate(() => {
      window.abrirModalEditarProducto = window.__abrirEditarReal;
      window.abrirModalModificadores = window.__abrirModsReal;
    });
  });
  await t('K3. menú: el formulario de edición conserva el nombre con comillas', async () => {
    await limpiarXss();
    const nombre = 'Pay "de la casa" ' + XA('menu-form');
    // Dentro de un <textarea> el HTML es texto... salvo que la descripción
    // cierre el textarea ella misma.
    const descripcion = 'dulce </textarea>' + X('menu-form-desc');
    await page.evaluate((n, d) => abrirModalEditarProducto(9, n, 50, d, 1, false, ''), nombre, descripcion);
    await sinEjecucion('menu-form');
    const valores = await page.evaluate(() => [document.getElementById('mp-nombre').value, document.getElementById('mp-desc').value]);
    assert(valores[0] === nombre, `el campo nombre quedó ${JSON.stringify(valores[0])}`);
    assert(valores[1] === descripcion, `la descripción quedó ${JSON.stringify(valores[1])}`);
    await page.evaluate(() => document.getElementById('modal-producto')?.remove());
  });

  await t('K2. modificadores: el nombre del producto, del grupo y de la opción no se ejecutan', async () => {
    await limpiarXss();
    await simularApi({ '/api/admin/menu/productos/9/modificadores': [{ id: 3, nombre: 'Tamaño "grande" ' + X('mod-grupo'), requerido: true, minimo: 1, maximo: null,
      opciones: [{ id: 4, nombre: 'Chica ' + X('mod-opcion'), precio_extra: 0, disponible: true }] }] });
    await page.evaluate((x) => {
      window.__grupos = [];
      window.abrirFormEditarGrupo = (...a) => { window.__grupos.push(a); };
      return abrirModalModificadores(9, 'Pay ' + x);
    }, X('mod-producto'));
    await sinEjecucion('modificadores');
    await page.evaluate(() => document.querySelector('#mod-grupos-wrap button[title="Editar"]').click());
    const grupos = await page.evaluate(() => window.__grupos);
    assert(grupos.length === 1 && grupos[0][1].startsWith('Tamaño "grande" <img') && grupos[0][2] === true && grupos[0][4] === null,
      `recibió ${JSON.stringify(grupos)}`);
  });

  // ── Z. Guardas del propio arreglo ─────────────────────────────────────────
  await t('Z1. jsArg y esc están declaradas una sola vez', async () => {
    const html = readFileSync(join(PANEL_DIR, 'index.html'), 'utf8');
    for (const nombre of ['jsArg', 'esc']) {
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
