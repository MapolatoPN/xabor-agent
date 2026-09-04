// LOS GRUPOS DE UN PRODUCTO SON LOS SUYOS, Y PREGUNTAR ES DEL BACKEND.
//
// Cuarto caso real del mismo patrón. Con el pedido YA completo —Salsa,
// Proteína, Hotcakes y Topping elegidos— el bot le exigió al cliente:
//
//   "para cada Combito de Chilaquiles tengo que elegir las guarniciones
//    (puedes elegir 1 o 2): Frijolitos naturales, Frijolitos con chorizo,
//    Papas a la mexicana, ... Bistec en salsa (+$30) ..."
//
// El Combito de Chilaquiles NO tiene grupo Guarniciones. Lo tiene Chilaquiles
// Sencillos: el platillo CONTIGUO en el menú, de nombre casi idéntico y con
// los dos primeros grupos iguales (Salsa, Proteína). El modelo continuó la
// lista del vecino. El cliente quedaba en un callejón sin salida: esa opción
// no existe para su producto y jamás podría registrarse.
//
// Antes ya habíamos visto lo mismo en otros ejes: una OPCIÓN que no participa
// en la promo (Waffles), y PRODUCTOS participantes inventados. Siempre igual —
// el modelo completa desde el menú lo que no le dijimos explícitamente.
//
// La regla que fija esta suite: el LLM interpreta qué pidió el cliente; el
// BACKEND decide qué falta y lo redacta. La prosa libre del modelo no puede
// pedir opciones de producto.
//
// El fixture reproduce la trampa: los dos platillos vecinos, parecidos, con
// grupos parcialmente compartidos. Un fixture con productos disjuntos no
// habría visto nunca este fallo.
//
// Uso: DATABASE_URL=... node test/fase-autoridad-grupos.mjs
import assert from 'assert';

const { pool } = await import('../src/services/database.js');
const { validarBorradorPedido, nombresDeGruposDelNegocio,
        mensajeBorradorParaCliente } = await import('../src/orders/validadorOrden.js');
const { tieneRespaldo, mismaRaiz } = await import('../src/agent/mencionesComerciales.js');
const { buscarOpcionPorMencion } = await import('../src/services/modificadores.js');

let pasadas = 0, fallidas = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

// ── Fixture: los dos vecinos del menú real ─────────────────────────────────
const q1 = async (sql, params) => (await pool.query(sql, params)).rows[0];
const NEG = (await q1(
  `INSERT INTO negocios (nombre, slug) VALUES ('Autoridad Grupos','autoridad-grupos')
   ON CONFLICT (slug) DO UPDATE SET nombre='Autoridad Grupos' RETURNING id`)).id;
for (const tabla of ['menu_modificadores_opciones', 'menu_modificadores_grupos', 'menu_productos', 'menu_categorias']) {
  await pool.query(`DELETE FROM ${tabla} WHERE negocio_id=$1`, [NEG]).catch(() => {});
}
const cat = async (n, orden) => (await q1(
  `INSERT INTO menu_categorias (negocio_id,nombre,orden) VALUES ($1,$2,$3) RETURNING id`, [NEG, n, orden])).id;
const prod = async (c, n, p) => (await q1(
  `INSERT INTO menu_productos (negocio_id,categoria_id,nombre,precio) VALUES ($1,$2,$3,$4) RETURNING id`, [NEG, c, n, p])).id;
const grupo = async (pr, n, { min = 1, max = 1, orden = 0 } = {}) => (await q1(
  `INSERT INTO menu_modificadores_grupos (negocio_id,producto_id,nombre,requerido,minimo,maximo,orden)
   VALUES ($1,$2,$3,TRUE,$4,$5,$6) RETURNING id`, [NEG, pr, n, min, max, orden])).id;
const op = async (g, n, extra = 0) => pool.query(
  `INSERT INTO menu_modificadores_opciones (negocio_id,grupo_id,nombre,precio_extra,disponible,orden)
   VALUES ($1,$2,$3,$4,TRUE,0)`, [NEG, g, n, extra]);

