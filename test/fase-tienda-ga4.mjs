// Google Analytics 4 con ecommerce en la tienda pública (por negocio).
//
// Lo que protege, en orden de importancia:
//   a) que un negocio SIN ID de medición no cargue NADA de Google;
//   b) que a Analytics no viaje ningún dato personal (nombre, teléfono,
//      dirección, correo, notas del cliente, nombre de la persona);
//   c) que `purchase` salga UNA sola vez por folio y solo con el pedido ya
//      confirmado (pago al recibir: al crearse; pago en línea: cuando el
//      servidor ve el pago), y que recargar la confirmación no lo repita;
//   d) que una falla de la analítica jamás interrumpa una compra, y que el
//      flujo de pedido mande al servidor exactamente lo mismo que antes;
//   e) que el ID se valide con /^G-[A-Z0-9]+$/ al guardar y al leer, y que
//      solo un administrador lo cambie;
//   f) que las páginas carguen los módulos con la huella correcta (caché).
//
// Parte A: puras (sin base ni navegador), incluido el módulo del navegador en
// un entorno simulado. Parte B: la tienda REAL (panel/tienda.html) en
// Chromium contra un servidor falso sin base: eventos exactos en dataLayer.
// Parte C: servidor real con negocios propios (slugs irrepetibles).
//
// Uso: mismas env vars que la batería (DATABASE_URL, PANEL_SECRET, …).
//      TEST_PORT_GA4 (4761) y TEST_PORT_GA4_FALSO (4762).
//      SOLO_PURAS=1 salta B y C; SIN_BASE=1 salta solo C.
import assert from 'assert';
import vm from 'vm';
import http from 'http';
import { readFileSync } from 'fs';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  normalizarGa4Id, ga4IdValido, compraGa4DePedido, itemGa4DeRenglon, GA4_REGEX,
} from '../src/services/tiendaAnalytics.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(__dirname, '..');
const leer = r => readFileSync(join(RAIZ, r), 'utf8').replace(/\r\n/g, '\n');
const TIENDA_HTML = leer('panel/tienda.html');
const TIENDA_JS = TIENDA_HTML.slice(TIENDA_HTML.indexOf('<script>'), TIENDA_HTML.lastIndexOf('</script>'));
const SEGUIMIENTO_HTML = leer('panel/tienda-seguimiento.html');
const PANEL = leer('panel/index.html');
const MODULO = readFileSync(join(RAIZ, 'panel/tienda-analytics.js'));
const EDITOR = readFileSync(join(RAIZ, 'panel/tienda-ga4.js'));
const RUTAS = leer('src/services/tiendaRutasCore.js');
const SERVER = leer('src/server.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(nombre); }
}
const lanza = (fn, codigo) => assert.throws(fn, e => e.codigo === codigo, `esperaba ${codigo}`);
const plano = x => JSON.parse(JSON.stringify(x));
const esperar = ms => new Promise(r => setTimeout(r, ms));

// Datos personales que las pruebas siembran a propósito: ninguno puede
// aparecer en algo que viaje a Analytics.
const PERSONALES = ['Juana', 'Pérez', '8781234567', '878 123 4567', 'Calle Falsa', 'Colonia Prueba',
  'timbre azul', 'llamar al', 'juana@correo.test', 'Tía Rosa'];
function sinPersonales(cosa, donde) {
  const s = JSON.stringify(cosa);
  for (const p of PERSONALES) assert.ok(!s.includes(p), `"${p}" viajó a Analytics en ${donde}: ${s.slice(0, 400)}`);
}

// Un pedido como lo guarda tiendaCheckout (forma de pedidos_activos.datos),
// lleno de datos personales que NO deben salir.
const datosPedido = (o = {}) => ({
  items: [
    { producto_id: 11, categoria_id: 1, nombre: 'Chilaquiles', cantidad: 2, precio_unitario: 115, precio_base: 95,
      modificadores: [{ grupo_id: 5, grupo: 'Tamaño', opcion_id: 51, opcion: 'Grande', precio_extra: 20 },
        { grupo_id: 6, grupo: 'Extras', opcion_id: 61, opcion: 'Sin cebolla', precio_extra: 0 }],
      notas: 'Grande, Sin cebolla · Sin chile, llamar al 8781234567', persona: { numero: 2, nombre: 'Tía Rosa' } },
    { producto_id: 21, categoria_id: 2, nombre: 'Café de olla', cantidad: 1, precio_unitario: 35, modificadores: [] },
  ],
  subtotal: 265, descuento: 26.5, costo_envio: 30, total: 268.5,
  cliente: { nombre: 'Juana Pérez', telefono: '8781234567', calle: 'Calle Falsa 123', colonia: 'Colonia Prueba' },
  notas: 'Tocar el timbre azul', forma_pago: 'efectivo (al recibir)',
  tienda: { promociones: [{ id: 1, nombre: '10% bienvenida', codigo: 'BIENVENIDA10', descuento: 26.5 },
    { id: 2, nombre: 'Envío gratis', codigo: null, descuento: 0 }] },
  ...o,
});
const CATEGORIAS = new Map([[1, 'Desayunos'], [2, 'Bebidas']]);

// ══ A) Puras ════════════════════════════════════════════════════════════════
await t('A1. el ID se valida con /^G-[A-Z0-9]+$/ y se normaliza al guardar', () => {
  assert.strictEqual(String(GA4_REGEX), String(/^G-[A-Z0-9]+$/));
  assert.strictEqual(normalizarGa4Id('G-ABC123XYZ'), 'G-ABC123XYZ');
  assert.strictEqual(normalizarGa4Id('  g-abc123xyz \n'), 'G-ABC123XYZ');
  for (const vacio of [null, undefined, '', '   ']) assert.strictEqual(normalizarGa4Id(vacio), null);
  for (const malo of ['UA-12345-1', 'G-', 'G-ABC!', 'G-ABC 123', 'GTM-ABC123', 'AW-123', 'G_ABC',
    'G-ABC"><script>alert(1)</script>', 'G-ABC?id=x', 'G-' + 'A'.repeat(40), 'xG-ABC', 42]) {
    lanza(() => normalizarGa4Id(malo), 'GA4_ID_INVALIDO');
  }
});

await t('A2. al leer, un valor guardado a mano con basura queda inerte (null)', () => {
  assert.strictEqual(ga4IdValido('G-ABC123'), 'G-ABC123');
  for (const malo of [null, undefined, '', 'g-abc123', 'G-ABC"><img src=x>', 'G-ABC\nG-DEF', 'G-' + 'A'.repeat(40), 7, {}]) {
    assert.strictEqual(ga4IdValido(malo), null, JSON.stringify(malo));
  }
});

await t('A3. purchase solo para un pedido confirmado; nunca pendiente de pago ni cancelado', () => {
  for (const estado of ['pendiente_pago', 'cancelado', null, undefined, '']) {
    assert.strictEqual(compraGa4DePedido({ folio: 'XAB-0001', estado, datos: datosPedido() }), null, String(estado));
  }
  assert.strictEqual(compraGa4DePedido({ folio: null, estado: 'nuevo', datos: datosPedido() }), null);
  assert.strictEqual(compraGa4DePedido({ folio: 'XAB-1', estado: 'nuevo', datos: datosPedido({ items: [] }) }), null);
  for (const estado of ['nuevo', 'en_preparacion', 'listo', 'entregado']) {
    assert.ok(compraGa4DePedido({ folio: 'XAB-0001', estado, datos: datosPedido() }), estado);
  }
});

await t('A4. purchase: folio, value sin envío ni impuestos, tax, shipping, coupon e items', () => {
  const c = plano(compraGa4DePedido({ folio: 'XAB-0042', estado: 'nuevo', datos: datosPedido(), categorias: CATEGORIAS }));
  assert.deepStrictEqual(c, {
    transaction_id: 'XAB-0042', currency: 'MXN',
    value: 238.5,          // 265 de productos − 26.5 de promoción; sin los 30 de envío
    tax: 0, shipping: 30, coupon: 'BIENVENIDA10',
    items: [
      { item_id: '11', item_name: 'Chilaquiles', item_category: 'Desayunos', item_variant: 'Grande, Sin cebolla', price: 115, quantity: 2 },
      { item_id: '21', item_name: 'Café de olla', item_category: 'Bebidas', price: 35, quantity: 1 },
    ],
  });
  // Rewards es forma de pago: baja el total cobrado pero no el valor vendido.
  const conPuntos = compraGa4DePedido({ folio: 'XAB-0042', estado: 'nuevo',
    datos: datosPedido({ total: 200, rewards_canje: { puntos: 600, monto: 68.5 } }), categorias: CATEGORIAS });
  assert.strictEqual(conPuntos.value, 238.5);
  // Sin promoción con código: no hay coupon.
  const sinCupon = compraGa4DePedido({ folio: 'XAB-1', estado: 'nuevo', datos: datosPedido({ tienda: {} }) });
  assert.ok(!('coupon' in sinCupon));
  // Sin subtotal guardado se cae a la suma de renglones.
  assert.strictEqual(compraGa4DePedido({ folio: 'XAB-1', estado: 'nuevo',
    datos: datosPedido({ subtotal: undefined, descuento: 0 }) }).value, 265);
});

await t('A22. Rewards: pedido de $300 con $100 pagados en puntos → value 300 (no 200)', () => {
  // Así lo deja tiendaCheckout: subtotal intacto, descuento de promociones en
  // 0, y el canje solo baja `total` (aplicarRewardsAlPedido).
  const c = compraGa4DePedido({ folio: 'XAB-0300', estado: 'nuevo', datos: {
    items: [{ producto_id: 7, categoria_id: 1, nombre: 'Paquete familiar', cantidad: 1, precio_unitario: 300, modificadores: [] }],
    subtotal: 300, descuento: 0, costo_envio: 0, total: 200, rewards_canje: { puntos: 1000, monto: 100 },
  }, categorias: CATEGORIAS });
  assert.strictEqual(c.value, 300);
  assert.deepStrictEqual([c.tax, c.shipping], [0, 0]);
});

