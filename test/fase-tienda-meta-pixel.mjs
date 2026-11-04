// Meta Pixel en la tienda pública (por negocio).
//
// Lo que protege, en orden de importancia:
//   a) que un negocio SIN ID de píxel no cargue NADA de Meta, y que el panel
//      de administración nunca lo cargue;
//   b) que a Meta no viaje ningún dato personal (nombre, teléfono, dirección,
//      correo, notas del cliente, nombre de la persona) ni el token de
//      seguimiento del pedido (ni en la URL ni en el referente);
//   c) que `Purchase` salga UNA sola vez por folio, con eventID = folio, y
//      solo con el pedido ya confirmado (pago al recibir: al crearse; pago en
//      línea: cuando el servidor ve el pago), y que recargar no lo repita;
//   d) que una falla del píxel jamás interrumpa una compra;
//   e) que el ID se valide con /^\d{15,16}$/ (como texto) al guardar y al
//      leer, y que solo un administrador lo cambie;
//   f) que las páginas carguen los módulos con la huella correcta (caché).
//
// Parte A: puras (sin base ni navegador), incluido el módulo del navegador en
// un entorno simulado. Parte B: la tienda REAL (panel/tienda.html) en
// Chromium contra un servidor falso, con un fbevents.js falso que registra
// cada llamada junto con la URL y el referente que el de verdad mandaría.
// Parte C: servidor real con negocios propios (slugs irrepetibles).
//
// Uso: mismas env vars que la batería (DATABASE_URL, PANEL_SECRET, …).
//      TEST_PORT_META (4771) y TEST_PORT_META_FALSO (4772).
//      SOLO_PURAS=1 salta B y C; SIN_BASE=1 salta solo C.
import assert from 'assert';
import vm from 'vm';
import http from 'http';
import { readFileSync, readdirSync } from 'fs';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  normalizarMetaPixelId, metaPixelIdValido, compraMetaDePedido, META_PIXEL_REGEX,
} from '../src/services/tiendaMetaPixel.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(__dirname, '..');
const leer = r => readFileSync(join(RAIZ, r), 'utf8').replace(/\r\n/g, '\n');
const TIENDA_HTML = leer('panel/tienda.html');
const TIENDA_JS = TIENDA_HTML.slice(TIENDA_HTML.indexOf('<script>'), TIENDA_HTML.lastIndexOf('</script>'));
const SEGUIMIENTO_HTML = leer('panel/tienda-seguimiento.html');
const MARCO_HTML = leer('panel/tienda-meta-pixel.html');
const PANEL = leer('panel/index.html');
const MODULO = readFileSync(join(RAIZ, 'panel/tienda-meta-pixel.js'));
const EDITOR = readFileSync(join(RAIZ, 'panel/tienda-meta-pixel-editor.js'));
const RUTAS = leer('src/services/tiendaRutasCore.js');
const SERVER = leer('src/server.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
const soloCasos = process.env.CASOS ? new Set(process.env.CASOS.split(',')) : null;
async function t(nombre, fn) {
  if (soloCasos && !soloCasos.has(nombre.split('.')[0])) return;
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(nombre); }
}
const lanza = (fn, codigo) => assert.throws(fn, e => e.codigo === codigo, `esperaba ${codigo}`);
const plano = x => JSON.parse(JSON.stringify(x));
const esperar = ms => new Promise(r => setTimeout(r, ms));

const PIXEL = '123456789012345';
const PIXEL16 = '1234567890123456';
const SUCURSAL = 'Mapolato Obispado';

// Datos personales que las pruebas siembran a propósito: ninguno puede
// aparecer en algo que viaje a Meta.
const PERSONALES = ['Juana', 'Pérez', '8781234567', '878 123 4567', 'Calle Falsa', 'Colonia Prueba',
  'timbre azul', 'llamar al', 'juana@correo.test', 'Tía Rosa'];
function sinPersonales(cosa, donde) {
  const s = JSON.stringify(cosa);
  for (const p of PERSONALES) assert.ok(!s.includes(p), `"${p}" viajó a Meta en ${donde}: ${s.slice(0, 400)}`);
}
const sinToken = (cosa, donde) => {
  const s = JSON.stringify(cosa);
  assert.ok(!/[a-f0-9]{48}/.test(s), `el token de seguimiento viajó a Meta en ${donde}: ${s.slice(0, 400)}`);
};

// Un pedido como lo guarda tiendaCheckout (forma de pedidos_activos.datos),
// lleno de datos personales que NO deben salir.
const datosPedido = (o = {}) => ({
  items: [
    { producto_id: 11, categoria_id: 1, nombre: 'Chilaquiles', cantidad: 2, precio_unitario: 115, precio_base: 95,
      modificadores: [{ grupo_id: 5, grupo: 'Tamaño', opcion_id: 51, opcion: 'Grande', precio_extra: 20 }],
      notas: 'Grande · Sin chile, llamar al 8781234567', persona: { numero: 2, nombre: 'Tía Rosa' } },
    { producto_id: 21, categoria_id: 2, nombre: 'Café de olla', cantidad: 1, precio_unitario: 35, modificadores: [] },
  ],
  subtotal: 265, descuento: 26.5, costo_envio: 30, total: 268.5,
  cliente: { nombre: 'Juana Pérez', telefono: '8781234567', correo: 'juana@correo.test', calle: 'Calle Falsa 123', colonia: 'Colonia Prueba' },
  notas: 'Tocar el timbre azul', forma_pago: 'efectivo (al recibir)',
  ...o,
});
const COMPRA_ESPERADA = {
  eventID: 'XAB-0042',
  params: {
    value: 268.5, currency: 'MXN', content_ids: ['11', '21'], content_type: 'product',
    contents: [{ id: '11', quantity: 2, item_price: 115 }, { id: '21', quantity: 1, item_price: 35 }],
    num_items: 3, sucursal: SUCURSAL,
  },
};

// ══ A) Puras ════════════════════════════════════════════════════════════════
await t('A1. el ID se valida con /^\\d{15,16}$/, como texto, al guardar', () => {
  assert.strictEqual(String(META_PIXEL_REGEX), String(/^\d{15,16}$/));
  assert.strictEqual(normalizarMetaPixelId(PIXEL), PIXEL);
  assert.strictEqual(normalizarMetaPixelId(PIXEL16), PIXEL16);
  assert.strictEqual(normalizarMetaPixelId(`  ${PIXEL} \n`), PIXEL);
  for (const vacio of [null, undefined, '', '   ']) assert.strictEqual(normalizarMetaPixelId(vacio), null);
  for (const malo of ['12345678901234', '12345678901234567', '12345678901234a', '1234 5678 9012 345',
    '123-456-789-012-345', `${PIXEL}"><script>alert(1)</script>`, `${PIXEL}');alert(1);//`, `${PIXEL}\n1`,
    '１２３４５６７８９０１２３４５', '+123456789012345', '-123456789012345', 'fb:123456789012345',
    Number(PIXEL), 9007199254740993, true, {}, [PIXEL]]) {
    lanza(() => normalizarMetaPixelId(malo), 'META_PIXEL_ID_INVALIDO');
  }
});

await t('A2. al leer, un valor guardado a mano con basura queda inerte (null)', () => {
  assert.strictEqual(metaPixelIdValido(PIXEL), PIXEL);
  assert.strictEqual(metaPixelIdValido(` ${PIXEL16} `), PIXEL16);
  for (const malo of [null, undefined, '', `${PIXEL}"><img src=x>`, `${PIXEL}\n${PIXEL}`, '1'.repeat(17), Number(PIXEL), {}]) {
    assert.strictEqual(metaPixelIdValido(malo), null, JSON.stringify(malo));
  }
});

await t('A3. Purchase solo para un pedido confirmado; nunca pendiente de pago ni cancelado', () => {
  for (const estado of ['pendiente_pago', 'cancelado', null, undefined, '']) {
    assert.strictEqual(compraMetaDePedido({ folio: 'XAB-0001', estado, datos: datosPedido() }), null, String(estado));
  }
  assert.strictEqual(compraMetaDePedido({ folio: null, estado: 'nuevo', datos: datosPedido() }), null);
  assert.strictEqual(compraMetaDePedido({ folio: 'XAB-1', estado: 'nuevo', datos: datosPedido({ items: [] }) }), null);
  for (const estado of ['nuevo', 'en_preparacion', 'listo', 'entregado', 'programado']) {
    assert.ok(compraMetaDePedido({ folio: 'XAB-0001', estado, datos: datosPedido() }), estado);
  }
});

await t('A4. Purchase: eventID = folio, value = total del pedido, contenidos, piezas y sucursal', () => {
  const c = plano(compraMetaDePedido({ folio: 'XAB-0042', estado: 'nuevo', datos: datosPedido(), sucursal: SUCURSAL }));
  assert.deepStrictEqual(c, COMPRA_ESPERADA);
  // Sin total guardado: productos − promociones + envío.
  assert.strictEqual(compraMetaDePedido({ folio: 'XAB-1', estado: 'nuevo', datos: datosPedido({ total: undefined }) }).params.value, 268.5);
  // Sin sucursal no se inventa el parámetro.
  assert.ok(!('sucursal' in compraMetaDePedido({ folio: 'XAB-1', estado: 'nuevo', datos: datosPedido() }).params));
  sinPersonales(c, 'compraMetaDePedido');
  assert.deepStrictEqual(Object.keys(c.params.contents[0]).sort(), ['id', 'item_price', 'quantity']);
});

