// Motor de PROMOCIONES multi-canal (2x1, segundo producto %, %, fijo).
//
// LA IA NUNCA CALCULA PROMOCIONES: el backend es la única fuente de verdad.
// Esta suite prueba el motor (calcularPromociones) y su integración con el
// pricing real de órdenes (validarOrdenPropuesta, canal LLM). Determinista:
// se inyecta `ahora` para las pruebas de día/vigencia.
//
// Uso: DATABASE_URL=... node test/fase-promociones.mjs
import assert from 'assert';

const { pool } = await import('../src/services/database.js');
const { calcularPromociones, guardarPromocion, listarPromociones, eliminarPromocion } =
  await import('../src/services/tiendaPromociones.js');
const { partesEnZona } = await import('../src/services/tiendaOnline.js');
const { validarOrdenPropuesta } = await import('../src/orders/validadorOrden.js');

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

const NEG_A = await montarNegocio('promo-eng-a', 'Promo Demo A');
const NEG_B = await montarNegocio('promo-eng-b', 'Promo Demo B');
await limpiar(NEG_A); await limpiar(NEG_B);

const catHotcakes = await categoria(NEG_A, 'HOTCAKES');
const catAlmuerzos = await categoria(NEG_A, 'ALMUERZOS AMERICANOS');
const catOmelettes = await categoria(NEG_A, 'OMELETTES');
const catBebidas = await categoria(NEG_A, 'BEBIDAS');
const pProtein = await producto(NEG_A, catHotcakes, 'Protein Pancakes', 169);
const pHotcake = await producto(NEG_A, catHotcakes, 'Hotcake Tradicional', 150);
const pOmeletteClaras = await producto(NEG_A, catOmelettes, 'Omelette de Claras', 198);
const pCafe = await producto(NEG_A, catBebidas, 'Café Americano', 25);

// Item de carrito para el motor (ya enriquecido con categoria_id + precio_base).
const item = (pid, catId, precio, cantidad = 1, extra = 0) =>
  ({ producto_id: pid, categoria_id: catId, precio_unitario: precio + extra, precio_base: precio, cantidad });

async function nueva2x1(extra = {}) {
  const { id } = await guardarPromocion(NEG_A, {
    nombre: extra.nombre || 'Martes 2x1 Hotcakes+Almuerzos', tipo: '2x1', automatica: true,
    cantidadRequerida: 2, cantidadBeneficiada: 1,
    categorias: extra.categorias || [catHotcakes, catAlmuerzos],
    canales: extra.canales || ['pos', 'whatsapp'],
    diasSemana: extra.diasSemana, horaInicio: extra.horaInicio, horaFin: extra.horaFin,
    vigenciaDesde: extra.vigenciaDesde, vigenciaHasta: extra.vigenciaHasta,
    acumulable: extra.acumulable, prioridad: extra.prioridad,
  });
  return id;
}
const calc = (items, o = {}) => calcularPromociones({
  negocioId: NEG_A, subtotal: items.reduce((s, i) => s + i.precio_unitario * i.cantidad, 0),
  items, canal: o.canal || 'pos', modalidad: o.modalidad || 'recoger', timezone: TZ, ahora: o.ahora || new Date(),
});
async function borraPromos() { await pool.query(`DELETE FROM tienda_promociones WHERE negocio_id=$1`, [NEG_A]); }

// ═══════════ TESTS ═══════════
await t('TEST 1 · 2x1: 2 Hotcakes elegibles → aplica, gratis el de menor precio', async () => {
  const id = await nueva2x1();
  const r = await calc([item(pProtein, catHotcakes, 169), item(pHotcake, catHotcakes, 150)]);
  assert.strictEqual(r.descuento, 150, `descuento esperado 150 (el más barato); fue ${r.descuento}`);
  assert.strictEqual(r.total, 169);
  assert.strictEqual(r.aplicadas[0].tipo, '2x1');
  await eliminarPromocion(NEG_A, id); await borraPromos();
});

