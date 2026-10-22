// ─── Promoción estimada en el carrito del POS + aviso de doble descuento ─────
//
// Desde el 22-oct-2026 el mostrador aplica solo las promociones al CREAR el
// pedido (promocionesMostrador.js), pero el carrito seguía mostrando el precio
// completo: quien atiende le decía al cliente un total que no era el que iba a
// pagar. Ahora el carrito pregunta al servidor —POST
// /api/pos/promociones/previsualizar, mismo motor y mismos argumentos que el
// alta— y pinta la promoción, el total y «agrega 1 más y aplica el 2x1». Y en
// Cobrar, un descuento manual sobre un pedido que ya trae promoción pide
// confirmación (la costumbre de escribir el 2x1 a mano lo duplicaría).
//
//   U — panel/promoCarrito.js en aislado: espera, descarta lo viejo, falla callado.
//   S — el endpoint: mismo resultado que el alta, solo lectura, validación.
//   P — el panel carga el módulo con su huella y engancha carrito y Cobrar.
//   B — el panel real en un navegador: carrito, envíos, falla y Cobrar.
//
// Uso: mismas env vars que la batería (DATABASE_URL, PANEL_SECRET, …).
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import vm from 'vm';
import assert from 'assert';
import puppeteer from 'puppeteer';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT_PROMO_CARRITO || '4734';
const FUENTE_MODULO = readFileSync(join(__dirname, '..', 'panel', 'promoCarrito.js'));
const PANEL = readFileSync(join(__dirname, '..', 'panel', 'index.html'), 'utf8');