// ── El módulo del navegador en un entorno simulado ──
// Una "pestaña" con su URL, su referente, su storage y un fetch que contesta
// lo que la prueba le diga. El storage se puede compartir entre pestañas para
// simular recargas y navegación en el mismo navegador. `enMarco` simula estar
// dentro de un iframe.
const TOKEN = 'a'.repeat(48), TOKEN2 = 'b'.repeat(48);
function navegadorNuevo() { return { local: new Map(), sesion: new Map() }; }
function pestana({ url = 'https://xabor.mx/t/demo', referrer = '', navegador = navegadorNuevo(), respuestas = {},
  sinStorage = false, servidor = null, enMarco = false } = {}) {
  const storage = mapa => ({
    getItem: k => (mapa.has(k) ? mapa.get(k) : null),
    setItem: (k, v) => { mapa.set(k, String(v)); },
    removeItem: k => { mapa.delete(k); },
    key: i => [...mapa.keys()][i] ?? null,
    get length() { return mapa.size; },
  });
  const bloqueado = { getItem() { throw new Error('bloqueado'); }, setItem() { throw new Error('bloqueado'); },
    removeItem() { throw new Error('bloqueado'); }, key() { throw new Error('bloqueado'); }, get length() { throw new Error('bloqueado'); } };
  const u = new URL(url);
  const scripts = [], marcos = [], pedidas = [];
  const elemento = tag => ({
    tagName: tag, style: {}, atributos: {}, oyentes: {},
    setAttribute(k, v) { this.atributos[k] = String(v); },
    addEventListener(ev, fn) { this.oyentes[ev] = fn; },
  });
  const ctx = {
    location: { href: url, search: u.search, pathname: u.pathname, origin: u.origin },
    document: {
      referrer,
      head: { appendChild: el => scripts.push(el) },
      body: { appendChild: el => marcos.push(el) },
      createElement: elemento,
      getElementById: () => null,
    },
    localStorage: sinStorage ? bloqueado : storage(navegador.local),
    sessionStorage: sinStorage ? bloqueado : storage(navegador.sesion),
    URLSearchParams, console,
    fetch: async (ruta, opciones) => {
      pedidas.push(`${opciones?.method || 'GET'} ${ruta}`);
      if (servidor) return fetch(servidor + ruta, { method: opciones?.method || 'GET' });
      const r = respuestas[`${opciones?.method || 'GET'} ${ruta}`];
      if (r instanceof Error) throw r;
      if (typeof r === 'function') return { ok: true, json: async () => r() };
      return r === undefined ? { ok: false, json: async () => ({}) } : { ok: true, json: async () => r };
    },
  };
  ctx.window = ctx;
  ctx.parent = enMarco ? { otro: true } : ctx;
  vm.createContext(ctx);
  vm.runInContext(MODULO.toString('utf8'), ctx);
  return {
    M: ctx.XaborMetaPixel, ctx, scripts, marcos, pedidas, navegador,
    // Lo que la página le pidió a fbq (el stub las encola hasta que carga fbevents.js).
    llamadas: () => plano((ctx.fbq?.queue || []).map(a => Array.prototype.slice.call(a))),
    eventos: () => plano((ctx.fbq?.queue || []).map(a => Array.prototype.slice.call(a)))
      .filter(a => a[0] === 'track').map(a => ({ nombre: a[1], p: a[2], o: a[3] })),
  };
}
const CATALOGO_PROD = { id: 11, nombre: 'Chilaquiles', precio: 95, descripcion: 'Con llamar al 8781234567' };
const LINEA = { productoId: 11, nombre: 'Chilaquiles', precio: 95, cantidad: 2,
  modificadores: [{ grupoId: 5, grupo: 'Tamaño', opcionId: 51, nombre: 'Grande', precioExtra: 20 }],
  notas: 'Sin chile, llamar al 8781234567', persona: { numero: 2, nombre: 'Tía Rosa' } };
const CAFE = { productoId: 21, nombre: 'Café de olla', precio: 35, cantidad: 1, modificadores: [], notas: '', persona: null };
const rutaMeta = tk => `/api/tienda/seguimiento/${tk}/meta-pixel`;
const rutaCompraMeta = tk => `/api/tienda/seguimiento/${tk}/meta-pixel/compra`;
const respuestasDe = (tk, { pixel = PIXEL, pendiente = false, compra = null, motivo, slug = 'demo' } = {}) => ({
  [`GET ${rutaMeta(tk)}`]: { metaPixelId: pixel, pendiente },
  [`POST ${rutaCompraMeta(tk)}`]: { metaPixelId: pixel, compra, pendiente, slug, ...(motivo ? { motivo } : {}) },
});
const COMPRA = plano(COMPRA_ESPERADA);
const pidioCompra = p => p.pedidas.some(x => x === `POST ${rutaCompraMeta(TOKEN)}` || x.endsWith('/meta-pixel/compra'));

await t('A5. sin ID del píxel: no inyecta fbevents.js, no crea fbq y todo es no-op', async () => {
  for (const id of [null, undefined, '', '12345', `${PIXEL}"><script>`, Number(PIXEL), '1'.repeat(17)]) {
    const p = pestana({ respuestas: respuestasDe(TOKEN, { pixel: null, compra: COMPRA }) });
    assert.strictEqual(p.M.iniciarTienda({ pixelId: id, sucursal: SUCURSAL }), false);
    p.M.verProducto(CATALOGO_PROD);
    p.M.cambioEnCarrito(null, LINEA);
    p.M.iniciarCheckout([LINEA]);
    await p.M.pedidoCreado({ folio: 'XAB-0042', trackingToken: TOKEN });
    await p.M.seguimiento(TOKEN);
    assert.strictEqual(p.scripts.length + p.marcos.length, 0, `cargó algo con ${id}`);
    assert.strictEqual(p.ctx.fbq, undefined);
    assert.deepStrictEqual(p.pedidas, [], 'sin píxel no debe preguntar nada al servidor');
    assert.strictEqual(p.navegador.local.size + p.navegador.sesion.size, 0, 'dejó marcas en storage');
  }
});

await t('A6. con ID: código base de Meta en el <head>, sin eventos automáticos, init y PageView', () => {
  const p = pestana();
  assert.strictEqual(p.M.iniciarTienda({ pixelId: PIXEL, sucursal: `  ${SUCURSAL}  ` }), true);
  assert.strictEqual(p.scripts.length, 1);
  assert.strictEqual(p.scripts[0].tagName, 'script');
  assert.strictEqual(p.scripts[0].src, 'https://connect.facebook.net/en_US/fbevents.js');
  assert.strictEqual(p.scripts[0].async, true);
  assert.deepStrictEqual(p.llamadas(), [['set', 'autoConfig', false, PIXEL], ['init', PIXEL], ['track', 'PageView']]);
  assert.strictEqual(p.ctx.fbq.disablePushState, true, 'el píxel contaría PageView por cambios de historial');
  // Una segunda llamada no vuelve a cargar ni a contar.
  assert.strictEqual(p.M.iniciarTienda({ pixelId: PIXEL, sucursal: SUCURSAL }), true);
  assert.strictEqual(p.scripts.length, 1);
  assert.strictEqual(p.eventos().length, 1);
  // El ID de 16 dígitos también sirve.
  const p16 = pestana();
  assert.strictEqual(p16.M.iniciarTienda({ pixelId: PIXEL16 }), true);
  assert.deepStrictEqual(p16.llamadas()[1], ['init', PIXEL16]);
});

await t('A7. ViewContent, AddToCart e InitiateCheckout con MXN, sucursal y sin datos personales', () => {
  const p = pestana();
  p.M.iniciarTienda({ pixelId: PIXEL, sucursal: SUCURSAL });
  p.M.verProducto(CATALOGO_PROD);
  p.M.cambioEnCarrito(null, LINEA);                          // agregar 2 con extra
  p.M.cambioEnCarrito(null, CAFE);                           // agregar café
  p.M.cambioEnCarrito(CAFE, null);                           // quitar: Meta no tiene evento
  p.M.cambioEnCarrito(LINEA, { ...LINEA, cantidad: 3 });     // editar 2 → 3: solo la pieza nueva
  p.M.cambioEnCarrito(LINEA, { ...LINEA, cantidad: 1 });     // bajar: nada
  p.M.cambioEnCarrito(LINEA, { ...LINEA, modificadores: [] }); // cambiar opciones: nada
  p.M.iniciarCheckout([{ ...LINEA, cantidad: 3 }, CAFE]);
  const ev = p.eventos().filter(e => e.nombre !== 'PageView');
  assert.deepStrictEqual(ev.map(e => e.nombre), ['ViewContent', 'AddToCart', 'AddToCart', 'AddToCart', 'InitiateCheckout']);
  assert.deepStrictEqual(ev[0].p, { content_ids: ['11'], content_name: 'Chilaquiles', content_type: 'product',
    value: 95, currency: 'MXN', sucursal: SUCURSAL });
  assert.deepStrictEqual(ev[1].p, { content_ids: ['11'], content_name: 'Chilaquiles', content_type: 'product',
    contents: [{ id: '11', quantity: 2, item_price: 115 }], value: 230, quantity: 2, currency: 'MXN', sucursal: SUCURSAL });
  assert.deepStrictEqual([ev[2].p.content_ids, ev[2].p.value, ev[2].p.quantity], [['21'], 35, 1]);
  assert.deepStrictEqual([ev[3].p.content_ids, ev[3].p.value, ev[3].p.quantity], [['11'], 115, 1]);
  assert.deepStrictEqual(ev[4].p, { content_ids: ['11', '21'], content_type: 'product',
    contents: [{ id: '11', quantity: 3, item_price: 115 }, { id: '21', quantity: 1, item_price: 35 }],
    num_items: 4, value: 380, currency: 'MXN', sucursal: SUCURSAL });
  sinPersonales(p.llamadas(), 'eventos de la tienda');
});

await t('A8. pago al recibir: reclama una vez y manda Purchase con eventID = folio; recargar no lo repite', async () => {
  const nav = navegadorNuevo();
  const p = pestana({ navegador: nav, respuestas: respuestasDe(TOKEN, { compra: COMPRA }) });
  p.M.iniciarTienda({ pixelId: PIXEL, sucursal: SUCURSAL });
  await p.M.pedidoCreado({ folio: 'XAB-0042', trackingToken: TOKEN });
  assert.deepStrictEqual(p.pedidas, [`GET ${rutaMeta(TOKEN)}`, `POST ${rutaCompraMeta(TOKEN)}`]);
  const compras = p.eventos().filter(e => e.nombre === 'Purchase');
  assert.strictEqual(compras.length, 1);
  assert.deepStrictEqual(compras[0].p, COMPRA.params);
  assert.deepStrictEqual(compras[0].o, { eventID: 'XAB-0042' });
  assert.ok(![...nav.local.keys()].some(k => k.startsWith('xabor_meta_pendiente:')), 'quedó pendiente');
  // Repetir en la misma página o en una recarga (mismo navegador) no manda ni reclama.
  await p.M.pedidoCreado({ folio: 'XAB-0042', trackingToken: TOKEN });
  const recarga = pestana({ navegador: nav, respuestas: respuestasDe(TOKEN, { compra: COMPRA }) });
  recarga.M.iniciarTienda({ pixelId: PIXEL, sucursal: SUCURSAL });
  await recarga.M.pedidoCreado({ folio: 'XAB-0042', trackingToken: TOKEN });
  await recarga.M.seguimiento(TOKEN);
  assert.strictEqual(p.eventos().filter(e => e.nombre === 'Purchase').length, 1);
  assert.strictEqual(recarga.eventos().filter(e => e.nombre === 'Purchase').length, 0);
  assert.deepStrictEqual(recarga.pedidas, [], 'la recarga volvió a preguntar');
});

