// Motor ÚNICO de captura (panel/captura.js) — garantías de la unificación.
//
// El panel tenía DOS capturas independientes que duplicaban casi todo:
// mostrador y envíos (recoger + domicilio). Dos catálogos leyendo el mismo
// /api/menu, dos carritos con estructuras distintas, dos agrupaciones, dos
// constructores de payload. Cada arreglo había que escribirlo dos veces y cada
// olvido se escondía en la copia — así vivió el bug de «domicilio no abre el
// configurador».
//
// Esta suite fija lo que la unificación tiene que cumplir, y sobre todo lo que
// NO puede romper. Dos partes:
//
//   PARTE 1 — el motor aislado, con la red bajo control: es la única forma de
//     provocar a voluntad una revalidación que falla o un menú que cambia a
//     mitad de captura.
//   PARTE 2 — la pantalla de verdad, con un navegador: es donde vivía el bug
//     y donde se comprueba que las dos modalidades comparten motor sin
//     compartir carrito.
//
// Fixtures propios y genéricos: nada depende del menú de un negocio concreto.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import vm from 'vm';
import puppeteer from 'puppeteer';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4766';

const { pool } = await import('../src/services/database.js');
const { crearTokenSesion } = await import('../src/services/session.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}
const fijarModulo = (negocioId, modulo, estado = 'activo') => pool.query(
  `INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,$3)
   ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = $3`, [negocioId, modulo, estado]);

const A = SEED.negocioA;
const MARCA = 'Cat captura unificada';

// ═══════════════════════════════════════════════════════════════════════════
//  PARTE 1 — EL MOTOR AISLADO
//  Se carga panel/captura.js en un sandbox con un /api/menu de mentira: así
//  se puede hacer fallar la red a voluntad, cosa imposible contra el servidor.
// ═══════════════════════════════════════════════════════════════════════════
const FUENTE_MOTOR = readFileSync(join(__dirname, '../panel/captura.js'), 'utf8');

// Menú de juguete: un producto normal y uno que se puede agotar a voluntad.
const menuDe = ({ precio = 100, agotado = false } = {}) => ([{
  id: 1, nombre: 'Categoría',
  productos: [
    { id: 10, nombre: 'Normal', precio, disponible: true, agotado, modificadores: [] },
    { id: 11, nombre: 'Otro', precio: 50, disponible: true, agotado: false, modificadores: [] },
  ],
}]);

// Un motor nuevo por prueba: el catálogo es estado de módulo y arrastrarlo
// entre casos escondería justo lo que se quiere medir.
function montarMotor() {
  const ctx = { console: { warn() {}, error() {} }, JSON, Object, Number, Math, String, Array, parseInt, parseFloat };
  ctx.window = ctx;
  vm.createContext(ctx);
  ctx.XaborModificadores = {
    firmaLinea: (l) => `${l.producto_id ?? l.nombre}|${(l.modificadores || []).map(Number).filter(Number.isFinite).sort((a, b) => a - b).join(',')}`,
    elegirLinea: async (p) => ({ producto_id: p.id, nombre: p.nombre, cantidad: 1, precio_unitario: Number(p.precio), modificadores: [], detalle: [], texto: '' }),
    tieneModificadores: () => false,
  };
  const red = { menu: menuDe(), fallar: false, llamadas: 0 };
  ctx.apiFetch = async () => {
    red.llamadas++;
    if (red.fallar) throw new Error('red caída');
    return { ok: true, json: async () => red.menu };
  };
  new vm.Script(FUENTE_MOTOR, { filename: 'captura.js' }).runInContext(ctx);
  return { motor: ctx.XaborCaptura, red };
}

await t('MOTOR', '1. una sola regla de vendibilidad: agotado no se vende por ninguna modalidad', async () => {
  const { motor } = montarMotor();
  assert.strictEqual(motor.vendible({ disponible: true, agotado: false }), true);
  assert.strictEqual(motor.vendible({ disponible: true, agotado: true }), false,
    'agotado es el interruptor de inventario: el servidor ya lo rechaza con PRODUCTO_NO_DISPONIBLE');
  assert.strictEqual(motor.vendible({ disponible: false, agotado: false }), false);
});

await t('MOTOR', '2. el catálogo conserva los modificadores al aplanarse', async () => {
  const { motor, red } = montarMotor();
  red.menu = [{ id: 1, nombre: 'C', productos: [{ id: 10, nombre: 'Con grupos', precio: 100, disponible: true,
    modificadores: [{ id: 5, nombre: 'Término', requerido: true, minimo: 1, maximo: 1, opciones: [{ id: 50, nombre: 'Suave', precio_extra: 0 }] }] }] }];
  await motor.catalogo.cargar();
  const p = motor.catalogo.producto(10);
  assert.deepStrictEqual((p.modificadores || []).map(g => g.nombre), ['Término'],
    'recortar los grupos aquí fue la raíz del bug de domicilio');
});

await t('MOTOR', '3. cache-first: la segunda carga responde sin volver a esperar a la red', async () => {
  const { motor, red } = montarMotor();
  await motor.catalogo.cargar();
  assert.strictEqual(red.llamadas, 1);
  const cats = await motor.catalogo.cargar();
  assert.ok(cats && cats.length, 'devuelve el catálogo que ya tenía, no una lista vacía');
  assert.strictEqual(cats[0].productos.length, 2);
});

await t('MOTOR', '4. una revalidación que FALLA conserva el catálogo anterior y no vacía nada', async () => {
  const { motor, red } = montarMotor();
  await motor.catalogo.cargar();
  const antes = JSON.stringify(motor.catalogo.categorias());
  red.fallar = true;
  const cats = await motor.catalogo.cargar();           // cache-first + revalidación que revienta
  await new Promise(r => setTimeout(r, 20));            // dejar terminar la revalidación de fondo
  assert.ok(cats && cats.length, 'la cuadrícula NUNCA se queda sin nada que pintar');
  assert.strictEqual(JSON.stringify(motor.catalogo.categorias()), antes,
    'se prefiere un menú de hace un minuto a una pantalla vacía en hora pico');
  assert.strictEqual(motor.catalogo.productos().length, 2);
});

await t('MOTOR', '5. onCambio se dispara SOLO si el catálogo efectivo cambió', async () => {
  const { motor, red } = montarMotor();
  let avisos = 0;
  motor.catalogo.onCambio(() => avisos++);
  await motor.catalogo.cargar();
  assert.strictEqual(avisos, 1, 'la primera carga sí avisa');

  red.menu = menuDe();                                   // mismo contenido, otro objeto
  await motor.catalogo.cargar({ refrescar: true });
  assert.strictEqual(avisos, 1, 'un menú idéntico no repinta: repintar de más pierde el estado de la pantalla');

  red.menu = menuDe({ precio: 130 });                    // cambio real
  await motor.catalogo.cargar({ refrescar: true });
  assert.strictEqual(avisos, 2, 'un cambio de precio sí tiene que verse');

  red.menu = menuDe({ agotado: true });                  // cambio de vendibilidad
  await motor.catalogo.cargar({ refrescar: true });
  assert.strictEqual(avisos, 3, 'agotar un producto sí tiene que verse');
});

await t('MOTOR', '6. si un producto se agota con el carrito a medias, lo capturado NO se altera', async () => {
  const { motor, red } = montarMotor();
  let repintados = 0;
  const carrito = new motor.Carrito({ onCambio: () => repintados++ });
  await motor.catalogo.cargar();
  await carrito.agregar(motor.catalogo.producto(10));
  await carrito.agregar(motor.catalogo.producto(10));
  assert.strictEqual(carrito.lineas.length, 1);
  assert.strictEqual(carrito.lineas[0].cantidad, 2);
  const antes = JSON.stringify(carrito.lineas);
  const repintadosAntes = repintados;

  red.menu = menuDe({ agotado: true });
  await motor.catalogo.cargar({ refrescar: true });

  assert.strictEqual(JSON.stringify(carrito.lineas), antes,
    'el pedido en curso es del operador: la revalidación no le quita ni le cambia líneas');
  assert.strictEqual(repintados, repintadosAntes, 'ni siquiera se toca el carrito para repintarlo');

  // Lo que sí: no dejar agregar más.
  const nueva = await carrito.agregar(motor.catalogo.producto(10));
  assert.strictEqual(nueva, null, 'se bloquean las adiciones nuevas');
  assert.strictEqual(carrito.lineas.length, 1, 'y el carrito sigue como estaba');
  assert.strictEqual(carrito.lineas[0].cantidad, 2);

  // Y el operador conserva el control de lo que ya capturó.
  carrito.cambiarCantidad(0, -1);
  assert.strictEqual(carrito.lineas[0].cantidad, 1, 'puede corregir la cantidad de lo ya capturado');
});

await t('MOTOR', '7. un producto que desaparece del menú tampoco toca el carrito en curso', async () => {
  const { motor, red } = montarMotor();
  const carrito = new motor.Carrito({});
  await motor.catalogo.cargar();
  await carrito.agregar(motor.catalogo.producto(10));
  red.menu = [{ id: 1, nombre: 'Categoría', productos: [] }];
  await motor.catalogo.cargar({ refrescar: true });
  assert.strictEqual(carrito.lineas.length, 1, 'lo capturado sobrevive aunque el menú ya no lo liste');
  assert.strictEqual(motor.catalogo.productos().length, 0);
});

await t('MOTOR', '8. cada modalidad tiene su carrito: un motor único no es un carrito compartido', async () => {
  const { motor } = montarMotor();
  await motor.catalogo.cargar();
  const mostrador = new motor.Carrito({});
  const envios = new motor.Carrito({});
  await mostrador.agregar(motor.catalogo.producto(10));
  assert.strictEqual(mostrador.lineas.length, 1);
  assert.strictEqual(envios.lineas.length, 0,
    'lo que se captura para llevar no puede aparecer en el domicilio que empieza después');
});

await t('MOTOR', '9. el payload es uno solo: ids elegidos y nota, nunca el precio del frontend', async () => {
  const { motor } = montarMotor();
  await motor.catalogo.cargar();
  const carrito = new motor.Carrito({});
  await carrito.agregar(motor.catalogo.producto(10));
  carrito.nota(0, 'sin cebolla');
  // Se compara el JSON, no los objetos: los que arma el motor nacen dentro
  // del sandbox y `deepStrictEqual` compararía además su prototipo, que es
  // el del otro realm. Lo que importa aquí es lo que viaja por la red.
  const comoViaja = (c) => JSON.parse(JSON.stringify(c.itemsParaServidor()));
  assert.deepStrictEqual(comoViaja(carrito), [
    { producto_id: 10, cantidad: 1, modificadores: [], notas: 'sin cebolla' },
  ], 'el precio lo pone el servidor contra el menú del propio negocio');
  // Item libre (lo que no está en el menú): conserva la ruta manual de
  // siempre, con nombre y precio, porque el servidor lo pasa tal cual.
  carrito.agregarLinea({ nombre: 'Algo fuera de menú', precio_unitario: 33, cantidad: 2 });
  assert.deepStrictEqual(comoViaja(carrito)[1],
    { nombre: 'Algo fuera de menú', cantidad: 2, precio_unitario: 33, notas: '' });
});

await t('MOTOR', '10. `lineas` se muta en el sitio: los nombres legados siguen apuntando al carrito real', async () => {
  const { motor } = montarMotor();
  await motor.catalogo.cargar();
  const carrito = new motor.Carrito({});
  const legado = carrito.lineas;               // como hacen posCarrito / ENV_CARRITO
  await carrito.agregar(motor.catalogo.producto(10));
  assert.strictEqual(legado.length, 1, 'el alias ve lo que se agrega');
  carrito.limpiar();
  assert.strictEqual(legado, carrito.lineas, 'limpiar NO reasigna el array');
  assert.strictEqual(legado.length, 0, 'y el alias ve el vaciado');
});

// ═══════════════════════════════════════════════════════════════════════════
//  PARTE 2 — LA PANTALLA DE VERDAD
//  El bug original no se veía en el backend: se veía al tocar un producto.
// ═══════════════════════════════════════════════════════════════════════════
async function crearCatalogo(negocioId) {
  const { rows: [cat] } = await pool.query(
    `INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,$2,TRUE,0) RETURNING id`,
    [negocioId, MARCA]);
  const prod = async (nombre, precio, extra = {}) => (await pool.query(
    `INSERT INTO menu_productos (negocio_id, categoria_id, codigo, nombre, descripcion, precio, disponible, agotado, orden)
     VALUES ($1,$2,$3,$4,'',$5,$6,$7,0) RETURNING id, nombre`,
    [negocioId, cat.id, 'U' + Math.floor(Math.random() * 1e9).toString(36), nombre, precio,
     extra.disponible !== false, extra.agotado === true])).rows[0];
  // Un producto CONFIGURABLE hace falta para comprobar que los modificadores
  // sobreviven al cambio de modalidad, no solo el número de líneas.
  const configurable = await prod('Unificada configurable', 120);
  const { rows: [gT] } = await pool.query(
    `INSERT INTO menu_modificadores_grupos (negocio_id, producto_id, nombre, requerido, minimo, maximo, orden)
     VALUES ($1,$2,'Término',TRUE,1,1,0) RETURNING id`, [negocioId, configurable.id]);
  await pool.query(
    `INSERT INTO menu_modificadores_opciones (negocio_id, grupo_id, nombre, precio_extra, disponible, orden)
     VALUES ($1,$2,'Suave',0,TRUE,0),($1,$2,'Cocido',0,TRUE,1)`, [negocioId, gT.id]);
  return {
    normal: await prod('Unificada normal', 90),
    agotado: await prod('Unificada agotado', 70, { agotado: true }),
    configurable,
  };
}

const limpiar = () => pool.query(`DELETE FROM menu_categorias WHERE nombre = $1 AND negocio_id = $2`, [MARCA, A]);

await limpiar();
for (const m of ['pos', 'menu']) await fijarModulo(A, m);
const fx = await crearCatalogo(A);

const srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 30000 });
const base = srv.base;
const token = crearTokenSesion({ usuarioId: SEED.adminNegocioAUsuarioId, negocioId: A, rol: 'admin' });

