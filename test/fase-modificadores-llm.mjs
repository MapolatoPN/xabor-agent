// Modificadores en el PATH DEL LLM (WhatsApp/voz): el importe del extra se
// pierde entre la conversación y el pedido registrado si el validador no
// canoniza los modificadores. Esta suite certifica que:
//   precio_item = precio_base_canónico + modificadores_válidos_canónicos
// el LLM nunca fija el importe, el extra se persiste, y el 2x1 sigue
// descontando SOLO la base (los extras se siguen cobrando).
//
// Uso: DATABASE_URL=... node test/fase-modificadores-llm.mjs
import assert from 'assert';

const { pool } = await import('../src/services/database.js');
const { guardarPromocion } = await import('../src/services/tiendaPromociones.js');
const { validarOrdenPropuesta } = await import('../src/orders/validadorOrden.js');

let pasadas = 0, fallidas = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

// ── Fixtures ──────────────────────────────────────────────────────────────
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
async function grupo(negocioId, productoId, nombre) {
  const { rows } = await pool.query(
    `INSERT INTO menu_modificadores_grupos (negocio_id, producto_id, nombre, requerido, minimo, maximo, orden)
     VALUES ($1,$2,$3,FALSE,0,0,0) RETURNING id`, [negocioId, productoId, nombre]);
  return rows[0].id;
}
async function opcion(negocioId, grupoId, nombre, precioExtra) {
  const { rows } = await pool.query(
    `INSERT INTO menu_modificadores_opciones (negocio_id, grupo_id, nombre, precio_extra, disponible, orden)
     VALUES ($1,$2,$3,$4,TRUE,0) RETURNING id`, [negocioId, grupoId, nombre, precioExtra]);
  return rows[0].id;
}
async function limpiar(negocioId) {
  await pool.query(`DELETE FROM tienda_promociones WHERE negocio_id=$1`, [negocioId]).catch(() => {});
  await pool.query(`DELETE FROM menu_modificadores_opciones WHERE negocio_id=$1`, [negocioId]).catch(() => {});
  await pool.query(`DELETE FROM menu_modificadores_grupos WHERE negocio_id=$1`, [negocioId]).catch(() => {});
  await pool.query(`DELETE FROM menu_productos WHERE negocio_id=$1`, [negocioId]).catch(() => {});
  await pool.query(`DELETE FROM menu_categorias WHERE negocio_id=$1`, [negocioId]).catch(() => {});
}

const NEG = await montarNegocio('mods-llm-a', 'Mods LLM A');
await limpiar(NEG);
const cat = await categoria(NEG, 'DESAYUNOS');
const pHotcakes = await producto(NEG, cat, 'Hotcakes Tradicionales', 149);
const pAlmuerzo = await producto(NEG, cat, 'Almuerzo Americano', 189);
// Extras reales del catálogo (precio SIEMPRE de la base):
const gAlm = await grupo(NEG, pAlmuerzo, 'Extras');
await opcion(NEG, gAlm, 'Salchicha americana', 40);
const gHot = await grupo(NEG, pHotcakes, 'Toppings');
await opcion(NEG, gHot, 'Blueberries', 30);

// Promo 2x1 sobre esos dos productos, SIEMPRE vigente (sin día/horario).
await guardarPromocion(NEG, {
  nombre: 'Martes 2x1', tipo: '2x1', automatica: true, cantidadRequerida: 2, cantidadBeneficiada: 1,
  canales: ['whatsapp', 'pos'], productos: [pHotcakes, pAlmuerzo],
});

const PAGO = 'efectivo';
const ordenBase = (items) => ({ canal: 'whatsapp', modalidad: 'recoger', forma_pago: PAGO, items });
const val = (items) => validarOrdenPropuesta(ordenBase(items), NEG, { canal: 'whatsapp' });

// ═══════════ TESTS ═══════════

await t('TEST 1 · Hotcakes + Almuerzo (sin extras) → subtotal 338, desc 149, total 189', async () => {
  const v = await val([{ nombre: 'Hotcakes Tradicionales', cantidad: 1 }, { nombre: 'Almuerzo Americano', cantidad: 1 }]);
  assert.ok(v.ok, 'debe validar');
  assert.strictEqual(v.orden.subtotal, 338);
  assert.strictEqual(v.orden.descuento, 149);
  assert.strictEqual(v.orden.total, 189);
});

await t('TEST 2 · + Salchicha $40 → subtotal 378, desc 149, total 229 (extra NO se descuenta)', async () => {
  const v = await val([
    { nombre: 'Hotcakes Tradicionales', cantidad: 1 },
    { nombre: 'Almuerzo Americano', cantidad: 1, modificadores: ['Salchicha americana'] },
  ]);
  assert.strictEqual(v.orden.subtotal, 378, `subtotal esperado 378; fue ${v.orden.subtotal}`);
  assert.strictEqual(v.orden.descuento, 149, 'el 2x1 descuenta solo la base más barata (149)');
  assert.strictEqual(v.orden.total, 229, `total esperado 229; fue ${v.orden.total}`);
});