await t('A9. pago en línea: al crearse no reclama (solo lee) y queda pendiente en ESTE navegador', async () => {
  const nav = navegadorNuevo();
  const p = pestana({ navegador: nav, respuestas: respuestasDe(TOKEN, { pendiente: true }) });
  p.M.iniciarTienda({ pixelId: PIXEL, sucursal: SUCURSAL });
  await p.M.pedidoCreado({ folio: 'XAB-0043', trackingToken: TOKEN });
  assert.deepStrictEqual(p.pedidas, [`GET ${rutaMeta(TOKEN)}`], 'no debe gastar el limitador de checkout mientras espera pago');
  assert.strictEqual(p.eventos().filter(e => e.nombre === 'Purchase').length, 0);
  assert.ok(nav.local.has(`xabor_meta_pendiente:${TOKEN}`));
});

await t('A10. seguimiento sin marca (otro dispositivo): ni una consulta, ni marco, ni píxel', async () => {
  const p = pestana({ url: `https://xabor.mx/seguimiento/${TOKEN}`, respuestas: respuestasDe(TOKEN, { compra: COMPRA }) });
  for (let i = 0; i < 3; i++) await p.M.seguimiento(TOKEN);
  assert.deepStrictEqual(p.pedidas, []);
  assert.strictEqual(p.marcos.length + p.scripts.length, 0);
  assert.strictEqual(p.ctx.fbq, undefined);
});

await t('A11. seguimiento con marca: espera el pago y manda la compra desde un marco sin token, una vez', async () => {
  const nav = navegadorNuevo();
  nav.local.set(`xabor_meta_pendiente:${TOKEN}`, String(Date.now()));
  let pagado = false;
  const respuestas = {
    [`GET ${rutaMeta(TOKEN)}`]: () => ({ metaPixelId: PIXEL, pendiente: !pagado }),
    [`POST ${rutaCompraMeta(TOKEN)}`]: () => ({ metaPixelId: PIXEL, compra: COMPRA, pendiente: false, slug: 'mapolato-obispado' }),
  };
  const p = pestana({ url: `https://xabor.mx/seguimiento/${TOKEN}?retorno=pago&r=exito`, navegador: nav, respuestas });
  await p.M.seguimiento(TOKEN);
  assert.deepStrictEqual(p.pedidas, [`GET ${rutaMeta(TOKEN)}`]);
  assert.strictEqual(p.marcos.length, 0, 'marco antes del pago');
  pagado = true;                                            // el webhook confirmó el dinero
  await p.M.seguimiento(TOKEN);
  assert.ok(pidioCompra(p));
  assert.strictEqual(p.marcos.length, 1);
  const [m] = p.marcos;
  assert.strictEqual(m.tagName, 'iframe');
  assert.strictEqual(m.src, '/t/mapolato-obispado/pixel');
  assert.strictEqual(m.atributos.referrerpolicy, 'no-referrer');
  assert.strictEqual(p.ctx.fbq, undefined, 'la página de seguimiento cargó el píxel (su URL lleva el token)');
  assert.strictEqual(p.scripts.length, 0);
  // El marco recibe la compra ya filtrada y la manda con su eventID.
  const marco = pestana({ url: 'https://xabor.mx/t/mapolato-obispado/pixel', navegador: nav, enMarco: true });
  m.contentWindow = marco.ctx;
  m.oyentes.load();
  assert.deepStrictEqual(marco.llamadas(), [['set', 'autoConfig', false, PIXEL], ['init', PIXEL],
    ['track', 'Purchase', COMPRA.params, { eventID: 'XAB-0042' }]]);
  // Más sondeos y una recarga del seguimiento no repiten nada.
  for (let i = 0; i < 2; i++) await p.M.seguimiento(TOKEN);
  const recarga = pestana({ url: `https://xabor.mx/seguimiento/${TOKEN}`, navegador: nav, respuestas });
  await recarga.M.seguimiento(TOKEN);
  assert.strictEqual(p.marcos.length + recarga.marcos.length, 1);
  assert.strictEqual(p.pedidas.filter(x => x.startsWith('POST')).length, 1);
  assert.deepStrictEqual(recarga.pedidas, []);
});

await t('A12. el marco solo manda si de verdad está enmarcado, una sola vez y con datos válidos', () => {
  const arriba = pestana({ url: 'https://xabor.mx/t/demo/pixel' });
  assert.strictEqual(arriba.M.compraEnMarco({ pixelId: PIXEL, eventID: 'XAB-1', params: COMPRA.params }), false);
  assert.strictEqual(arriba.ctx.fbq, undefined);
  const m = pestana({ url: 'https://xabor.mx/t/demo/pixel', enMarco: true });
  assert.strictEqual(m.M.compraEnMarco({ pixelId: 'basura', eventID: 'XAB-1', params: COMPRA.params }), false);
  assert.strictEqual(m.M.compraEnMarco({ pixelId: PIXEL, eventID: '', params: COMPRA.params }), false);
  assert.strictEqual(m.ctx.fbq, undefined);
  assert.strictEqual(m.M.compraEnMarco({ pixelId: PIXEL, eventID: 'XAB-1', params: COMPRA.params }), true);
  assert.strictEqual(m.M.compraEnMarco({ pixelId: PIXEL, eventID: 'XAB-2', params: COMPRA.params }), false);
  assert.strictEqual(m.eventos().length, 1, 'el marco no debe mandar PageView ni una segunda compra');
});

await t('A13. pendiente de pago o cancelado: el reclamo no manda nada y la marca se resuelve bien', async () => {
  // Cancelado o ya entregado a otro navegador: deja de ser compra de este.
  for (const motivo of ['sin_compra', 'ya_entregada']) {
    const nav = navegadorNuevo();
    nav.local.set(`xabor_meta_pendiente:${TOKEN}`, String(Date.now()));
    const p = pestana({ url: `https://xabor.mx/seguimiento/${TOKEN}`, navegador: nav, respuestas: respuestasDe(TOKEN, { motivo }) });
    await p.M.seguimiento(TOKEN);
    assert.strictEqual(p.marcos.length, 0);
    assert.ok(!nav.local.has(`xabor_meta_pendiente:${TOKEN}`), `${motivo}: siguió pendiente`);
  }
  // Una marca vencida (3 días) ya no reclama.
  const nav = navegadorNuevo();
  nav.local.set(`xabor_meta_pendiente:${TOKEN}`, String(Date.now() - 4 * 864e5));
  const p = pestana({ url: `https://xabor.mx/seguimiento/${TOKEN}`, navegador: nav, respuestas: respuestasDe(TOKEN, { compra: COMPRA }) });
  await p.M.seguimiento(TOKEN);
  assert.deepStrictEqual(p.pedidas, []);
});

await t('A14. la tienda abierta desde el seguimiento o el pago: el token se tacha del referente', () => {
  for (const [ref, limpio] of [
    [`https://xabor.mx/seguimiento/${TOKEN}?retorno=pago&r=exito`, 'https://xabor.mx/seguimiento/token?retorno=pago&r=exito'],
    [`https://xabor.mx/pagar/${TOKEN2}`, 'https://xabor.mx/pagar/token'],
  ]) {
    const p = pestana({ referrer: ref });
    p.M.iniciarTienda({ pixelId: PIXEL });
    assert.strictEqual(p.ctx.document.referrer, limpio);
  }
  const normal = pestana({ referrer: 'https://www.instagram.com/' });
  normal.M.iniciarTienda({ pixelId: PIXEL });
  assert.strictEqual(normal.ctx.document.referrer, 'https://www.instagram.com/');
  // Sin píxel no se toca nada.
  const sin = pestana({ referrer: `https://xabor.mx/seguimiento/${TOKEN}` });
  sin.M.iniciarTienda({ pixelId: null });
  assert.strictEqual(sin.ctx.document.referrer, `https://xabor.mx/seguimiento/${TOKEN}`);
});

await t('A15. nada del módulo lanza: basura, storage bloqueado, red caída o fbq roto', async () => {
  const p = pestana({ respuestas: { [`GET ${rutaMeta(TOKEN)}`]: new Error('sin red') } });
  assert.strictEqual(p.M.iniciarTienda({ pixelId: PIXEL }), true);
  for (const basura of [undefined, null, 0, 'x', {}, [], { id: null }, { productoId: 1 }, { cantidad: -5, productoId: 1, nombre: 'x' }]) {
    p.M.verProducto(basura); p.M.cambioEnCarrito(basura, basura); p.M.iniciarCheckout(basura);
    await p.M.pedidoCreado(basura); await p.M.seguimiento(basura); p.M.compraEnMarco(basura);
  }
  await p.M.pedidoCreado({ folio: 'XAB-1', trackingToken: TOKEN });     // fetch lanza
  const sinSt = pestana({ sinStorage: true, respuestas: respuestasDe(TOKEN, { compra: COMPRA }) });
  sinSt.M.iniciarTienda({ pixelId: PIXEL });
  await sinSt.M.pedidoCreado({ folio: 'XAB-0042', trackingToken: TOKEN });
  assert.strictEqual(sinSt.eventos().filter(e => e.nombre === 'Purchase').length, 1, 'sin storage el pago al recibir igual se reporta');
  const roto = pestana();
  roto.M.iniciarTienda({ pixelId: PIXEL });
  roto.ctx.fbq.callMethod = () => { throw new Error('fbq roto'); };
  roto.M.verProducto(CATALOGO_PROD);
  roto.M.cambioEnCarrito(null, LINEA);
});

await t('A21. el navegador vuelve a filtrar la compra: lo que sobre en la respuesta no viaja a Meta', async () => {
  const sucia = { eventID: 'XAB-0042', cliente: { nombre: 'Juana Pérez' }, params: {
    ...COMPRA.params, cliente: { nombre: 'Juana Pérez', telefono: '8781234567' }, notas: 'Tocar el timbre azul',
    contents: COMPRA.params.contents.map(c => ({ ...c, notas: 'llamar al 8781234567', persona: 'Tía Rosa' })) } };
  const p = pestana({ respuestas: respuestasDe(TOKEN, { compra: sucia }) });
  p.M.iniciarTienda({ pixelId: PIXEL, sucursal: SUCURSAL });
  await p.M.pedidoCreado({ folio: 'XAB-0042', trackingToken: TOKEN });
  const [compra] = p.eventos().filter(e => e.nombre === 'Purchase');
  assert.deepStrictEqual(compra.p, COMPRA.params);
  sinPersonales(p.llamadas(), 'Purchase re-filtrado');
  // Y en el marco del seguimiento, igual.
  const nav = navegadorNuevo();
  nav.local.set(`xabor_meta_pendiente:${TOKEN}`, String(Date.now()));
  const s = pestana({ url: `https://xabor.mx/seguimiento/${TOKEN}`, navegador: nav, respuestas: respuestasDe(TOKEN, { compra: sucia }) });
  await s.M.seguimiento(TOKEN);
  const marco = pestana({ url: 'https://xabor.mx/t/demo/pixel', navegador: nav, enMarco: true });
  s.marcos[0].contentWindow = marco.ctx;
  s.marcos[0].oyentes.load();
  sinPersonales(marco.llamadas(), 'Purchase del marco');
  assert.deepStrictEqual(marco.eventos()[0].p, COMPRA.params);
});