await t('A5. el purchase del servidor no lleva ningún dato personal', () => {
  const c = compraGa4DePedido({ folio: 'XAB-0042', estado: 'nuevo', datos: datosPedido(), categorias: CATEGORIAS });
  sinPersonales(c, 'compraGa4DePedido');
  const item = itemGa4DeRenglon(datosPedido().items[0], CATEGORIAS);
  assert.deepStrictEqual(Object.keys(item).sort(),
    ['item_category', 'item_id', 'item_name', 'item_variant', 'price', 'quantity']);
});

// ── El módulo del navegador en un entorno simulado ──
// Una "pestaña" con su URL, su storage y un fetch que contesta lo que la
// prueba le diga. El storage se puede compartir entre pestañas para simular
// recargas y navegación en el mismo navegador.
const TOKEN = 'a'.repeat(48), TOKEN2 = 'b'.repeat(48);
function navegadorNuevo() { return { local: new Map(), sesion: new Map() }; }
// Con `servidor`, el fetch de la pestaña va a ese servidor real (parte C).
function pestana({ url = 'https://xabor.mx/t/demo', referrer = '', navegador = navegadorNuevo(), respuestas = {}, sinStorage = false, servidor = null } = {}) {
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
  const scripts = [], pedidas = [];
  const ctx = {
    location: { href: url, search: u.search, pathname: u.pathname, origin: u.origin },
    document: {
      referrer,
      head: { appendChild: el => scripts.push(el) },
      createElement: tag => ({ tagName: tag }),
      getElementById: () => null,
    },
    localStorage: sinStorage ? bloqueado : storage(navegador.local),
    sessionStorage: sinStorage ? bloqueado : storage(navegador.sesion),
    URLSearchParams, console,
    fetch: async (ruta, opciones) => {
      pedidas.push(`${opciones?.method || 'GET'} ${ruta}`);
      if (servidor) return fetch(servidor + ruta, { method: opciones?.method || 'GET' });
      const r = respuestas[ruta];
      if (r instanceof Error) throw r;
      if (typeof r === 'function') return { ok: true, json: async () => r() };
      return r === undefined ? { ok: false, json: async () => ({}) } : { ok: true, json: async () => r };
    },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(MODULO.toString('utf8'), ctx);
  return {
    A: ctx.XaborAnalytics, ctx, scripts, pedidas, navegador,
    eventos: () => plano((ctx.dataLayer || []).map(a => Array.prototype.slice.call(a)))
      .filter(a => a[0] === 'event').map(a => ({ nombre: a[1], p: a[2] })),
    config: () => plano((ctx.dataLayer || []).map(a => Array.prototype.slice.call(a))).find(a => a[0] === 'config'),
  };
}
const CATALOGO = [
  { id: 1, nombre: 'Desayunos', productos: [{ id: 11, nombre: 'Chilaquiles', precio: 95 }, { id: 12, nombre: 'Molletes', precio: 80 }] },
  { id: 2, nombre: 'Bebidas', productos: [{ id: 21, nombre: 'Café de olla', precio: 35 }] },
];
const LINEA = { productoId: 11, nombre: 'Chilaquiles', precio: 95, cantidad: 2,
  modificadores: [{ grupoId: 5, grupo: 'Tamaño', opcionId: 51, nombre: 'Grande', precioExtra: 20 },
    { grupoId: 6, grupo: 'Extras', opcionId: 61, nombre: 'Sin cebolla', precioExtra: 0 }],
  notas: 'Sin chile, llamar al 8781234567', persona: { numero: 2, nombre: 'Tía Rosa' } };
const CAFE = { productoId: 21, nombre: 'Café de olla', precio: 35, cantidad: 1, modificadores: [], notas: '', persona: null };
const COMPRA = plano(compraGa4DePedido({ folio: 'XAB-0042', estado: 'nuevo', datos: datosPedido(), categorias: CATEGORIAS }));
const rutaAnalytics = tk => `/api/tienda/seguimiento/${tk}/analytics`;      // GET: ID y si espera pago
const rutaCompra = tk => `/api/tienda/seguimiento/${tk}/analytics/compra`;   // POST: reclama la compra
const pidioCompra = p => p.pedidas.some(x => x.startsWith('POST ') && x.endsWith('/analytics/compra'));
// Lo que contesta el servidor de mentira para un token: el GET (ID y si
// espera pago) y el POST (la compra). Cualquiera de los dos puede ser función.
const respuestasDe = (tk, { ga4 = 'G-PRUEBA123', pendiente = false, compra = null, motivo, get, post } = {}) => ({
  [rutaAnalytics(tk)]: get || { ga4MeasurementId: ga4, pendiente },
  [rutaCompra(tk)]: post || { ga4MeasurementId: ga4, compra, pendiente, ...(motivo ? { motivo } : {}) },
});

await t('A6. sin ID de medición: no inyecta gtag.js, no crea gtag ni dataLayer, y todo es no-op', async () => {
  for (const id of [null, undefined, '', 'UA-1234-1', 'G-abc', 'G-ABC"><script>', 'G-' + 'A'.repeat(40)]) {
    const p = pestana({ respuestas: respuestasDe(TOKEN, { ga4: null, compra: COMPRA }) });
    assert.strictEqual(p.A.iniciarTienda({ measurementId: id, catalogo: CATALOGO }), false);
    p.A.verProducto(CATALOGO[0].productos[0]);
    p.A.cambioEnCarrito(null, LINEA);
    p.A.verCarrito([LINEA]); p.A.iniciarCheckout([LINEA]);
    p.A.elegirEntrega([LINEA], 'domicilio'); p.A.elegirPago([LINEA], 'efectivo');
    await p.A.pedidoCreado({ folio: 'XAB-0042', trackingToken: TOKEN, metodoPago: { pagaDespues: true } });
    assert.strictEqual(p.scripts.length, 0, `cargó un script con ${id}`);
    assert.strictEqual(p.ctx.gtag, undefined);
    assert.strictEqual(p.ctx.dataLayer, undefined);
    assert.deepStrictEqual(p.pedidas, [], 'sin GA4 no debe preguntar nada al servidor');
    assert.strictEqual(p.navegador.local.size + p.navegador.sesion.size, 0, 'dejó marcas en storage');
  }
});

await t('A7. con ID: carga gtag.js de ese ID y lo configura con linker mapolato.com ↔ xabor.mx', () => {
  const p = pestana();
  assert.strictEqual(p.A.iniciarTienda({ measurementId: 'G-PRUEBA123', catalogo: CATALOGO }), true);
  assert.strictEqual(p.scripts.length, 1);
  assert.strictEqual(p.scripts[0].src, 'https://www.googletagmanager.com/gtag/js?id=G-PRUEBA123');
  assert.strictEqual(p.scripts[0].async, true);
  assert.deepStrictEqual(p.config(), ['config', 'G-PRUEBA123', { linker: { domains: ['mapolato.com', 'xabor.mx'] } }]);
  // Un segundo arranque no carga otro script.
  assert.strictEqual(p.A.iniciarTienda({ measurementId: 'G-PRUEBA123', catalogo: CATALOGO }), true);
  assert.strictEqual(p.scripts.length, 1);
});

await t('A8. eventos de ecommerce: nombres, MXN, value, items con categoría, variante y precio con extras', () => {
  const p = pestana();
  p.A.iniciarTienda({ measurementId: 'G-PRUEBA123', catalogo: CATALOGO });
  // Sin IntersectionObserver (navegador viejo) se reporta cada lista al arrancar.
  const listas = p.eventos().filter(e => e.nombre === 'view_item_list');
  assert.deepStrictEqual(listas.map(e => [e.p.item_list_id, e.p.item_list_name, e.p.items.length]),
    [['cat-1', 'Desayunos', 2], ['cat-2', 'Bebidas', 1]]);
  assert.deepStrictEqual(listas[0].p.items[1], { item_id: '12', item_name: 'Molletes', item_category: 'Desayunos',
    price: 80, quantity: 1, index: 1, item_list_id: 'cat-1', item_list_name: 'Desayunos' });

  p.A.verProducto(CATALOGO[0].productos[0]);
  p.A.cambioEnCarrito(null, LINEA);
  p.A.cambioEnCarrito(null, CAFE);
  p.A.verCarrito([LINEA, CAFE]);
  p.A.cambioEnCarrito(CAFE, null);
  p.A.iniciarCheckout([LINEA]);
  p.A.elegirEntrega([LINEA], 'domicilio');
  p.A.elegirEntrega([LINEA], 'recoger');
  p.A.elegirPago([LINEA], 'enlace_pago');
  p.A.elegirPago([LINEA], 'efectivo');
  const ev = p.eventos().filter(e => e.nombre !== 'view_item_list');
  assert.deepStrictEqual(ev.map(e => e.nombre), ['view_item', 'add_to_cart', 'add_to_cart', 'view_cart', 'remove_from_cart',
    'begin_checkout', 'add_shipping_info', 'add_shipping_info', 'add_payment_info', 'add_payment_info']);
  for (const e of ev) assert.strictEqual(e.p.currency, 'MXN', e.nombre);
  const chilaquiles = { item_id: '11', item_name: 'Chilaquiles', item_category: 'Desayunos',
    item_variant: 'Grande, Sin cebolla', price: 115, quantity: 2 };
  assert.deepStrictEqual(ev[0].p, { currency: 'MXN', value: 95,
    items: [{ item_id: '11', item_name: 'Chilaquiles', item_category: 'Desayunos', price: 95, quantity: 1 }] });
  assert.deepStrictEqual(ev[1].p, { currency: 'MXN', value: 230, items: [chilaquiles] });
  assert.deepStrictEqual(ev[3].p.items.map(i => i.item_id), ['11', '21']);
  assert.strictEqual(ev[3].p.value, 265);
  assert.deepStrictEqual(ev[4].p.items, [{ item_id: '21', item_name: 'Café de olla', item_category: 'Bebidas', price: 35, quantity: 1 }]);
  assert.deepStrictEqual([ev[6].p.shipping_tier, ev[7].p.shipping_tier], ['Entrega a domicilio', 'Recoger en sucursal']);
  assert.deepStrictEqual([ev[8].p.payment_type, ev[9].p.payment_type], ['Tarjeta en línea', 'Efectivo']);
  sinPersonales(p.eventos(), 'eventos del carrito');
});

await t('A9. editar un renglón: la cantidad manda la diferencia; cambiar opciones es quitar y agregar', () => {
  const p = pestana();
  p.A.iniciarTienda({ measurementId: 'G-PRUEBA123', catalogo: CATALOGO });
  const base = p.eventos().length;
  p.A.cambioEnCarrito(LINEA, { ...LINEA, cantidad: 5 });
  p.A.cambioEnCarrito(LINEA, { ...LINEA, cantidad: 1 });
  p.A.cambioEnCarrito(LINEA, { ...LINEA, notas: 'otra nota' });    // mismo item: nada
  p.A.cambioEnCarrito(LINEA, { ...LINEA, modificadores: [LINEA.modificadores[0]] });
  const ev = p.eventos().slice(base);
  assert.deepStrictEqual(ev.map(e => [e.nombre, e.p.items[0].quantity, e.p.items[0].item_variant]), [
    ['add_to_cart', 3, 'Grande, Sin cebolla'],
    ['remove_from_cart', 1, 'Grande, Sin cebolla'],
    ['remove_from_cart', 2, 'Grande, Sin cebolla'],
    ['add_to_cart', 2, 'Grande'],
  ]);
});

await t('A10. pago al recibir: purchase una sola vez, del servidor, y recargar no lo repite', async () => {
  const navegador = navegadorNuevo();
  const respuestas = respuestasDe(TOKEN, { compra: COMPRA });
  const p = pestana({ navegador, respuestas });
  p.A.iniciarTienda({ measurementId: 'G-PRUEBA123', catalogo: CATALOGO });
  await p.A.pedidoCreado({ folio: 'XAB-0042', trackingToken: TOKEN, metodoPago: { id: 'efectivo', pagaDespues: true } });
  await p.A.pedidoCreado({ folio: 'XAB-0042', trackingToken: TOKEN, metodoPago: { id: 'efectivo', pagaDespues: true } });
  const compras = p.eventos().filter(e => e.nombre === 'purchase');
  assert.strictEqual(compras.length, 1);
  assert.deepStrictEqual(compras[0].p, COMPRA);
  assert.deepStrictEqual(p.pedidas, [`POST ${rutaCompra(TOKEN)}`], 'la tienda solo debe reclamar la compra, una vez');
  // La confirmación recargada (misma pestaña) y el seguimiento después: ni
  // siquiera vuelven a reclamarla (aunque el servidor de mentira la daría).
  const recarga = pestana({ navegador, respuestas });
  recarga.A.iniciarTienda({ measurementId: 'G-PRUEBA123', catalogo: CATALOGO });
  await recarga.A.pedidoCreado({ folio: 'XAB-0042', trackingToken: TOKEN, metodoPago: { pagaDespues: true } });
  const seg = pestana({ url: `https://xabor.mx/seguimiento/${TOKEN}`, navegador, respuestas });
  await seg.A.seguimiento(TOKEN);
  await seg.A.seguimiento(TOKEN);
  assert.strictEqual([...recarga.eventos(), ...seg.eventos()].filter(e => e.nombre === 'purchase').length, 0);
  assert.ok(!pidioCompra(recarga) && !pidioCompra(seg), 'una recarga volvió a reclamar la compra');
  assert.ok(seg.config(), 'el seguimiento debe cargar GA4');
});

await t('A11. pago en línea: nada mientras espera; purchase cuando el servidor ve el pago; una vez', async () => {
  const navegador = navegadorNuevo();
  let pagado = false;
  const respuestas = respuestasDe(TOKEN2, {
    // Un GET que (como un servidor viejo) trajera la compra no debe servir de nada.
    get: () => ({ ga4MeasurementId: 'G-PRUEBA123', pendiente: !pagado, compra: { ...COMPRA, transaction_id: 'XAB-0043' } }),
    post: () => ({ ga4MeasurementId: 'G-PRUEBA123', pendiente: !pagado,
      compra: pagado ? { ...COMPRA, transaction_id: 'XAB-0043' } : null, ...(pagado ? {} : { motivo: 'pendiente_pago' }) }),
  });
  const tienda = pestana({ navegador, respuestas });
  tienda.A.iniciarTienda({ measurementId: 'G-PRUEBA123', catalogo: CATALOGO });
  await tienda.A.pedidoCreado({ folio: 'XAB-0043', trackingToken: TOKEN2, metodoPago: { id: 'enlace_pago', pagaDespues: false } });
  assert.strictEqual(tienda.eventos().filter(e => e.nombre === 'purchase').length, 0);
  // Regresa de la pasarela: el webhook todavía no llega.
  const seg = pestana({ url: `https://xabor.mx/seguimiento/${TOKEN2}?retorno=pago`, navegador, respuestas });
  await seg.A.seguimiento(TOKEN2);
  await seg.A.seguimiento(TOKEN2);
  assert.strictEqual(seg.eventos().filter(e => e.nombre === 'purchase').length, 0);
  pagado = true;                       // el webhook confirmó el pago
  await seg.A.seguimiento(TOKEN2);
  await seg.A.seguimiento(TOKEN2);
  const compras = seg.eventos().filter(e => e.nombre === 'purchase');
  assert.deepStrictEqual(compras.map(c => c.p.transaction_id), ['XAB-0043']);
  // Ya reportado, el sondeo deja de preguntar.
  const antes = seg.pedidas.length;
  await seg.A.seguimiento(TOKEN2);
  assert.strictEqual(seg.pedidas.length, antes);
  // Recargar el seguimiento no lo repite; otro dispositivo (sin la marca)
  // ni lo manda ni lo reclama: solo lee el ID para su page_view.
  const recarga = pestana({ url: `https://xabor.mx/seguimiento/${TOKEN2}`, navegador, respuestas });
  await recarga.A.seguimiento(TOKEN2);
  const otro = pestana({ url: `https://xabor.mx/seguimiento/${TOKEN2}`, respuestas });
  await otro.A.seguimiento(TOKEN2);
  assert.strictEqual([...recarga.eventos(), ...otro.eventos()].filter(e => e.nombre === 'purchase').length, 0);
  assert.deepStrictEqual(otro.pedidas, [`GET ${rutaAnalytics(TOKEN2)}`]);
  assert.ok(otro.config(), 'el otro dispositivo sí carga GA4 (page_view)');
});

await t('A12. cancelado o ya entregado a otro navegador: la marca se borra y no hay purchase', async () => {
  for (const motivo of ['sin_compra', 'ya_entregada']) {
    const navegador = navegadorNuevo();
    const p = pestana({ navegador, respuestas: respuestasDe(TOKEN2, { compra: null, pendiente: false, motivo }) });
    p.A.iniciarTienda({ measurementId: 'G-PRUEBA123', catalogo: CATALOGO });
    await p.A.pedidoCreado({ folio: 'XAB-0044', trackingToken: TOKEN2, metodoPago: { pagaDespues: false } });
    assert.ok(![...navegador.local.keys()].some(k => k.startsWith('xabor_ga4_pendiente:')), `quedó la marca (${motivo})`);
    assert.strictEqual(p.eventos().filter(e => e.nombre === 'purchase').length, 0);
  }
});

await t('A13. el token de seguimiento se tacha de page_location y page_referrer', async () => {
  const respuestas = respuestasDe(TOKEN);
  const seg = pestana({ url: `https://xabor.mx/seguimiento/${TOKEN}?retorno=pago`, referrer: 'https://pasarela.test/x', respuestas });
  await seg.A.seguimiento(TOKEN);
  const [, , cfg] = seg.config();
  assert.strictEqual(cfg.page_location, 'https://xabor.mx/seguimiento/token?retorno=pago');
  assert.ok(!('page_referrer' in cfg));
  const tienda = pestana({ referrer: `https://xabor.mx/seguimiento/${TOKEN}` });
  tienda.A.iniciarTienda({ measurementId: 'G-PRUEBA123', catalogo: CATALOGO });
  const [, , cfg2] = tienda.config();
  assert.strictEqual(cfg2.page_referrer, 'https://xabor.mx/seguimiento/token');
  assert.ok(!('page_location' in cfg2), 'en la tienda la URL va tal cual');
  assert.ok(!JSON.stringify([seg.config(), tienda.config()]).includes(TOKEN));
});

await t('A14. ?ga4_debug=1 marca la pestaña para DebugView y se recuerda al ir al seguimiento', async () => {
  const navegador = navegadorNuevo();
  const t1 = pestana({ url: 'https://xabor.mx/t/demo?ga4_debug=1', navegador });
  t1.A.iniciarTienda({ measurementId: 'G-PRUEBA123', catalogo: CATALOGO });
  assert.strictEqual(t1.config()[2].debug_mode, true);
  const seg = pestana({ url: `https://xabor.mx/seguimiento/${TOKEN}`, navegador, respuestas: respuestasDe(TOKEN) });
  await seg.A.seguimiento(TOKEN);
  assert.strictEqual(seg.config()[2].debug_mode, true);
  const normal = pestana();
  normal.A.iniciarTienda({ measurementId: 'G-PRUEBA123', catalogo: CATALOGO });
  assert.ok(!('debug_mode' in normal.config()[2]));
});

await t('A15. nada lanza: storage bloqueado, fetch caído, gtag roto, entradas basura', async () => {
  const caida = new Error('sin red');
  const p = pestana({ sinStorage: true, respuestas: { [rutaAnalytics(TOKEN)]: caida, [rutaCompra(TOKEN)]: caida } });
  assert.strictEqual(p.A.iniciarTienda({ measurementId: 'G-PRUEBA123', catalogo: CATALOGO }), true);
  await p.A.pedidoCreado({ folio: 'XAB-1', trackingToken: TOKEN, metodoPago: { pagaDespues: true } });
  await p.A.seguimiento(TOKEN);
  for (const basura of [undefined, null, 42, 'x', {}, [], { productos: 'x' }]) {
    p.A.iniciarTienda(basura); p.A.verProducto(basura); p.A.cambioEnCarrito(basura, basura);
    p.A.verCarrito(basura); p.A.iniciarCheckout(basura); p.A.elegirEntrega(basura, basura);
    p.A.elegirPago(basura, basura); await p.A.pedidoCreado(basura); await p.A.seguimiento(basura);
  }
  p.ctx.gtag = () => { throw new Error('gtag roto'); };
  p.A.verProducto(CATALOGO[0].productos[0]);
  p.A.cambioEnCarrito(null, LINEA);
  // Sin storage, las marcas viven en memoria de la pestaña: el pago al
  // recibir se reporta una vez y repetir no lo duplica.
  const sinSt = pestana({ sinStorage: true, respuestas: respuestasDe(TOKEN, { compra: COMPRA }) });
  sinSt.A.iniciarTienda({ measurementId: 'G-PRUEBA123', catalogo: CATALOGO });
  await sinSt.A.pedidoCreado({ folio: 'XAB-0042', trackingToken: TOKEN, metodoPago: { pagaDespues: true } });
  await sinSt.A.pedidoCreado({ folio: 'XAB-0042', trackingToken: TOKEN, metodoPago: { pagaDespues: true } });
  assert.strictEqual(sinSt.eventos().filter(e => e.nombre === 'purchase').length, 1);
  // Y una promesa devuelta por el módulo nunca rechaza.
  assert.strictEqual(await p.A.seguimiento(TOKEN), undefined);
});

await t('A16. el purchase del navegador re-filtra los items: ni un campo extra del servidor pasa', async () => {
  const sucia = { ...COMPRA, cliente: 'Juana Pérez', items: COMPRA.items.map(i => ({ ...i, notas: 'llamar al 8781234567' })) };
  const p = pestana({ respuestas: respuestasDe(TOKEN, { compra: sucia }) });
  p.A.iniciarTienda({ measurementId: 'G-PRUEBA123', catalogo: CATALOGO });
  await p.A.pedidoCreado({ folio: 'XAB-0042', trackingToken: TOKEN, metodoPago: { pagaDespues: true } });
  const [compra] = p.eventos().filter(e => e.nombre === 'purchase');
  assert.deepStrictEqual(compra.p, COMPRA);
  sinPersonales(p.eventos(), 'purchase re-filtrado');
});

// ── Cableado estático: huellas, enganches y un solo punto de contacto ──
await t('A17. tienda y seguimiento cargan el módulo con la huella sha256 del archivo', () => {
  const huella = createHash('sha256').update(MODULO).digest('hex').slice(0, 8);
  for (const [nombre, html] of [['tienda.html', TIENDA_HTML], ['tienda-seguimiento.html', SEGUIMIENTO_HTML]]) {
    const m = html.match(/<script src="\/tienda-analytics\.js\?v=([0-9a-f]+)"><\/script>/);
    assert.ok(m, `${nombre}: no se encontró la etiqueta del módulo`);
    assert.strictEqual(m[1], huella, `${nombre}: actualiza la etiqueta a ?v=${huella}`);
    assert.ok(html.indexOf('/tienda-analytics.js') < html.indexOf('<script>\n'), `${nombre}: el módulo debe cargar antes del script de la página`);
  }
  const huellaEditor = createHash('sha256').update(EDITOR).digest('hex').slice(0, 8);
  const m = PANEL.match(/<script src="\/tienda-ga4\.js\?v=([0-9a-f]+)"><\/script>/);
  assert.ok(m, 'panel: no se encontró la etiqueta del editor');
  assert.strictEqual(m[1], huellaEditor, `panel: actualiza la etiqueta a ?v=${huellaEditor}`);
});

await t('A18. las páginas jamás hablan con Google por su cuenta: todo pasa por XaborAnalytics', () => {
  for (const [nombre, html] of [['tienda.html', TIENDA_HTML], ['tienda-seguimiento.html', SEGUIMIENTO_HTML]]) {
    assert.ok(!/googletagmanager|google-analytics|gtag\(|dataLayer/.test(html), `${nombre} habla con Google directo`);
  }
  // Y cada llamada de la tienda va por el envoltorio que no puede lanzar.
  assert.ok(TIENDA_JS.includes("const analitica = (fn, ...args) => { try { window.XaborAnalytics?.[fn]?.(...args); } catch (e) {} };"));
  assert.ok(!/XaborAnalytics\.[a-zA-Z]/.test(TIENDA_JS), 'la tienda llama XaborAnalytics.x sin el envoltorio');
  assert.ok(SEGUIMIENTO_HTML.includes('try { window.XaborAnalytics?.seguimiento(TOKEN); } catch (e) {}'));
  // El módulo es una IIFE y su único nombre global es XaborAnalytics.
  const src = MODULO.toString('utf8');
  assert.deepStrictEqual([...src.matchAll(/window\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)].map(m => m[1]).sort(),
    ['XaborAnalytics', 'dataLayer', 'gtag'].sort());
  assert.ok(!/matchMedia/.test(src), 'fase-tienda-desktop prohíbe matchMedia en la tienda');
});

await t('A19. cada evento está enganchado en el punto exacto de la tienda', () => {
  // El texto de una función: desde su declaración hasta la siguiente.
  const funcion = nombre => {
    const i = TIENDA_JS.search(new RegExp(`(async )?function ${nombre}\\(`));
    assert.ok(i >= 0, `no existe ${nombre}`);
    const resto = TIENDA_JS.slice(i + 10);
    const j = resto.search(/\n(async )?function /);
    return TIENDA_JS.slice(i, i + 10 + (j < 0 ? resto.length : j));
  };
  const esperado = {
    iniciar: "analitica('iniciarTienda', { measurementId: TIENDA.analytics?.ga4MeasurementId, catalogo: CATALOGO });",
    abrirProducto: "if (indiceEdicion < 0) analitica('verProducto', p);",
    agregarAlCarrito: "analitica('cambioEnCarrito', anterior, linea);",
    quitarLinea: "analitica('cambioEnCarrito', quitada, null);",
    abrirCarrito: "analitica('verCarrito', CARRITO);",
    irAlCheckout: "analitica('iniciarCheckout', CARRITO);",
    pasoAdelante: "if (PASOS[paso] === 'pago') analitica('elegirPago', CARRITO, CK.metodoPago);",
    confirmarPedido: "analitica('pedidoCreado', r);",
  };
  for (const [fn, linea] of Object.entries(esperado)) {
    assert.ok(funcion(fn).includes(linea), `${fn} no tiene: ${linea}`);
  }
  assert.ok(funcion('pasoAdelante').includes("if (PASOS[paso] === 'modalidad') analitica('elegirEntrega', CARRITO, CK.modalidad);"));
  // La analítica nunca recibe el objeto CK entero (trae nombre, teléfono, dirección).
  assert.ok(!/analitica\([^)]*\bCK\)/.test(TIENDA_JS) && !/analitica\([^)]*\bCK,/.test(TIENDA_JS), 'se le pasó CK completo a la analítica');
  // purchase se reporta DESPUÉS de que el servidor aceptó el pedido.
  const confirmar = funcion('confirmarPedido');
  assert.ok(confirmar.indexOf("await api(API + '/checkout'") < confirmar.indexOf("analitica('pedidoCreado', r);"));
});

await t('A20. el panel engancha el editor en Tienda → Analítica; el editor es una IIFE', () => {
  assert.ok(PANEL.includes(`data-sec="analitica"   data-modulo="tienda_online" onclick="tndIr('analitica')">Analítica</button>`));
  assert.ok(PANEL.includes('<div id="tnd-sec-analitica"   class="tnd-sec" style="display:none;"></div>'));
  assert.ok(PANEL.includes('     analitica: () => window.XaborGa4Tienda?.abrir(el),\n     banner: () => window.XaborBannerTienda?.abrir(el) })[sec]?.();'));
  const src = EDITOR.toString('utf8').replace(/\r\n/g, '\n');
  const cuerpo = src.replace(/^(\/\/[^\n]*\n)+/, '');
  assert.ok(cuerpo.startsWith('(function () {') && cuerpo.trimEnd().endsWith('})();'));
  assert.deepStrictEqual([...src.matchAll(/window\.([A-Za-z_$][\w$]*)\s*=/g)].map(m => m[1]), ['XaborGa4Tienda']);
  assert.ok(!/\sonclick=/.test(src));
  assert.ok(!/function XaborGa4Tienda|const XaborGa4Tienda|let XaborGa4Tienda/.test(PANEL));
});

await t('A21. rutas: ID en la API pública, endpoint por token y edición solo de administradores', () => {
  assert.ok(RUTAS.includes('analytics: { ga4MeasurementId: await obtenerGa4Id(tienda.negocioId) },'));
  assert.ok(RUTAS.includes("app.get('/api/tienda/seguimiento/:token/analytics', limitePublico,"));
  assert.ok(RUTAS.includes("app.post('/api/tienda/seguimiento/:token/analytics/compra', limiteCheckout,"));
  assert.ok(RUTAS.includes("app.get('/api/admin/tienda/analytics', ...gate, soloAdmin,"));
  assert.ok(RUTAS.includes("app.put('/api/admin/tienda/analytics', ...gate, soloAdmin,"));
  assert.ok(SERVER.includes("if ('ga4_measurement_id' in cambios) {"), 'PUT /api/config no valida el ID');
});

// ══ B) La tienda real en Chromium, contra un servidor falso ═════════════════
if (process.env.SOLO_PURAS === '1') {
  console.log('\n(SOLO_PURAS=1: se omiten las partes B y C)');
} else {
  const puppeteer = (await import('puppeteer')).default;
  const PUERTO_FALSO = Number(process.env.TEST_PORT_GA4_FALSO || 4762);
  const BASE = `http://localhost:${PUERTO_FALSO}`;
  const GA = { demo: 'G-PRUEBA123', singa: null };

  // Catálogo con altura real: la tercera categoría queda fuera de pantalla.
  const relleno = 'Descripción larga para que la tarjeta tenga altura de verdad y el menú se tenga que recorrer.';
  const CAT_FALSO = [
    { id: 1, nombre: 'Desayunos', productos: [
      { id: 11, nombre: 'Chilaquiles', precio: 95, descripcion: relleno, imagen: null, badge: null, destacado: false, agotado: false,
        grupos: [
          { id: 5, nombre: 'Tamaño', requerido: true, min: 1, max: 1, opciones: [{ id: 51, nombre: 'Grande', precioExtra: 20 }, { id: 52, nombre: 'Chico', precioExtra: 0 }] },
          { id: 6, nombre: 'Extras', requerido: false, min: 0, max: 3, opciones: [{ id: 61, nombre: 'Sin cebolla', precioExtra: 0 }, { id: 62, nombre: 'Queso extra', precioExtra: 15 }] },
        ] },
      ...Array.from({ length: 7 }, (_, i) => ({ id: 13 + i, nombre: `Plato ${i + 1}`, precio: 70 + i, descripcion: relleno, grupos: [] })),
    ] },
    { id: 2, nombre: 'Bebidas', productos: [
      { id: 21, nombre: 'Café de olla', precio: 35, descripcion: relleno, grupos: [] },
      ...Array.from({ length: 7 }, (_, i) => ({ id: 22 + i, nombre: `Bebida ${i + 1}`, precio: 30 + i, descripcion: relleno, grupos: [] })),
    ] },
    { id: 3, nombre: 'Postres', productos: Array.from({ length: 6 }, (_, i) => ({ id: 31 + i, nombre: `Postre ${i + 1}`, precio: 50 + i, descripcion: relleno, grupos: [] })) },
  ];
  const PRODUCTOS = new Map(CAT_FALSO.flatMap(c => c.productos.map(p => [p.id, { ...p, categoria_id: c.id }])));

  const PEDIDOS = new Map();     // token -> pedido falso
  const CHECKOUTS = [];          // cuerpos recibidos por POST /checkout
  const LLAMADAS = [];           // rutas /api pedidas, para saber qué consultó la tienda
  let folioN = 9000;

  // Recalcula renglones como el servidor real (precio con extras desde el
  // catálogo, jamás del navegador) y arma el pedido en la forma de datos.
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
    slug, ordenesPorPersona: false, negocio: `Tienda ${slug}`, descripcion: 'Prueba GA4', logo: null, portada: null,
    color: '#7c2d12', bienvenida: null, apertura: { abierto: true, cierraA: '23:59' }, modalidades: ['recoger', 'domicilio'],
    aceptaProgramados: false, anticipacionMinutos: 30, timezone: 'America/Matamoros', limiteDiasProgramado: 7, horarios: {},
    entrega: { costoBase: 30, pedidoMinimo: 0, entregaGratisDesde: 0, zonas: [], tiempo: '30-45 min' },
    preparacionMinutos: 20, cuentas: false, banner: [], diseno: { tema: 'clasico' },
    analytics: { ga4MeasurementId: GA[slug] ?? null },
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
    if (ruta.match(/^\/seguimiento\/[a-f0-9]{48}$/)) return archivo('panel/tienda-seguimiento.html', 'text/html; charset=utf-8');
    if (ruta === '/tienda-analytics.js' || ruta === '/ordenes-persona.js') return archivo('panel' + ruta, 'application/javascript');
    if (ruta === '/pasarela') {   // la pasarela regresa al seguimiento, como Clip
      res.writeHead(302, { Location: `/seguimiento/${url.searchParams.get('tk')}?retorno=pago` });
      return res.end();
    }
    if ((m = ruta.match(/^\/api\/tienda\/seguimiento\/([a-f0-9]{48})(\/pago|\/analytics|\/analytics\/compra)?$/))) {
      const p = PEDIDOS.get(m[1]);
      if (!p) return json(404, { error: 'Pedido no encontrado' });
      const ga4MeasurementId = GA[p.slug];
      if (m[2] === '/analytics') return json(200, { ga4MeasurementId, pendiente: !p.confirmado });
      if (m[2] === '/analytics/compra' && req.method === 'POST') {
        // Mismo contrato que entregarCompraGa4 (la garantía real se prueba
        // contra el servidor de verdad en la parte C).
        if (!ga4MeasurementId) return json(200, { ga4MeasurementId: null, compra: null, pendiente: !p.confirmado, motivo: 'sin_ga4' });
        if (!p.confirmado) return json(200, { ga4MeasurementId, compra: null, pendiente: true, motivo: 'pendiente_pago' });
        if (p.entregada) return json(200, { ga4MeasurementId, compra: null, pendiente: false, motivo: 'ya_entregada' });
        p.entregada = true;
        return json(200, { ga4MeasurementId, pendiente: false, compra: compraGa4DePedido({ folio: p.folio, estado: 'nuevo',
          datos: p.datos, categorias: new Map(CAT_FALSO.map(c => [c.id, c.nombre])) }) });
      }
      if (m[2] === '/pago' && req.method === 'POST') {
        return json(200, p.confirmado ? { estado: 'no_requiere_pago', url: null, folio: p.folio }
          : { estado: 'pendiente_pago', folio: p.folio, url: `/pasarela?tk=${m[1]}` });
      }
      if (m[2] === '/pago') {
        return json(200, { folio: p.folio, pedidoEstado: p.confirmado ? 'nuevo' : 'pendiente_pago',
          esperandoPago: !p.confirmado, pagoEstado: p.confirmado ? 'pagado' : null });
      }
      return json(200, { folio: p.folio, negocio: `Tienda ${p.slug}`, logo: null, color: null, cancelado: false,
        modalidad: p.datos.modalidad, etapaActual: 'recibido', total: p.datos.total, programadoPara: null,
        etapas: etapas.map((e, i) => ({ clave: e, etiqueta: e, cumplida: i === 0, actual: i === 0 })),
        items: p.datos.items.map(i => ({ nombre: i.nombre, cantidad: i.cantidad })) });
    }
    if ((m = ruta.match(/^\/api\/tienda\/([a-z]+)(\/[a-z]+)?$/))) {
      const [, slug, sub] = m;
      if (!(slug in GA)) return json(404, { error: 'Tienda no encontrada' });
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

  let navegador;
  try {
    navegador = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });

    // Una pestaña en un contexto (navegador) propio. Todo lo que la página
    // empuja a dataLayer se copia aquí, sobreviviendo a cada navegación; las
    // peticiones a Google se contestan con un gtag.js vacío y se cuentan.
    // El espía NO crea dataLayer: solo envuelve el que cree la página, así
    // que "sin ID no existe dataLayer" se puede comprobar.
    async function pestanaReal(contexto, { bloquear = [] } = {}) {
      const pagina = await contexto.newPage();
      await pagina.setViewport({ width: 390, height: 760 });
      const registro = { eventos: [], google: [], errores: [] };
      await pagina.exposeFunction('__ga', s => { try { registro.eventos.push(JSON.parse(s)); } catch { /* */ } });
      await pagina.evaluateOnNewDocument(() => {
        let dl;
        Object.defineProperty(window, 'dataLayer', {
          configurable: true,
          get() { return dl; },
          set(v) {
            dl = v;
            const push = v.push.bind(v);
            v.push = function (...xs) {
              for (const x of xs) { try { window.__ga(JSON.stringify({ pagina: location.pathname.split('/')[1], args: Array.from(x) })); } catch (e) { /* */ } }
              return push(...xs);
            };
          },
        });
      });
      await pagina.setRequestInterception(true);
      pagina.on('request', r => {
        const u = r.url();
        if (bloquear.some(b => u.includes(b))) return r.abort();
        if (u.startsWith('https://www.googletagmanager.com/')) {
          registro.google.push(u);
          return r.respond({ status: 200, contentType: 'application/javascript', body: '/* gtag.js de prueba */' });
        }
        if (!u.startsWith(BASE)) return r.abort();
        r.continue();
      });
      pagina.on('pageerror', e => registro.errores.push(e.message));
      return { pagina, registro };
    }
    const ir = async (pagina, ruta) => {
      await pagina.goto(BASE + ruta, { waitUntil: 'domcontentloaded' });
    };
    const clic = async (pagina, selector) => {
      await pagina.waitForFunction(s => { const el = document.querySelector(s); return el && !el.disabled; }, { timeout: 8000 }, selector);
      await pagina.$eval(selector, el => el.click());
    };
    const escribirEn = (pagina, selector, valor) => pagina.$eval(selector, (el, v) => { el.value = v; }, valor);
    const hojaAbierta = (pagina, id) => pagina.waitForFunction(i => document.getElementById(i)?.classList.contains('on'), { timeout: 8000 }, id);
    const eventos = (registro, nombre) => registro.eventos.filter(e => e.args[0] === 'event' && (!nombre || e.args[1] === nombre));
    const hasta = async (fn, ms = 9000) => { const fin = Date.now() + ms; while (Date.now() < fin) { if (await fn()) return true; await esperar(100); } return false; };
    // Navegaciones que dispara la propia página: se espera por la URL, sin
    // evaluar nada en un documento que se está yendo.
    const llegarA = async (pagina, fragmento, ms = 10000) => {
      assert.ok(await hasta(() => pagina.url().includes(fragmento), ms), `no llegó a ${fragmento}: ${pagina.url()}`);
      await pagina.waitForSelector('.folio', { timeout: ms });
    };
    // Recorre la página en pasos (como un dedo), de arriba abajo y de vuelta.
    const recorrer = pagina => pagina.evaluate(async () => {
      const pausa = ms => new Promise(r => setTimeout(r, ms));
      for (let y = 0; y <= document.body.scrollHeight; y += 250) { window.scrollTo(0, y); await pausa(90); }
      for (let y = document.body.scrollHeight; y >= 0; y -= 250) { window.scrollTo(0, y); await pausa(90); }
    });

    async function comprar(pagina, { modalidad, metodo }) {
      await clic(pagina, 'button.prod[onclick="abrirProducto(21)"]');
      await hojaAbierta(pagina, 'hoja-prod');
      await clic(pagina, '#btn-agregar');
      await clic(pagina, '#btn-carrito');
      await hojaAbierta(pagina, 'hoja-carrito');
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

    // ── B1–B6: pago al recibir, recorrido completo ──
    const ctx1 = await navegador.createBrowserContext();
    const { pagina: p1, registro: r1 } = await pestanaReal(ctx1);
    await ir(p1, '/t/demo?ga4_debug=1');
    await p1.waitForSelector('.cat-sec');

    await t('B1. la tienda con ID carga gtag.js de su ID con linker y modo depuración', async () => {
      assert.ok(await hasta(() => r1.google.length > 0), 'no pidió gtag.js');
      assert.deepStrictEqual(r1.google, ['https://www.googletagmanager.com/gtag/js?id=G-PRUEBA123']);
      const cfg = r1.eventos.find(e => e.args[0] === 'config');
      assert.deepStrictEqual(cfg.args, ['config', 'G-PRUEBA123', { linker: { domains: ['mapolato.com', 'xabor.mx'] }, debug_mode: true }]);
    });

    await t('B2. view_item_list por categoría cuando entra en pantalla, una sola vez', async () => {
      assert.ok(await hasta(() => eventos(r1, 'view_item_list').length >= 1));
      await esperar(300);
      const alInicio = eventos(r1, 'view_item_list').map(e => e.args[2].item_list_id);
      assert.ok(alInicio.includes('cat-1') && !alInicio.includes('cat-3'), `al inicio: ${alInicio}`);
      for (let i = 0; i < 2; i++) await recorrer(p1);
      await esperar(300);
      const ids = eventos(r1, 'view_item_list').map(e => e.args[2].item_list_id);
      assert.deepStrictEqual([...ids].sort(), ['cat-1', 'cat-2', 'cat-3']);
      const desayunos = eventos(r1, 'view_item_list').find(e => e.args[2].item_list_id === 'cat-1').args[2];
      assert.strictEqual(desayunos.item_list_name, 'Desayunos');
      assert.strictEqual(desayunos.items.length, 8);
      assert.deepStrictEqual(desayunos.items[0], { item_id: '11', item_name: 'Chilaquiles', item_category: 'Desayunos',
        price: 95, quantity: 1, index: 0, item_list_id: 'cat-1', item_list_name: 'Desayunos' });
    });

    await t('B3. producto, carrito con opciones y notas, quitar, editar y ver carrito', async () => {
      await clic(p1, 'button.prod[onclick="abrirProducto(11)"]');
      await hojaAbierta(p1, 'hoja-prod');
      await clic(p1, '#prod-cuerpo input[name="g5"][value="51"]');
      await clic(p1, '#prod-cuerpo input[name="g6"][value="61"]');
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
      await clic(p1, '.linea-acc button[onclick="quitarLinea(1)"]');
      await clic(p1, '.linea-acc button[onclick="editarLinea(0)"]');
      await hojaAbierta(p1, 'hoja-prod');
      await clic(p1, '[onclick="cambiarCantidad(1)"]');
      await clic(p1, '#btn-agregar');
      await esperar(250);
      await clic(p1, '#btn-carrito');
      await hojaAbierta(p1, 'hoja-carrito');
      const ev = r1.eventos.filter(e => e.args[0] === 'event' && e.args[1] !== 'view_item_list')
        .map(e => [e.args[1], e.args[2].items.map(i => `${i.item_id}:${i.quantity}:${i.item_variant || ''}:${i.price}`).join('|')]);
      assert.deepStrictEqual(ev, [
        ['view_item', '11:1::95'],
        ['add_to_cart', '11:2:Grande, Sin cebolla:115'],
        ['view_item', '21:1::35'],
        ['add_to_cart', '21:1::35'],
        ['view_cart', '11:2:Grande, Sin cebolla:115|21:1::35'],
        ['remove_from_cart', '21:1::35'],
        ['add_to_cart', '11:1:Grande, Sin cebolla:115'],     // editar 2 → 3: solo la diferencia
        ['view_cart', '11:3:Grande, Sin cebolla:115'],
      ]);
      const add = eventos(r1, 'add_to_cart')[0].args[2];
      assert.deepStrictEqual(add, { currency: 'MXN', value: 230, items: [{ item_id: '11', item_name: 'Chilaquiles',
        item_category: 'Desayunos', item_variant: 'Grande, Sin cebolla', price: 115, quantity: 2 }] });
    });

    await t('B4. begin_checkout, add_shipping_info (domicilio) y add_payment_info (efectivo)', async () => {
      await clic(p1, '#btn-ir-checkout');
      await hojaAbierta(p1, 'hoja-checkout');
      await clic(p1, `button.opcion-grande[onclick="elegirModalidad('recoger')"]`);
      await clic(p1, `button.opcion-grande[onclick="elegirModalidad('domicilio')"]`);
      await clic(p1, '#ck-pie .btn');
      await p1.waitForSelector('#ck-nombre');
      await escribirEn(p1, '#ck-nombre', 'Juana Pérez');
      await escribirEn(p1, '#ck-tel', '878 123 4567');
      await escribirEn(p1, '#ck-dir', 'Calle Falsa 123, entre 1 y 2');
      await escribirEn(p1, '#ck-colonia', 'Colonia Prueba');
      await escribirEn(p1, '#ck-notas', 'Tocar el timbre azul');
      await clic(p1, '#ck-pie .btn');
      await clic(p1, `button.opcion-grande[onclick="elegirPago('enlace_pago')"]`);
      await clic(p1, `button.opcion-grande[onclick="elegirPago('efectivo')"]`);
      await clic(p1, '#ck-pie .btn');
      await p1.waitForSelector('#btn-confirmar');
      const pasos = eventos(r1).filter(e => ['begin_checkout', 'add_shipping_info', 'add_payment_info'].includes(e.args[1]));
      assert.deepStrictEqual(pasos.map(e => [e.args[1], e.args[2].shipping_tier || e.args[2].payment_type || '', e.args[2].value]), [
        ['begin_checkout', '', 345], ['add_shipping_info', 'Entrega a domicilio', 345], ['add_payment_info', 'Efectivo', 345]]);
    });

    await t('B5. purchase al confirmar (pago al recibir): una vez, con folio y montos del pedido', async () => {
      await clic(p1, '#btn-confirmar');
      await p1.waitForFunction(() => document.getElementById('ck-titulo')?.textContent === '¡Pedido recibido!', { timeout: 8000 });
      assert.ok(await hasta(() => eventos(r1, 'purchase').length > 0), 'no llegó el purchase');
      await esperar(500);
      const compras = eventos(r1, 'purchase');
      assert.strictEqual(compras.length, 1);
      assert.deepStrictEqual(compras[0].args[2], { transaction_id: 'XAB-9001', currency: 'MXN', value: 345, tax: 0, shipping: 30,
        items: [{ item_id: '11', item_name: 'Chilaquiles', item_category: 'Desayunos', item_variant: 'Grande, Sin cebolla', price: 115, quantity: 3 }] });
      // El checkout mandó exactamente lo de siempre: la analítica no tocó el carrito.
      const b = CHECKOUTS.at(-1);
      assert.deepStrictEqual(b.items, [{ productoId: 11, cantidad: 3, notas: 'Sin chile, llamar al 8781234567', persona: null,
        modificadores: [{ grupoId: 5, opcionId: 51 }, { grupoId: 6, opcionId: 61 }] }]);
      assert.deepStrictEqual([b.modalidad, b.metodoPago, b.cliente.nombre, b.direccion, b.colonia, b.notas],
        ['domicilio', 'efectivo', 'Juana Pérez', 'Calle Falsa 123, entre 1 y 2', 'Colonia Prueba', 'Tocar el timbre azul']);
    });

    await t('B6. recargar la confirmación, seguir el pedido y recargar el seguimiento no repite el purchase', async () => {
      await clic(p1, '#ck-pie .btn');                       // "Seguir mi pedido"
      await llegarA(p1, '/seguimiento/');
      assert.ok(await hasta(() => r1.eventos.some(e => e.pagina === 'seguimiento' && e.args[0] === 'config')));
      await p1.reload({ waitUntil: 'domcontentloaded' });
      await p1.waitForSelector('.folio');
      await esperar(1200);
      await p1.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await esperar(1200);
      assert.strictEqual(eventos(r1, 'purchase').length, 1);
      const cfgSeg = r1.eventos.filter(e => e.pagina === 'seguimiento' && e.args[0] === 'config');
      for (const c of cfgSeg) {
        assert.match(c.args[2].page_location, /\/seguimiento\/token$/);
        assert.ok(!JSON.stringify(c).match(/[a-f0-9]{48}/), 'el token viajó a Analytics');
      }
      assert.deepStrictEqual(r1.errores, []);
    });

    await t('B7. ningún dato personal viajó a Analytics en todo el recorrido', () => {
      assert.ok(r1.eventos.length > 10);
      sinPersonales(r1.eventos, 'recorrido de compra');
      assert.ok(!JSON.stringify(r1.eventos).match(/[a-f0-9]{48}/), 'el token de seguimiento viajó a Analytics');
    });
    await ctx1.close();

    // ── B8: pago en línea con regreso de la pasarela ──
    const ctx2 = await navegador.createBrowserContext();
    const { pagina: p2, registro: r2 } = await pestanaReal(ctx2);

    await t('B8. pago en línea: sin purchase al crear ni al volver; llega cuando el servidor ve el pago', async () => {
      await ir(p2, '/t/demo');
      await p2.waitForSelector('.cat-sec');
      await comprar(p2, { modalidad: 'recoger', metodo: 'enlace_pago' });
      await llegarA(p2, '/seguimiento/');
      const token = new URL(p2.url()).pathname.split('/')[2];
      assert.ok(PEDIDOS.get(token), 'no se encontró el pedido');
      assert.ok(await hasta(() => r2.eventos.some(e => e.pagina === 'seguimiento' && e.args[0] === 'config')));
      await esperar(1500);
      assert.strictEqual(eventos(r2, 'purchase').length, 0, 'purchase antes del pago');
      PEDIDOS.get(token).confirmado = true;                 // el webhook confirmó el dinero
      assert.ok(await hasta(() => eventos(r2, 'purchase').length > 0, 12000), 'no llegó el purchase tras el pago');
      const [compra] = eventos(r2, 'purchase');
      assert.strictEqual(compra.pagina, 'seguimiento');
      assert.deepStrictEqual(compra.args[2], { transaction_id: PEDIDOS.get(token).folio, currency: 'MXN', value: 35, tax: 0, shipping: 0,
        items: [{ item_id: '21', item_name: 'Café de olla', item_category: 'Bebidas', price: 35, quantity: 1 }] });
      await p2.reload({ waitUntil: 'domcontentloaded' });
      await p2.waitForSelector('.folio');
      await esperar(1500);
      assert.strictEqual(eventos(r2, 'purchase').length, 1, 'recargar el seguimiento repitió el purchase');
      sinPersonales(r2.eventos, 'pago en línea');
      assert.deepStrictEqual(r2.errores, []);

      // Otro dispositivo abre la liga de seguimiento (p. ej. desde WhatsApp):
      // carga GA4 para su page_view, pero ni manda ni reclama la compra.
      const ctx3 = await navegador.createBrowserContext();
      const { pagina: p3, registro: r3 } = await pestanaReal(ctx3);
      LLAMADAS.length = 0;
      await ir(p3, `/seguimiento/${token}`);
      await p3.waitForSelector('.folio');
      assert.ok(await hasta(() => r3.eventos.some(e => e.args[0] === 'config')), 'el otro dispositivo no cargó GA4');
      await esperar(1000);
      assert.strictEqual(eventos(r3, 'purchase').length, 0, 'otro dispositivo duplicó el purchase');
      assert.ok(!LLAMADAS.some(l => l.startsWith('POST') && l.endsWith('/analytics/compra')), `el otro dispositivo reclamó la compra: ${LLAMADAS}`);
      await ctx3.close();
    });
    await ctx2.close();

    // ── B9–B10: sin ID y con la analítica caída ──
    await t('B9. negocio sin ID: ni gtag.js, ni gtag, ni consultas de analítica; el pedido sale igual', async () => {
      const ctx = await navegador.createBrowserContext();
      const { pagina, registro } = await pestanaReal(ctx);
      LLAMADAS.length = 0;
      await ir(pagina, '/t/singa');
      await pagina.waitForSelector('.cat-sec');
      await comprar(pagina, { modalidad: 'recoger', metodo: 'efectivo' });
      await pagina.waitForFunction(() => document.getElementById('ck-titulo')?.textContent === '¡Pedido recibido!', { timeout: 8000 });
      await esperar(600);
      assert.deepStrictEqual(registro.google, []);
      assert.deepStrictEqual(registro.eventos, []);
      assert.strictEqual(await pagina.evaluate(() => typeof window.gtag + '/' + typeof window.dataLayer), 'undefined/undefined');
      // Ni el GET (…/analytics) ni el reclamo (…/analytics/compra).
      assert.ok(!LLAMADAS.some(l => l.includes('/analytics')), `consultó analítica: ${LLAMADAS}`);
      await clic(pagina, '#ck-pie .btn');                   // seguimiento de un negocio sin ID
      await llegarA(pagina, '/seguimiento/');
      await esperar(800);
      assert.deepStrictEqual(registro.google, []);
      assert.strictEqual(await pagina.evaluate(() => typeof window.gtag), 'undefined');
      assert.deepStrictEqual(registro.errores, []);
      await ctx.close();
    });

    await t('B10. si el módulo de analítica no carga (o Google está bloqueado), comprar funciona igual', async () => {
      for (const bloquear of [['/tienda-analytics.js'], ['googletagmanager.com']]) {
        const ctx = await navegador.createBrowserContext();
        const { pagina, registro } = await pestanaReal(ctx, { bloquear });
        const antes = CHECKOUTS.length;
        await ir(pagina, '/t/demo');
        await pagina.waitForSelector('.cat-sec');
        await comprar(pagina, { modalidad: 'domicilio', metodo: 'efectivo' });
        await pagina.waitForFunction(() => document.getElementById('ck-titulo')?.textContent === '¡Pedido recibido!', { timeout: 8000 });
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
    const PUERTO = process.env.TEST_PORT_GA4 || '4761';
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
      return { status: r.status, tipo, body: tipo.includes('json') ? await r.json() : await r.text() };
    };
    const sesion = (usuarioId, negocioId, rol) =>
      `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId, negocioId, rol }))}`;
    const guardado = async letra => (await pool.query(
      `SELECT valor FROM configuracion WHERE negocio_id = $1 AND clave = 'ga4_measurement_id'`, [NEG[letra].id])).rows[0]?.valor ?? null;

    async function alta(letra) {
      const id = randomUUID(), slug = `ga4-${letra}-${SUF}`;
      await pool.query(`INSERT INTO negocios (id, nombre, slug, activo) VALUES ($1,$2,$3,TRUE)`, [id, `GA4 ${letra} ${SUF}`, slug]);
      const usuarios = {};
      for (const rol of ['admin', 'staff']) {
        const { rows: [u] } = await pool.query(
          `INSERT INTO usuarios (negocio_id, nombre, email, activo) VALUES ($1,$2,$3,TRUE) RETURNING id`,
          [id, `${rol} ${letra}`, `${rol}-${letra}-${SUF}@ga4.local`]);
        await pool.query(`INSERT INTO usuario_negocios (usuario_id, negocio_id, rol, activo) VALUES ($1,$2,$3,TRUE)`, [u.id, id, rol]);
        usuarios[rol] = sesion(u.id, id, rol);
      }
      for (const m of ['tienda_online', 'menu']) {
        await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,'activo')`, [id, m]);
      }
      await pool.query(`INSERT INTO tienda_config (negocio_id, estado) VALUES ($1,'publicada')`, [id]);
      const { rows: [c] } = await pool.query(
        `INSERT INTO menu_categorias (negocio_id, nombre) VALUES ($1,'Desayunos GA4') RETURNING id`, [id]);
      const { rows: [p] } = await pool.query(
        `INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio) VALUES ($1,$2,'Chilaquiles GA4',95) RETURNING id`, [id, c.id]);
      await pool.query(`INSERT INTO tienda_productos (negocio_id, producto_id, publicado) VALUES ($1,$2,TRUE)`, [id, p.id]);
      NEG[letra] = { id, slug, ...usuarios, categoria: c.id, producto: p.id };
    }

    // Un pedido de tienda como lo deja el checkout: la fila de pedidos_activos
    // (con datos personales) y su vínculo en tienda_pedidos con el token.
    async function pedido(letra, estado) {
      const n = NEG[letra];
      const folio = `XAB-GA4${letra.toUpperCase()}${randomBytes(3).toString('hex')}`;
      const token = randomBytes(24).toString('hex');
      const ck = randomBytes(24).toString('hex');
      const datos = datosPedido({
        items: [{ ...datosPedido().items[0], producto_id: n.producto, categoria_id: n.categoria, nombre: 'Chilaquiles GA4' }],
        subtotal: 230, descuento: 23, costo_envio: 30, total: 237, canal: 'tienda_online',
        tienda: { checkout_token: ck, tracking_token: token, promociones: [{ codigo: 'BIENVENIDA10', descuento: 23 }] },
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

      await t('C1. un negocio sin ID: la API pública manda ga4MeasurementId null', async () => {
        const r = await pedir(`/api/tienda/${NEG.a.slug}`);
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.deepStrictEqual(r.body.analytics, { ga4MeasurementId: null });
      });

      await t('C2. un operador (staff) no puede ver ni cambiar el ID; sin sesión, 401', async () => {
        for (const [metodo, cuerpo] of [['GET'], ['PUT', { ga4MeasurementId: 'G-STAFF123' }]]) {
          const r = await pedir('/api/admin/tienda/analytics', { cookie: NEG.a.staff, metodo, cuerpo });
          assert.strictEqual(r.status, 403, `${metodo} -> ${r.status}`);
        }
        assert.strictEqual(await guardado('a'), null, 'el operador dejó algo escrito');
        assert.strictEqual((await pedir('/api/admin/tienda/analytics')).status, 401);
      });

      await t('C3. el admin no puede guardar un ID con otro formato (400 GA4_ID_INVALIDO)', async () => {
        for (const malo of ['UA-12345-1', 'G-', 'GTM-ABC123', 'G-ABC"><script>alert(1)</script>', 'G-' + 'A'.repeat(40), 123]) {
          const r = await pedir('/api/admin/tienda/analytics', { cookie: NEG.a.admin, metodo: 'PUT', cuerpo: { ga4MeasurementId: malo } });
          assert.strictEqual(r.status, 400, `${malo} -> ${r.status}`);
          assert.strictEqual(r.body.codigo, 'GA4_ID_INVALIDO');
        }
        assert.strictEqual(await guardado('a'), null);
      });

      await t('C4. el admin guarda el ID (normalizado) y solo su tienda lo publica', async () => {
        const r = await pedir('/api/admin/tienda/analytics', { cookie: NEG.a.admin, metodo: 'PUT', cuerpo: { ga4MeasurementId: ' g-abc123xyz ' } });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.strictEqual(r.body.ga4MeasurementId, 'G-ABC123XYZ');
        assert.strictEqual(await guardado('a'), 'G-ABC123XYZ');
        const admin = await pedir('/api/admin/tienda/analytics', { cookie: NEG.a.admin });
        assert.deepStrictEqual(admin.body, { ga4MeasurementId: 'G-ABC123XYZ', slug: NEG.a.slug });
        assert.deepStrictEqual((await pedir(`/api/tienda/${NEG.a.slug}`)).body.analytics, { ga4MeasurementId: 'G-ABC123XYZ' });
        assert.deepStrictEqual((await pedir(`/api/tienda/${NEG.b.slug}`)).body.analytics, { ga4MeasurementId: null });
      });

      await t('C5. una fila escrita a mano con basura no llega a la tienda', async () => {
        await pool.query(`INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,'ga4_measurement_id',$2)`,
          [NEG.b.id, 'G-ABC"><script>alert(1)</script>']);
        assert.deepStrictEqual((await pedir(`/api/tienda/${NEG.b.slug}`)).body.analytics, { ga4MeasurementId: null });
        assert.strictEqual((await pedir('/api/admin/tienda/analytics', { cookie: NEG.b.admin })).body.ga4MeasurementId, null);
      });

      await t('C6. PUT /api/config tampoco deja guardar un ID inválido', async () => {
        const malo = await pedir('/api/config', { cookie: NEG.b.admin, metodo: 'PUT', cuerpo: { ga4_measurement_id: 'UA-1-1' } });
        assert.strictEqual(malo.status, 400);
        assert.strictEqual(await guardado('b'), 'G-ABC"><script>alert(1)</script>', 'tocó la fila con un valor rechazado');
        const bueno = await pedir('/api/config', { cookie: NEG.b.admin, metodo: 'PUT', cuerpo: { ga4_measurement_id: 'g-bbb222' } });
        assert.strictEqual(bueno.status, 200, JSON.stringify(bueno.body));
        assert.strictEqual(await guardado('b'), 'G-BBB222');
        assert.deepStrictEqual((await pedir(`/api/tienda/${NEG.b.slug}`)).body.analytics, { ga4MeasurementId: 'G-BBB222' });
      });

      // La marca de entrega vive en tienda_pedidos.derivaciones.
      const entregada = async token => (await pool.query(
        `SELECT jsonb_exists(derivaciones, 'ga4_purchase') AS e FROM tienda_pedidos WHERE tracking_token = $1`, [token])).rows[0]?.e;
      const reclamar = token => pedir(`/api/tienda/seguimiento/${token}/analytics/compra`, { metodo: 'POST' });

      await t('C7. GET solo lee; POST entrega el purchase del pedido real una vez, y nunca si espera pago', async () => {
        for (const malo of ['z'.repeat(48), 'a'.repeat(48)]) {
          assert.strictEqual((await pedir(`/api/tienda/seguimiento/${malo}/analytics`)).status, 404);
          assert.strictEqual((await reclamar(malo)).status, 404);
        }
        const { folio, token } = await pedido('a', 'pendiente_pago');
        const ruta = `/api/tienda/seguimiento/${token}/analytics`;
        assert.deepStrictEqual((await pedir(ruta)).body, { ga4MeasurementId: 'G-ABC123XYZ', pendiente: true });
        assert.deepStrictEqual((await reclamar(token)).body,
          { ga4MeasurementId: 'G-ABC123XYZ', compra: null, pendiente: true, motivo: 'pendiente_pago' });
        assert.strictEqual(await entregada(token), false, 'un pedido pendiente de pago gastó la entrega');
        await pool.query(`UPDATE pedidos_activos SET estado = 'nuevo' WHERE folio = $1`, [folio]);   // el webhook confirmó
        // Leer, cuantas veces sea, no trae ni gasta la compra.
        for (let i = 0; i < 3; i++) assert.deepStrictEqual((await pedir(ruta)).body, { ga4MeasurementId: 'G-ABC123XYZ', pendiente: false });
        assert.strictEqual(await entregada(token), false, 'un GET gastó la entrega');
        const r = await reclamar(token);
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(r.body, { ga4MeasurementId: 'G-ABC123XYZ', pendiente: false, compra: {
          transaction_id: folio, currency: 'MXN', value: 207, tax: 0, shipping: 30, coupon: 'BIENVENIDA10',
          items: [{ item_id: String(NEG.a.producto), item_name: 'Chilaquiles GA4', item_category: 'Desayunos GA4',
            item_variant: 'Grande, Sin cebolla', price: 115, quantity: 2 }] } });
        sinPersonales(r.body, 'POST compra por token');
        assert.strictEqual(await entregada(token), true);
        assert.deepStrictEqual((await reclamar(token)).body,
          { ga4MeasurementId: 'G-ABC123XYZ', compra: null, pendiente: false, motivo: 'ya_entregada' });
        // Un pedido cancelado nunca entrega nada.
        const cancelado = await pedido('a', 'cancelado');
        assert.deepStrictEqual((await reclamar(cancelado.token)).body,
          { ga4MeasurementId: 'G-ABC123XYZ', compra: null, pendiente: false, motivo: 'sin_compra' });
        assert.strictEqual(await entregada(cancelado.token), false);
      });

      await t('C8. sin ID del negocio, no se arma, no se devuelve y no se gasta la compra', async () => {
        await pedir('/api/admin/tienda/analytics', { cookie: NEG.b.admin, metodo: 'PUT', cuerpo: { ga4MeasurementId: '' } });
        assert.strictEqual(await guardado('b'), null, 'vaciar el campo debe borrar la fila');
        const { token } = await pedido('b', 'nuevo');
        assert.deepStrictEqual((await pedir(`/api/tienda/seguimiento/${token}/analytics`)).body,
          { ga4MeasurementId: null, pendiente: false });
        assert.deepStrictEqual((await reclamar(token)).body,
          { ga4MeasurementId: null, compra: null, pendiente: false, motivo: 'sin_ga4' });
        assert.strictEqual(await entregada(token), false);
      });

      await t('C10. dos navegadores distintos con el mismo folio: solo uno manda purchase', async () => {
        // El peor caso: los DOS navegadores creen que el pedido es suyo (tienen
        // la marca de pendiente, que es por navegador) y reclaman a la vez.
        // Corre el módulo real del navegador contra el servidor real.
        const { folio, token } = await pedido('a', 'nuevo');
        const respuesta = { folio, trackingToken: token, metodoPago: { id: 'efectivo', pagaDespues: true } };
        const n1 = pestana({ servidor: base }), n2 = pestana({ servidor: base });
        for (const n of [n1, n2]) n.A.iniciarTienda({ measurementId: 'G-ABC123XYZ', catalogo: [] });
        await Promise.all([n1.A.pedidoCreado(respuesta), n2.A.pedidoCreado(respuesta)]);
        const compras = [...n1.eventos(), ...n2.eventos()].filter(e => e.nombre === 'purchase');
        assert.strictEqual(compras.length, 1, `mandaron purchase ${compras.length} navegadores`);
        assert.strictEqual(compras[0].p.transaction_id, folio);
        assert.ok(pidioCompra(n1) && pidioCompra(n2), 'los dos debían reclamar para que la prueba valga');
        // Ninguno de los dos se queda reintentando, y un tercero que llegue
        // después (con marca, desde su seguimiento) tampoco recibe nada.
        for (const n of [n1, n2]) assert.ok(![...n.navegador.local.keys()].some(k => k.startsWith('xabor_ga4_pendiente:')));
        const n3 = pestana({ url: `${base}/seguimiento/${token}`, servidor: base });
        n3.navegador.local.set(`xabor_ga4_pendiente:${token}`, String(Date.now()));
        await n3.A.seguimiento(token);
        assert.ok(pidioCompra(n3));
        assert.strictEqual(n3.eventos().filter(e => e.nombre === 'purchase').length, 0, 'un tercer navegador recibió la compra');
      });

      await t('C11. diez reclamos simultáneos del mismo folio: exactamente uno recibe la compra', async () => {
        const { folio, token } = await pedido('a', 'nuevo');
        const rs = await Promise.all(Array.from({ length: 10 }, () => reclamar(token)));
        assert.ok(rs.every(r => r.status === 200), rs.map(r => r.status).join(','));
        const conCompra = rs.filter(r => r.body.compra);
        assert.strictEqual(conCompra.length, 1, `${conCompra.length} reclamos recibieron la compra`);
        assert.strictEqual(conCompra[0].body.compra.transaction_id, folio);
        assert.strictEqual(rs.filter(r => r.body.motivo === 'ya_entregada').length, 9);
      });

      await t('C9. el servidor sirve la tienda con el módulo y el módulo como JavaScript público', async () => {
        const pagina = await pedir(`/t/${NEG.a.slug}`);
        assert.strictEqual(pagina.status, 200);
        assert.match(pagina.body, /<script src="\/tienda-analytics\.js\?v=[0-9a-f]{8}"><\/script>/);
        const modulo = await pedir('/tienda-analytics.js');
        assert.strictEqual(modulo.status, 200);
        assert.match(modulo.tipo, /javascript/);
        assert.ok(modulo.body.includes('window.XaborAnalytics'));
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
