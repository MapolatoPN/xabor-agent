// ─── EL CATÁLOGO PUBLICADO DE WHATSAPP, CONTRA POSTGRES ───────────────────
//
// La tabla `whatsapp_productos` (098), el servicio que la lee y escribe y las
// rutas del panel que la exponen. Lo que tiene que sostenerse:
//
//   · un producto nuevo nace SIN publicar, y retirarlo deja la fila en FALSE;
//   · el agente solo ve lo publicado de categorías activas; lo demás queda en
//     `nombresOcultos` (para la emisión segura) y si la lectura falla, la carta
//     sale VACÍA (falla cerrado, nunca el menú completo);
//   · solo un administrador con el módulo publica, y el negocio sale SIEMPRE
//     de la sesión: un id o un negocioId ajenos no publican nada, y la FK
//     compuesta lo impide también en el esquema;
//   · re-ejecutar la migración no vuelve a publicar lo que el negocio retiró.
//
// Uso: DATABASE_URL a un Postgres LOCAL y desechable con 098 aplicada.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import express from 'express';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL requerida');
const HOST = new URL(process.env.DATABASE_URL).hostname;
if (!['localhost', '127.0.0.1', '::1'].includes(HOST)) throw new Error('Solo acepta Postgres local');

const { pool } = await import('../src/services/database.js');
const {
  obtenerCatalogoDelAgente, listarProductosWhatsapp, idsPublicadosEnWhatsapp,
} = await import('../src/services/catalogoWhatsapp.js');
const { registrarRutasCatalogoWhatsapp } = await import('../src/services/catalogoWhatsappRutas.js');

let pasadas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); pasadas += 1; console.log(`    OK  ${nombre}`); }
  catch (e) { fallos.push(`${nombre}: ${e.message}`); console.log(`> FALLO ${nombre}: ${e.message}`); }
}

// ── Dos negocios con su menú; nada publicado todavía ─────────────────────
const MARCA = 'CWA ';
const negocios = [];
async function negocio(nombre) {
  const { rows: [n] } = await pool.query('INSERT INTO negocios (nombre, slug) VALUES ($1,$2) RETURNING id',
    [MARCA + nombre, `cwa-${randomUUID()}`]);
  negocios.push(n.id);
  return n.id;
}
async function categoria(neg, nombre, activa = true) {
  const { rows: [c] } = await pool.query(
    'INSERT INTO menu_categorias (negocio_id,nombre,activa,orden) VALUES ($1,$2,$3,0) RETURNING id',
    [neg, MARCA + nombre, activa]);
  return c.id;
}
async function producto(neg, cat, nombre, precio = 50) {
  const { rows: [p] } = await pool.query(
    `INSERT INTO menu_productos (negocio_id,categoria_id,nombre,precio,disponible,agotado,orden)
     VALUES ($1,$2,$3,$4,TRUE,FALSE,0) RETURNING id`, [neg, cat, MARCA + nombre, precio]);
  return p.id;
}
const A = await negocio('A');
const B = await negocio('B');
const catA = await categoria(A, 'Desayunos');
const extrasA = await categoria(A, 'EXTRAS');
const ocultaA = await categoria(A, 'Temporada', false);
const P = {
  waffle: await producto(A, catA, 'Waffle', 105),
  cafe: await producto(A, catA, 'Café', 45),
  pieza: await producto(A, catA, 'Pieza de Hotcake', 55),
  huevo: await producto(A, extrasA, 'Extra Huevo', 20),
  pan: await producto(A, ocultaA, 'Pan de Temporada', 70),
};
const catB = await categoria(B, 'Pizzas');
const pizzaB = await producto(B, catB, 'Pizza', 180);

const fila = async (neg, id) => (await pool.query(
  'SELECT publicado, origen FROM whatsapp_productos WHERE negocio_id=$1 AND producto_id=$2', [neg, id])).rows[0] || null;
const nombresCarta = (carta) => carta.flatMap((c) => c.productos.map((p) => p.nombre)).sort();

// ── Las rutas, montadas con una sesión de prueba ─────────────────────────
const app = express();
app.use(express.json());
// Sesión simulada con el mismo contrato que `requireSesionNegocio(rol)`. La
// prueba con el servidor y las sesiones reales es fase-catalogo-whatsapp-panel.
const requireSesionNegocio = (rolMinimo) => (req, res, next) => {
  const neg = req.get('x-prueba-negocio');
  if (!neg) return res.status(401).json({ error: 'sin sesión' });
  req.negocioId = neg;
  req.rol = req.get('x-prueba-rol') || 'staff';
  if (rolMinimo === 'admin' && req.rol !== 'admin') return res.status(403).json({ error: 'Permiso insuficiente' });
  return next();
};
const requireModulo = (modulo) => (req, res, next) => (req.get('x-prueba-sin-modulo') === modulo
  ? res.status(403).json({ codigo: 'modulo_no_contratado', error: 'Módulo no contratado' }) : next());