// ── Cableado estático: huellas, enganches, un solo punto de contacto ──
const huella = buf => createHash('sha256').update(buf).digest('hex').slice(0, 8);
await t('A16. tienda, seguimiento y marco cargan el módulo con su huella; el panel, el editor con la suya', () => {
  for (const [nombre, html] of [['tienda.html', TIENDA_HTML], ['tienda-seguimiento.html', SEGUIMIENTO_HTML], ['tienda-meta-pixel.html', MARCO_HTML]]) {
    const m = html.match(/<script src="\/tienda-meta-pixel\.js\?v=([0-9a-f]+)"><\/script>/);
    assert.ok(m, `${nombre}: no se encontró la etiqueta del módulo`);
    assert.strictEqual(m[1], huella(MODULO), `${nombre}: actualiza la etiqueta a ?v=${huella(MODULO)}`);
  }
  for (const [nombre, html] of [['tienda.html', TIENDA_HTML], ['tienda-seguimiento.html', SEGUIMIENTO_HTML]]) {
    assert.ok(html.indexOf('/tienda-meta-pixel.js') < html.indexOf('<script>\n'), `${nombre}: el módulo debe cargar antes del script de la página`);
  }
  const m = PANEL.match(/<script src="\/tienda-meta-pixel-editor\.js\?v=([0-9a-f]+)"><\/script>/);
  assert.ok(m, 'panel: no se encontró la etiqueta del editor');
  assert.strictEqual(m[1], huella(EDITOR), `panel: actualiza la etiqueta a ?v=${huella(EDITOR)}`);
});

await t('A17. el píxel solo existe en la tienda pública: ni el panel, ni superadmin, ni otra página lo cargan', () => {
  const PUBLICAS = new Set(['tienda.html', 'tienda-seguimiento.html', 'tienda-meta-pixel.html']);
  for (const archivo of readdirSync(join(RAIZ, 'panel')).filter(f => f.endsWith('.html'))) {
    const html = leer(`panel/${archivo}`);
    assert.ok(!/fbevents\.js|fbq\(|facebook\.com\/tr/.test(html), `${archivo} habla con el píxel de Meta directo`);
    if (!PUBLICAS.has(archivo)) assert.ok(!html.includes('/tienda-meta-pixel.js'), `${archivo} carga el módulo del píxel`);
  }
  // Solo el módulo conoce fbevents.js; el editor del panel no carga nada de Meta.
  const editor = EDITOR.toString('utf8');
  assert.ok(!/connect\.facebook|fbevents|fbq/.test(editor), 'el editor del panel carga el píxel');
  for (const js of readdirSync(join(RAIZ, 'panel')).filter(f => f.endsWith('.js') && f !== 'tienda-meta-pixel.js')) {
    assert.ok(!leer(`panel/${js}`).includes('fbevents.js'), `${js} carga fbevents.js`);
  }
  // El seguimiento nunca crea fbq en su propia ventana: lo hace el marco.
  assert.ok(!/fbq|connect\.facebook/.test(SEGUIMIENTO_HTML.replace(/<!--[\s\S]*?-->/g, '')));
});

await t('A18. cada evento está enganchado en su punto de la tienda, por el envoltorio que no lanza', () => {
  const funcion = nombre => {
    const i = TIENDA_JS.search(new RegExp(`(async )?function ${nombre}\\(`));
    assert.ok(i >= 0, `no existe ${nombre}`);
    const resto = TIENDA_JS.slice(i + 10);
    const j = resto.search(/\n(async )?function /);
    return TIENDA_JS.slice(i, i + 10 + (j < 0 ? resto.length : j));
  };
  assert.ok(TIENDA_JS.includes("const pixelMeta = (fn, ...args) => { try { window.XaborMetaPixel?.[fn]?.(...args); } catch (e) {} };"));
  assert.ok(!/XaborMetaPixel\.[a-zA-Z]/.test(TIENDA_JS), 'la tienda llama XaborMetaPixel.x sin el envoltorio');
  const esperado = {
    iniciar: "pixelMeta('iniciarTienda', { pixelId: TIENDA.metaPixel?.pixelId, sucursal: TIENDA.metaPixel?.sucursal });",
    abrirProducto: "if (indiceEdicion < 0) pixelMeta('verProducto', p);",
    agregarAlCarrito: "pixelMeta('cambioEnCarrito', anterior, linea);",
    irAlCheckout: "pixelMeta('iniciarCheckout', CARRITO);",
    confirmarPedido: "pixelMeta('pedidoCreado', r);",
  };
  for (const [fn, linea] of Object.entries(esperado)) assert.ok(funcion(fn).includes(linea), `${fn} no tiene: ${linea}`);
  const confirmar = funcion('confirmarPedido');
  assert.ok(confirmar.indexOf("await api(API + '/checkout'") < confirmar.indexOf("pixelMeta('pedidoCreado', r);"));
  assert.ok(!/pixelMeta\([^)]*\bCK[,)]/.test(TIENDA_JS), 'se le pasó CK completo al píxel');
  assert.ok(SEGUIMIENTO_HTML.includes('try { window.XaborMetaPixel?.seguimiento(TOKEN); } catch (e) {}'));
  // El módulo es una IIFE y su único nombre global propio es XaborMetaPixel
  // (fbq y _fbq son los del código base de Meta).
  const src = MODULO.toString('utf8');
  assert.deepStrictEqual([...src.matchAll(/window\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)].map(m => m[1]), ['XaborMetaPixel']);
  assert.ok(!/matchMedia/.test(src), 'fase-tienda-desktop prohíbe matchMedia en la tienda');
});