const navegador = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const pagina = await navegador.newPage();
const erroresJS = [];
pagina.on('pageerror', e => erroresJS.push(e.message));
pagina.on('dialog', d => d.accept().catch(() => {}));
await pagina.setCookie({ name: 'xabor_sesion', value: encodeURIComponent(token), domain: 'localhost', path: '/' });
await pagina.goto(base + '/app', { waitUntil: 'networkidle0' });

const textos = (sel) => pagina.evaluate(s => [...document.querySelectorAll(s)].map(b => b.textContent), sel);

await t('PANTALLA', '11. mostrador NO ofrece un producto agotado (antes sí, y el pedido moría en el servidor)', async () => {
  await pagina.evaluate(() => nuevoPedidoModalidad('llevar'));
  await pagina.waitForFunction(() => document.querySelectorAll('.pos-producto').length > 0, { timeout: 10000 });
  const vistos = await textos('.pos-producto');
  assert.ok(vistos.some(x => x.includes(fx.normal.nombre)), 'el disponible sí se ofrece');
  assert.ok(!vistos.some(x => x.includes(fx.agotado.nombre)),
    'el agotado no se puede capturar: el servidor lo rechaza con PRODUCTO_NO_DISPONIBLE');
});

await t('PANTALLA', '12. envíos aplica exactamente la misma regla', async () => {
  await pagina.evaluate(() => nuevoPedidoModalidad('domicilio'));
  await pagina.waitForFunction(() => document.querySelectorAll('.pos-producto').length > 0, { timeout: 10000 });
  const vistos = await textos('.pos-producto');
  assert.ok(vistos.some(x => x.includes(fx.normal.nombre)));
  assert.ok(!vistos.some(x => x.includes(fx.agotado.nombre)), 'la regla es una sola para las dos modalidades');
});