const { crearTokenSesion } = await import('../src/services/session.js');
const { pool } = await import('../src/services/database.js');
const { BANDERA_PROMOS_MOSTRADOR } = await import('../src/services/promocionesMostrador.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}
const esperar = (ms) => new Promise(r => setTimeout(r, ms));
const NEG_A = SEED.negocioA;
const tokenDe = (usuarioId, rol) => crearTokenSesion({ usuarioId, negocioId: NEG_A, rol });
const ADMIN_A = `xabor_sesion=${encodeURIComponent(tokenDe(SEED.adminNegocioAUsuarioId, 'admin'))}`;
const STAFF_A = `xabor_sesion=${encodeURIComponent(tokenDe(SEED.staffNegocioAUsuarioId, 'staff'))}`;

// ════════════════════════════════════════════════════════════════════════════
// U — El módulo del panel, sin navegador
// ════════════════════════════════════════════════════════════════════════════
function cargarModulo() {
  const ctx = { setTimeout, clearTimeout, AbortController, console };
  vm.createContext(ctx);
  new vm.Script(FUENTE_MODULO.toString('utf8'), { filename: 'promoCarrito.js' }).runInContext(ctx);
  return ctx.XaborPromoCarrito;
}
const PROMO = cargarModulo();
const carrito = (n) => ({ modalidad: 'llevar', items: [{ producto_id: 1, cantidad: n }] });

await t('U', '1. muchas consultas del mismo carrito = UNA petición; el resultado se recuerda', async () => {
  let pedidas = 0; const pintados = [];
  const m = PROMO.crear({ esperaMs: 5, limiteMs: 200, pedir: async () => { pedidas++; return { ok: true, descuento: 10 }; } });
  for (let i = 0; i < 5; i++) assert.strictEqual(m.consultar(carrito(2), r => pintados.push(r)), null);
  await esperar(60);
  assert.strictEqual(pedidas, 1);
  assert.strictEqual(pintados.length, 1);
  assert.strictEqual(m.ultimo(carrito(2)).descuento, 10);
  assert.strictEqual(m.consultar(carrito(2), () => pintados.push('otra')).descuento, 10, 'el mismo carrito no vuelve a preguntar');
  assert.strictEqual(pedidas, 1);
  assert.strictEqual(m.ultimo(carrito(3)), null, 'el resultado es de ESE carrito, no de otro');
});

await t('U', '2. si el carrito cambia mientras se pregunta, la respuesta vieja no se pinta', async () => {
  const pintados = [];
  const m = PROMO.crear({ esperaMs: 5, limiteMs: 500, pedir: async (p) => {
    await esperar(p.items[0].cantidad === 2 ? 80 : 5);
    return { ok: true, descuento: p.items[0].cantidad };
  } });
  m.consultar(carrito(2), r => pintados.push(r.descuento));
  await esperar(20);               // la del 2 ya está en vuelo
  m.consultar(carrito(3), r => pintados.push(r.descuento));
  await esperar(150);
  assert.deepStrictEqual(pintados, [3]);
  assert.strictEqual(m.ultimo(carrito(2)), null);
  assert.strictEqual(m.ultimo(carrito(3)).descuento, 3);
});

await t('U', '3. si falla, no hay vista previa y el mismo carrito no reintenta en bucle', async () => {
  let pedidas = 0; const pintados = [];
  const m = PROMO.crear({ esperaMs: 5, limiteMs: 200, pedir: async () => { pedidas++; throw new Error('caído'); } });
  m.consultar(carrito(2), r => pintados.push(r));
  await esperar(40);
  assert.deepStrictEqual(pintados, [null]);
  assert.strictEqual(m.ultimo(carrito(2)), null);
  m.consultar(carrito(2), r => pintados.push(r));
  await esperar(40);
  assert.strictEqual(pedidas, 1);
});

await t('U', '4. si tarda más que el límite, se descarta aunque llegue después', async () => {
  const pintados = [];
  let abortada = false;
  const m = PROMO.crear({ esperaMs: 5, limiteMs: 30, pedir: async (p, signal) => {
    signal?.addEventListener('abort', () => { abortada = true; });
    await esperar(120);
    return { ok: true, descuento: 99 };
  } });
  m.consultar(carrito(2), r => pintados.push(r));
  await esperar(200);
  assert.deepStrictEqual(pintados, [null]);
  assert.ok(abortada, 'la petición tardía se cancela');
  assert.strictEqual(m.ultimo(carrito(2)), null);
});

await t('U', '6. repintar el MISMO carrito con la petición en vuelo no la reinicia', async () => {
  let pedidas = 0; let abortadas = 0; const pintados = [];
  const m = PROMO.crear({ esperaMs: 5, limiteMs: 500, pedir: async (p, signal) => {
    pedidas++;
    signal?.addEventListener('abort', () => { abortadas++; });
    await esperar(60);
    return { ok: true, descuento: 7 };
  } });
  m.consultar(carrito(2), r => pintados.push(r.descuento));
  await esperar(20);                // ya en vuelo
  for (let i = 0; i < 3; i++) m.consultar(carrito(2), r => pintados.push(r.descuento));
  await esperar(150);
  assert.strictEqual(pedidas, 1);
  assert.strictEqual(abortadas, 0, 'el repintado canceló la petición buena');
  assert.deepStrictEqual(pintados, [7]);
});

await t('U', '5. el aviso de oportunidad se arma con productos y promoción', async () => {
  assert.strictEqual(PROMO.textoOportunidad({ unidadesFaltantes: 1, nombre: 'Miercoles de Chilaquiles', productos: ['Chilaquiles Sencillos'] }),
    'Agrega 1 más de Chilaquiles Sencillos y aplica «Miercoles de Chilaquiles»');
  assert.strictEqual(PROMO.textoOportunidad({ unidadesFaltantes: 2, nombre: 'X' }), 'Agrega 2 más y aplica «X»');
  assert.strictEqual(PROMO.textoOportunidad({ unidadesFaltantes: 0, nombre: 'X' }), '');
  assert.strictEqual(PROMO.textoOportunidad(undefined), '');
});

// ════════════════════════════════════════════════════════════════════════════
// P — El panel carga el módulo y lo engancha
// ════════════════════════════════════════════════════════════════════════════
await t('P', '1. index.html carga promoCarrito.js con la huella de su contenido', async () => {
  const huella = createHash('sha256').update(FUENTE_MODULO).digest('hex').slice(0, 8);
  const m = PANEL.match(/<script src="\/promoCarrito\.js\?v=([0-9a-f]{8})"><\/script>/);
  assert.ok(m, 'no se carga /promoCarrito.js');
  assert.strictEqual(m[1], huella, `el ?v= dice "${m[1]}" pero el módulo tiene huella "${huella}". ` +
    `Si acabas de editar promoCarrito.js, pon "${huella}" en el ?v= de index.html.`);
  assert.ok(PANEL.indexOf('/captura.js?v=') < PANEL.indexOf('/promoCarrito.js?v='), 'se carga después de captura.js');
});
await t('P', '2. cada función nueva existe UNA sola vez (en el panel la repetida gana la última)', async () => {
  for (const f of ['promoCarritoPOS', 'payloadPromoPOS', 'promoActualPOS', 'pintarPromoPOS']) {
    const n = (PANEL.match(new RegExp(`function ${f}\\(`, 'g')) || []).length;
    assert.strictEqual(n, 1, `${f} definida ${n} veces`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// Preparación con base y servidor
// ════════════════════════════════════════════════════════════════════════════
async function fijarModulo(modulo) {
  await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,'activo')
    ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = 'activo'`, [NEG_A, modulo]);
}
for (const m of ['pos', 'caja', 'menu', 'rewards']) await fijarModulo(m);
await pool.query(`DELETE FROM configuracion WHERE negocio_id = $1 AND clave = $2`, [NEG_A, BANDERA_PROMOS_MOSTRADOR]);

const sufijo = Date.now().toString(36);
const MARCA = `Promo carrito ${sufijo}`;
const PROD = {};
{
  const { rows: [cat] } = await pool.query(
    `INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,$2,TRUE,0) RETURNING id`, [NEG_A, MARCA]);
  for (const [clave, nombre, precio] of [
    ['chila', `Chila ${sufijo}`, 195], ['agua', `Agua ${sufijo}`, 25], ['prim', `Primera ${sufijo}`, 60],
  ]) {
    const { rows: [p] } = await pool.query(
      `INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio, disponible, agotado, orden)
       VALUES ($1,$2,$3,$4,TRUE,FALSE,1) RETURNING id`, [NEG_A, cat.id, nombre, precio]);
    PROD[clave] = { id: p.id, nombre };
  }
}

const srv = await arrancarServidor({ PORT: PUERTO, TZ: 'America/Matamoros' }, { timeoutMs: 90000 });
const BASE = srv.base;
const api = (ruta, opts = {}, ck = ADMIN_A) => fetch(BASE + ruta, {
  ...opts, headers: { 'Content-Type': 'application/json', Cookie: ck, ...(opts.headers || {}) },
});
const json = async (r) => { try { return await r.json(); } catch { return {}; } };
const PROMOS = [];
async function crearPromo(cuerpo) {
  const r = await api('/api/admin/tienda/promociones', { method: 'POST', body: JSON.stringify({
    tipo: '2x1', automatica: true, canales: ['pos'], cantidadRequerida: 2, cantidadBeneficiada: 1,
    activa: true, acumulable: true, ...cuerpo,
  }) });
  const d = await json(r);
  assert.strictEqual(r.status, 200, `crear promo: ${r.status} ${JSON.stringify(d)}`);
  PROMOS.push(d.id);
  return d.id;
}
const preview = async (cuerpo, ck = STAFF_A) => {
  const r = await api('/api/pos/promociones/previsualizar', { method: 'POST', body: JSON.stringify(cuerpo) }, ck);
  return { status: r.status, d: await json(r) };
};
const it = (p, cantidad = 1) => ({ producto_id: p.id, cantidad, modificadores: [] });
const NOMBRE_CHILA = `Miercoles de Chilaquiles ${sufijo}`;

let navegador;
try {
await crearPromo({ nombre: NOMBRE_CHILA, productos: [PROD.chila.id] });
await crearPromo({ nombre: `Primera compra ${sufijo}`, productos: [PROD.prim.id], soloPrimeraCompra: true });
await crearPromo({ nombre: `Envio gratis ${sufijo}`, tipo: 'envio_gratis', productos: [], minimoCompra: 400,
  modalidades: ['domicilio'], cantidadRequerida: null, cantidadBeneficiada: null });

// ─── S — el endpoint ────────────────────────────────────────────────────────
await t('S', '1. mostrador: 2 chilaquiles + agua → 2x1 de $195, total $220', async () => {
  const { status, d } = await preview({ modalidad: 'llevar', items: [it(PROD.chila, 2), it(PROD.agua)] });
  assert.strictEqual(status, 200, JSON.stringify(d));
  assert.strictEqual(d.subtotal, 415);
  assert.strictEqual(d.descuento, 195);
  assert.strictEqual(d.total, 220);
  assert.strictEqual(d.promociones[0].nombre, NOMBRE_CHILA);
  assert.deepStrictEqual(d.oportunidades, []);
});

await t('S', '2. con 3 chilaquiles avisa que falta 1, con el nombre del producto', async () => {
  const { d } = await preview({ modalidad: 'llevar', items: [it(PROD.chila, 3)] });
  assert.strictEqual(d.descuento, 195);
  assert.strictEqual(d.oportunidades.length, 1);
  assert.strictEqual(d.oportunidades[0].unidadesFaltantes, 1);
  assert.strictEqual(d.oportunidades[0].nombre, NOMBRE_CHILA);
  assert.deepStrictEqual(d.oportunidades[0].productos, [PROD.chila.nombre]);
});

await t('S', '3. un solo chilaquil: sin descuento, pero con el aviso', async () => {
  const { d } = await preview({ modalidad: 'llevar', items: [it(PROD.chila, 1)] });
  assert.strictEqual(d.descuento, 0);
  assert.strictEqual(d.total, 195);
  assert.strictEqual(d.oportunidades[0]?.unidadesFaltantes, 1);
});

await t('S', '4. lo que estima para mostrador es lo que el alta cobra (mismo total)', async () => {
  const items = [it(PROD.chila, 3), it(PROD.agua, 2)];
  const { d } = await preview({ modalidad: 'llevar', items });
  const r = await api('/api/pedido-presencial', { method: 'POST', body: JSON.stringify({ items, nombre: 'Paridad' }) }, STAFF_A);
  const alta = await json(r);
  assert.strictEqual(r.status, 200, JSON.stringify(alta));
  assert.strictEqual(Number(alta.pedido.total), d.total);
  assert.strictEqual(Number(alta.pedido.descuento), d.descuento);
});

await t('S', '5. lo que estima para «recoger» es lo que crea el POS de envíos', async () => {
  const items = [it(PROD.chila, 2), it(PROD.agua)];
  const { d } = await preview({ modalidad: 'recoger', items, telefono: '8781112233' });
  assert.strictEqual(d.descuento, 195);
  const r = await api('/api/pos/pedidos', { method: 'POST', body: JSON.stringify({
    tipo: 'recoger', cliente: { nombre: 'Paridad', telefono: '8781112233' }, items, formaPago: 'efectivo' }) }, STAFF_A);
  const alta = await json(r);
  assert.strictEqual(r.status, 200, JSON.stringify(alta));
  assert.strictEqual(Number(alta.pedido.total), d.total);
});

await t('S', '6. domicilio con envío gratis: el envío sale en $0, igual que al crear', async () => {
  const items = [it(PROD.chila, 2), it(PROD.agua)];
  const { d } = await preview({ modalidad: 'domicilio', items, telefono: '8781112244', costoEnvio: 40 });
  assert.strictEqual(d.envioGratis, true);
  assert.strictEqual(d.envio, 0);
  assert.strictEqual(d.total, 220);
  const r = await api('/api/pos/pedidos', { method: 'POST', body: JSON.stringify({
    tipo: 'domicilio', cliente: { nombre: 'Paridad', telefono: '8781112244' }, items, formaPago: 'efectivo',
    costoEnvio: 40, direccion: { calle: 'Hidalgo 1', colonia: 'Centro' } }) }, STAFF_A);
  const alta = await json(r);
  assert.strictEqual(r.status, 200, JSON.stringify(alta));
  assert.strictEqual(Number(alta.pedido.total), d.total);
});

await t('S', '7. primera compra: sin cliente no se estima; con cliente de Rewards nuevo sí', async () => {
  const sin = (await preview({ modalidad: 'llevar', items: [it(PROD.prim, 2)] })).d;
  assert.strictEqual(sin.descuento, 0);
  const con = (await preview({ modalidad: 'llevar', items: [it(PROD.prim, 2)], telefono: `5218780${Date.now() % 1000000}` })).d;
  assert.strictEqual(con.descuento, 60);
});

await t('S', '8. bandera del mostrador apagada: mostrador sin promo, envíos igual que siempre', async () => {
  await pool.query(`INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,$2,'false')
    ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = 'false'`, [NEG_A, BANDERA_PROMOS_MOSTRADOR]);
  try {
    assert.strictEqual((await preview({ modalidad: 'llevar', items: [it(PROD.chila, 2)] })).d.descuento, 0);
    assert.strictEqual((await preview({ modalidad: 'recoger', items: [it(PROD.chila, 2)] })).d.descuento, 195);
  } finally {
    await pool.query(`DELETE FROM configuracion WHERE negocio_id = $1 AND clave = $2`, [NEG_A, BANDERA_PROMOS_MOSTRADOR]);
  }
});

await t('S', '9. solo lectura: estimar no crea pedidos, folios ni usos de promoción', async () => {
  const contar = async () => (await pool.query(`SELECT
      (SELECT COUNT(*) FROM pedidos_activos WHERE negocio_id = $1)::int AS pedidos,
      (SELECT COUNT(*) FROM tienda_promocion_usos WHERE negocio_id = $1)::int AS usos`, [NEG_A])).rows[0];
  const antes = await contar();
  for (const modalidad of ['llevar', 'recoger', 'domicilio']) {
    await preview({ modalidad, items: [it(PROD.chila, 2), it(PROD.agua)], costoEnvio: 40 });
  }
  await esperar(300);
  assert.deepStrictEqual(await contar(), antes);
});

await t('S', '10. validación: modalidad inválida y producto ajeno son 400; carrito vacío es cero', async () => {
  const m = await preview({ modalidad: 'mesa', items: [it(PROD.chila, 2)] });
  assert.strictEqual(m.status, 400);
  assert.strictEqual(m.d.codigo, 'MODALIDAD_INVALIDA');
  const ajeno = await preview({ modalidad: 'recoger', items: [{ producto_id: 987654321, cantidad: 1 }] });
  assert.strictEqual(ajeno.status, 400);
  const vacio = await preview({ modalidad: 'llevar', items: [] });
  assert.strictEqual(vacio.status, 200);
  assert.strictEqual(vacio.d.total, 0);
  const sinSesion = await fetch(BASE + '/api/pos/promociones/previsualizar', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ modalidad: 'llevar', items: [] }) });
  assert.ok([401, 403].includes(sinSesion.status), `sin sesión respondió ${sinSesion.status}`);
});

// ─── B — el panel real en un navegador ─────────────────────────────────────
navegador = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const pagina = await navegador.newPage();
const erroresJS = [];
pagina.on('pageerror', e => erroresJS.push(e.message));
const dialogos = [];
let responderDialogo = true;
pagina.on('dialog', d => { dialogos.push(d.message()); (responderDialogo ? d.accept() : d.dismiss()).catch(() => {}); });
let cortarPreview = false;
let respuestaFalsa = null;
await pagina.setRequestInterception(true);
pagina.on('request', req => {
  const esPreview = req.url().includes('/api/pos/promociones/previsualizar');
  if (esPreview && cortarPreview) req.abort().catch(() => {});
  else if (esPreview && respuestaFalsa) req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(respuestaFalsa) }).catch(() => {});
  else req.continue().catch(() => {});
});
await pagina.setCookie({ name: 'xabor_sesion', value: encodeURIComponent(tokenDe(SEED.adminNegocioAUsuarioId, 'admin')), domain: 'localhost', path: '/' });
await pagina.goto(BASE + '/app', { waitUntil: 'networkidle0' });

const vista = () => pagina.evaluate(() => ({
  fila: document.getElementById('pos-promo-row').style.display,
  etiqueta: document.getElementById('pos-promo-label').textContent,
  monto: document.getElementById('pos-promo-monto').textContent,
  aviso: document.getElementById('pos-promo-oportunidad').style.display === 'none' ? '' : document.getElementById('pos-promo-oportunidad').textContent,
  total: document.getElementById('pos-total-monto').textContent,
  totalEtiqueta: document.getElementById('pos-total-label').textContent,
  subtotal: document.getElementById('pos-subtotal-row').style.display === 'none' ? null : document.getElementById('pos-subtotal-monto').textContent,
  barra: document.getElementById('mobile-cart-total')?.textContent,
}));
async function tocar(nombre) {
  await pagina.evaluate((n) => [...document.querySelectorAll('.pos-producto')].find(x => x.textContent.includes(n)).click(), nombre);
}
async function vaciar() {
  await pagina.evaluate(() => _cPOS.limpiar());
  await pagina.waitForFunction(() => posCarrito.length === 0, { timeout: 3000 });
}

await t('B', '1. mostrador: el carrito muestra el 2x1 y el total que se va a cobrar', async () => {
  await pagina.evaluate(() => nuevoPedidoModalidad('llevar'));
  await pagina.waitForFunction(() => document.querySelectorAll('.pos-producto').length > 0, { timeout: 10000 });
  await tocar(PROD.chila.nombre); await tocar(PROD.chila.nombre); await tocar(PROD.agua.nombre);
  await pagina.waitForFunction(() => document.getElementById('pos-promo-row').style.display === 'flex', { timeout: 5000 });
  const v = await vista();
  assert.strictEqual(v.etiqueta, `Promoción (${NOMBRE_CHILA})`);
  assert.strictEqual(v.monto, '-$195');
  assert.strictEqual(v.subtotal, '$415');
  assert.strictEqual(v.total, '$220');
  assert.strictEqual(v.totalEtiqueta, 'Total');
  assert.strictEqual(v.barra, '$220', 'la barra móvil dice otro total');
  assert.strictEqual(v.aviso, '');
});

await t('B', '2. con un tercer chilaquil avisa «agrega 1 más… y aplica»', async () => {
  await tocar(PROD.chila.nombre);
  await pagina.waitForFunction(() => document.getElementById('pos-promo-oportunidad').style.display !== 'none', { timeout: 5000 });
  const v = await vista();
  assert.strictEqual(v.aviso, `Agrega 1 más de ${PROD.chila.nombre} y aplica «${NOMBRE_CHILA}»`);
  assert.strictEqual(v.total, '$415');
});

await t('B', '3. sin la promoción el carrito vuelve a verse como antes', async () => {
  await vaciar();
  await tocar(PROD.agua.nombre);
  await esperar(900);
  const v = await vista();
  assert.strictEqual(v.fila, 'none');
  assert.strictEqual(v.total, '$25');
  assert.strictEqual(v.totalEtiqueta, 'Subtotal');
  assert.strictEqual(v.subtotal, null);
});

await t('B', '4. si la consulta falla, el carrito se ve como antes y no truena nada', async () => {
  await vaciar();
  cortarPreview = true;
  try {
    await tocar(PROD.chila.nombre); await tocar(PROD.chila.nombre);
    await esperar(1500);
    const v = await vista();
    assert.strictEqual(v.fila, 'none');
    assert.strictEqual(v.total, '$390');
  } finally { cortarPreview = false; }
});

await t('B', '4b. una estimación hecha sobre OTRO subtotal (menú cambió) no se pinta', async () => {
  await vaciar();
  respuestaFalsa = { ok: true, subtotal: 999, descuento: 100, total: 899, envio: 0, envioGratis: false,
    promociones: [{ id: 'x', nombre: 'Precio viejo', descuento: 100 }], oportunidades: [] };
  try {
    await tocar(PROD.chila.nombre); await tocar(PROD.chila.nombre); await tocar(PROD.agua.nombre);
    await esperar(1200);
    const v = await vista();
    assert.strictEqual(v.fila, 'none', 'pintó una promo calculada sobre otro carrito');
    assert.strictEqual(v.total, '$415');
  } finally { respuestaFalsa = null; }
});

await t('B', '5. Recoger (POS de envíos) usa la misma vista previa', async () => {
  await vaciar();
  await pagina.evaluate(() => nuevoPedidoModalidad('recoger'));
  await pagina.waitForFunction(() => document.querySelectorAll('.pos-producto').length > 0, { timeout: 10000 });
  await tocar(PROD.chila.nombre); await tocar(PROD.chila.nombre);
  await pagina.waitForFunction(() => document.getElementById('pos-promo-row').style.display === 'flex', { timeout: 5000 });
  const v = await vista();
  assert.strictEqual(v.monto, '-$195');
  assert.strictEqual(v.total, '$195');
  await vaciar();
  await pagina.evaluate(() => nuevoPedidoModalidad('llevar'));
});

await t('B', '5b. Domicilio con envío gratis: la promo incluye el envío y el total no lo suma', async () => {
  await vaciar();
  await pagina.evaluate(() => nuevoPedidoModalidad('domicilio'));
  await pagina.waitForFunction(() => document.querySelectorAll('.pos-producto').length > 0, { timeout: 10000 });
  await pagina.evaluate(() => { document.getElementById('env-costo-envio').value = '40'; renderCarrito(); });
  await tocar(PROD.chila.nombre); await tocar(PROD.chila.nombre); await tocar(PROD.agua.nombre);
  await pagina.waitForFunction(() => document.getElementById('pos-promo-row').style.display === 'flex', { timeout: 5000 });
  await esperar(300);
  const v = await vista();
  assert.strictEqual(v.monto, '-$235', 'el ahorro es 2x1 ($195) + envío ($40)');
  assert.strictEqual(v.total, '$220');
  assert.strictEqual(v.barra, '$220');
  await pagina.evaluate(() => { document.getElementById('env-costo-envio').value = '0'; });
  await vaciar();
  await pagina.evaluate(() => nuevoPedidoModalidad('llevar'));
});

await t('B', '6. Cobrar: un descuento manual sobre un pedido con promo pide confirmación', async () => {
  const r = await api('/api/pedido-presencial', { method: 'POST',
    body: JSON.stringify({ items: [it(PROD.chila, 2)], nombre: 'Doble descuento' }) });
  const alta = await json(r);
  assert.strictEqual(r.status, 200, JSON.stringify(alta));
  const folio = alta.pedido.id;
  const abrir = (desc) => pagina.evaluate((f, p, d) => {
    abrirCobro(f, p);
    cobroSelPago(document.querySelector('[data-cobro-pago="efectivo"]'));
    document.getElementById('cobro-desc-val').value = String(d);
    document.getElementById('cobro-desc-motivo').value = '2x1 a mano';
    cobroRender();
  }, folio, alta.pedido, desc);
  // Cancelar en el aviso: no sale el cobro.
  dialogos.length = 0; responderDialogo = false;
  await abrir(20);
  await pagina.evaluate(() => confirmarCobro());
  await esperar(500);
  assert.strictEqual(dialogos.length, 1, 'no preguntó');
  assert.ok(dialogos[0].includes(NOMBRE_CHILA) && dialogos[0].includes('-$195') && dialogos[0].includes('$20'), dialogos[0]);
  let f = (await pool.query(`SELECT datos FROM pedidos_activos WHERE folio = $1`, [folio])).rows[0].datos;
  assert.notStrictEqual(f.pago_confirmado, true, 'cobró aunque se canceló el aviso');
  // Aceptar: cobra con promo + manual.
  dialogos.length = 0; responderDialogo = true;
  await pagina.evaluate(() => confirmarCobro());
  await pagina.waitForFunction(() => !document.getElementById('modal-cobro').classList.contains('visible'), { timeout: 5000 });
  f = (await pool.query(`SELECT datos FROM pedidos_activos WHERE folio = $1`, [folio])).rows[0].datos;
  assert.strictEqual(f.pago_confirmado, true);
  assert.strictEqual(Number(f.total), 175);
  responderDialogo = true;
});

await t('B', '7. Cobrar sin descuento manual no pregunta nada', async () => {
  const r = await api('/api/pedido-presencial', { method: 'POST',
    body: JSON.stringify({ items: [it(PROD.chila, 2)], nombre: 'Sin manual' }) });
  const alta = await json(r);
  dialogos.length = 0;
  await pagina.evaluate((f, p) => {
    abrirCobro(f, p);
    cobroSelPago(document.querySelector('[data-cobro-pago="efectivo"]'));
    cobroRender();
    confirmarCobro();
  }, alta.pedido.id, alta.pedido);
  await pagina.waitForFunction(() => !document.getElementById('modal-cobro').classList.contains('visible'), { timeout: 5000 });
  // El ticket automático puede abrir su ventana; lo que no debe haber es un confirm de descuento.
  assert.ok(!dialogos.some(m => m.includes('descuento manual')), dialogos.join(' | '));
});

await t('B', '8. ningún error de JavaScript en toda la sesión', async () => {
  assert.deepStrictEqual(erroresJS, []);
});

} finally {
  if (navegador) await navegador.close().catch(() => {});
  srv.detener();
  await pool.query(`DELETE FROM configuracion WHERE negocio_id = $1 AND clave = $2`, [NEG_A, BANDERA_PROMOS_MOSTRADOR]).catch(() => {});
  if (PROMOS.length) {
    await pool.query(`DELETE FROM tienda_promocion_usos WHERE promocion_id = ANY($1)`, [PROMOS]).catch(() => {});
    await pool.query(`DELETE FROM tienda_promociones WHERE id = ANY($1)`, [PROMOS]).catch(() => {});
  }
  await pool.query(`UPDATE menu_productos SET disponible = FALSE WHERE negocio_id = $1 AND nombre LIKE $2`, [NEG_A, `%${sufijo}`]).catch(() => {});
  await pool.end().catch(() => {});
}

console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallos.length) { console.log(fallos.join('\n')); process.exit(1); }
process.exit(0);