await t('TEST 2 · 2x1: Protein elegible + Omelette NO elegible → NO aplica (0)', async () => {
  await nueva2x1(); // participantes: HOTCAKES + ALMUERZOS (no OMELETTES)
  const r = await calc([item(pProtein, catHotcakes, 169), item(pOmeletteClaras, catOmelettes, 198)]);
  assert.strictEqual(r.descuento, 0, 'una sola unidad elegible no forma pareja 2x1');
  assert.strictEqual(r.total, 367);
  await borraPromos();
});

await t('TEST 3 · 2x1: dos elegibles con precios distintos → descuenta el menor', async () => {
  await nueva2x1();
  const r = await calc([item(pProtein, catHotcakes, 169), item(pHotcake, catHotcakes, 150)]);
  assert.strictEqual(r.descuento, 150);
  await borraPromos();
});

await t('TEST 4 · segundo producto 50% → exactamente 50%, no gratis', async () => {
  const { id } = await guardarPromocion(NEG_A, {
    nombre: '2do al 50% Hotcakes', tipo: 'segundo_descuento', automatica: true, valor: 50,
    cantidadRequerida: 2, cantidadBeneficiada: 1, categorias: [catHotcakes], canales: ['pos'],
  });
  // A 180, B 160 → el más barato (160) recibe 50% = 80
  const pA = await producto(NEG_A, catHotcakes, 'HC A', 180);
  const pB = await producto(NEG_A, catHotcakes, 'HC B', 160);
  const r = await calc([item(pA, catHotcakes, 180), item(pB, catHotcakes, 160)]);
  assert.strictEqual(r.descuento, 80, `50% de 160 = 80; fue ${r.descuento}`);
  await eliminarPromocion(NEG_A, id); await borraPromos();
});

await t('TEST 5 · día incorrecto → no aplica', async () => {
  const ahora = new Date('2026-09-01T18:00:00-06:00'); // un día fijo
  const dia = partesEnZona(ahora, TZ).diaSemana;
  await nueva2x1({ diasSemana: [(dia + 1) % 7] }); // solo OTRO día
  const r = await calc([item(pProtein, catHotcakes, 169), item(pHotcake, catHotcakes, 150)], { ahora });
  assert.strictEqual(r.descuento, 0, 'fuera del día configurado no aplica');
  await borraPromos();
});

await t('TEST 6 · fuera de vigencia → no aplica', async () => {
  await nueva2x1({ vigenciaDesde: '2020-01-01', vigenciaHasta: '2020-12-31' });
  const r = await calc([item(pProtein, catHotcakes, 169), item(pHotcake, catHotcakes, 150)], { ahora: new Date() });
  assert.strictEqual(r.descuento, 0);
  await borraPromos();
});

await t('TEST 7 · canal no participante → no aplica', async () => {
  await nueva2x1({ canales: ['tienda_online'] });
  const r = await calc([item(pProtein, catHotcakes, 169), item(pHotcake, catHotcakes, 150)], { canal: 'pos' });
  assert.strictEqual(r.descuento, 0, 'promo de tienda_online no aplica en POS');
  await borraPromos();
});

await t('TEST 8 · cantidad 3 → un solo beneficio 2x1', async () => {
  await nueva2x1();
  const r = await calc([item(pProtein, catHotcakes, 169, 1), item(pHotcake, catHotcakes, 150, 2)]); // 3 unidades: 169,150,150
  assert.strictEqual(r.descuento, 150, '3 unidades → 1 grupo → 1 gratis (el más barato 150)');
  await borraPromos();
});

await t('TEST 9 · cantidad 4 → dos beneficios correctos', async () => {
  await nueva2x1();
  const pC = await producto(NEG_A, catHotcakes, 'HC 120', 120);
  const pD = await producto(NEG_A, catHotcakes, 'HC 200', 200);
  // unidades: 100(usamos 120), etc. -> [120,150,169,200]; 2 gratis = 2 más baratas = 120+150=270
  const r = await calc([item(pC, catHotcakes, 120), item(pHotcake, catHotcakes, 150), item(pProtein, catHotcakes, 169), item(pD, catHotcakes, 200)]);
  assert.strictEqual(r.descuento, 270, `2 más baratas (120+150)=270; fue ${r.descuento}`);
  await borraPromos();
});