// Categoría CHILAQUILES — el vecino que SÍ tiene Guarniciones.
const catChila = await cat('CHILAQUILES', 0);
const SENCILLOS = await prod(catChila, 'Chilaquiles Sencillos', 145);
const gsSalsa = await grupo(SENCILLOS, 'Salsa', { orden: 0 });
for (const x of ['Suiza', 'Roja', 'Verde']) await op(gsSalsa, x);
const gsProt = await grupo(SENCILLOS, 'Proteína', { orden: 1 });
for (const x of ['Pechuga de pollo', 'Huevos estrellados']) await op(gsProt, x);
const gsGuarn = await grupo(SENCILLOS, 'Guarniciones', { min: 1, max: 2, orden: 2 });
for (const x of ['Frijolitos naturales', 'Papas a la mexicana']) await op(gsGuarn, x);
await op(gsGuarn, 'Bistec en salsa', 30);

// Categoría Combitos — el producto real, SIN Guarniciones.
const catComb = await cat('Combitos', 1);
const COMBITO = await prod(catComb, 'Combito de Chilaquiles', 195);
const gcSalsa = await grupo(COMBITO, 'Salsa', { orden: 0 });
for (const x of ['Suiza', 'Roja', 'Verde']) await op(gcSalsa, x);
const gcProt = await grupo(COMBITO, 'Proteína', { orden: 1 });
for (const x of ['Pechuga de pollo', 'Huevos estrellados']) await op(gcProt, x);
const gcHW = await grupo(COMBITO, 'Hotcakes o Waffles', { orden: 2 });
for (const x of ['Hotcakes', 'Waffles']) await op(gcHW, x);
const gcTop = await grupo(COMBITO, 'Topping', { orden: 3 });
await op(gcTop, 'Miel y Mantequilla'); await op(gcTop, 'Nutella', 30);

// Producto con DOS opciones que contienen "pollo": la abreviación no puede
// resolverse ahí, y el backend tiene que preguntar en vez de elegir.
const TORTA = await prod(catComb, 'Torta de Milanesa', 120);
const gtProt = await grupo(TORTA, 'Proteína', { orden: 0 });
for (const x of ['Pechuga de pollo', 'Milanesa de pollo']) await op(gtProt, x);

const item = (n, mods = []) => ({ nombre: n, cantidad: 1, modificadores: mods });
const mod = (g, ...o) => ({ grupo: g, opciones: o });
const COMPLETO = [mod('Salsa', 'Suiza'), mod('Proteína', 'Pechuga de pollo'),
  mod('Hotcakes o Waffles', 'Hotcakes'), mod('Topping', 'Nutella')];
// El texto del ciclo tiene que RESPALDAR las selecciones: si el cliente no las
// dijo, la fidelidad las descarta (y hace bien). Aquí se prueban los grupos, no
// el provenance, así que el fixture incluye lo que el cliente eligió.
const DIJO = 'quiero un combito con salsa suiza, pechuga de pollo, hotcakes y nutella, '
  + 'y unos chilaquiles sencillos con salsa roja, huevos estrellados y frijolitos naturales';
const val = (items, texto = DIJO, menciones = []) =>
  validarBorradorPedido({ items }, NEG, { textoCiclo: texto, menciones });

const GRUPOS = await nombresDeGruposDelNegocio(NEG);


// ═══ G2 — los grupos del producto son SOLO los suyos ══════════════════════
await t('G2. el backend expone únicamente los grupos del producto exacto', async () => {
  const rc = await val([item('Combito de Chilaquiles', COMPLETO)]);
  assert.deepStrictEqual(rc.gruposDelPedido.sort(),
    ['Hotcakes o Waffles', 'Proteína', 'Salsa', 'Topping'],
    'ni un grupo prestado del vecino');
  assert.ok(!rc.gruposDelPedido.includes('Guarniciones'));
});

// ═══ G3 — lo que SÍ falta se pregunta, y solo eso ═════════════════════════
await t('G3. con un grupo pendiente, el backend pregunta ESE y solo ese', async () => {
  const sinTopping = COMPLETO.filter((m) => m.grupo !== 'Topping');
  const rc = await val([item('Combito de Chilaquiles', sinTopping)]);
  assert.deepStrictEqual(rc.gruposPendientes, ['Topping']);
  const msg = mensajeBorradorParaCliente(rc);
  assert.match(msg, /topping/i, msg);
  assert.doesNotMatch(msg, /guarnici/i, `jamás el grupo del vecino: ${msg}`);
});

// ═══ G4 — no se repite un grupo ya resuelto ═══════════════════════════════

// ═══ G5 — recapitular NO es preguntar ═════════════════════════════════════