await t('TEST 3 · Hotcakes+Blueberries(30) y Almuerzo+Salchicha(40) → subtotal 408, desc 149, total 259', async () => {
  const v = await val([
    { nombre: 'Hotcakes Tradicionales', cantidad: 1, modificadores: ['Blueberries'] },
    { nombre: 'Almuerzo Americano', cantidad: 1, modificadores: ['Salchicha americana'] },
  ]);
  assert.strictEqual(v.orden.subtotal, 408, `subtotal esperado 408; fue ${v.orden.subtotal}`);
  assert.strictEqual(v.orden.descuento, 149);
  assert.strictEqual(v.orden.total, 259, `total esperado 259; fue ${v.orden.total}`);
});

await t('TEST 4 · quitar la Salchicha → recalcula de 229 a 189', async () => {
  const conExtra = await val([
    { nombre: 'Hotcakes Tradicionales', cantidad: 1 },
    { nombre: 'Almuerzo Americano', cantidad: 1, modificadores: ['Salchicha americana'] },
  ]);
  assert.strictEqual(conExtra.orden.total, 229);
  const sinExtra = await val([
    { nombre: 'Hotcakes Tradicionales', cantidad: 1 },
    { nombre: 'Almuerzo Americano', cantidad: 1 },
  ]);
  assert.strictEqual(sinExtra.orden.total, 189, 'sin el extra vuelve a 189');
});

await t('TEST 5 · modificador INVENTADO por el modelo → NO se cobra; se reporta en ajustes', async () => {
  const v = await val([
    { nombre: 'Hotcakes Tradicionales', cantidad: 1 },
    { nombre: 'Almuerzo Americano', cantidad: 1, modificadores: ['Queso extraterrestre'] },
  ]);
  assert.strictEqual(v.orden.total, 189, 'un extra inexistente no cambia el total');
  const aj = v.ajustes.find(a => a.tipo === 'modificador_no_reconocido');
  assert.ok(aj && aj.ignorados.includes('Queso extraterrestre'), 'debe registrarse como no reconocido');
});

await t('TEST 6 · precio de modificador ENVIADO MAL por el modelo → backend usa el canónico (40)', async () => {
  const v = await val([
    { nombre: 'Hotcakes Tradicionales', cantidad: 1 },
    { nombre: 'Almuerzo Americano', cantidad: 1, modificadores: [{ opcion: 'Salchicha americana', precio_extra: 999 }] },
  ]);
  assert.strictEqual(v.orden.total, 229, 'ignora el 999 del modelo y usa el precio_extra de la base (40)');
});

await t('TEST 7 · el pedido conserva el modificador (ticket/cocina/historial) con precio canónico', async () => {
  const v = await val([{ nombre: 'Almuerzo Americano', cantidad: 1, modificadores: ['Salchicha americana'] }]);
  const item = v.orden.items.find(i => i.nombre === 'Almuerzo Americano');
  assert.ok(Array.isArray(item.modificadores) && item.modificadores.length === 1, 'el item guarda modificadores');
  assert.strictEqual(item.modificadores[0].opcion, 'Salchicha americana');
  assert.strictEqual(item.modificadores[0].precio_extra, 40, 'precio canónico');
  assert.strictEqual(item.precio_unitario, 229, 'precio_unitario = base 189 + extra 40');
  assert.strictEqual(item.precio_base, 189, 'precio_base queda solo la base (para el 2x1)');
  assert.ok(/Salchicha americana/.test(item.modificadores_texto || ''), 'texto para cocina');
  assert.ok(!('_modsLLM' in item), 'no debe filtrarse el campo temporal');
});

await t('TEST 8 · números OFICIALES: el validador expone subtotal/descuento/total del backend (no los del LLM)', async () => {
  // El modelo manda subtotal/descuento/total inventados → se ignoran.
  const orden = { canal: 'whatsapp', modalidad: 'recoger', forma_pago: PAGO,
    subtotal: 1, descuento: 1, total: 1,
    items: [
      { nombre: 'Hotcakes Tradicionales', cantidad: 1 },
      { nombre: 'Almuerzo Americano', cantidad: 1, modificadores: ['Salchicha americana'] },
    ] };
  const v = await validarOrdenPropuesta(orden, NEG, { canal: 'whatsapp' });
  assert.strictEqual(v.orden.subtotal, 378, 'subtotal oficial');
  assert.strictEqual(v.orden.descuento, 149, 'descuento oficial');
  assert.strictEqual(v.orden.total, 229, 'total oficial (la respuesta preconfirmación debe usar ESTOS)');
});

await t('TEST 9 · E2E de registro: Almuerzo + Salchicha confirmado → orden con Salchicha y total 229', async () => {
  // La misma orden que emitiría el LLM tras "agregar salchicha" y confirmar.
  const v = await val([
    { nombre: 'Hotcakes Tradicionales', cantidad: 1 },
    { nombre: 'Almuerzo Americano', cantidad: 1, modificadores: ['Salchicha americana'], notas: 'bien cocido' },
  ]);
  assert.ok(v.ok);
  assert.strictEqual(v.orden.total, 229);
  const alm = v.orden.items.find(i => i.nombre === 'Almuerzo Americano');
  assert.ok(alm.modificadores.some(m => m.opcion === 'Salchicha americana'), 'la Salchicha viaja en el pedido');
  assert.strictEqual(alm.notas, 'bien cocido', 'las notas sin costo se conservan aparte');
});

// ═══════════ RESUMEN ═══════════
await limpiar(NEG);
await pool.end();
console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallidas) { console.log('Fallos:\n  - ' + fallos.join('\n  - ')); process.exit(1); }