await t('A19. el panel engancha el editor bajo Tienda → Analítica; el editor es una IIFE sin onclick', () => {
  assert.ok(PANEL.includes('<div id="tnd-sec-meta-pixel"  class="tnd-sec" style="display:none;"></div>'));
  assert.ok(PANEL.includes("if (sec === 'analitica') {\n    const meta = document.getElementById('tnd-sec-meta-pixel');\n    if (meta) { meta.style.display = 'block'; window.XaborMetaPixelTienda?.abrir(meta); }"));
  const src = EDITOR.toString('utf8').replace(/\r\n/g, '\n');
  const cuerpo = src.replace(/^(\/\/[^\n]*\n)+/, '');
  assert.ok(cuerpo.startsWith('(function () {') && cuerpo.trimEnd().endsWith('})();'));
  assert.deepStrictEqual([...src.matchAll(/window\.([A-Za-z_$][\w$]*)\s*=/g)].map(m => m[1]), ['XaborMetaPixelTienda']);
  assert.ok(!/\sonclick=/.test(src));
  assert.ok(src.includes('<label for="tmp-id">Meta Pixel ID</label>'));
  // Todo lo que se pinta del ID o del slug pasa por esc().
  const pintados = [...src.matchAll(/\$\{([^{}]*\bE\.(?:id|slug)\b[^{}]*)\}/g)].map(m => m[1]);
  assert.ok(pintados.length >= 2, 'no se encontraron los lugares donde se pinta el ID');
  for (const expr of pintados) {
    assert.ok(/^(esc|encodeURIComponent)\(/.test(expr.trim()) || /^E\.id \? '[^']*' : ''$/.test(expr.trim()), `se pinta sin escapar: \${${expr}}`);
  }
});

await t('A20. rutas: el ID en la API pública, endpoints por token, marco y edición solo de administradores', () => {
  assert.ok(RUTAS.includes('metaPixel: await metaPixelPublico(tienda.negocioId, tienda.branding.titular),'));
  assert.ok(RUTAS.indexOf('metaPixel: await metaPixelPublico') < RUTAS.indexOf('        diseno,\n      });'), 'diseno debe seguir siendo la última propiedad');
  assert.ok(RUTAS.includes("app.get('/api/tienda/seguimiento/:token/meta-pixel', limitePublico,"));
  assert.ok(RUTAS.includes("app.post('/api/tienda/seguimiento/:token/meta-pixel/compra', limiteCheckout,"));
  assert.ok(RUTAS.includes("app.get('/t/:slug/pixel', limitePublico,"));
  assert.ok(RUTAS.includes("app.get('/api/admin/tienda/meta-pixel', ...gate, soloAdminPixel,"));
  assert.ok(RUTAS.includes("app.put('/api/admin/tienda/meta-pixel', ...gate, soloAdminPixel,"));
  assert.ok(SERVER.includes("if ('meta_pixel_id' in cambios) {"), 'PUT /api/config no valida el ID');
});

// ══ B) La tienda real en Chromium, contra un servidor falso ═════════════════
if (process.env.SOLO_PURAS === '1') {
  console.log('\n(SOLO_PURAS=1: se omiten las partes B y C)');
} else {
  const puppeteer = (await import('puppeteer')).default;
  const PUERTO_FALSO = Number(process.env.TEST_PORT_META_FALSO || 4772);
  const BASE = `http://localhost:${PUERTO_FALSO}`;
  const PIXELES = { demo: PIXEL, sinpixel: null };
  const SUCURSALES = { demo: 'Tienda Demo Obispado', sinpixel: 'Tienda Sin Pixel' };

  const CAT_FALSO = [
    { id: 1, nombre: 'Desayunos', productos: [
      { id: 11, nombre: 'Chilaquiles', precio: 95, descripcion: 'Verdes o rojos', imagen: null, badge: null, destacado: false, agotado: false,
        grupos: [{ id: 5, nombre: 'Tamaño', requerido: true, min: 1, max: 1,
          opciones: [{ id: 51, nombre: 'Grande', precioExtra: 20 }, { id: 52, nombre: 'Chico', precioExtra: 0 }] }] },
      { id: 12, nombre: 'Molletes', precio: 80, descripcion: 'Con pico de gallo', grupos: [] },
    ] },
    { id: 2, nombre: 'Bebidas', productos: [{ id: 21, nombre: 'Café de olla', precio: 35, descripcion: 'De olla', grupos: [] }] },
  ];
  const PRODUCTOS = new Map(CAT_FALSO.flatMap(c => c.productos.map(p => [p.id, { ...p, categoria_id: c.id }])));
  const PEDIDOS = new Map();     // token -> pedido falso
  const CHECKOUTS = [];
  const LLAMADAS = [];
  let folioN = 9100;

  function renglones(items) {
    return items.map(i => {
      const p = PRODUCTOS.get(i.productoId);
      const opciones = (p.grupos || []).flatMap(g => g.opciones.map(o => ({ ...o, grupo: g.nombre, grupoId: g.id })));
      const mods = (i.modificadores || []).map(m => opciones.find(o => o.id === m.opcionId)).filter(Boolean);
      return { producto_id: p.id, categoria_id: p.categoria_id, nombre: p.nombre, cantidad: i.cantidad,
        precio_unitario: p.precio + mods.reduce((s, m) => s + m.precioExtra, 0),
        modificadores: mods.map(m => ({ grupo_id: m.grupoId, grupo: m.grupo, opcion_id: m.id, opcion: m.nombre, precio_extra: m.precioExtra })),
        notas: i.notas || '' };
    });
  }
  const cotizacion = cuerpo => {
    const rs = renglones(cuerpo.items || []);
    const subtotal = rs.reduce((s, r) => s + r.precio_unitario * r.cantidad, 0);
    const envio = cuerpo.modalidad === 'domicilio' ? 30 : 0;
    return { modalidad: cuerpo.modalidad, zona: null, subtotal, descuento: 0, envio, envioBase: envio, envioGratis: false,
      ahorro: 0, aplicadas: [], rechazos: [], rewards: null, total: subtotal + envio, totalSinRewards: subtotal + envio,
      pedidoMinimo: 0, cumpleMinimo: true, faltaParaMinimo: 0, tiempoEstimado: '30-45 min', pistaEnvioGratis: null };
  };
  const tiendaFalsa = slug => ({
    slug, ordenesPorPersona: false, negocio: SUCURSALES[slug], descripcion: 'Prueba Meta', logo: null, portada: null,
    color: '#7c2d12', bienvenida: null, apertura: { abierto: true, cierraA: '23:59' }, modalidades: ['recoger', 'domicilio'],
    aceptaProgramados: false, anticipacionMinutos: 30, timezone: 'America/Matamoros', limiteDiasProgramado: 7, horarios: {},
    entrega: { costoBase: 30, pedidoMinimo: 0, entregaGratisDesde: 0, zonas: [], tiempo: '30-45 min' },
    preparacionMinutos: 20, cuentas: false,
    analytics: { ga4MeasurementId: null },
    metaPixel: PIXELES[slug] ? { pixelId: PIXELES[slug], sucursal: SUCURSALES[slug] } : null,
    banner: [], diseno: { tema: 'clasico' },
  });
  const etapas = ['recibido', 'preparando', 'listo', 'en_camino', 'entregado'];

  const servidorFalso = http.createServer(async (req, res) => {
    const url = new URL(req.url, BASE);
    const ruta = url.pathname;
    let cuerpo = '';
    for await (const c of req) cuerpo += c;
    const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const archivo = (rel, tipo) => { res.writeHead(200, { 'Content-Type': tipo }); res.end(readFileSync(join(RAIZ, rel))); };
    if (ruta.startsWith('/api/')) LLAMADAS.push(`${req.method} ${ruta}`);
    let m;
    if ((m = ruta.match(/^\/t\/([a-z]+)$/))) return archivo('panel/tienda.html', 'text/html; charset=utf-8');
    if ((m = ruta.match(/^\/t\/([a-z]+)\/pixel$/))) return archivo('panel/tienda-meta-pixel.html', 'text/html; charset=utf-8');
    if (ruta.match(/^\/seguimiento\/[a-f0-9]{48}$/)) return archivo('panel/tienda-seguimiento.html', 'text/html; charset=utf-8');
    if (['/tienda-analytics.js', '/tienda-meta-pixel.js', '/ordenes-persona.js'].includes(ruta)) return archivo('panel' + ruta, 'application/javascript');
    if (ruta === '/pasarela') {   // la pasarela regresa al seguimiento, como Clip
      res.writeHead(302, { Location: `/seguimiento/${url.searchParams.get('tk')}?retorno=pago&r=exito` });
      return res.end();
    }
    if ((m = ruta.match(/^\/api\/tienda\/seguimiento\/([a-f0-9]{48})(\/pago|\/pago\/verificar|\/analytics|\/analytics\/compra|\/meta-pixel|\/meta-pixel\/compra)?$/))) {
      const p = PEDIDOS.get(m[1]);
      if (!p) return json(404, { error: 'Pedido no encontrado' });
      const metaPixelId = PIXELES[p.slug];
      if (m[2] === '/analytics') return json(200, { ga4MeasurementId: null, pendiente: !p.confirmado });
      if (m[2] === '/analytics/compra') return json(200, { ga4MeasurementId: null, compra: null, pendiente: !p.confirmado, motivo: 'sin_ga4' });
      if (m[2] === '/meta-pixel') return json(200, { metaPixelId, pendiente: !p.confirmado });
      if (m[2] === '/meta-pixel/compra' && req.method === 'POST') {
        // Mismo contrato que entregarCompraMeta (la garantía real se prueba
        // contra el servidor de verdad en la parte C).
        if (!metaPixelId) return json(200, { metaPixelId: null, compra: null, pendiente: !p.confirmado, motivo: 'sin_pixel' });
        if (!p.confirmado) return json(200, { metaPixelId, compra: null, pendiente: true, motivo: 'pendiente_pago' });
        if (p.entregada) return json(200, { metaPixelId, compra: null, pendiente: false, motivo: 'ya_entregada' });
        p.entregada = true;
        return json(200, { metaPixelId, pendiente: false, slug: p.slug,
          compra: compraMetaDePedido({ folio: p.folio, estado: 'nuevo', datos: p.datos, sucursal: SUCURSALES[p.slug] }) });
      }
      if (m[2] === '/pago/verificar') {
        return json(200, { folio: p.folio, pedidoEstado: p.confirmado ? 'nuevo' : 'pendiente_pago',
          esperandoPago: !p.confirmado, pagoEstado: p.confirmado ? 'pagado' : null, consulta: p.confirmado ? 'pagado' : 'pendiente' });
      }
      if (m[2] === '/pago' && req.method === 'POST') {
        return json(200, p.confirmado ? { estado: 'no_requiere_pago', url: null, folio: p.folio }
          : { estado: 'pendiente_pago', folio: p.folio, url: `/pasarela?tk=${m[1]}` });
      }
      if (m[2] === '/pago') {
        return json(200, { folio: p.folio, pedidoEstado: p.confirmado ? 'nuevo' : 'pendiente_pago',
          esperandoPago: !p.confirmado, pagoEstado: p.confirmado ? 'pagado' : null });
      }
      return json(200, { folio: p.folio, negocio: SUCURSALES[p.slug], logo: null, color: null, cancelado: false,
        modalidad: p.datos.modalidad, etapaActual: 'recibido', total: p.datos.total, programadoPara: null,
        etapas: etapas.map((e, i) => ({ clave: e, etiqueta: e, cumplida: i === 0, actual: i === 0 })),
        items: p.datos.items.map(i => ({ nombre: i.nombre, cantidad: i.cantidad })) });
    }
    if ((m = ruta.match(/^\/api\/tienda\/([a-z]+)(\/[a-z]+)?$/))) {
      const [, slug, sub] = m;
      if (!(slug in PIXELES)) return json(404, { error: 'Tienda no encontrada' });
      if (!sub) return json(200, tiendaFalsa(slug));
      if (sub === '/catalogo') return json(200, { categorias: CAT_FALSO });
      if (sub === '/pagos') {
        return json(200, { metodos: [
          { id: 'enlace_pago', icono: '💳', etiqueta: 'Pago con tarjeta en línea', detalle: 'Pasarela', pagaDespues: false },
          { id: 'efectivo', icono: '💵', etiqueta: 'Efectivo al recibir', detalle: 'En persona', pagaDespues: true },
        ] });
      }
      const b = cuerpo ? JSON.parse(cuerpo) : {};
      if (sub === '/cotizar') return json(200, cotizacion(b));
      if (sub === '/checkout') {
        CHECKOUTS.push(b);
        const c = cotizacion(b);
        const token = randomBytes(24).toString('hex');
        const enLinea = b.metodoPago === 'enlace_pago';
        const folio = `XAB-${++folioN}`;
        PEDIDOS.set(token, { slug, folio, confirmado: !enLinea, datos: {
          items: renglones(b.items), subtotal: c.subtotal, descuento: 0, costo_envio: c.envio, total: c.total,
          modalidad: b.modalidad === 'domicilio' ? 'entrega a domicilio' : 'recoger en tienda',
          cliente: { nombre: b.cliente?.nombre, telefono: b.cliente?.telefono }, notas: b.notas } });
        return json(200, { ok: true, yaExistia: false, folio, trackingToken: token, total: c.total, ahorro: 0,
          rewards: null, rewardsNoAplicado: false, programadoPara: null,
          metodoPago: { id: b.metodoPago, pagaDespues: !enLinea } });
      }
    }
    res.writeHead(404); res.end();
  });
  await new Promise(r => servidorFalso.listen(PUERTO_FALSO, r));

  // fbevents.js de prueba: toma la cola del código base y registra cada
  // llamada con lo que el de verdad leería al mandarla (location.href como
  // `dl`, document.referrer como `rl`) y si corre dentro de un marco.
  const FBEVENTS_FALSO = `(function(){
    var f = window.fbq; if (!f) return;
    function rec(a){ try { (window.__meta || window.top.__meta)(JSON.stringify({ args: Array.prototype.slice.call(a),
      dl: location.href, rl: document.referrer, enMarco: window.top !== window })); } catch (e) {} }
    f.callMethod = function(){ rec(arguments); };
    (f.queue || []).forEach(rec); f.queue = [];
  })();`;

  let navegador;
  try {
    navegador = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });

    async function pestanaReal(contexto, { bloquear = [] } = {}) {
      const pagina = await contexto.newPage();
      await pagina.setViewport({ width: 390, height: 760 });
      const registro = { meta: [], fbevents: [], errores: [] };
      await pagina.exposeFunction('__meta', s => { try { registro.meta.push(JSON.parse(s)); } catch { /* */ } });
      await pagina.setRequestInterception(true);
      pagina.on('request', r => {
        const u = r.url();
        if (bloquear.some(b => u.includes(b))) return r.abort();
        if (u.startsWith('https://connect.facebook.net/')) {
          registro.fbevents.push(u);
          return r.respond({ status: 200, contentType: 'application/javascript', body: FBEVENTS_FALSO });
        }
        if (!u.startsWith(BASE)) return r.abort();
        r.continue();
      });
      pagina.on('pageerror', e => registro.errores.push(e.message));
      return { pagina, registro };
    }
    const ir = (pagina, ruta) => pagina.goto(BASE + ruta, { waitUntil: 'domcontentloaded' });
    const clic = async (pagina, selector) => {
      await pagina.waitForFunction(s => { const el = document.querySelector(s); return el && !el.disabled; }, { timeout: 8000 }, selector);
      await pagina.$eval(selector, el => el.click());
    };
    const escribirEn = (pagina, selector, valor) => pagina.$eval(selector, (el, v) => { el.value = v; }, valor);
    const hojaAbierta = (pagina, id) => pagina.waitForFunction(i => document.getElementById(i)?.classList.contains('on'), { timeout: 8000 }, id);
    const eventos = (registro, nombre) => registro.meta.filter(e => e.args[0] === 'track' && (!nombre || e.args[1] === nombre));
    const hasta = async (fn, ms = 9000) => { const fin = Date.now() + ms; while (Date.now() < fin) { if (await fn()) return true; await esperar(100); } return false; };
    const llegarA = async (pagina, fragmento, ms = 10000) => {
      assert.ok(await hasta(() => pagina.url().includes(fragmento), ms), `no llegó a ${fragmento}: ${pagina.url()}`);
      await pagina.waitForSelector('.folio', { timeout: ms });
    };
    const confirmado = pagina => pagina.waitForFunction(() => document.getElementById('ck-titulo')?.textContent === '¡Pedido recibido!', { timeout: 8000 });

    async function llenarYConfirmar(pagina, { modalidad, metodo }) {
      await clic(pagina, '#btn-ir-checkout');
      await hojaAbierta(pagina, 'hoja-checkout');
      await clic(pagina, `button.opcion-grande[onclick="elegirModalidad('${modalidad}')"]`);
      await clic(pagina, '#ck-pie .btn');
      await pagina.waitForSelector('#ck-nombre');
      await escribirEn(pagina, '#ck-nombre', 'Juana Pérez');
      await escribirEn(pagina, '#ck-tel', '878 123 4567');
      if (modalidad === 'domicilio') {
        await escribirEn(pagina, '#ck-dir', 'Calle Falsa 123, entre 1 y 2');
        await escribirEn(pagina, '#ck-colonia', 'Colonia Prueba');
      }
      await escribirEn(pagina, '#ck-notas', 'Tocar el timbre azul');
      await clic(pagina, '#ck-pie .btn');
      await clic(pagina, `button.opcion-grande[onclick="elegirPago('${metodo}')"]`);
      await clic(pagina, '#ck-pie .btn');
      await clic(pagina, '#btn-confirmar');
    }
    async function comprarCafe(pagina, opciones) {
      await clic(pagina, 'button.prod[onclick="abrirProducto(21)"]');
      await hojaAbierta(pagina, 'hoja-prod');
      await clic(pagina, '#btn-agregar');
      await clic(pagina, '#btn-carrito');
      await hojaAbierta(pagina, 'hoja-carrito');
      await llenarYConfirmar(pagina, opciones);
    }

    // ── B1–B5: recorrido completo con pago al recibir ──
    const ctx1 = await navegador.createBrowserContext();
    const { pagina: p1, registro: r1 } = await pestanaReal(ctx1);
    await ir(p1, '/t/demo');
    await p1.waitForSelector('.cat-sec');

    await t('B1. la tienda con ID carga fbevents.js en el <head>, sin eventos automáticos, init y PageView', async () => {
      assert.ok(await hasta(() => r1.meta.length >= 3), 'no llegó a fbevents.js');
      assert.deepStrictEqual(r1.fbevents, ['https://connect.facebook.net/en_US/fbevents.js']);
      assert.deepStrictEqual(r1.meta.slice(0, 3).map(e => e.args), [['set', 'autoConfig', false, PIXEL], ['init', PIXEL], ['track', 'PageView']]);
      assert.strictEqual(r1.meta[2].dl, `${BASE}/t/demo`);
      assert.strictEqual(await p1.evaluate(() => !!document.head.querySelector('script[src="https://connect.facebook.net/en_US/fbevents.js"]')), true);
    });

    await t('B2. ViewContent al abrir, AddToCart al agregar y al subir cantidad, InitiateCheckout al entrar al checkout', async () => {
      await clic(p1, 'button.prod[onclick="abrirProducto(11)"]');
      await hojaAbierta(p1, 'hoja-prod');
      await clic(p1, '#prod-cuerpo input[name="g5"][value="51"]');
      await clic(p1, '[onclick="cambiarCantidad(1)"]');
      await escribirEn(p1, '#prod-notas', 'Sin chile, llamar al 8781234567');
      await clic(p1, '#btn-agregar');
      await esperar(250);
      await clic(p1, 'button.prod[onclick="abrirProducto(21)"]');
      await hojaAbierta(p1, 'hoja-prod');
      await clic(p1, '#btn-agregar');
      await esperar(250);
      await clic(p1, '#btn-carrito');
      await hojaAbierta(p1, 'hoja-carrito');
      await clic(p1, '.linea-acc button[onclick="quitarLinea(1)"]');     // quitar el café: nada
      await clic(p1, '.linea-acc button[onclick="editarLinea(0)"]');
      await hojaAbierta(p1, 'hoja-prod');
      await clic(p1, '[onclick="cambiarCantidad(1)"]');                   // 2 → 3
      await clic(p1, '#btn-agregar');
      await esperar(250);
      await clic(p1, '#btn-carrito');
      await hojaAbierta(p1, 'hoja-carrito');
      await clic(p1, '#btn-ir-checkout');
      await hojaAbierta(p1, 'hoja-checkout');
      await esperar(200);
      const ev = eventos(r1).filter(e => e.args[1] !== 'PageView').map(e => [e.args[1], e.args[2]]);
      const S = SUCURSALES.demo;
      assert.deepStrictEqual(ev, [
        ['ViewContent', { content_ids: ['11'], content_name: 'Chilaquiles', content_type: 'product', value: 95, currency: 'MXN', sucursal: S }],
        ['AddToCart', { content_ids: ['11'], content_name: 'Chilaquiles', content_type: 'product',
          contents: [{ id: '11', quantity: 2, item_price: 115 }], value: 230, quantity: 2, currency: 'MXN', sucursal: S }],
        ['ViewContent', { content_ids: ['21'], content_name: 'Café de olla', content_type: 'product', value: 35, currency: 'MXN', sucursal: S }],
        ['AddToCart', { content_ids: ['21'], content_name: 'Café de olla', content_type: 'product',
          contents: [{ id: '21', quantity: 1, item_price: 35 }], value: 35, quantity: 1, currency: 'MXN', sucursal: S }],
        ['AddToCart', { content_ids: ['11'], content_name: 'Chilaquiles', content_type: 'product',
          contents: [{ id: '11', quantity: 1, item_price: 115 }], value: 115, quantity: 1, currency: 'MXN', sucursal: S }],
        ['InitiateCheckout', { content_ids: ['11'], content_type: 'product', contents: [{ id: '11', quantity: 3, item_price: 115 }],
          num_items: 3, value: 345, currency: 'MXN', sucursal: S }],
      ]);
    });

    await t('B3. Purchase al confirmar (pago al recibir): una vez, eventID = folio, value = total con envío', async () => {
      await clic(p1, `button.opcion-grande[onclick="elegirModalidad('domicilio')"]`);
      await clic(p1, '#ck-pie .btn');
      await p1.waitForSelector('#ck-nombre');
      await escribirEn(p1, '#ck-nombre', 'Juana Pérez');
      await escribirEn(p1, '#ck-tel', '878 123 4567');
      await escribirEn(p1, '#ck-dir', 'Calle Falsa 123, entre 1 y 2');
      await escribirEn(p1, '#ck-colonia', 'Colonia Prueba');
      await escribirEn(p1, '#ck-notas', 'Tocar el timbre azul');
      await clic(p1, '#ck-pie .btn');
      await clic(p1, `button.opcion-grande[onclick="elegirPago('efectivo')"]`);
      await clic(p1, '#ck-pie .btn');
      await clic(p1, '#btn-confirmar');
      await confirmado(p1);
      assert.ok(await hasta(() => eventos(r1, 'Purchase').length > 0), 'no llegó el Purchase');
      await esperar(500);
      const compras = eventos(r1, 'Purchase');
      assert.strictEqual(compras.length, 1);
      assert.deepStrictEqual(compras[0].args.slice(2), [{ value: 375, currency: 'MXN', content_ids: ['11'], content_type: 'product',
        contents: [{ id: '11', quantity: 3, item_price: 115 }], num_items: 3, sucursal: SUCURSALES.demo }, { eventID: 'XAB-9101' }]);
      assert.strictEqual(compras[0].dl, `${BASE}/t/demo`);
      // El checkout mandó exactamente lo de siempre: el píxel no tocó el pedido.
      const b = CHECKOUTS.at(-1);
      assert.deepStrictEqual(b.items, [{ productoId: 11, cantidad: 3, notas: 'Sin chile, llamar al 8781234567', persona: null,
        modificadores: [{ grupoId: 5, opcionId: 51 }] }]);
    });

    await t('B4. recargar la confirmación, seguir el pedido y recargar el seguimiento no repite el Purchase', async () => {
      await clic(p1, '#ck-pie .btn');                       // "Seguir mi pedido"
      await llegarA(p1, '/seguimiento/');
      await esperar(1200);
      await p1.reload({ waitUntil: 'domcontentloaded' });
      await p1.waitForSelector('.folio');
      await esperar(1200);
      await p1.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await esperar(1200);
      assert.strictEqual(eventos(r1, 'Purchase').length, 1);
      assert.ok(!r1.meta.some(e => e.dl.includes('/seguimiento/')), 'el seguimiento cargó el píxel');
      assert.deepStrictEqual(r1.errores, []);
    });

    await t('B5. ningún dato personal ni el token viajaron a Meta en todo el recorrido', () => {
      assert.ok(r1.meta.length > 8);
      sinPersonales(r1.meta, 'recorrido de compra');
      sinToken(r1.meta, 'recorrido de compra');
    });
    await ctx1.close();

    // ── B6–B7: pago en línea con regreso de la pasarela ──
    const ctx2 = await navegador.createBrowserContext();
    const { pagina: p2, registro: r2 } = await pestanaReal(ctx2);

    await t('B6. pago en línea: sin Purchase al crear ni al volver; llega desde el marco sin token al confirmarse', async () => {
      await ir(p2, '/t/demo');
      await p2.waitForSelector('.cat-sec');
      await comprarCafe(p2, { modalidad: 'recoger', metodo: 'enlace_pago' });
      await llegarA(p2, '/seguimiento/');
      const token = new URL(p2.url()).pathname.split('/')[2];
      assert.ok(PEDIDOS.get(token), 'no se encontró el pedido');
      await esperar(1500);
      assert.strictEqual(eventos(r2, 'Purchase').length, 0, 'Purchase antes del pago');
      assert.ok(!LLAMADAS.some(l => l === `POST /api/tienda/seguimiento/${token}/meta-pixel/compra`), 'reclamó mientras esperaba pago');
      PEDIDOS.get(token).confirmado = true;                 // el webhook confirmó el dinero
      assert.ok(await hasta(() => eventos(r2, 'Purchase').length > 0, 15000), 'no llegó el Purchase tras el pago');
      const [compra] = eventos(r2, 'Purchase');
      assert.strictEqual(compra.enMarco, true);
      assert.strictEqual(compra.dl, `${BASE}/t/demo/pixel`);
      assert.strictEqual(compra.rl, '');
      assert.deepStrictEqual(compra.args.slice(2), [{ value: 35, currency: 'MXN', content_ids: ['21'], content_type: 'product',
        contents: [{ id: '21', quantity: 1, item_price: 35 }], num_items: 1, sucursal: SUCURSALES.demo }, { eventID: PEDIDOS.get(token).folio }]);
      // La página de seguimiento nunca tuvo fbq propio.
      assert.strictEqual(await p2.evaluate(() => typeof window.fbq), 'undefined');
      assert.ok(!r2.meta.some(e => !e.enMarco && e.dl.includes('/seguimiento/')), 'el seguimiento mandó eventos con su URL');
      assert.ok(!r2.meta.some(e => e.enMarco && e.args[1] === 'PageView'), 'el marco contó una visita');
      await p2.reload({ waitUntil: 'domcontentloaded' });
      await p2.waitForSelector('.folio');
      await esperar(1500);
      assert.strictEqual(eventos(r2, 'Purchase').length, 1, 'recargar el seguimiento repitió el Purchase');
      sinPersonales(r2.meta, 'pago en línea');
      sinToken(r2.meta, 'pago en línea');
      assert.deepStrictEqual(r2.errores, []);

      // Volver a la tienda desde el seguimiento: el referente llega sin token.
      await p2.evaluate(() => { location.href = '/t/demo'; });
      await p2.waitForSelector('.cat-sec');
      assert.ok(await hasta(() => r2.meta.filter(e => e.args[1] === 'PageView').length >= 2));
      const vista = r2.meta.filter(e => e.args[1] === 'PageView').at(-1);
      assert.match(vista.rl, /\/seguimiento\/token\?retorno=pago&r=exito$/);
      sinToken(r2.meta, 'regreso a la tienda');

      // Otro dispositivo abre la liga de seguimiento (p. ej. desde WhatsApp):
      // ni carga el píxel ni pregunta nada de Meta.
      const ctx3 = await navegador.createBrowserContext();
      const { pagina: p3, registro: r3 } = await pestanaReal(ctx3);
      LLAMADAS.length = 0;
      await ir(p3, `/seguimiento/${token}`);
      await p3.waitForSelector('.folio');
      await esperar(1200);
      assert.deepStrictEqual(r3.fbevents, []);
      assert.ok(!LLAMADAS.some(l => l.includes('/meta-pixel')), `el otro dispositivo consultó el píxel: ${LLAMADAS}`);
      await ctx3.close();
    });
    await ctx2.close();

    // ── B7–B8: sin ID y con el píxel caído ──
    await t('B7. negocio sin ID: ni fbevents.js, ni fbq, ni consultas del píxel; el pedido sale igual', async () => {
      const ctx = await navegador.createBrowserContext();
      const { pagina, registro } = await pestanaReal(ctx);
      LLAMADAS.length = 0;
      await ir(pagina, '/t/sinpixel');
      await pagina.waitForSelector('.cat-sec');
      await comprarCafe(pagina, { modalidad: 'recoger', metodo: 'efectivo' });
      await confirmado(pagina);
      await esperar(600);
      assert.deepStrictEqual(registro.fbevents, []);
      assert.deepStrictEqual(registro.meta, []);
      assert.strictEqual(await pagina.evaluate(() => typeof window.fbq), 'undefined');
      assert.ok(!LLAMADAS.some(l => l.includes('/meta-pixel')), `consultó el píxel: ${LLAMADAS}`);
      assert.deepStrictEqual(registro.errores, []);
      await ctx.close();
    });

    await t('B8. si el módulo no carga o Meta está bloqueado, comprar funciona igual', async () => {
      for (const bloquear of [['/tienda-meta-pixel.js'], ['connect.facebook.net']]) {
        const ctx = await navegador.createBrowserContext();
        const { pagina, registro } = await pestanaReal(ctx, { bloquear });
        const antes = CHECKOUTS.length;
        await ir(pagina, '/t/demo');
        await pagina.waitForSelector('.cat-sec');
        await comprarCafe(pagina, { modalidad: 'domicilio', metodo: 'efectivo' });
        await confirmado(pagina);
        assert.strictEqual(CHECKOUTS.length, antes + 1, `no llegó el pedido con ${bloquear}`);
        assert.deepStrictEqual(registro.errores, [], `errores con ${bloquear}: ${registro.errores}`);
        await ctx.close();
      }
    });
  } finally {
    if (navegador) await navegador.close().catch(() => {});
    servidorFalso.close();
  }

  // ══ C) Servidor real con base ═════════════════════════════════════════════
  if (process.env.SIN_BASE === '1') {
    console.log('\n(SIN_BASE=1: se omite la parte C)');
  } else {
    const { arrancarServidor } = await import('./lib-servidor.mjs');
    const { crearTokenSesion } = await import('../src/services/session.js');
    const { pool } = await import('../src/services/database.js');
    const PUERTO = process.env.TEST_PORT_META || '4771';
    const base = `http://localhost:${PUERTO}`;
    const SUF = randomBytes(4).toString('hex');
    const NEG = {};

    const pedir = async (ruta, { cookie, metodo = 'GET', cuerpo } = {}) => {
      const r = await fetch(base + ruta, {
        method: metodo,
        headers: { ...(cuerpo !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
        body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
      });
      const tipo = r.headers.get('content-type') || '';
      return { status: r.status, tipo, headers: r.headers, body: tipo.includes('json') ? await r.json() : await r.text() };
    };
    const sesion = (usuarioId, negocioId, rol) =>
      `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId, negocioId, rol }))}`;
    const guardado = async letra => (await pool.query(
      `SELECT valor FROM configuracion WHERE negocio_id = $1 AND clave = 'meta_pixel_id'`, [NEG[letra].id])).rows[0]?.valor ?? null;

    async function alta(letra) {
      const id = randomUUID(), slug = `meta-${letra}-${SUF}`;
      await pool.query(`INSERT INTO negocios (id, nombre, slug, activo) VALUES ($1,$2,$3,TRUE)`, [id, `Meta ${letra} ${SUF}`, slug]);
      const usuarios = {};
      for (const rol of ['admin', 'staff']) {
        const { rows: [u] } = await pool.query(
          `INSERT INTO usuarios (negocio_id, nombre, email, activo) VALUES ($1,$2,$3,TRUE) RETURNING id`,
          [id, `${rol} ${letra}`, `${rol}-${letra}-${SUF}@meta.local`]);
        await pool.query(`INSERT INTO usuario_negocios (usuario_id, negocio_id, rol, activo) VALUES ($1,$2,$3,TRUE)`, [u.id, id, rol]);
        usuarios[rol] = sesion(u.id, id, rol);
      }
      for (const m of ['tienda_online', 'menu']) {
        await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,'activo')`, [id, m]);
      }
      await pool.query(`INSERT INTO tienda_config (negocio_id, estado, titular) VALUES ($1,'publicada',$2)`, [id, `Sucursal ${letra.toUpperCase()} ${SUF}`]);
      const { rows: [c] } = await pool.query(
        `INSERT INTO menu_categorias (negocio_id, nombre) VALUES ($1,'Desayunos Meta') RETURNING id`, [id]);
      const { rows: [p] } = await pool.query(
        `INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio) VALUES ($1,$2,'Chilaquiles Meta',95) RETURNING id`, [id, c.id]);
      await pool.query(`INSERT INTO tienda_productos (negocio_id, producto_id, publicado) VALUES ($1,$2,TRUE)`, [id, p.id]);
      NEG[letra] = { id, slug, sucursal: `Sucursal ${letra.toUpperCase()} ${SUF}`, ...usuarios, categoria: c.id, producto: p.id };
    }

    async function pedido(letra, estado) {
      const n = NEG[letra];
      const folio = `XAB-META${letra.toUpperCase()}${randomBytes(3).toString('hex')}`;
      const token = randomBytes(24).toString('hex');
      const ck = randomBytes(24).toString('hex');
      const datos = datosPedido({
        items: [{ ...datosPedido().items[0], producto_id: n.producto, categoria_id: n.categoria, nombre: 'Chilaquiles Meta' }],
        subtotal: 230, descuento: 23, costo_envio: 30, total: 237, canal: 'tienda_online',
        tienda: { checkout_token: ck, tracking_token: token },
      });
      await pool.query(`INSERT INTO pedidos_activos (folio, negocio_id, estado, datos) VALUES ($1,$2,$3,$4)`,
        [folio, n.id, estado, JSON.stringify(datos)]);
      await pool.query(`INSERT INTO tienda_pedidos (negocio_id, checkout_token, tracking_token, pedido_folio, estado)
        VALUES ($1,$2,$3,$4,'creado')`, [n.id, ck, token, folio]);
      return { folio, token };
    }

    async function limpiar() {
      for (const n of Object.values(NEG)) {
        for (const sql of [
          'DELETE FROM tienda_pedidos WHERE negocio_id = $1', 'DELETE FROM pedidos_activos WHERE negocio_id = $1',
          'DELETE FROM tienda_productos WHERE negocio_id = $1', 'DELETE FROM tienda_config WHERE negocio_id = $1',
          'DELETE FROM menu_productos WHERE negocio_id = $1', 'DELETE FROM menu_categorias WHERE negocio_id = $1',
          'DELETE FROM configuracion WHERE negocio_id = $1', 'DELETE FROM negocio_modulos WHERE negocio_id = $1',
          'DELETE FROM usuario_negocios WHERE negocio_id = $1', 'DELETE FROM usuarios WHERE negocio_id = $1',
          'DELETE FROM negocios WHERE id = $1',
        ]) await pool.query(sql, [n.id]).catch(e => console.log(`  (limpieza) ${e.message}`));
      }
    }

    let servidor;
    try {
      await alta('a');
      await alta('b');
      servidor = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 90000 });

      await t('C1. un negocio sin ID: la API pública manda metaPixel null y diseno sigue al final', async () => {
        const r = await pedir(`/api/tienda/${NEG.a.slug}`);
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.strictEqual(r.body.metaPixel, null);
        assert.strictEqual(Object.keys(r.body).at(-1), 'diseno');
      });

      await t('C2. un operador (staff) no puede ver ni cambiar el ID; sin sesión, 401', async () => {
        for (const [metodo, cuerpo] of [['GET'], ['PUT', { metaPixelId: PIXEL }]]) {
          const r = await pedir('/api/admin/tienda/meta-pixel', { cookie: NEG.a.staff, metodo, cuerpo });
          assert.strictEqual(r.status, 403, `${metodo} -> ${r.status}`);
        }
        const config = await pedir('/api/config', { cookie: NEG.a.staff, metodo: 'PUT', cuerpo: { meta_pixel_id: PIXEL } });
        assert.ok([401, 403].includes(config.status), `PUT /api/config staff -> ${config.status}`);
        assert.strictEqual(await guardado('a'), null, 'el operador dejó algo escrito');
        assert.strictEqual((await pedir('/api/admin/tienda/meta-pixel')).status, 401);
      });

      await t('C3. el admin no puede guardar un ID con otro formato (400 META_PIXEL_ID_INVALIDO)', async () => {
        for (const malo of ['12345678901234', '12345678901234567', 'abc456789012345', `${PIXEL}"><script>alert(1)</script>`,
          '1234 5678 9012 345', Number(PIXEL), true]) {
          const r = await pedir('/api/admin/tienda/meta-pixel', { cookie: NEG.a.admin, metodo: 'PUT', cuerpo: { metaPixelId: malo } });
          assert.strictEqual(r.status, 400, `${malo} -> ${r.status}`);
          assert.strictEqual(r.body.codigo, 'META_PIXEL_ID_INVALIDO');
        }
        assert.strictEqual(await guardado('a'), null);
      });

      await t('C4. el admin guarda el ID y solo su tienda lo publica, con su sucursal', async () => {
        const r = await pedir('/api/admin/tienda/meta-pixel', { cookie: NEG.a.admin, metodo: 'PUT', cuerpo: { metaPixelId: ` ${PIXEL} ` } });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.strictEqual(r.body.metaPixelId, PIXEL);
        assert.strictEqual(await guardado('a'), PIXEL);
        assert.deepStrictEqual((await pedir('/api/admin/tienda/meta-pixel', { cookie: NEG.a.admin })).body, { metaPixelId: PIXEL, slug: NEG.a.slug });
        assert.deepStrictEqual((await pedir(`/api/tienda/${NEG.a.slug}`)).body.metaPixel, { pixelId: PIXEL, sucursal: NEG.a.sucursal });
        assert.strictEqual((await pedir(`/api/tienda/${NEG.b.slug}`)).body.metaPixel, null);
        // Guardar el de GA4 no toca el de Meta, ni al revés.
        await pedir('/api/admin/tienda/analytics', { cookie: NEG.a.admin, metodo: 'PUT', cuerpo: { ga4MeasurementId: '' } });
        assert.strictEqual(await guardado('a'), PIXEL);
      });

      await t('C5. una fila escrita a mano con basura no llega a la tienda', async () => {
        await pool.query(`INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,'meta_pixel_id',$2)`,
          [NEG.b.id, `${PIXEL}');alert(1);//`]);
        assert.strictEqual((await pedir(`/api/tienda/${NEG.b.slug}`)).body.metaPixel, null);
        assert.strictEqual((await pedir('/api/admin/tienda/meta-pixel', { cookie: NEG.b.admin })).body.metaPixelId, null);
      });

      await t('C6. PUT /api/config tampoco deja guardar un ID inválido', async () => {
        const malo = await pedir('/api/config', { cookie: NEG.b.admin, metodo: 'PUT', cuerpo: { meta_pixel_id: '123' } });
        assert.strictEqual(malo.status, 400);
        assert.strictEqual(await guardado('b'), `${PIXEL}');alert(1);//`, 'tocó la fila con un valor rechazado');
        const bueno = await pedir('/api/config', { cookie: NEG.b.admin, metodo: 'PUT', cuerpo: { meta_pixel_id: PIXEL16 } });
        assert.strictEqual(bueno.status, 200, JSON.stringify(bueno.body));
        assert.strictEqual(await guardado('b'), PIXEL16);
        assert.deepStrictEqual((await pedir(`/api/tienda/${NEG.b.slug}`)).body.metaPixel, { pixelId: PIXEL16, sucursal: NEG.b.sucursal });
      });

      const marcas = async token => (await pool.query(
        `SELECT jsonb_exists(derivaciones, 'meta_purchase') AS meta, jsonb_exists(derivaciones, 'ga4_purchase') AS ga4
           FROM tienda_pedidos WHERE tracking_token = $1`, [token])).rows[0];
      const reclamar = token => pedir(`/api/tienda/seguimiento/${token}/meta-pixel/compra`, { metodo: 'POST' });

      await t('C7. GET solo lee; POST entrega el Purchase del pedido real una vez, y nunca si espera pago', async () => {
        for (const malo of ['z'.repeat(48), 'a'.repeat(48)]) {
          assert.strictEqual((await pedir(`/api/tienda/seguimiento/${malo}/meta-pixel`)).status, 404);
          assert.strictEqual((await reclamar(malo)).status, 404);
        }
        const { folio, token } = await pedido('a', 'pendiente_pago');
        const ruta = `/api/tienda/seguimiento/${token}/meta-pixel`;
        assert.deepStrictEqual((await pedir(ruta)).body, { metaPixelId: PIXEL, pendiente: true });
        assert.deepStrictEqual((await reclamar(token)).body, { metaPixelId: PIXEL, compra: null, pendiente: true, motivo: 'pendiente_pago' });
        assert.strictEqual((await marcas(token)).meta, false, 'un pedido pendiente de pago gastó la entrega');
        await pool.query(`UPDATE pedidos_activos SET estado = 'nuevo' WHERE folio = $1`, [folio]);   // el webhook confirmó
        for (let i = 0; i < 3; i++) assert.deepStrictEqual((await pedir(ruta)).body, { metaPixelId: PIXEL, pendiente: false });
        assert.strictEqual((await marcas(token)).meta, false, 'un GET gastó la entrega');
        const r = await reclamar(token);
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(r.body, { metaPixelId: PIXEL, pendiente: false, slug: NEG.a.slug, compra: {
          eventID: folio, params: { value: 237, currency: 'MXN', content_ids: [String(NEG.a.producto)], content_type: 'product',
            contents: [{ id: String(NEG.a.producto), quantity: 2, item_price: 115 }], num_items: 2, sucursal: NEG.a.sucursal } } });
        sinPersonales(r.body, 'POST compra por token');
        assert.deepStrictEqual(await marcas(token), { meta: true, ga4: false }, 'la marca de Meta tocó la de GA4');
        assert.deepStrictEqual((await reclamar(token)).body, { metaPixelId: PIXEL, compra: null, pendiente: false, motivo: 'ya_entregada' });
        const cancelado = await pedido('a', 'cancelado');
        assert.deepStrictEqual((await reclamar(cancelado.token)).body, { metaPixelId: PIXEL, compra: null, pendiente: false, motivo: 'sin_compra' });
        assert.strictEqual((await marcas(cancelado.token)).meta, false);
      });

      await t('C8. sin ID del negocio, no se arma, no se devuelve y no se gasta la compra', async () => {
        await pedir('/api/admin/tienda/meta-pixel', { cookie: NEG.b.admin, metodo: 'PUT', cuerpo: { metaPixelId: '' } });
        assert.strictEqual(await guardado('b'), null, 'vaciar el campo debe borrar la fila');
        const { token } = await pedido('b', 'nuevo');
        assert.deepStrictEqual((await pedir(`/api/tienda/seguimiento/${token}/meta-pixel`)).body, { metaPixelId: null, pendiente: false });
        assert.deepStrictEqual((await reclamar(token)).body, { metaPixelId: null, compra: null, pendiente: false, motivo: 'sin_pixel' });
        assert.strictEqual((await marcas(token)).meta, false);
      });

      await t('C9. dos navegadores con el mismo folio: solo uno manda Purchase (módulo real contra servidor real)', async () => {
        const { folio, token } = await pedido('a', 'nuevo');
        const respuesta = { folio, trackingToken: token };
        const n1 = pestana({ servidor: base }), n2 = pestana({ servidor: base });
        for (const n of [n1, n2]) n.M.iniciarTienda({ pixelId: PIXEL, sucursal: NEG.a.sucursal });
        await Promise.all([n1.M.pedidoCreado(respuesta), n2.M.pedidoCreado(respuesta)]);
        const compras = [...n1.eventos(), ...n2.eventos()].filter(e => e.nombre === 'Purchase');
        assert.strictEqual(compras.length, 1, `mandaron Purchase ${compras.length} navegadores`);
        assert.deepStrictEqual(compras[0].o, { eventID: folio });
        assert.ok(pidioCompra(n1) && pidioCompra(n2), 'los dos debían reclamar para que la prueba valga');
      });

      await t('C10. diez reclamos simultáneos del mismo folio: exactamente uno recibe la compra', async () => {
        const { folio, token } = await pedido('a', 'nuevo');
        const rs = await Promise.all(Array.from({ length: 10 }, () => reclamar(token)));
        assert.ok(rs.every(r => r.status === 200), rs.map(r => r.status).join(','));
        const conCompra = rs.filter(r => r.body.compra);
        assert.strictEqual(conCompra.length, 1, `${conCompra.length} reclamos recibieron la compra`);
        assert.strictEqual(conCompra[0].body.compra.eventID, folio);
        assert.strictEqual(rs.filter(r => r.body.motivo === 'ya_entregada').length, 9);
      });

      await t('C11. el servidor sirve la tienda con el módulo, el marco solo enmarcable aquí y el módulo como JS', async () => {
        const pagina = await pedir(`/t/${NEG.a.slug}`);
        assert.strictEqual(pagina.status, 200);
        assert.match(pagina.body, /<script src="\/tienda-meta-pixel\.js\?v=[0-9a-f]{8}"><\/script>/);
        assert.ok(!pagina.body.includes(PIXEL), 'el ID se escribió en el HTML de la tienda');
        const marco = await pedir(`/t/${NEG.a.slug}/pixel`);
        assert.strictEqual(marco.status, 200);
        assert.strictEqual(marco.headers.get('x-frame-options'), 'SAMEORIGIN');
        assert.strictEqual(marco.headers.get('content-security-policy'), "frame-ancestors 'self'");
        assert.match(marco.headers.get('x-robots-tag') || '', /noindex/);
        assert.match(marco.body, /<script src="\/tienda-meta-pixel\.js\?v=[0-9a-f]{8}"><\/script>/);
        const modulo = await pedir('/tienda-meta-pixel.js');
        assert.strictEqual(modulo.status, 200);
        assert.match(modulo.tipo, /javascript/);
        assert.ok(modulo.body.includes('window.XaborMetaPixel'));
        // El panel de administración no carga el módulo del píxel.
        const app = await pedir('/app', { cookie: NEG.a.admin });
        if (app.status === 200 && typeof app.body === 'string') {
          assert.ok(!app.body.includes('/tienda-meta-pixel.js') && !app.body.includes('fbevents'), '/app carga el píxel');
        }
      });
    } finally {
      await limpiar();
      if (servidor) servidor.detener();
      await pool.end().catch(() => {});
    }
  }
}

console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallidas) { console.log('Fallos:\n - ' + fallos.join('\n - ')); process.exit(1); }
process.exit(0);