// ═══ G6 — el vecino SÍ puede preguntar sus guarniciones ═══════════════════
await t('G6. en Chilaquiles Sencillos, Guarniciones sí es una pregunta válida', async () => {
  const rc = await val([item('Chilaquiles Sencillos', [mod('Salsa', 'Roja'), mod('Proteína', 'Pechuga de pollo')])]);
  assert.deepStrictEqual(rc.gruposPendientes, ['Guarniciones'], 'ahí sí falta');
  assert.match(mensajeBorradorParaCliente(rc), /guarnici/i);
});

// ═══ G7 — multi-item: cada producto con sus grupos ════════════════════════
await t('G7. con los dos artículos juntos, cada uno conserva sus propios grupos', async () => {
  const rc = await val([
    item('Combito de Chilaquiles', COMPLETO),
    item('Chilaquiles Sencillos', [mod('Salsa', 'Roja'), mod('Proteína', 'Huevos estrellados'), mod('Guarniciones', 'Frijolitos naturales')]),
  ]);
  assert.strictEqual(rc.ok, true, mensajeBorradorParaCliente(rc) || '');
  assert.deepStrictEqual(rc.gruposPendientes, [], 'ambos completos');
});

// ═══ G8 — unidades repetidas del mismo producto ═══════════════════════════
await t('G8. dos unidades iguales no duplican ni inventan grupos', async () => {
  const rc = await val([item('Combito de Chilaquiles', COMPLETO), item('Combito de Chilaquiles', COMPLETO)]);
  assert.strictEqual(rc.ok, true, mensajeBorradorParaCliente(rc) || '');
  assert.deepStrictEqual(rc.gruposDelPedido.sort(),
    ['Hotcakes o Waffles', 'Proteína', 'Salsa', 'Topping'], 'sin repetir grupos');
});

// ═══ G9 — dos unidades, una incompleta ════════════════════════════════════
await t('G9. si a una unidad le falta un grupo, se pregunta ESE y una sola vez', async () => {
  const sinTopping = COMPLETO.filter((m) => m.grupo !== 'Topping');
  const rc = await val([item('Combito de Chilaquiles', sinTopping), item('Combito de Chilaquiles', sinTopping)]);
  assert.deepStrictEqual(rc.gruposPendientes, ['Topping']);
  const msg = mensajeBorradorParaCliente(rc);
  assert.strictEqual((msg.match(/topping/gi) || []).length, 1, `sin repetir por unidad: ${msg}`);
  assert.doesNotMatch(msg, /guarnici/i, msg);
});

// ═══ A1-A4 — el cliente abrevia también dentro de un grupo ═══════════════
// "con pollo" contra una opción llamada "Pechuga de pollo" producía el absurdo
// "no tenemos Pollo; tengo Pechuga de pollo". La tolerancia ya existía para las
// menciones sueltas y faltaba en la selección estructurada; esa asimetría se
// veía en la cara del cliente. El checkout no se afloja: la búsqueda queda
// acotada al grupo que el modelo nombró y solo resuelve si el candidato es único.
await t('A1. "Pollo" resuelve a "Pechuga de pollo" dentro de su grupo', async () => {
  const rc = await val([item('Combito de Chilaquiles', [
    mod('Salsa', 'Suiza'), mod('Proteína', 'Pollo'),
    mod('Hotcakes o Waffles', 'Hotcakes'), mod('Topping', 'Nutella')])],
  'quiero un combito con salsa suiza, pollo, hotcakes y nutella');
  const p = rc.productos[0];
  assert.deepStrictEqual(p.invalidos, [], `no puede decir que no hay pollo: ${JSON.stringify(p.invalidos)}`);
  assert.ok(p.elegidas.some((e) => e.grupo === 'Proteína' && e.opcion === 'Pechuga de pollo'),
    `debe quedar elegida la opción real: ${JSON.stringify(p.elegidas)}`);
  assert.strictEqual(rc.ok, true, mensajeBorradorParaCliente(rc) || '');
});

await t('A2. si dos opciones del grupo contienen la palabra, se pregunta', async () => {
  const rc = await val([item('Torta de Milanesa', [mod('Proteína', 'Pollo')])],
    'quiero una torta de milanesa con pollo');
  const p = rc.productos[0];
  assert.deepStrictEqual(p.elegidas, [], 'no se elige por el cliente entre dos candidatos');
  assert.strictEqual(p.ambiguos.length, 1, JSON.stringify(p.ambiguos));
  assert.strictEqual(p.ambiguos[0].nombre, 'Pollo');
});

