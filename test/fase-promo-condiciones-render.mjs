// RENDERER de condiciones (presentación): fraseCondiciones debe generar texto
// natural por operador y NO concatenar nombre_grupo + opciones (bug real:
// grupo "Waffles o Hotcakes" + opción "Hotcakes" → "Waffles o Hotcakes Hotcakes").
// La elegibilidad NO cambia; esto es solo redacción.
//
// Uso: DATABASE_URL=... node test/fase-promo-condiciones-render.mjs
import assert from 'assert';

const { fraseCondiciones, guardarPromocion, describirPromocionesParaFecha } =
  await import('../src/services/tiendaPromociones.js');
const { pool } = await import('../src/services/database.js');

let pasadas = 0, fallidas = 0; const fallos = [];
function t(nombre, fn) {
  try { const r = fn(); if (r && r.then) return r.then(() => { console.log(`  OK  ${nombre}`); pasadas++; }).catch(e => { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(nombre); });
    console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

// Map<producto_id, grupos[]> con la forma que produce cargarGruposDeProductos.
const P = 1;
const grupos = new Map([[P, [
  { id: 10, nombre: 'Waffles o Hotcakes', opciones: [{ id: 100, nombre: 'Hotcakes' }, { id: 101, nombre: 'Waffles' }] },
  { id: 11, nombre: 'Salsa', opciones: [{ id: 110, nombre: 'Roja' }, { id: 111, nombre: 'Verde' }, { id: 112, nombre: 'Suiza' }] },
  { id: 12, nombre: 'Proteína', opciones: [{ id: 120, nombre: 'Pechuga de pollo' }, { id: 121, nombre: 'Res' }] },
  { id: 13, nombre: 'Guarniciones sencillas', opciones: [{ id: 130, nombre: 'Frijoles' }, { id: 131, nombre: 'Papa' }] },
]]]);
const cond = (o) => ({ producto_id: P, grupo_id: o.g, operador: o.op, option_ids: o.ids || [], min: o.min ?? null, max: o.max ?? null });

t('1 · grupo cuyo nombre contiene la opción → solo la opción (no el grupo)', () => {
  const txt = fraseCondiciones([cond({ g: 10, op: 'una_de', ids: [100] })], grupos);
  assert.strictEqual(txt, 'Participan los preparados con Hotcakes.');
  assert.ok(!/Waffles o Hotcakes Hotcakes/.test(txt), 'jamás concatena grupo+opción');
});

t('2 · una_de con UNA opción → "con {opción}"', () => {
  assert.strictEqual(fraseCondiciones([cond({ g: 11, op: 'una_de', ids: [110] })], grupos), 'Participan los preparados con Roja.');
});

t('3 · una_de con VARIAS opciones → "con {a} o {b}"', () => {
  assert.strictEqual(fraseCondiciones([cond({ g: 11, op: 'una_de', ids: [110, 111] })], grupos), 'Participan los preparados con Roja o Verde.');
});

t('4 · cantidad exacta → "con N {grupo}"', () => {
  assert.strictEqual(fraseCondiciones([cond({ g: 13, op: 'cantidad', min: 2, max: 2 })], grupos), 'Participan los preparados con 2 guarniciones sencillas.');
});

t('5 · incluye → "con {opción}"', () => {
  assert.strictEqual(fraseCondiciones([cond({ g: 12, op: 'incluye', ids: [120] })], grupos), 'Participan los preparados con Pechuga de pollo.');
});

t('6 · REGRESIÓN miércoles: salsa Roja/Verde + Pechuga de pollo + 2 guarniciones', () => {
  const txt = fraseCondiciones([
    cond({ g: 11, op: 'una_de', ids: [110, 111] }),
    cond({ g: 12, op: 'incluye', ids: [120] }),
    cond({ g: 13, op: 'cantidad', min: 2, max: 2 }),
  ], grupos);
  assert.strictEqual(txt, 'Participan los preparados con Roja o Verde, Pechuga de pollo y 2 guarniciones sencillas.');
});

t('7 · cantidades min/max en lenguaje natural', () => {
  assert.strictEqual(fraseCondiciones([cond({ g: 13, op: 'cantidad', min: 1 })], grupos), 'Participan los preparados con al menos 1 guarniciones sencillas.');
  assert.strictEqual(fraseCondiciones([cond({ g: 13, op: 'cantidad', max: 2 })], grupos), 'Participan los preparados con hasta 2 guarniciones sencillas.');
  assert.strictEqual(fraseCondiciones([cond({ g: 13, op: 'cantidad', min: 1, max: 2 })], grupos), 'Participan los preparados con entre 1 y 2 guarniciones sencillas.');
});

t('8 · sin condiciones → cadena vacía', () => {
  assert.strictEqual(fraseCondiciones([], grupos), '');
});

// ── E2E "jueves": describirPromocionesParaFecha real con grupo "Waffles o Hotcakes" ──
async function montarNegocio(slug, nombre) {
  const { rows: [n] } = await pool.query(`INSERT INTO negocios (nombre, slug) VALUES ($1,$2) ON CONFLICT (slug) DO UPDATE SET nombre=$1 RETURNING id`, [nombre, slug]);
  return n.id;
}
const NEG = await montarNegocio('promo-render-a', 'Promo Render A');
async function limpiar() {
  await pool.query(`DELETE FROM tienda_promociones WHERE negocio_id=$1`, [NEG]).catch(()=>{});
  await pool.query(`DELETE FROM menu_modificadores_opciones WHERE negocio_id=$1`, [NEG]).catch(()=>{});
  await pool.query(`DELETE FROM menu_modificadores_grupos WHERE negocio_id=$1`, [NEG]).catch(()=>{});
  await pool.query(`DELETE FROM menu_productos WHERE negocio_id=$1`, [NEG]).catch(()=>{});
  await pool.query(`DELETE FROM menu_categorias WHERE negocio_id=$1`, [NEG]).catch(()=>{});
}
await limpiar();
const cat = (await pool.query(`INSERT INTO menu_categorias (negocio_id,nombre,orden) VALUES ($1,'COMBOS',0) RETURNING id`, [NEG])).rows[0].id;
const prod = (await pool.query(`INSERT INTO menu_productos (negocio_id,categoria_id,nombre,precio) VALUES ($1,$2,'Combito',195) RETURNING id`, [NEG, cat])).rows[0].id;
const g = (await pool.query(`INSERT INTO menu_modificadores_grupos (negocio_id,producto_id,nombre,requerido,minimo,maximo,orden) VALUES ($1,$2,'Waffles o Hotcakes',false,0,0,0) RETURNING id`, [NEG, prod])).rows[0].id;
const oHot = (await pool.query(`INSERT INTO menu_modificadores_opciones (negocio_id,grupo_id,nombre,precio_extra,disponible,orden) VALUES ($1,$2,'Hotcakes',0,true,0) RETURNING id`, [NEG, g])).rows[0].id;
await pool.query(`INSERT INTO menu_modificadores_opciones (negocio_id,grupo_id,nombre,precio_extra,disponible,orden) VALUES ($1,$2,'Waffles',0,true,1)`, [NEG, g]);
await guardarPromocion(NEG, {
  nombre: 'Jueves Combito', tipo: 'segundo_descuento', valor: 50, automatica: true, cantidadRequerida: 2, cantidadBeneficiada: 1,
  canales: ['whatsapp'], productos: [prod], diasSemana: [4],
  condicionesModificadores: [{ productoId: prod, grupoId: g, operador: 'una_de', optionIds: [oHot] }],
});

await (async () => {
  try {
    const promos = await describirPromocionesParaFecha(NEG, { canal: 'whatsapp', ahora: new Date('2024-01-04T12:00:00Z'), timezone: 'UTC', minutos: null }); // jueves
    const p = promos.find(x => x.nombre === 'Jueves Combito');
    assert.ok(p, 'la promo de jueves aparece');
    assert.ok(/con Hotcakes/.test(p.condicionesTexto), 'redacción natural: ' + p.condicionesTexto);
    assert.ok(!/Waffles o Hotcakes Hotcakes/.test(p.condicionesTexto), 'jamás el bug de concatenación');
    console.log('  OK  9 · E2E por fecha (jueves): condicionesTexto natural sin bug'); pasadas++;
  } catch (e) { console.log(`FALLO 9 · E2E por fecha: ${e.message}`); fallidas++; fallos.push('9 E2E'); }
})();

await limpiar();
await pool.end();
console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallidas) { console.log('Fallos:\n  - ' + fallos.join('\n  - ')); process.exit(1); }
