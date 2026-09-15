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
  return {
    normal: await prod('Unificada normal', 90),
    agotado: await prod('Unificada agotado', 70, { agotado: true }),
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
  await pagina.waitForFunction(() => document.querySelectorAll('#env-lista-productos button').length > 0, { timeout: 10000 });
  const vistos = await textos('#env-lista-productos button');
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

await t('PANTALLA', '14. mostrador y envíos NO comparten carrito', async () => {
  await pagina.evaluate(() => nuevoPedidoModalidad('llevar'));
  await pagina.waitForFunction(() => document.querySelectorAll('.pos-producto').length > 0, { timeout: 10000 });
  await pagina.evaluate((nombre) => {
    const b = [...document.querySelectorAll('.pos-producto')].find(x => x.textContent.includes(nombre));
    b.click();
  }, fx.normal.nombre);
  await pagina.waitForFunction(() => posCarrito.length === 1, { timeout: 5000 });
  const env = await pagina.evaluate(() => ENV_CARRITO.length);
  assert.strictEqual(env, 0, 'capturar para llevar no puede aparecer en el domicilio de al lado');
  const mismos = await pagina.evaluate(() => posCarrito === ENV_CARRITO);
  assert.strictEqual(mismos, false, 'son dos instancias del mismo motor, no un carrito compartido');
});

await t('PANTALLA', '15. los globales legados SON las líneas del motor, no una copia', async () => {
  const ok = await pagina.evaluate(() => posCarrito === _cMostrador.lineas && ENV_CARRITO === _cEnvios.lineas);
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
await navegador.close();
await limpiar();

console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }

await srv.detener();
await pool.end();
process.exitCode = fallidas > 0 ? 1 : 0;