await t('PANTALLA', '13. las dos capturas comparten el MISMO catálogo (una sola lectura de /api/menu)', async () => {
  const igual = await pagina.evaluate(() => {
    const plano = XaborCaptura.catalogo.productos().map(p => p.id).sort();
    const env = ENV_PRODUCTOS.map(p => p.id).sort();
    const arbol = XaborCaptura.catalogo.categorias().flatMap(c => (c.productos || []).map(p => p.id)).sort();
    return JSON.stringify(plano) === JSON.stringify(env) && JSON.stringify(plano) === JSON.stringify(arbol);
  });
  assert.ok(igual, 'mostrador (árbol) y envíos (plano) son dos vistas de la misma lectura, no dos catálogos');
});

await t('PANTALLA', '14. cambiar de modalidad conserva el carrito y solo cambia los campos', async () => {
  // Antes eran dos pantallas con dos carritos y cambiar de modalidad obligaba
  // a recapturar. Ahora es el MISMO pedido: cambia cómo se entrega, no lo que
  // el operador ya capturó.
  await pagina.evaluate(() => nuevoPedidoModalidad('llevar'));
  await pagina.waitForFunction(() => document.querySelectorAll('.pos-producto').length > 0, { timeout: 10000 });
  await pagina.evaluate((nombre) => {
    [...document.querySelectorAll('.pos-producto')].find(x => x.textContent.includes(nombre)).click();
  }, fx.normal.nombre);
  await pagina.waitForFunction(() => posCarrito.length === 1, { timeout: 5000 });

  const antes = await pagina.evaluate(() => JSON.parse(JSON.stringify(posCarrito)));
  await pagina.evaluate(() => nuevoPedidoModalidad('domicilio'));
  await new Promise(r => setTimeout(r, 400));
  const despues = await pagina.evaluate(() => JSON.parse(JSON.stringify(posCarrito)));
  assert.deepStrictEqual(despues, antes, 'lo capturado sobrevive al cambio de modalidad');

  // Y lo que sí cambia son los campos del pedido, no la pantalla.
  const ui = await pagina.evaluate(() => ({
    sigueEnLaCaptura: document.getElementById('vista-presencial').style.display !== 'none',
    hayCuadricula: document.querySelectorAll('.pos-producto').length > 0,
    contacto: document.getElementById('pos-campos-contacto').style.display !== 'none',
    domicilio: document.getElementById('pos-campos-domicilio').style.display !== 'none',
    envio: document.getElementById('pos-envio-row').style.display !== 'none',
    pago: document.getElementById('pos-pago-row').style.display !== 'none',
    rewards: document.getElementById('rw-pos-widget').style.display !== 'none',
  }));
  assert.ok(ui.sigueEnLaCaptura && ui.hayCuadricula, 'domicilio NO saca al operador a otra pantalla');
  assert.ok(ui.contacto && ui.domicilio && ui.envio && ui.pago, 'domicilio pide sus campos');
  assert.ok(!ui.rewards, 'Rewards se oculta donde el backend no lo acepta (/api/pos/pedidos)');

  await pagina.evaluate(() => nuevoPedidoModalidad('llevar'));
  await new Promise(r => setTimeout(r, 300));
  const vuelta = await pagina.evaluate(() => ({
    contacto: document.getElementById('pos-campos-contacto').style.display !== 'none',
    pago: document.getElementById('pos-pago-row').style.display !== 'none',
    rewards: document.getElementById('rw-pos-widget').style.display !== 'none',
    carrito: posCarrito.length,
  }));
  assert.ok(!vuelta.contacto && !vuelta.pago, 'para llevar no pide contacto ni forma de pago');
  assert.ok(vuelta.rewards, 'Rewards vuelve en para llevar');
  assert.strictEqual(vuelta.carrito, 1, 'el carrito sigue intacto');
});