await t('A3. una opción que NO existe en el grupo se sigue rechazando', async () => {
  const rc = await val([item('Combito de Chilaquiles', [mod('Proteína', 'Camarón')])],
    'quiero un combito con camarón');
  const p = rc.productos[0];
  assert.strictEqual(p.invalidos.length, 1, JSON.stringify(p.invalidos));
  assert.strictEqual(p.invalidos[0].solicitado, 'Camarón');
  assert.ok(p.invalidos[0].alternativas.includes('Pechuga de pollo'));
});

await t('A4. un texto libre SIN grupo sigue siendo nota, no selección', async () => {
  const rc = await val([{ nombre: 'Combito de Chilaquiles', cantidad: 1,
    modificadores: ['sin cebolla'], notas: 'sin cebolla' }],
  'quiero un combito sin cebolla');
  const p = rc.productos[0];
  assert.deepStrictEqual(p.invalidos, [], 'una nota no puede volverse un rechazo');
  assert.deepStrictEqual(p.elegidas, [], 'ni una selección inventada');
});

// ═══ M1-M5 — el cliente concuerda en género y número ═════════════════════
// Bucle real en producción: el cliente pidió "chilaquiles SUIZOS", el modelo
// interpretó bien (Salsa: Suiza) y la validación de respaldo lo descartó porque
// "suiza" no aparece literalmente en "suizos". El grupo volvía a quedar vacío,
// el backend lo preguntaba otra vez, el cliente contestaba "Suizos" otra vez...
// sin salida. En español el cliente concuerda con el platillo; su propia
// elección tiene que contar como respaldo.
const DICHO = 'seria un combito de chilaquiles suizos con huevos estrellados y waffles de nutella';

await t('M1. "suizos" respalda la opción "Suiza"', () => {
  assert.strictEqual(tieneRespaldo('Suiza', DICHO), true);
  assert.strictEqual(tieneRespaldo('Huevos estrellados', DICHO), true);
});

await t('M2. la mención en plural/masculino resuelve a la opción real', () => {
  const g = [{ id: 1, nombre: 'Salsa', opciones: [{ id: 1, nombre: 'Suiza' },
    { id: 2, nombre: 'Roja' }, { id: 3, nombre: 'Verde' }] }];
  for (const [dicho, esperado] of [['suizos', 'Suiza'], ['rojos', 'Roja'], ['verdes', 'Verde']]) {
    assert.strictEqual(buscarOpcionPorMencion(g, dicho).modificador?.opcion, esperado, dicho);
  }
});

await t('M3. el borrador completo NO se vacía por concordancia', async () => {
  const rc = await val([item('Combito de Chilaquiles', COMPLETO)], DICHO
    + ' con salsa suiza, pechuga de pollo, hotcakes y nutella');
  assert.deepStrictEqual(rc.productos[0].sinRespaldo, [], 'nada puede descartarse por género/número');
  assert.deepStrictEqual(rc.gruposPendientes, [], 'y por tanto no queda nada pendiente');
});

await t('M4. la raíz NO colapsa cosas distintas', () => {
  for (const [a, b] of [['Papa', 'papaya'], ['Melón', 'mole'], ['Fresa', 'fresco'], ['Miel', 'mole']]) {
    assert.strictEqual(mismaRaiz(a, b), false, `${a} y ${b} son cosas distintas`);
  }
  const g = [{ id: 1, nombre: 'Sabor', opciones: [{ id: 1, nombre: 'Papaya' }, { id: 2, nombre: 'Fresa' }] }];
  assert.strictEqual(buscarOpcionPorMencion(g, 'papa').estado, 'sin_coincidencia',
    '"papa" no puede convertirse en "Papaya"');
});

await t('M5. si la raíz encaja en DOS opciones, se sigue preguntando', () => {
  const g = [{ id: 1, nombre: 'Medida', opciones: [{ id: 1, nombre: 'Grande 1 Litro' },
    { id: 2, nombre: 'Grande 2 Litros' }] }];
  assert.strictEqual(buscarOpcionPorMencion(g, 'grandes').estado, 'ambiguo',
    'la tolerancia no puede volverse una adivinanza');
});

// ── Resumen ────────────────────────────────────────────────────────────────
console.log(`\n${fallidas === 0 ? 'TODO VERDE' : 'CON FALLOS'} — ${pasadas} pasadas, ${fallidas} fallidas`);
if (fallos.length) for (const f of fallos) console.log(`  · ${f}`);
await pool.end().catch(() => {});
process.exit(fallidas === 0 ? 0 : 1);
