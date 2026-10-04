// Formulario «tienda» (tienda_v1), Fase 1, con base: vitrina, miniaturas y el
// precalentamiento tras guardarImagenProducto contra Postgres real.
//
// Corre SOLO contra una base local test_botones_* con la red limitada a local
// (exigirBaseBotonesLocal). Las fotos se guardan con el driver local del
// almacenamiento, como las sube el dueño desde el panel.
//
// Garantías que prueba:
//   bandera apagada  guardar una foto responde igual que hoy y no genera nada
//                    (tampoco con valores parecidos: 'false', 'TRUE')
//   vitrina          UNA consulta; orden comercial; solo publicados de categorías
//                    activas y del negocio; descripciones y llaves reales
//   no queda vieja   con la caché caliente, una foto nueva se ve ya; la quitada
//                    deja de verse ya; nunca se genera la miniatura de la vieja
//   receta           WebP y PNG guardados salen JPEG
//   precalentar      con la bandera: tras guardar y por negocio (portadas
//                    incluidas); al arrancar, solo los negocios encendidos
//   sin transacción  la cola de miniaturas no toca la base
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { pool, actualizarConfiguracion } from '../src/services/database.js';
import { exigirBaseBotonesLocal, prepararNegocioBotones } from './lib-botones-local.mjs';
import { guardarImagenProducto, eliminarImagenProducto } from '../src/services/imagenesProducto.js';
import { obtenerVitrina, vitrinasTienda, precalentarNegocio, precalentarAlArrancar, esperarPrecalentamiento, portadaDeCategoria,
  SQL_VITRINA } from '../src/services/vitrinaTienda.js';
import { miniaturasMenu, miniaturaEnCache, NOMBRES_VARIANTES, VARIANTES_PRECALENTADAS, VARIANTES } from '../src/services/miniaturasMenu.js';

exigirBaseBotonesLocal();
let pasadas = 0, fallidas = 0;
const t = async (nombre, fn) => {
  try { await fn(); pasadas++; console.log(`  ok  ${nombre}`); } catch (e) { fallidas++; console.log(`FALLA ${nombre}: ${e.stack || e.message}`); }
};
const rechazos = [];
process.on('unhandledRejection', (e) => rechazos.push(e));