await t('PANTALLA', '15. los globales legados SON las líneas del motor, no una copia', async () => {
  const ok = await pagina.evaluate(() => posCarrito === _cPOS.lineas && ENV_CARRITO === _cPOS.lineas);
  assert.ok(ok, 'si fueran copias, Rewards y la barra móvil leerían un carrito fantasma');
  // Rewards y la barra móvil leen `precio_unitario` de estas mismas líneas.
  const suma = await pagina.evaluate(() => posCarrito.reduce((s, i) => s + i.precio_unitario * i.cantidad, 0));
  assert.strictEqual(suma, 90, 'el subtotal que ve Rewards es el del carrito de verdad');
  const barra = await pagina.evaluate(() => document.getElementById('mobile-cart-count').textContent);
  assert.strictEqual(barra, '1', 'la barra móvil se actualizó sola al cambiar el carrito');
});

await t('PANTALLA', '16. agotar un producto con el carrito a medias no le quita nada al operador', async () => {
  await pool.query(`UPDATE menu_productos SET agotado = TRUE WHERE id = $1`, [fx.normal.id]);
  await pagina.evaluate(() => XaborCaptura.catalogo.cargar({ refrescar: true }));
  await pagina.waitForFunction((n) =>
    ![...document.querySelectorAll('.pos-producto')].some(x => x.textContent.includes(n)),
    { timeout: 10000 }, fx.normal.nombre);
  const c = await pagina.evaluate(() => JSON.parse(JSON.stringify(posCarrito)));
  assert.strictEqual(c.length, 1, 'la línea capturada sigue ahí');
  assert.strictEqual(c[0].cantidad, 1);
  await pool.query(`UPDATE menu_productos SET agotado = FALSE WHERE id = $1`, [fx.normal.id]);
});

await t('PANTALLA', '17. la pantalla no lanzó errores de JavaScript', async () => {
  assert.deepStrictEqual(erroresJS, []);
});

await pagina.close();

