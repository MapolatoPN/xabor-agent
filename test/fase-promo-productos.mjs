// Promociones por PRODUCTOS ESPECÍFICOS (elegibilidad por producto + aislamiento).
//
// El motor ya soportaba `promo.productos`; esta suite certifica el camino
// completo que expone la UI nueva: guardar/editar con product_ids, que solo
// apliquen los productos marcados (independiente de su categoría) y que sea
// IMPOSIBLE asociar un producto de otro negocio (aislamiento estricto).
//
// Uso: DATABASE_URL=... node test/fase-promo-productos.mjs
import assert from 'assert';

const { pool } = await import('../src/services/database.js');
const { calcularPromociones, guardarPromocion, listarPromociones } =
  await import('../src/services/tiendaPromociones.js');

const TZ = 'America/Matamoros';
let pasadas = 0, fallidas = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

// ── Fixtures ────────────────────────────────────────────────────────────────
async function montarNegocio(slug, nombre) {
  const { rows: [n] } = await pool.query(
    `INSERT INTO negocios (nombre, slug) VALUES ($1,$2) ON CONFLICT (slug) DO UPDATE SET nombre=$1 RETURNING id`, [nombre, slug]);
  return n.id;
}
async function categoria(negocioId, nombre) {
  const { rows } = await pool.query(
    `INSERT INTO menu_categorias (negocio_id, nombre, orden) VALUES ($1,$2,0) ON CONFLICT DO NOTHING RETURNING id`, [negocioId, nombre]);
  if (rows[0]) return rows[0].id;
  return (await pool.query(`SELECT id FROM menu_categorias WHERE negocio_id=$1 AND nombre=$2 LIMIT 1`, [negocioId, nombre])).rows[0].id;
}
async function producto(negocioId, catId, nombre, precio) {
  const { rows } = await pool.query(
    `INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio) VALUES ($1,$2,$3,$4) RETURNING id`, [negocioId, catId, nombre, precio]);
  return rows[0].id;
}
async function limpiar(negocioId) {
  await pool.query(`DELETE FROM tienda_promociones WHERE negocio_id=$1`, [negocioId]).catch(() => {});
  await pool.query(`DELETE FROM menu_productos WHERE negocio_id=$1`, [negocioId]).catch(() => {});
  await pool.query(`DELETE FROM menu_categorias WHERE negocio_id=$1`, [negocioId]).catch(() => {});
}

const NEG_A = await montarNegocio('promo-prod-a', 'Promo Prod A');
const NEG_B = await montarNegocio('promo-prod-b', 'Promo Prod B');
await limpiar(NEG_A); await limpiar(NEG_B);

// Una sola categoría en A: probamos que la elegibilidad es POR PRODUCTO, no por
// categoría — todos comparten categoría, pero solo aplican los marcados.
const catDesayunos = await categoria(NEG_A, 'DESAYUNOS');
const pHotcakes  = await producto(NEG_A, catDesayunos, 'Hotcakes Tradicionales', 150);
const pProtein   = await producto(NEG_A, catDesayunos, 'Protein Pancakes', 170);
const pWaffles   = await producto(NEG_A, catDesayunos, 'Waffles', 160);
const pOmelette  = await producto(NEG_A, catDesayunos, 'Omelette de Claras', 198); // NO participa
// Negocio B: su propio producto (nunca debe poder asociarse a una promo de A).
const catB = await categoria(NEG_B, 'OTROS');
const pForaneo = await producto(NEG_B, catB, 'Producto de Otro Negocio', 99);

const SELECCION = [pHotcakes, pProtein, pWaffles];

const item = (pid, precio, cantidad = 1, extra = 0) =>
  ({ producto_id: pid, categoria_id: catDesayunos, precio_unitario: precio + extra, precio_base: precio, cantidad });
const calc = (items) => calcularPromociones({
  negocioId: NEG_A, subtotal: items.reduce((s, i) => s + i.precio_unitario * i.cantidad, 0),
  items, canal: 'pos', modalidad: 'recoger', timezone: TZ, ahora: new Date(),
});
async function crear2x1Productos(productos = SELECCION) {
  return (await guardarPromocion(NEG_A, {
    nombre: 'Martes 2x1', tipo: '2x1', automatica: true,
    cantidadRequerida: 2, cantidadBeneficiada: 1,
    productos, canales: ['pos', 'whatsapp'],
  })).id;
}
async function borraPromos() { await pool.query(`DELETE FROM tienda_promociones WHERE negocio_id=$1`, [NEG_A]); }

// ═══════════ TESTS ═══════════