await t('TEST 10 · extras NO se regalan (beneficio sobre precio base)', async () => {
  await nueva2x1();
  // Dos Hotcakes de $169 base, uno con +$30 de extra. El 2x1 descuenta 169 (base), no 199.
  const r = await calc([item(pProtein, catHotcakes, 169, 1, 30), item(pHotcake, catHotcakes, 169, 1, 0)]);
  assert.strictEqual(r.descuento, 169, `beneficio sobre precio base 169, no 199; fue ${r.descuento}`);
  await borraPromos();
});

await t('TEST 11+12 · quitar/cambiar cantidad → recalcula (motor sin estado)', async () => {
  await nueva2x1();
  const dos = await calc([item(pProtein, catHotcakes, 169), item(pHotcake, catHotcakes, 150)]);
  assert.strictEqual(dos.descuento, 150);
  const uno = await calc([item(pProtein, catHotcakes, 169)]); // se quitó uno
  assert.strictEqual(uno.descuento, 0, 'con un solo item el 2x1 deja de aplicar');
  await borraPromos();
});

await t('TEST 13 · dos promos incompatibles → no duplica descuento', async () => {
  await nueva2x1({ nombre: '2x1', acumulable: false, prioridad: 1 });
  await guardarPromocion(NEG_A, { nombre: '20% Hotcakes', tipo: 'porcentaje', automatica: true, valor: 20, categorias: [catHotcakes], canales: ['pos'], acumulable: false, prioridad: 2 });
  const r = await calc([item(pProtein, catHotcakes, 169), item(pHotcake, catHotcakes, 150)]);
  // Solo una (la no-acumulable de menor prioridad = el 2x1) → 150, no 150+%.
  assert.strictEqual(r.aplicadas.length, 1, `una sola promo aplicada; fueron ${r.aplicadas.length}`);
  assert.strictEqual(r.descuento, 150);
  await borraPromos();
});

await t('TEST 14 · multi-tenant: promo de A no aplica a negocio B', async () => {
  const id = await nueva2x1();
  // Mismo carrito, pero evaluado para NEG_B (que no tiene esa promo).
  const r = await calcularPromociones({ negocioId: NEG_B, subtotal: 319,
    items: [item(pProtein, catHotcakes, 169), item(pHotcake, catHotcakes, 150)], canal: 'pos', modalidad: 'recoger', timezone: TZ });
  assert.strictEqual(r.descuento, 0, 'B no ve las promociones de A');
  await eliminarPromocion(NEG_A, id); await borraPromos();
});

await t('TEST 15 · snapshot histórico: desactivar la promo después NO cambia la orden ya calculada', async () => {
  const id = await nueva2x1({ canales: ['whatsapp'] });
  const orden = { canal: 'whatsapp', modalidad: 'recoger', forma_pago: 'efectivo',
    items: [{ nombre: 'Protein Pancakes', cantidad: 1, precio_unitario: 0 }, { nombre: 'Hotcake Tradicional', cantidad: 1, precio_unitario: 0 }] };
  const v = await validarOrdenPropuesta(orden, NEG_A, { canal: 'whatsapp' });
  assert.ok(v.ok, 'la orden debe validar');
  const snapshotDescuento = v.orden.descuento;
  assert.strictEqual(snapshotDescuento, 150, `descuento snapshot 150; fue ${snapshotDescuento}`);
  // Desactivar la promo AHORA no debe alterar el objeto orden ya calculado.
  await eliminarPromocion(NEG_A, id);
  assert.strictEqual(v.orden.descuento, 150, 'el snapshot de la orden es inmutable');
  assert.strictEqual(v.orden.promociones.length, 1);
  await borraPromos();
});