const solida = (color, formato = 'jpeg') => sharp({ create: { width: 640, height: 480, channels: 3, background: color } })[formato]().toBuffer();
const ROJO = await solida('#e01010'), AZUL = await solida('#1030e0'), VERDE_WEBP = await solida('#10a020', 'webp');
const PNG_TRANSPARENTE = await sharp({ create: { width: 300, height: 300, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
async function pixel(base64) {
  const { data } = await sharp(Buffer.from(base64, 'base64')).raw().toBuffer({ resolveWithObject: true });
  return [...data.subarray(0, 3)];
}
const cerca = (px, rgb, tol = 40) => px.every((c, i) => Math.abs(c - rgb[i]) <= tol);
const esJpeg = (b64) => Buffer.from(b64, 'base64').subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
/** Cuenta las consultas y conexiones del pool mientras corre fn. */
async function contando(fn) {
  const query = pool.query, connect = pool.connect, sql = [];
  let conexiones = 0;
  pool.query = function (...a) { sql.push(typeof a[0] === 'string' ? a[0] : a[0]?.text); return query.apply(this, a); };
  pool.connect = function (...a) { conexiones++; return connect.apply(this, a); };
  try { const r = await fn(); return { r, sql, conexiones }; } finally { pool.query = query; pool.connect = connect; }
}
const bandera = (negocioId, valor) => actualizarConfiguracion({ whatsapp_flow_tienda_v1: valor }, negocioId);

// ── Carta de A (B es el negocio mínimo de lib-botones-local) ─────────────
const A = await prepararNegocioBotones(), B = await prepararNegocioBotones();
async function categoria(negocioId, nombre, orden, activa = true) {
  return (await pool.query('INSERT INTO menu_categorias(negocio_id,nombre,orden,activa) VALUES($1,$2,$3,$4) RETURNING id', [negocioId, nombre, orden, activa])).rows[0].id;
}
async function producto(negocioId, categoriaId, nombre, orden, { descripcion = null, publicado = true } = {}) {
  const { rows: [p] } = await pool.query(`INSERT INTO menu_productos(negocio_id,categoria_id,nombre,precio,disponible,orden,descripcion)
    VALUES($1,$2,$3,100,true,$4,$5) RETURNING id`, [negocioId, categoriaId, nombre, orden, descripcion]);
  if (publicado !== null) await pool.query('INSERT INTO whatsapp_productos(negocio_id,producto_id,publicado) VALUES($1,$2,$3)', [negocioId, p.id, publicado]);
  return p.id;
}
const { rows: [{ categoria_id: bebidas }] } = await pool.query('SELECT categoria_id FROM menu_productos WHERE id=$1', [A.productoId]);
const desayunos = await categoria(A.negocioId, 'Desayunos', 1), postres = await categoria(A.negocioId, 'Postres', 1);
const oculta = await categoria(A.negocioId, 'Oculta', 0, false);
const hotcakes = await producto(A.negocioId, desayunos, 'Hotcakes', 2, { descripcion: 'Dos piezas con fruta' });
const waffles = await producto(A.negocioId, desayunos, 'Waffles', 1);
const molletes = await producto(A.negocioId, desayunos, 'Molletes', 1, { descripcion: '  Con frijoles\n' });
await producto(A.negocioId, desayunos, 'Interno', 0, { publicado: false });
await producto(A.negocioId, desayunos, 'Sin registro', 0, { publicado: null });
const pay = await producto(A.negocioId, postres, 'Pay', 0, { descripcion: 'Rico' });
await producto(A.negocioId, oculta, 'Secreto', 0);
const llave = async (productoId) => (await pool.query("SELECT opciones->'imagen'->>'storage_key' AS k FROM menu_productos WHERE id=$1", [productoId])).rows[0].k;
const S = String;

let llaveRoja;
await t('bandera apagada: guardar una foto responde como hoy, no genera miniaturas ni escribe configuración', async () => {
  const cfgAntes = (await pool.query('SELECT clave, valor FROM configuracion WHERE negocio_id=$1 ORDER BY clave', [A.negocioId])).rows;
  const r = await guardarImagenProducto(A.negocioId, hotcakes, ROJO, 'hotcakes.jpg');
  assert.deepEqual(Object.keys(r).sort(), ['ok', 'producto', 'url']);
  assert.equal(r.ok, true); assert.match(r.url, new RegExp(`^/img/producto/${hotcakes}\\?v=[A-Za-z0-9]+$`));
  llaveRoja = r.producto.opciones.imagen.storage_key;
  assert.match(llaveRoja, /\/productos\/[0-9a-f-]{36}\.jpg$/); assert.equal(await llave(hotcakes), llaveRoja);
  await esperarPrecalentamiento();
  const e = miniaturasMenu.estado();
  assert.deepEqual([e.lecturas, e.pendientes, e.entradas, e.generadas], [0, 0, 0, 0]);
  for (const v of NOMBRES_VARIANTES) assert.equal(miniaturaEnCache(llaveRoja, v), null);
  assert.deepEqual((await pool.query('SELECT clave, valor FROM configuracion WHERE negocio_id=$1 ORDER BY clave', [A.negocioId])).rows, cfgAntes);
  for (const valor of ['false', 'TRUE', ' true']) {
    await bandera(A.negocioId, valor);
    const otra = await guardarImagenProducto(A.negocioId, waffles, ROJO, 'w.jpg');
    assert.equal(otra.ok, true); await esperarPrecalentamiento();
    assert.equal(miniaturasMenu.estado().lecturas, 0, `«${valor}» no enciende la tienda`);
  }
  await eliminarImagenProducto(A.negocioId, waffles);
});

await t('vitrina: UNA consulta; orden comercial; solo publicados de categorías activas del negocio; descripciones y llaves reales', async () => {
  vitrinasTienda.vaciar();
  const { r: v, sql } = await contando(() => obtenerVitrina(A.negocioId));
  assert.deepEqual(sql, [SQL_VITRINA], 'una sola consulta por negocio');
  assert.equal(v.error, null);
  assert.deepEqual(v.categorias.map((c) => [c.id, c.nombre]), [[S(bebidas), 'Bebidas'], [S(desayunos), 'Desayunos'], [S(postres), 'Postres']]);
  assert.deepEqual(v.categorias.map((c) => c.productos), [[S(A.productoId)], [S(waffles), S(molletes), S(hotcakes)], [S(pay)]]);
  assert.deepEqual(v.productos[S(hotcakes)], { id: S(hotcakes), orden: 2, descripcion: 'Dos piezas con fruta', storageKey: llaveRoja, categoriaId: S(desayunos) });
  assert.equal(v.productos[S(molletes)].descripcion, 'Con frijoles');
  assert.equal(v.productos[S(waffles)].storageKey, null, 'la foto quitada no aparece');
  assert.equal(Object.keys(v.productos).length, 5, 'sin Interno, Sin registro ni Secreto');
  const { sql: otra } = await contando(() => obtenerVitrina(A.negocioId));
  assert.equal(otra.length, 0, 'dentro de los 60 s no vuelve a consultar');
  const vb = await obtenerVitrina(B.negocioId);
  assert.deepEqual(Object.keys(vb.productos), [S(B.productoId)], 'cada negocio ve solo lo suyo');
});

let llaveAzul, llaveWebp, llavePng;
await t('bandera en prueba: una foto nueva se ve ya con la caché caliente y sus tres miniaturas se generan en segundo plano; la vieja nunca', async () => {
  await bandera(A.negocioId, 'prueba');
  assert.equal((await obtenerVitrina(A.negocioId)).productos[S(hotcakes)].storageKey, llaveRoja, 'caché caliente con la llave vieja');
  const r = await guardarImagenProducto(A.negocioId, hotcakes, AZUL, 'hotcakes-2.jpg');
  llaveAzul = r.producto.opciones.imagen.storage_key;
  assert.notEqual(llaveAzul, llaveRoja);
  const { r: v, sql } = await contando(() => obtenerVitrina(A.negocioId));
  assert.equal(v.productos[S(hotcakes)].storageKey, llaveAzul, 'sin esperar a que venzan los 60 s');
  assert.equal(sql.length, 1);
  await esperarPrecalentamiento();
  assert.equal(miniaturaEnCache(llaveAzul, 'lista80'), null, 'lista80 no se precalienta: la pide la escalera');
  for (const nombre of VARIANTES_PRECALENTADAS) {
    const b64 = miniaturaEnCache(llaveAzul, nombre);
    assert(b64 && esJpeg(b64), nombre);
    const m = await sharp(Buffer.from(b64, 'base64')).metadata();
    assert.deepEqual([m.width, m.height], [VARIANTES[nombre].ancho, VARIANTES[nombre].alto]);
    assert(cerca(await pixel(b64), [16, 48, 224]), `${nombre} azul`);
    assert.equal(miniaturaEnCache(llaveRoja, nombre), null, 'de la foto vieja no se generó nada');
  }
});

await t('receta con fotos guardadas: WebP y PNG con transparencia salen JPEG (la transparencia, blanca)', async () => {
  llaveWebp = (await guardarImagenProducto(A.negocioId, molletes, VERDE_WEBP, 'molletes.webp')).producto.opciones.imagen.storage_key;
  llavePng = (await guardarImagenProducto(A.negocioId, pay, PNG_TRANSPARENTE, 'pay.png')).producto.opciones.imagen.storage_key;
  assert.match(llaveWebp, /\.webp$/); assert.match(llavePng, /\.png$/, 'el almacenamiento conserva WebP y PNG');
  await esperarPrecalentamiento();
  for (const nombre of VARIANTES_PRECALENTADAS) {
    const deWebp = miniaturaEnCache(llaveWebp, nombre), dePng = miniaturaEnCache(llavePng, nombre);
    assert(esJpeg(deWebp) && esJpeg(dePng), nombre);
    assert(cerca(await pixel(deWebp), [16, 160, 32]), `${nombre} verde`);
    assert((await pixel(dePng)).every((c) => c >= 245), `${nombre} blanco`);
  }
});

await t('precalentar el negocio: portadas (cat128) y fotos (lista96 y ficha480) en orden comercial, sin tocar la base mientras genera', async () => {
  miniaturasMenu.vaciar();
  const v = await obtenerVitrina(A.negocioId);
  assert.equal(portadaDeCategoria(v, desayunos), llaveWebp, 'Waffles no tiene foto: la portada es la de Molletes');
  assert.equal(portadaDeCategoria(v, postres), llavePng);
  assert.equal(await precalentarNegocio(A.negocioId), 8);
  const { sql, conexiones } = await contando(() => miniaturasMenu.esperar());
  assert.deepEqual([sql.length, conexiones], [0, 0], 'la cola de miniaturas no consulta ni abre conexiones');
  for (const k of [llaveAzul, llaveWebp, llavePng]) for (const n of ['lista96', 'ficha480']) assert(miniaturaEnCache(k, n), `${k} ${n}`);
  assert(miniaturaEnCache(llaveWebp, 'cat128') && miniaturaEnCache(llavePng, 'cat128'));
  assert.equal(miniaturaEnCache(llaveAzul, 'cat128'), null, 'Hotcakes no es portada');
});

await t('quitar la foto: la vitrina deja de verla ya y la categoría se queda sin portada', async () => {
  await obtenerVitrina(A.negocioId);
  assert.equal((await eliminarImagenProducto(A.negocioId, pay)).ok, true);
  const v = await obtenerVitrina(A.negocioId);
  assert.equal(v.productos[S(pay)].storageKey, null);
  assert.equal(portadaDeCategoria(v, postres), null);
});

await t('al arrancar: solo los negocios con la bandera encendida', async () => {
  const llaveB = (await guardarImagenProducto(B.negocioId, B.productoId, ROJO, 'cafe.jpg')).producto.opciones.imagen.storage_key;
  await esperarPrecalentamiento();
  await bandera(A.negocioId, 'true'); await bandera(B.negocioId, 'false');
  miniaturasMenu.vaciar(); vitrinasTienda.vaciar();
  const n = await precalentarAlArrancar();
  await miniaturasMenu.esperar();
  assert.equal(n, 5, 'Desayunos: su portada (cat128) + Hotcakes y Molletes (lista96 y ficha480); Pay ya no tiene foto');
  for (const k of [llaveAzul, llaveWebp]) assert(miniaturaEnCache(k, 'lista96'), k);
  for (const v of NOMBRES_VARIANTES) assert.equal(miniaturaEnCache(llaveB, v), null, `B está apagado (${v})`);
});

await new Promise((r) => setImmediate(r));
assert.equal(rechazos.length, 0, String(rechazos[0]));
await pool.end();
console.log(`RESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas} (vitrina tienda con base)`);
process.exit(fallidas ? 1 : 0);