await t('TEST 1 · crear promoción con 3 productos específicos → se guarda con esos IDs', async () => {
  const id = await crear2x1Productos();
  const promos = await listarPromociones(NEG_A);
  const p = promos.find(x => x.id === id);
  assert.ok(p, 'la promoción creada debe listarse');
  assert.ok(Array.isArray(p.productos), 'productos debe ser un arreglo');
  assert.deepStrictEqual([...p.productos].map(Number).sort((a, b) => a - b),
    [...SELECCION].map(Number).sort((a, b) => a - b), 'deben quedar exactamente los 3 IDs seleccionados');
  assert.strictEqual(p.categorias, null, 'no debe fijar categorías cuando participa por productos');
  await borraPromos();
});

await t('TEST 2 · guardar y volver a editar → los 3 productos siguen preseleccionados', async () => {
  const id = await crear2x1Productos();
  // "Volver a editar" = releer lo persistido; la UI hace prodsSel de aquí.
  const p = (await listarPromociones(NEG_A)).find(x => x.id === id);
  const sel = new Set((p.productos || []).map(Number));
  assert.ok(sel.has(Number(pHotcakes)) && sel.has(Number(pProtein)) && sel.has(Number(pWaffles)),
    'los tres marcados deben aparecer preseleccionados');
  assert.ok(!sel.has(Number(pOmelette)), 'el no marcado NO debe aparecer seleccionado');
  await borraPromos();
});

await t('TEST 3 · producto seleccionado → aplica (2x1 regala el de menor precio)', async () => {
  await crear2x1Productos();
  // Hotcakes(150) + Protein(170), ambos marcados → aplica, gratis el de 150.
  const r = await calc([item(pHotcakes, 150), item(pProtein, 170)]);
  assert.strictEqual(r.descuento, 150, `esperado 150; fue ${r.descuento}`);
  assert.strictEqual(r.total, 170);
  assert.strictEqual(r.aplicadas[0]?.tipo, '2x1');
  await borraPromos();
});

await t('TEST 4 · mismo producto marcado, cantidad 2 → aplica', async () => {
  await crear2x1Productos();
  const r = await calc([item(pWaffles, 160, 2)]);
  assert.strictEqual(r.descuento, 160, `un par del producto marcado forma 2x1; fue ${r.descuento}`);
  await borraPromos();
});

await t('TEST 5 · producto NO seleccionado de la MISMA categoría → NO aplica', async () => {
  await crear2x1Productos();
  // Omelette (misma categoría DESAYUNOS) NO está en la selección: 2 no aplican.
  const r = await calc([item(pOmelette, 198, 2)]);
  assert.strictEqual(r.descuento, 0, 'un producto de la categoría pero NO marcado no debe aplicar');
  assert.strictEqual(r.total, 396);
  await borraPromos();
});

await t('TEST 6 · marcado + no-marcado (misma categoría) → solo 1 unidad elegible, NO forma 2x1', async () => {
  await crear2x1Productos();
  const r = await calc([item(pHotcakes, 150), item(pOmelette, 198)]);
  assert.strictEqual(r.descuento, 0, 'una sola unidad elegible no forma pareja 2x1');
  await borraPromos();
});

await t('TEST 7 · aislamiento: asociar un producto de OTRO negocio → rechazado (PRODUCTO_AJENO)', async () => {
  await assert.rejects(
    () => guardarPromocion(NEG_A, {
      nombre: 'Intento cruzado', tipo: '2x1', automatica: true,
      cantidadRequerida: 2, cantidadBeneficiada: 1,
      productos: [pForaneo], canales: ['pos'],
    }),
    (e) => e.codigo === 'PRODUCTO_AJENO',
    'debe rechazarse un producto de otro negocio');
  // y no debe haberse creado nada
  assert.strictEqual((await listarPromociones(NEG_A)).length, 0, 'no debe persistir la promo rechazada');
  await borraPromos();
});

await t('TEST 8 · aislamiento: mezcla propio + ajeno → rechazado completo (fail-closed)', async () => {
  await assert.rejects(
    () => guardarPromocion(NEG_A, {
      nombre: 'Mezcla', tipo: '2x1', automatica: true,
      cantidadRequerida: 2, cantidadBeneficiada: 1,
      productos: [pHotcakes, pForaneo], canales: ['pos'],
    }),
    (e) => e.codigo === 'PRODUCTO_AJENO');
  assert.strictEqual((await listarPromociones(NEG_A)).length, 0, 'ni siquiera con un ID propio válido debe colarse');
  await borraPromos();
});

// ═══════════ RESUMEN ═══════════
await limpiar(NEG_A); await limpiar(NEG_B);
await pool.end();
console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallidas) { console.log('Fallos:\n  - ' + fallos.join('\n  - ')); process.exit(1); }