await t('TEST 16+18 · LLM: el modelo NO calcula; Omelette no participante → descuento 0', async () => {
  await nueva2x1({ categorias: [catHotcakes, catAlmuerzos], canales: ['whatsapp'] });
  // El modelo manda precios inventados (incl. 0 y descuento) → se ignoran.
  const orden = { canal: 'whatsapp', modalidad: 'recoger', forma_pago: 'efectivo', descuento: 999,
    items: [{ nombre: 'Protein Pancakes', cantidad: 1, precio_unitario: 0 }, { nombre: 'Omelette de Claras', cantidad: 1, precio_unitario: 0 }] };
  const v = await validarOrdenPropuesta(orden, NEG_A, { canal: 'whatsapp' });
  assert.ok(v.ok);
  assert.strictEqual(v.orden.subtotal, 367, 'precios reales de catálogo, no los del modelo');
  assert.strictEqual(v.orden.descuento, 0, 'Omelette no participa → 0 (el modelo no puede regalarlo)');
  assert.strictEqual(v.orden.total, 367);
  await borraPromos();
});

await t('TEST 19 · LLM: Protein + Hotcake participante → descuento 150, total 169', async () => {
  await nueva2x1({ categorias: [catHotcakes], canales: ['whatsapp'] });
  const orden = { canal: 'whatsapp', modalidad: 'recoger', forma_pago: 'efectivo',
    items: [{ nombre: 'Protein Pancakes', cantidad: 1 }, { nombre: 'Hotcake Tradicional', cantidad: 1 }] };
  const v = await validarOrdenPropuesta(orden, NEG_A, { canal: 'whatsapp' });
  assert.ok(v.ok);
  assert.strictEqual(v.orden.subtotal, 319);
  assert.strictEqual(v.orden.descuento, 150);
  assert.strictEqual(v.orden.total, 169);
  assert.strictEqual(v.orden.promociones[0].tipo, '2x1');
  await borraPromos();
});

await t('TEST 17 · listar promociones vigentes estructuradas (para "¿qué promociones tienen?")', async () => {
  await nueva2x1({ nombre: 'Martes 2x1' });
  const lista = await listarPromociones(NEG_A);
  const p = lista.find(x => x.nombre === 'Martes 2x1');
  assert.ok(p, 'la promo aparece en el listado');
  assert.strictEqual(p.tipo, '2x1');
  assert.strictEqual(p.cantidadRequerida, 2);
  assert.ok(Array.isArray(p.canales) && p.canales.includes('pos'));
  await borraPromos();
});

await t('TEST extra · oportunidad: 1 Protein con 2x1 activo → sugiere agregar 1 más', async () => {
  await nueva2x1();
  const r = await calc([item(pProtein, catHotcakes, 169)]);
  assert.strictEqual(r.descuento, 0);
  assert.strictEqual(r.oportunidades.length, 1);
  assert.strictEqual(r.oportunidades[0].unidadesFaltantes, 1);
  await borraPromos();
});

await t('TEST extra · validaciones: %>100, cantidad beneficiada > requerida, sin nombre', async () => {
  await assert.rejects(() => guardarPromocion(NEG_A, { nombre: 'x', tipo: 'porcentaje', automatica: true, valor: 150 }), /entre 1 y 100/);
  await assert.rejects(() => guardarPromocion(NEG_A, { nombre: 'x', tipo: '2x1', automatica: true, cantidadRequerida: 1, cantidadBeneficiada: 3 }), /no puede exceder/);
  await assert.rejects(() => guardarPromocion(NEG_A, { nombre: '', tipo: '2x1', automatica: true }), /nombre/);
});

// ── Limpieza ────────────────────────────────────────────────────────────────
await limpiar(NEG_A); await limpiar(NEG_B);
console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallos.length) { console.log('FALLOS:'); fallos.forEach(f => console.log(' - ' + f)); }
await pool.end?.().catch(() => {});
process.exit(fallidas ? 1 : 0);