registrarRutasCatalogoWhatsapp(app, { requireSesionNegocio, requireModulo });
const servidor = app.listen(0);
await new Promise((ok) => servidor.once('listening', ok));
const BASE = `http://127.0.0.1:${servidor.address().port}`;
const llamar = async (ruta, { negocio: neg = A, rol = 'admin', cuerpo, metodo = 'POST', sinModulo = null } = {}) => {
  const headers = { 'Content-Type': 'application/json', ...(neg ? { 'x-prueba-negocio': neg } : {}),
    ...(rol ? { 'x-prueba-rol': rol } : {}), ...(sinModulo ? { 'x-prueba-sin-modulo': sinModulo } : {}) };
  const r = await fetch(`${BASE}${ruta}`, { method: metodo, headers, ...(cuerpo ? { body: JSON.stringify(cuerpo) } : {}) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

try {
  await t('W1 un producto nuevo nace sin publicar: no está en la carta del agente', async () => {
    assert.equal(await fila(A, P.waffle), null);
    const { carta, nombresOcultos, error } = await obtenerCatalogoDelAgente(A);
    assert.equal(error, null);
    assert.deepEqual(carta, [], 'sin nada publicado la carta del agente tiene que estar vacía');
    assert.ok(nombresOcultos.includes(`${MARCA}Waffle`));
    const lista = await listarProductosWhatsapp(A);
    assert.equal(lista.length, 5);
    assert.ok(lista.every((p) => p.publicado === false));
  });

  await t('W2 publicar por la ruta: aparece en la carta; lo demás sigue oculto', async () => {
    const r = await llamar('/api/admin/whatsapp/productos/publicar', { cuerpo: { productoIds: [P.waffle, P.cafe], publicado: true } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.actualizados, 2);
    const { carta, nombresOcultos } = await obtenerCatalogoDelAgente(A);
    assert.deepEqual(nombresCarta(carta), [`${MARCA}Café`, `${MARCA}Waffle`]);
    assert.deepEqual(carta.map((c) => c.nombre), [`${MARCA}Desayunos`], 'EXTRAS sin publicados no puede aparecer');
    assert.ok(nombresOcultos.includes(`${MARCA}Pieza de Hotcake`) && nombresOcultos.includes(`${MARCA}Extra Huevo`));
    assert.ok(!nombresOcultos.includes(`${MARCA}Waffle`));
    assert.deepEqual((await fila(A, P.waffle)), { publicado: true, origen: 'panel' });
  });

  await t('W3 solo el administrador con el módulo: staff 403, sin sesión 401, sin módulo 403', async () => {
    const cuerpo = { productoIds: [P.pieza], publicado: true };
    assert.equal((await llamar('/api/admin/whatsapp/productos/publicar', { rol: 'staff', cuerpo })).status, 403);
    assert.equal((await llamar('/api/admin/whatsapp/productos/publicar', { negocio: null, cuerpo })).status, 401);
    assert.equal((await llamar('/api/admin/whatsapp/productos/publicar', { sinModulo: 'whatsapp', cuerpo })).status, 403);
    assert.equal((await llamar('/api/admin/whatsapp/productos', { rol: 'staff', metodo: 'GET' })).status, 403);
    assert.equal(await fila(A, P.pieza), null, 'un intento rechazado publicó igual');
  });

  await t('W4 el negocio sale de la sesión: ni un negocioId ni un producto ajenos publican nada', async () => {
    const r = await llamar('/api/admin/whatsapp/productos/publicar',
      { cuerpo: { negocioId: B, productoIds: [pizzaB], publicado: true } });
    assert.equal(r.status, 200);
    assert.equal(r.body.actualizados, 0);
    assert.equal(await fila(B, pizzaB), null);
    assert.equal(await fila(A, pizzaB), null);
    await assert.rejects(
      pool.query('INSERT INTO whatsapp_productos (negocio_id, producto_id, publicado) VALUES ($1,$2,TRUE)', [A, pizzaB]),
      /fk_whatsapp_producto_negocio|foreign key/i, 'la FK compuesta dejó publicar un producto de otro negocio');
    const listaA = await llamar('/api/admin/whatsapp/productos', { metodo: 'GET' });
    assert.ok(!listaA.body.productos.some((p) => p.id === pizzaB), 'el panel de A lista productos de B');
    assert.equal((await obtenerCatalogoDelAgente(B)).carta.length, 0);
  });

  await t('W5 ofrecer y retirar una categoría; retirar deja las filas en FALSE', async () => {
    let r = await llamar('/api/admin/whatsapp/categorias/publicar', { cuerpo: { categoriaId: extrasA, publicado: true } });
    assert.equal(r.status, 200);
    assert.ok(nombresCarta((await obtenerCatalogoDelAgente(A)).carta).includes(`${MARCA}Extra Huevo`));
    r = await llamar('/api/admin/whatsapp/categorias/publicar', { cuerpo: { categoriaId: catA, publicado: false } });
    assert.equal(r.body.actualizados, 3);
    const filas = (await pool.query(`SELECT count(*)::int AS n, count(*) FILTER (WHERE publicado)::int AS pub
      FROM whatsapp_productos WHERE negocio_id=$1 AND producto_id = ANY($2::int[])`, [A, [P.waffle, P.cafe, P.pieza]])).rows[0];
    assert.deepEqual(filas, { n: 3, pub: 0 }, 'retirar tiene que dejar la fila en FALSE, no borrarla');
    assert.deepEqual((await obtenerCatalogoDelAgente(A)).carta.map((c) => c.nombre), [`${MARCA}EXTRAS`]);
  });

  await t('W6 una categoría oculta en el menú no se ofrece aunque su producto esté publicado', async () => {
    await llamar('/api/admin/whatsapp/productos/publicar', { cuerpo: { productoIds: [P.pan], publicado: true } });
    assert.ok(!nombresCarta((await obtenerCatalogoDelAgente(A)).carta).includes(`${MARCA}Pan de Temporada`));
    assert.ok(!(await idsPublicadosEnWhatsapp(A)).has(P.pan));
  });

  await t('W7 cuerpos inválidos: 400 y nada escrito', async () => {
    const antes = (await pool.query('SELECT count(*)::int AS n FROM whatsapp_productos WHERE negocio_id=$1', [A])).rows[0].n;
    assert.equal((await llamar('/api/admin/whatsapp/productos/publicar',
      { cuerpo: { productoIds: [P.pieza], publicado: 'true' } })).status, 400);
    assert.equal((await llamar('/api/admin/whatsapp/categorias/publicar',
      { cuerpo: { categoriaId: 'abc', publicado: true } })).status, 400);
    const despues = (await pool.query('SELECT count(*)::int AS n FROM whatsapp_productos WHERE negocio_id=$1', [A])).rows[0].n;
    assert.equal(despues, antes);
  });

  await t('W8 si la publicación no se puede leer, la carta del agente sale VACÍA (nunca el menú entero)', async () => {
    const dbRota = { query: async () => { throw new Error('conexión perdida'); } };
    const r = await obtenerCatalogoDelAgente(A, { db: dbRota });
    assert.deepEqual(r.carta, []);
    assert.equal(r.error, 'lectura_publicacion');
    assert.ok(r.nombresOcultos.includes(`${MARCA}Waffle`), 'sin carta, todo el menú cuenta como oculto para la emisión');
  });

  await t('W9 re-ejecutar la migración 098 no siembra de nuevo ni vuelve a publicar lo retirado', async () => {
    // Un producto publicado en la Tienda y nunca tocado para WhatsApp: la
    // siembra solo ocurre la PRIMERA vez que la tabla nace; una re-ejecución
    // no puede publicarlo por su cuenta.
    const deTienda = await producto(A, catA, 'Solo en Tienda', 90);
    await pool.query('INSERT INTO tienda_productos (negocio_id, producto_id, publicado) VALUES ($1,$2,TRUE)', [A, deTienda]);
    const sql = readFileSync(new URL('../migrations/098_catalogo_whatsapp.sql', import.meta.url), 'utf8');
    const antes = (await pool.query('SELECT producto_id, publicado, origen FROM whatsapp_productos WHERE negocio_id=$1 ORDER BY 1', [A])).rows;
    await pool.query(sql);
    await pool.query(sql);
    const despues = (await pool.query('SELECT producto_id, publicado, origen FROM whatsapp_productos WHERE negocio_id=$1 ORDER BY 1', [A])).rows;
    assert.deepEqual(despues, antes);
    assert.equal(await fila(A, deTienda), null, 'la re-ejecución sembró otra vez desde la Tienda');
    await pool.query('DELETE FROM tienda_productos WHERE negocio_id=$1', [A]);
  });

  await t('W10 borrar un producto del menú borra su publicación (FK en cascada)', async () => {
    const temporal = await producto(A, extrasA, 'Temporal', 10);
    await llamar('/api/admin/whatsapp/productos/publicar', { cuerpo: { productoIds: [temporal], publicado: true } });
    assert.ok(await fila(A, temporal));
    await pool.query('DELETE FROM menu_productos WHERE negocio_id=$1 AND id=$2', [A, temporal]);
    assert.equal(await fila(A, temporal), null);
  });
} finally {
  servidor.close();
  for (const n of negocios) {
    for (const sql of ['DELETE FROM whatsapp_productos WHERE negocio_id=$1', 'DELETE FROM menu_productos WHERE negocio_id=$1',
      'DELETE FROM menu_categorias WHERE negocio_id=$1', 'DELETE FROM negocios WHERE id=$1']) {
      await pool.query(sql, [n]).catch(() => {});
    }
  }
  await pool.end().catch(() => {});
}

console.log(`\n${'─'.repeat(70)}`);
console.log(`${pasadas} pasadas, ${fallos.length} fallidas de ${pasadas + fallos.length}`);
for (const f of fallos) console.log(`  · ${f}`);
process.exit(fallos.length ? 1 : 0);
