// El catálogo de Rappi sale del MENÚ REAL del negocio, no de un literal.
//
// Causa cerrada: `construirCatalogoRappi()` devolvía un objeto escrito a mano
// (13 productos con precios de julio: Chicken Louisiana $259 cuando en la
// base vale $180). El dueño editaba su menú en Xabor y Rappi seguía
// publicando lo viejo -- más caro y sin los productos nuevos.
//
// Esta suite fija la fuente de datos y sus filtros. NO envía nada a Rappi:
// solo construye el payload y lo inspecciona.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const FUENTE = readFileSync(join(__dirname, '..', 'src', 'services', 'rappi-api.js'), 'utf8');

const { pool } = await import('../src/services/database.js');
const { construirCatalogoRappi, skuDeProducto, esPublicableEnRappi } = await import('../src/services/rappi-api.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

const NEG_A = SEED.negocioA;
const NEG_B = SEED.negocioB;
const suf = Date.now().toString().slice(-6);
const STORE_A = `STORE_A_${suf}`;
const STORE_B = `STORE_B_${suf}`;

// Fixture con los precios REALES del incidente (aquí sí pueden vivir:
// son datos de prueba, no del código productivo).
const PRODUCTOS_A = [
  { nombre: `RC Chicken Louisiana ${suf}`, precio: 180, codigo: `PANRC1${suf}`, cat: 'Paninis' },
  { nombre: `RC Chicken Parm ${suf}`, precio: 195, codigo: null, cat: 'Paninis' },
  { nombre: `RC Chicken Fit ${suf}`, precio: 179, codigo: null, cat: 'Paninis' },
  { nombre: `RC Refresco ${suf}`, precio: 35, codigo: null, cat: 'Bebidas', conGrupo: true },
  { nombre: `RC Envio ${suf}`, precio: 60, codigo: null, cat: 'Logistica', opciones: { tipo_item: 'envio' } },
  { nombre: `RC Agotado ${suf}`, precio: 99, codigo: null, cat: 'Bebidas', agotado: true },
  { nombre: `RC NoDisponible ${suf}`, precio: 99, codigo: null, cat: 'Ocultos', disponible: false },
];

async function del(sql, params) {
  try { await pool.query(sql, params); } catch (e) { console.warn('[limpieza] paso omitido:', e.message.slice(0, 80)); }
}
async function limpiar() {
  for (const neg of [NEG_A, NEG_B]) {
    await del(`DELETE FROM menu_modificadores_opciones WHERE negocio_id = $1 AND nombre LIKE 'RC %'`, [neg]);
    await del(`DELETE FROM menu_modificadores_grupos WHERE negocio_id = $1 AND nombre LIKE 'RC %'`, [neg]);
    await del(`DELETE FROM menu_productos WHERE negocio_id = $1 AND nombre LIKE 'RC %'`, [neg]);
    await del(`DELETE FROM menu_categorias WHERE negocio_id = $1 AND nombre LIKE 'RC %'`, [neg]);
    await del(`DELETE FROM integraciones_canal WHERE negocio_id = $1 AND canal = 'rappi'`, [neg]);
  }
}

let idsA = {};
try {
  await limpiar();

  // ── Fixture A: menú real con categorías, cargo de envío y un modificador ──
  const catIds = {};
  for (const [i, nombre] of ['Paninis', 'Bebidas', 'Logistica', 'Ocultos', 'Vacia'].entries()) {
    const { rows: [c] } = await pool.query(
      `INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,$2,TRUE,$3) RETURNING id`,
      [NEG_A, `RC ${nombre} ${suf}`, 900 + i]);
    catIds[nombre] = c.id;
  }
  for (const [i, p] of PRODUCTOS_A.entries()) {
    const { rows: [row] } = await pool.query(
      `INSERT INTO menu_productos (negocio_id, categoria_id, codigo, nombre, descripcion, precio, disponible, agotado, orden, opciones)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [NEG_A, catIds[p.cat], p.codigo, p.nombre, `Descripcion de ${p.nombre}`, p.precio,
       p.disponible !== false, p.agotado === true, i + 1, p.opciones ? JSON.stringify(p.opciones) : null]);
    idsA[p.nombre] = row.id;
    if (p.conGrupo) {
      const { rows: [g] } = await pool.query(
        `INSERT INTO menu_modificadores_grupos (negocio_id, producto_id, nombre, requerido, minimo, maximo, orden)
         VALUES ($1,$2,$3,TRUE,1,1,1) RETURNING id`, [NEG_A, row.id, `RC Elige sabor ${suf}`]);
      for (const [j, o] of [['RC Cola', 0], ['RC Naranja', 5], ['RC Apagada', 0]].entries()) {
        await pool.query(
          `INSERT INTO menu_modificadores_opciones (negocio_id, grupo_id, nombre, precio_extra, disponible, orden)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [NEG_A, g.id, `${o[0]} ${suf}`, o[1], o[0] !== 'RC Apagada', j + 1]);
      }
    }
  }
  // Negocio B: menú propio, para probar aislamiento
  const { rows: [catB] } = await pool.query(
    `INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,$2,TRUE,901) RETURNING id`,
    [NEG_B, `RC Otros ${suf}`]);
  await pool.query(
    `INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio, disponible, agotado, orden)
     VALUES ($1,$2,$3,777,TRUE,FALSE,1)`, [NEG_B, catB.id, `RC Producto Ajeno ${suf}`]);
  for (const [neg, store] of [[NEG_A, STORE_A], [NEG_B, STORE_B]]) {
    await pool.query(
      `INSERT INTO integraciones_canal (negocio_id, canal, identificador, nombre, estado, activo)
       VALUES ($1,'rappi',$2,'RC test','activo',TRUE)`, [neg, store]);
  }

  const cat = await construirCatalogoRappi(NEG_A, { storeId: STORE_A });
  const porNombre = (n) => cat.items.find(i => i.name === n);

  await t('1. el catalogo se construye desde la BASE, no de un literal hardcodeado', async () => {
    assert.ok(!/sku:\s*'PAN001'/.test(FUENTE), 'el catálogo literal sigue en el código productivo');
    assert.ok(/FROM menu_productos/.test(FUENTE), 'rappi-api ya no lee menu_productos');
    assert.ok(cat.items.length > 0, 'catálogo vacío');
    // El catálogo trae el menú REAL del negocio (incluye lo que ya tuviera
    // sembrado, no solo el fixture) y desde luego los productos nuevos.
    assert.ok(cat.items.some(i => i.name === `RC Chicken Louisiana ${suf}`),
      'no aparecieron los productos recién creados en la base');
  });

  await t('2. aislamiento multiempresa: el catálogo de A no incluye productos de B', async () => {
    assert.ok(!cat.items.some(i => /Ajeno/.test(i.name)), 'se coló un producto del otro negocio');
    const catB = await construirCatalogoRappi(NEG_B, { storeId: STORE_B });
    assert.ok(catB.items.some(i => /Ajeno/.test(i.name)), 'B no ve su propio producto');
    assert.ok(!catB.items.some(i => /Chicken/.test(i.name)), 'B ve productos de A');
  });

  await t('3. el precio de la BASE se refleja exacto (180/195/179, no 259/270/256)', async () => {
    assert.strictEqual(porNombre(`RC Chicken Louisiana ${suf}`).price, 180);
    assert.strictEqual(porNombre(`RC Chicken Parm ${suf}`).price, 195);
    assert.strictEqual(porNombre(`RC Chicken Fit ${suf}`).price, 179);
  });

  await t('4. producto con opciones.tipo_item=envio EXCLUIDO (estructural, no por nombre)', async () => {
    assert.ok(!porNombre(`RC Envio ${suf}`), 'el cargo de envío se publicó como mercancía');
    assert.strictEqual(esPublicableEnRappi({ opciones: { tipo_item: 'envio' }, disponible: true }), false);
    // Y jamás por texto: un producto llamado "Envio" SIN la marca sí se publica.
    assert.strictEqual(esPublicableEnRappi({ nombre: 'Envío a domicilio', opciones: null, disponible: true }), true);
  });

  await t('5. productos no disponibles o agotados excluidos', async () => {
    assert.ok(!porNombre(`RC NoDisponible ${suf}`), 'se publicó un producto deshabilitado');
    assert.ok(!porNombre(`RC Agotado ${suf}`), 'se publicó un producto agotado');
  });

  await t('6. categorías sin productos publicables NO se publican', async () => {
    const cats = new Set(cat.items.map(i => i.category.name));
    assert.ok(!cats.has(`RC Vacia ${suf}`), 'se publicó una categoría vacía');
    assert.ok(!cats.has(`RC Logistica ${suf}`), 'se publicó la categoría que solo tenía el cargo de envío');
    assert.ok(!cats.has(`RC Ocultos ${suf}`), 'se publicó una categoría cuyo único producto está deshabilitado');
    assert.ok(cats.has(`RC Paninis ${suf}`) && cats.has(`RC Bebidas ${suf}`));
  });

  await t('7. SKU estable entre dos construcciones (y no depende del orden del arreglo)', async () => {
    const otra = await construirCatalogoRappi(NEG_A, { storeId: STORE_A });
    const mapa = (c) => Object.fromEntries(c.items.map(i => [i.name, i.sku]));
    assert.deepStrictEqual(mapa(otra), mapa(cat), 'los SKU cambiaron entre dos construcciones');
    // Reordenar el menú no puede cambiar la identidad del producto.
    await pool.query(`UPDATE menu_productos SET orden = 50 WHERE id = $1`, [idsA[`RC Chicken Louisiana ${suf}`]]);
    const tras = await construirCatalogoRappi(NEG_A, { storeId: STORE_A });
    assert.strictEqual(mapa(tras)[`RC Chicken Louisiana ${suf}`], mapa(cat)[`RC Chicken Louisiana ${suf}`],
      'el SKU cambió al reordenar el menú');
    await pool.query(`UPDATE menu_productos SET orden = 1 WHERE id = $1`, [idsA[`RC Chicken Louisiana ${suf}`]]);
  });

  await t('8. SKU sin colisiones y con identidad conocida por Rappi cuando existe codigo', async () => {
    const skus = cat.items.map(i => i.sku);
    assert.strictEqual(new Set(skus).size, skus.length, `SKU duplicados: ${skus.join(',')}`);
    // El producto con `codigo` conserva el que Rappi ya conoce.
    assert.strictEqual(porNombre(`RC Chicken Louisiana ${suf}`).sku, `PANRC1${suf}`);
    // El que no tiene código usa la PK, que es inmutable.
    assert.strictEqual(porNombre(`RC Chicken Parm ${suf}`).sku, `XB-${idsA[`RC Chicken Parm ${suf}`]}`);
    assert.strictEqual(skuDeProducto({ id: 7, codigo: '  ' }), 'XB-7');
  });

  await t('9. producto SIN modificadores reales => CERO toppings inventados', async () => {
    for (const n of [`RC Chicken Louisiana ${suf}`, `RC Chicken Parm ${suf}`, `RC Chicken Fit ${suf}`]) {
      assert.deepStrictEqual(porNombre(n).children, [], `${n} trajo toppings inventados`);
    }
  });

  await t('10. producto CON modificadores reales => contrato Rappi correcto (y opción apagada fuera)', async () => {
    const refresco = porNombre(`RC Refresco ${suf}`);
    assert.strictEqual(refresco.children.length, 2, `toppings: ${refresco.children.length} (la opción apagada no se publica)`);
    const cola = refresco.children.find(c => /RC Cola/.test(c.name));
    const naranja = refresco.children.find(c => /RC Naranja/.test(c.name));
    assert.ok(cola && naranja);
    assert.strictEqual(cola.type, 'TOPPING');
    assert.strictEqual(cola.price, 0);
    assert.strictEqual(naranja.price, 5, 'no se respetó precio_extra');
    assert.strictEqual(cola.category.minQty, 1);
    assert.strictEqual(cola.category.maxQty, 1);
    assert.strictEqual(cola.category.id, naranja.category.id, 'las opciones del mismo grupo deben compartir categoría');
    assert.ok(!refresco.children.some(c => /Apagada/.test(c.name)), 'se publicó una opción deshabilitada');
  });

  await t('11-12. imágenes: no se inventan URLs y su ausencia no rompe el payload', async () => {
    // menu_productos no guarda imagen por producto; el contrato acepta vacío.
    assert.ok(cat.items.every(i => i.imageUrl === ''), 'apareció una URL de imagen inventada');
    assert.ok(cat.items.every(i => typeof i.imageUrl === 'string'), 'imageUrl debe existir como string');
  });

  await t('13. el payload cumple el contrato que Rappi ya aceptó', async () => {
    for (const i of cat.items) {
      assert.strictEqual(typeof i.sku, 'string');
      assert.ok(i.sku.length > 0);
      assert.strictEqual(i.type, 'PRODUCT');
      assert.strictEqual(typeof i.price, 'number');
      assert.ok(Number.isFinite(i.price) && i.price > 0, `precio inválido en ${i.name}`);
      assert.ok(i.category && typeof i.category.id === 'string' && typeof i.category.name === 'string');
      assert.strictEqual(typeof i.category.sortingPosition, 'number');
      assert.strictEqual(typeof i.category.minQty, 'number');
      assert.strictEqual(typeof i.category.maxQty, 'number');
      assert.ok(Array.isArray(i.children));
      assert.strictEqual(typeof i.maxLimit, 'number');
      assert.strictEqual(typeof i.sortingPosition, 'number');
      assert.strictEqual(typeof i.description, 'string');
      for (const c of i.children) {
        assert.strictEqual(c.type, 'TOPPING');
        assert.strictEqual(typeof c.price, 'number');
        assert.ok(c.category && typeof c.category.id === 'string');
      }
    }
    // sortingPosition de categoría arranca en 1 y es consistente por categoría.
    const posPorCat = new Map();
    for (const i of cat.items) {
      const previa = posPorCat.get(i.category.id);
      if (previa !== undefined) assert.strictEqual(i.category.sortingPosition, previa, 'sortingPosition inconsistente en una categoría');
      posPorCat.set(i.category.id, i.category.sortingPosition);
    }
    assert.ok([...posPorCat.values()].includes(1), 'ninguna categoría en posición 1');
  });

  await t('14. storeId correcto por integración (nunca el de otro negocio)', async () => {
    assert.strictEqual(cat.storeId, STORE_A);
    const catB = await construirCatalogoRappi(NEG_B, { storeId: STORE_B });
    assert.strictEqual(catB.storeId, STORE_B);
  });

  await t('15. sin negocio explícito, el builder FALLA CERRADO (jamás publica un menú global)', async () => {
    for (const malo of [undefined, null, '', '   ']) {
      let error = null;
      try { await construirCatalogoRappi(malo); } catch (e) { error = e; }
      assert.ok(error, `aceptó negocioId=${JSON.stringify(malo)}`);
      assert.ok(/negocioId/.test(error.message));
    }
    // La ruta admin usa el negocio de la sesión, no un parámetro del cliente.
    const SERVER = readFileSync(join(__dirname, '..', 'src', 'server.js'), 'utf8');
    assert.ok(/subir-menu', requireAdminSeguro, requireModulo\('rappi'\)/.test(SERVER),
      'la ruta admin dejó de exigir admin de negocio + módulo');
    assert.ok(/await construirCatalogoRappi\(req\.negocioId\)/.test(SERVER),
      'la ruta admin ya no construye con el negocio autenticado');
    assert.ok(!/construirCatalogoRappi\(\)/.test(SERVER), 'quedó una llamada sin negocio');
  });

  await t('16. cero contaminación: dos catálogos seguidos de negocios distintos no se mezclan', async () => {
    const a1 = await construirCatalogoRappi(NEG_A, { storeId: STORE_A });
    const b1 = await construirCatalogoRappi(NEG_B, { storeId: STORE_B });
    const a2 = await construirCatalogoRappi(NEG_A, { storeId: STORE_A });
    assert.deepStrictEqual(a2.items.map(i => i.sku), a1.items.map(i => i.sku));
    const skusB = new Set(b1.items.map(i => i.sku));
    assert.ok(!a2.items.some(i => skusB.has(i.sku)), 'SKUs cruzados entre negocios');
  });

  await t('17. el client_id de Rappi ya no se loguea completo', async () => {
    assert.ok(!/client_id: \$\{CLIENT_ID\}/.test(FUENTE), 'el client_id sigue imprimiéndose completo');
    assert.ok(/client_id: …\$\{String\(CLIENT_ID/.test(FUENTE), 'el log dejó de existir o no está enmascarado');
    assert.ok(!/console\.log\([^)]*CLIENT_SECRET/.test(FUENTE), 'el secret aparece en un log');
  });

} catch (e) {
  console.error('ERROR FATAL:', e.stack || e);
  fallidas++; fallos.push('ERROR FATAL: ' + e.message);
} finally {
  await limpiar();
  await pool.end().catch(() => {});
}

console.log(`\n═══ fase-rappi-catalogo-real: ${pasadas} OK · ${fallidas} fallos ═══`);
if (fallos.length) console.log('Fallos: ' + fallos.join(' | '));
process.exit(fallidas ? 1 : 0);