await t('COCINA', '21. las notas de ENTREGA no se cruzan con las de cocina ni con la impresión', async () => {
  // Dos cosas distintas que se llaman igual:
  //   item.notas   → preparación, viaja por línea dentro de items, la imprime
  //                  la comanda de cocina;
  //   pedido.notas → entrega, viaja a nivel pedido, la lee el repartidor.
  // Cruzarlas mandaría «dejar en portón» a la plancha.
  const leer = async (r) => (await fetch(base + r)).text();
  const panel = await leer('/index.html');

  // El campo de entrega solo lo toca la creación del pedido y la limpieza del
  // formulario: nunca el carrito, nunca la comanda.
  const usos = [...panel.matchAll(/env-notas-entrega/g)].length;
  assert.ok(usos >= 2 && usos <= 3, 'usos inesperados del campo de entrega: ' + usos);

  const cuerpo = (firma, n = 2500) => {
    const i = panel.indexOf(firma);
    assert.ok(i >= 0, 'no se encontró ' + firma);
    return panel.slice(i, i + n);
  };
  // La comanda de cocina no sabe que existen las notas de entrega.
  for (const fn of ['function comandaHTML(', 'function imprimirComanda(', 'function abrirPopupImpresion(']) {
    assert.ok(!cuerpo(fn).includes('env-notas-entrega'),
      `${fn} no puede leer el campo de entrega`);
  }
  // Y la nota por línea sigue entrando solo por el motor.
  assert.match(panel, /function notaCarrito\(idx, texto\) \{\s*_cPOS\.nota\(idx, texto\);/,
    'la nota de cocina se escribe por el motor, no a mano');
  // El payload de items no lleva la nota de entrega: la arma el motor.
  const motor = await leer('/captura.js');
  assert.ok(!motor.includes('env-notas-entrega'), 'el motor no conoce el campo de entrega');
});

// ═══════════════════════════════════════════════════════════════════════════
//  PARTE 4 — CAMBIAR DE MODALIDAD
//
//  Antes cambiar de modalidad era cambiar de pantalla, así que no había nada
//  que conservar: el operador recapturaba. Ahora es el MISMO pedido decidiendo
//  cómo se entrega, y eso abre preguntas que antes no existían — qué sobrevive,
//  qué se limpia, y sobre todo qué NO puede viajar al servidor.
//
//  Se prueba en los tres anchos, porque el layout cambia (dos pantallas hasta
//  1024px) pero el estado del pedido no debe cambiar con él.
// ═══════════════════════════════════════════════════════════════════════════
const ANCHOS = [['desktop', 1280, 900], ['tablet', 768, 1024], ['movil', 375, 812]];

// Lo que se manda al servidor sin llegar a mandarlo: se intercepta fetch.
async function cuerpoEnviado(pag, fn) {
  await pag.evaluate(() => {
    window.__cap = null;
    if (!window.__origFetch) window.__origFetch = window.fetch;
    window.fetch = function (u, o) {
      const s = String(u);
      if (/pedido-presencial|pos\/pedidos/.test(s)) {
        window.__cap = { url: s.replace(location.origin, ''), body: JSON.parse(o.body) };
        // No se crea el pedido: lo que importa es QUÉ viajaba.
        return Promise.resolve(new Response(JSON.stringify({ ok: false, error: 'interceptado' }), { status: 400 }));
      }
      return window.__origFetch.apply(this, arguments);
    };
  });
  await fn();
  const cap = await pag.evaluate(() => window.__cap);
  await pag.evaluate(() => { if (window.__origFetch) window.fetch = window.__origFetch; });
  return cap;
}

for (const [etiqueta, ancho, alto] of ANCHOS) {
  const pag = await navegador.newPage();
  const errs = [];
  pag.on('pageerror', e => errs.push(e.message));
  pag.on('dialog', d => d.accept().catch(() => {}));
  await pag.setViewport({ width: ancho, height: alto });
  await pag.setCookie({ name: 'xabor_sesion', value: encodeURIComponent(token), domain: 'localhost', path: '/' });
  await pag.goto(base + '/app', { waitUntil: 'networkidle0' });

  const modo = async (m) => {
    await pag.evaluate(x => nuevoPedidoModalidad(x), m);
    await pag.waitForFunction(() => document.querySelectorAll('.pos-producto').length > 0, { timeout: 10000 });
    await new Promise(r => setTimeout(r, 250));
  };
  const tocar = (nombre) => pag.evaluate((n) => {
    const b = [...document.querySelectorAll('.pos-producto')].find(x => x.textContent.includes(n));
    if (!b) throw new Error('no está el producto ' + n);
    b.click();
  }, nombre);
  const carrito = () => pag.evaluate(() => JSON.parse(JSON.stringify(posCarrito)));
  const total = () => pag.evaluate(() => document.getElementById('pos-total-monto').textContent);
  const campos = () => pag.evaluate(() => ({
    contacto: document.getElementById('pos-campos-contacto').style.display !== 'none',
    domicilio: document.getElementById('pos-campos-domicilio').style.display !== 'none',
    envio: document.getElementById('pos-envio-row').style.display !== 'none',
    pago: document.getElementById('pos-pago-row').style.display !== 'none',
    rewards: document.getElementById('rw-pos-widget').style.display !== 'none',
    enLaCaptura: document.getElementById('vista-presencial').style.display !== 'none',
    cuadricula: document.querySelectorAll('.pos-producto').length > 0,
  }));

  // Carrito de partida: un producto simple y uno CONFIGURADO, para que la
  // comprobación no se limite a "hay dos líneas".
  await modo('llevar');
  await tocar(fx.normal.nombre);
  await tocar(fx.configurable.nombre);
  await pag.waitForFunction(() => !!document.getElementById('xb-mods-dlg')?.open, { timeout: 5000 });
  await pag.evaluate(() => {
    const l = [...document.querySelectorAll('#xb-mods-body .xb-op')].find(x => x.textContent.includes('Suave'));
    const i = l.querySelector('input'); i.checked = true; i.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await pag.evaluate(() => document.getElementById('xb-mods-agregar').click());
  await pag.waitForFunction(() => posCarrito.length === 2, { timeout: 5000 });
  const base0 = await carrito();

  await t('TRANSICION', `${etiqueta}: para llevar → recoger conserva productos y modificadores`, async () => {
    await modo('recoger');
    assert.deepStrictEqual(await carrito(), base0, 'el carrito debe sobrevivir intacto');
    const c = await campos();
    assert.ok(c.enLaCaptura && c.cuadricula, 'no puede sacar al operador de la captura');
    assert.ok(c.contacto && c.pago, 'recoger pide contacto y forma de pago');
    assert.ok(!c.domicilio && !c.envio, 'recoger no pide dirección ni envío');
    assert.ok(!c.rewards, 'Rewards se oculta fuera de Para llevar');
  });

  await t('TRANSICION', `${etiqueta}: recoger → para llevar vuelve sin pedir contacto ni pago`, async () => {
    await modo('llevar');
    assert.deepStrictEqual(await carrito(), base0);
    const c = await campos();
    assert.ok(!c.contacto && !c.pago && !c.domicilio && !c.envio, 'para llevar solo pide nombre opcional');
    assert.ok(c.rewards, 'Rewards vuelve');
  });

  await t('TRANSICION', `${etiqueta}: para llevar → domicilio conserva el carrito y suma el envío`, async () => {
    const antesTotal = await total();
    await modo('domicilio');
    assert.deepStrictEqual(await carrito(), base0);
    const c = await campos();
    assert.ok(c.contacto && c.domicilio && c.envio && c.pago, 'domicilio pide todo lo suyo');
    assert.strictEqual(await total(), antesTotal, 'sin costo de envío el total no cambia');
    await pag.evaluate(() => { const e = document.getElementById('env-costo-envio'); e.value = '35'; e.dispatchEvent(new Event('input', { bubbles: true })); });
    await new Promise(r => setTimeout(r, 200));
    const conEnvio = Number((await total()).replace('$', ''));
    assert.strictEqual(conEnvio, Number(antesTotal.replace('$', '')) + 35, 'el envío ENTRA al total');
  });

  await t('TRANSICION', `${etiqueta}: domicilio → recoger saca el envío del total`, async () => {
    await modo('recoger');
    const c = await campos();
    assert.ok(!c.envio, 'la fila de envío desaparece');
    assert.strictEqual(Number((await total()).replace('$', '')), base0.reduce((s, l) => s + l.precio_unitario * l.cantidad, 0),
      'el envío SALE del total al dejar domicilio');
    assert.deepStrictEqual(await carrito(), base0);
  });

  await t('TRANSICION', `${etiqueta}: domicilio → para llevar → domicilio, ida y vuelta`, async () => {
    await modo('domicilio');
    await pag.evaluate(() => { const e = document.getElementById('env-costo-envio'); e.value = '20'; e.dispatchEvent(new Event('input', { bubbles: true })); });
    await new Promise(r => setTimeout(r, 150));
    const subtotal = base0.reduce((s, l) => s + l.precio_unitario * l.cantidad, 0);
    assert.strictEqual(Number((await total()).replace('$', '')), subtotal + 20);
    await modo('llevar');
    assert.strictEqual(Number((await total()).replace('$', '')), subtotal, 'en para llevar no hay envío');
    await modo('domicilio');
    assert.strictEqual(Number((await total()).replace('$', '')), subtotal + 20, 'al volver, el envío vuelve al total');
    assert.deepStrictEqual(await carrito(), base0, 'y el carrito nunca se tocó');
  });

  await t('TRANSICION', `${etiqueta}: dirección y envío NO viajan si la modalidad final no es domicilio`, async () => {
    // Se llenan los datos de domicilio a propósito y luego se cambia a recoger.
    await modo('domicilio');
    await pag.evaluate(() => {
      const v = (id, x) => { document.getElementById(id).value = x; };
      v('env-nombre', 'Transicion'); v('env-telefono', '8781110001');
      v('env-calle', 'Av Prueba'); v('env-numext', '742'); v('env-colonia', 'Centro');
      v('env-entrecalles', 'A y B'); v('env-referencia', 'Portón azul');
      v('env-notas-entrega', 'Tocar el timbre');
      const e = document.getElementById('env-costo-envio'); e.value = '35'; e.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await modo('recoger');
    const cap = await cuerpoEnviado(pag, () => pag.evaluate(() => crearPedidoPOS()));
    assert.ok(cap, 'debió intentar crear el pedido');
    assert.strictEqual(cap.url, '/api/pos/pedidos');
    assert.strictEqual(cap.body.tipo, 'recoger');
    assert.strictEqual(cap.body.direccion, undefined, 'la dirección NO puede viajar en recoger');
    assert.strictEqual(cap.body.costoEnvio, 0, 'el costo de envío NO puede viajar en recoger');
    assert.ok(!JSON.stringify(cap.body).includes('Tocar el timbre'), 'las notas de entrega tampoco');
    assert.ok(!JSON.stringify(cap.body).includes('Portón azul'), 'ni la referencia');
  });

  await t('TRANSICION', `${etiqueta}: la forma de pago de recoger/domicilio no altera para llevar`, async () => {
    await modo('domicilio');
    await pag.evaluate(() => { document.getElementById('env-metodo-pago').value = 'tarjeta'; });
    await modo('llevar');
    const cap = await cuerpoEnviado(pag, () => pag.evaluate(() => crearPedidoPOS()));
    assert.ok(cap, 'debió intentar crear el pedido');
    assert.strictEqual(cap.url, '/api/pedido-presencial');
    assert.strictEqual(cap.body.forma_pago, undefined,
      'para llevar no manda forma de pago: nace por_cobrar y se cobra en el modal Cobrar');
    assert.strictEqual(cap.body.formaPago, undefined, 'tampoco con el nombre del otro endpoint');
    assert.strictEqual(cap.body.costoEnvio, undefined, 'ni costo de envío');
    assert.strictEqual(cap.body.direccion, undefined, 'ni dirección');
  });

  await t('TRANSICION', `${etiqueta}: salir de para llevar RETIRA el canje Rewards y lo avisa`, async () => {
    await modo('llevar');
    await pag.evaluate(() => { const e = document.getElementById('env-costo-envio'); e.value = '0'; e.dispatchEvent(new Event('input', { bubbles: true })); });
    // Canje aplicado a mano: lo que importa es qué pasa al cambiar de
    // modalidad, no cómo se aplicó.
    await pag.evaluate(() => { rwCanjeAplicado = { puntos: 100, monto: 20 }; renderCarrito(); });
    const subtotal = base0.reduce((s, l) => s + l.precio_unitario * l.cantidad, 0);
    assert.strictEqual(Number((await total()).replace('$', '')), subtotal - 20, 'el canje descuenta en para llevar');

    await modo('domicilio');
    const estado = await pag.evaluate(() => ({
      canje: rwCanjeAplicado,
      aviso: document.getElementById('pos-error').textContent,
      visible: document.getElementById('pos-error').style.display !== 'none',
    }));
    assert.strictEqual(estado.canje, null, 'el canje se retira al salir de para llevar');
    assert.ok(/canje/i.test(estado.aviso) && estado.visible, 'y el operador se entera: ' + JSON.stringify(estado.aviso));
    assert.strictEqual(Number((await total()).replace('$', '')), subtotal, 'el total deja de tener el descuento');

    // Y no puede viajar al pedido de domicilio.
    await pag.evaluate(() => {
      const v = (id, x) => { document.getElementById(id).value = x; };
      v('env-nombre', 'Transicion'); v('env-telefono', '8781110001');
      v('env-calle', 'Av Prueba'); v('env-colonia', 'Centro');
    });
    const cap = await cuerpoEnviado(pag, () => pag.evaluate(() => crearPedidoPOS()));
    assert.ok(!JSON.stringify(cap.body).toLowerCase().includes('rewards'), 'ningún rastro del canje en el pedido');
  });

  await t('TRANSICION', `${etiqueta}: al volver a para llevar, Rewards recalcula sobre el carrito conservado`, async () => {
    await modo('llevar');
    const est = await pag.evaluate(() => ({
      canje: rwCanjeAplicado,
      rewardsVisible: document.getElementById('rw-pos-widget').style.display !== 'none',
      base: posCarrito.reduce((s, i) => s + i.precio_unitario * i.cantidad, 0),
    }));
    assert.strictEqual(est.canje, null, 'el canje no reaparece solo');
    assert.ok(est.rewardsVisible, 'el widget vuelve para poder canjear de nuevo');
    assert.strictEqual(est.base, base0.reduce((s, l) => s + l.precio_unitario * l.cantidad, 0),
      'Rewards recalcula sobre el carrito conservado');
    assert.strictEqual(Number((await total()).replace('$', '')), est.base);
  });


  // ─── Notas de ENTREGA (pedido.notas) ──────────────────────────────────────
  // Son del repartidor, no de la cocina. `item.notas` es preparación y viaja
  // por línea dentro de items; esto es `pedido.notas`, lo guarda
  // construirOrdenPOS y lo pinta el portal del repartidor. No se mezclan.
  //
  // El campo llevaba en la interfaz desde la vista Envíos y NUNCA se mandaba:
  // el operador escribía «dejar en portón» y no llegaba a ningún lado.
  await t('NOTAS', `${etiqueta}: domicilio manda las notas de entrega en pedido.notas`, async () => {
    await modo('domicilio');
    await pag.evaluate(() => {
      const v = (id, x) => { document.getElementById(id).value = x; };
      v('env-nombre', 'Notas'); v('env-telefono', '8781110002');
      v('env-calle', 'Av Prueba'); v('env-colonia', 'Centro');
      v('env-notas-entrega', 'Dejar en portón');
    });
    const cap = await cuerpoEnviado(pag, () => pag.evaluate(() => crearPedidoPOS()));
    assert.strictEqual(cap.body.notas, 'Dejar en portón', 'la nota de entrega viaja tal cual');
    // Y no se cuela en la cocina: los items llevan SU propia nota, vacía aquí.
    assert.ok(cap.body.items.every(i => !String(i.notas || '').includes('portón')),
      'la nota de entrega no puede aparecer en las notas de cocina de los items');
  });

  await t('NOTAS', `${etiqueta}: recoger NO manda notas aunque el campo siga poblado`, async () => {
    await modo('recoger');
    const sigue = await pag.evaluate(() => document.getElementById('env-notas-entrega').value);
    assert.strictEqual(sigue, 'Dejar en portón', 'el texto se conserva: no se le tira el trabajo al operador');
    const cap = await cuerpoEnviado(pag, () => pag.evaluate(() => crearPedidoPOS()));
    assert.strictEqual(cap.body.tipo, 'recoger');
    assert.ok(!('notas' in cap.body), 'en recoger la propiedad notas debe estar AUSENTE');
  });

  await t('NOTAS', `${etiqueta}: para llevar NO manda notas aunque el campo siga poblado`, async () => {
    await modo('llevar');
    assert.strictEqual(await pag.evaluate(() => document.getElementById('env-notas-entrega').value), 'Dejar en portón');
    const cap = await cuerpoEnviado(pag, () => pag.evaluate(() => crearPedidoPOS()));
    assert.strictEqual(cap.url, '/api/pedido-presencial');
    assert.ok(!('notas' in cap.body), 'para llevar no tiene entrega: la propiedad notas debe estar AUSENTE');
  });

  await t('NOTAS', `${etiqueta}: domicilio con el campo vacío no manda basura`, async () => {
    await modo('domicilio');
    await pag.evaluate(() => { document.getElementById('env-notas-entrega').value = '   '; });
    const cap = await cuerpoEnviado(pag, () => pag.evaluate(() => crearPedidoPOS()));
    assert.ok(!('notas' in cap.body), 'solo espacios se omite, no se manda una cadena en blanco');
  });

  await t('NOTAS', `${etiqueta}: el texto sobrevive a domicilio → otra modalidad → domicilio`, async () => {
    await modo('domicilio');
    await pag.evaluate(() => { document.getElementById('env-notas-entrega').value = 'Timbre descompuesto, tocar fuerte'; });
    await modo('llevar');
    await modo('recoger');
    await modo('domicilio');
    assert.strictEqual(await pag.evaluate(() => document.getElementById('env-notas-entrega').value),
      'Timbre descompuesto, tocar fuerte', 'el texto se conserva en la interfaz');
    const cap = await cuerpoEnviado(pag, () => pag.evaluate(() => crearPedidoPOS()));
    assert.strictEqual(cap.body.notas, 'Timbre descompuesto, tocar fuerte',
      'y se serializa porque la modalidad FINAL es domicilio');
  });

  await t('NOTAS', `${etiqueta}: el límite del campo es el mismo que el del servidor`, async () => {
    const max = await pag.evaluate(() => document.getElementById('env-notas-entrega').getAttribute('maxlength'));
    assert.strictEqual(max, '500', 'construirOrdenPOS hace slice(0,500): el campo no debe dejar escribir lo que se va a perder');
    await modo('domicilio');
    await pag.evaluate(() => { document.getElementById('env-notas-entrega').value = 'x'.repeat(900); });
    const cap = await cuerpoEnviado(pag, () => pag.evaluate(() => crearPedidoPOS()));
    assert.strictEqual(cap.body.notas.length, 500, 'si alguien la puebla por script, se recorta igual');
    await pag.evaluate(() => { document.getElementById('env-notas-entrega').value = ''; });
  });

  await t('TRANSICION', `${etiqueta}: sin errores de JavaScript en todo el recorrido`, async () => {
    assert.deepStrictEqual(errs, []);
  });

  await pag.close();
}

await navegador.close();
// ═══════════════════════════════════════════════════════════════════════════
//  PARTE 3 — QUE EL MOTOR LLEGUE ENTERO AL NAVEGADOR
//
//  El 2026-09-15 la captura de pedidos se cayó en producción sin que fallara
//  una sola prueba. La causa no fue la lógica: el cambio se repartía entre dos
//  archivos servidos con políticas de caché DISTINTAS —
//
//    /app              Cache-Control: public, max-age=0      (revalida siempre)
//    /modificadores.js Cache-Control: public, max-age=14400  (Cloudflare: 4 h)
//
//  — y al navegador le llegó el index.html NUEVO con el módulo VIEJO de su
//  caché: «elegirLinea is not a function» al primer clic, y ningún producto se
//  podía agregar en NINGUNA modalidad. Ninguna suite lo vio porque el
//  navegador de pruebas arranca sin caché y siempre recibe los dos archivos
//  del mismo commit.
//
//  captura.js corre exactamente el mismo riesgo, y peor: el panel lo invoca en
//  cada alta de producto y encima depende de modificadores.js. Por eso lleva
//  su propia huella y estos guardianes.
// ═══════════════════════════════════════════════════════════════════════════
const { createHash } = await import('crypto');
const traerTexto = async (ruta) => (await fetch(base + ruta)).text();

await t('CACHE', '18. la etiqueta de captura.js lleva la huella de su contenido', async () => {
  const modulo = readFileSync(join(__dirname, '..', 'panel', 'captura.js'));
  const huella = createHash('sha256').update(modulo).digest('hex').slice(0, 8);
  const html = await traerTexto('/index.html');
  const refs = [...html.matchAll(/src="\/captura\.js(\?v=([0-9a-f]{8}))?"/g)];
  assert.ok(refs.length >= 1, 'el panel debe cargar el motor de captura');
  for (const r of refs) {
    assert.ok(r[2],
      'hay un <script src="/captura.js"> SIN ?v= — la caché de 4 h lo puede servir viejo ' +
      'y el panel se queda llamando a un motor que no existe');
    assert.strictEqual(r[2], huella,
      `el ?v= dice "${r[2]}" pero el módulo tiene huella "${huella}". ` +
      `Si acabas de editar captura.js, pon "${huella}" en el ?v= de index.html.`);
  }
});

await t('CACHE', '19. toda API de XaborCaptura que el panel invoca EXISTE en el módulo', async () => {
  // La comprobación de fondo: aunque alguien olvidara el ?v=, esto caza el
  // momento exacto en que el panel empieza a depender de algo que el motor no
  // ofrece. Es la forma de la caída de producción, en estático.
  const js = await traerTexto('/captura.js');
  const expuestas = new Set(
    (js.match(/global\.XaborCaptura\s*=\s*\{([^}]*)\}/)?.[1] || '')
      .split(',').map(s => s.split(':')[0].trim()).filter(Boolean));
  assert.ok(expuestas.size >= 4, 'se debe poder leer lo que el módulo expone: ' + [...expuestas]);

  const html = await traerTexto('/index.html');
  const usadas = new Set([...html.matchAll(/XaborCaptura\.([A-Za-z_$][\w$]*)/g)].map(m => m[1]));
  assert.ok(usadas.size > 0, 'el panel debe usar el motor');
  for (const fn of usadas) {
    assert.ok(expuestas.has(fn),
      `el panel llama a XaborCaptura.${fn}, que el módulo NO expone ` +
      `(expone: ${[...expuestas].join(', ')}). Así se cayó producción el 2026-09-15.`);
  }
  // El catálogo se usa por método desde todo el panel: también tienen que existir.
  const metodos = new Set([...html.matchAll(/XaborCaptura\.catalogo\.([A-Za-z_$][\w$]*)/g)].map(m => m[1]));
  assert.ok(metodos.size > 0, 'el panel usa el catálogo del motor');
  for (const m of metodos) {
    assert.ok(new RegExp(`(^|[^\w.])${m}\s*[(:,]`, 'm').test(js),
      `el panel llama a XaborCaptura.catalogo.${m}, que el módulo no define`);
  }
});

await t('CACHE', '20. el motor se sirve y es JavaScript válido', async () => {
  const r = await fetch(base + '/captura.js');
  assert.strictEqual(r.status, 200, '/captura.js debe servirse');
  new vm.Script(await r.text(), { filename: 'captura.js' });
});

await limpiar();

console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }

await srv.detener();
await pool.end();
process.exitCode = fallidas > 0 ? 1 : 0;
