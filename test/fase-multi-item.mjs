// RECONCILIACIÓN DE MENCIONES ENTRE ARTÍCULOS.
//
// Regresión real que obligó a revertir un deploy: un pedido de dos artículos
// —Combito de Chilaquiles (salsa suiza, pollo) y Hotcakes Tradicionales
// (hotcakes, cajeta)— con el borrador PERFECTAMENTE separado por el modelo,
// recibió como respuesta:
//
//   "no manejamos "salsa suiza" y "pollo" en Hotcakes Tradicionales"
//   "no manejamos "hotcakes" y "cajeta" en Combito de Chilaquiles"
//
// La causa era estructural: el bucle de menciones vivía DENTRO del bucle de
// artículos, y la lista de menciones es del TURNO. Cada artículo terminaba
// comparando su catálogo contra las menciones del otro. El diseño asumió sin
// decirlo un solo producto por mensaje.
//
// El invariante que fija esta suite: una mención válida para OTRO artículo
// nunca puede volverse inválida porque el artículo actual no la reconozca.
//
// Uso: DATABASE_URL=... PANEL_SECRET=... ADMIN_PASSWORD=... SESSION_SECRET=...
//      INTEGRATIONS_ENCRYPTION_KEY=... node test/fase-multi-item.mjs
import assert from 'assert';

const { pool } = await import('../src/services/database.js');
const { validarBorradorPedido, mensajeBorradorParaCliente } = await import('../src/orders/validadorOrden.js');

let pasadas = 0, fallidas = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

// ── Fixture ────────────────────────────────────────────────────────────────
const q1 = async (sql, params) => (await pool.query(sql, params)).rows[0];
const NEG = (await q1(
  `INSERT INTO negocios (nombre, slug) VALUES ('Multi Item Suite','multi-item-suite')
   ON CONFLICT (slug) DO UPDATE SET nombre='Multi Item Suite' RETURNING id`)).id;
for (const tabla of ['menu_modificadores_opciones', 'menu_modificadores_grupos', 'menu_productos', 'menu_categorias']) {
  await pool.query(`DELETE FROM ${tabla} WHERE negocio_id=$1`, [NEG]).catch(() => {});
}
const cat = (await q1(`INSERT INTO menu_categorias (negocio_id,nombre,orden) VALUES ($1,'GENERAL',0) RETURNING id`, [NEG])).id;
const prod = async (n, p = 100) => (await q1(
  `INSERT INTO menu_productos (negocio_id,categoria_id,nombre,precio) VALUES ($1,$2,$3,$4) RETURNING id`, [NEG, cat, n, p])).id;
const grupo = async (pr, n, req = true) => (await q1(
  `INSERT INTO menu_modificadores_grupos (negocio_id,producto_id,nombre,requerido,minimo,maximo,orden)
   VALUES ($1,$2,$3,$4,$5,1,0) RETURNING id`, [NEG, pr, n, req, req ? 1 : 0])).id;
const op = async (g, n) => pool.query(
  `INSERT INTO menu_modificadores_opciones (negocio_id,grupo_id,nombre,precio_extra,disponible,orden)
   VALUES ($1,$2,$3,0,TRUE,0)`, [NEG, g, n]);

// Dos artículos con catálogos DISJUNTOS.
const ALFA = await prod('Alfa');
const gColor = await grupo(ALFA, 'Color'); await op(gColor, 'Roja'); await op(gColor, 'Azul');
const BETA = await prod('Beta');
const gSabor = await grupo(BETA, 'Sabor'); await op(gSabor, 'Dulce'); await op(gSabor, 'Salado');
// Tercero, para probar que no es una solución "de a dos".
const GAMMA = await prod('Gamma');
const gTam = await grupo(GAMMA, 'Tamaño'); await op(gTam, 'Mini'); await op(gTam, 'Maxi');
// Dos artículos que aceptan LA MISMA opción: la ambigüedad no se adivina.
const DELTA = await prod('Delta');
const gExtraD = await grupo(DELTA, 'Extra', false); await op(gExtraD, 'Canela');
const EPSILON = await prod('Epsilon');
const gExtraE = await grupo(EPSILON, 'Extra', false); await op(gExtraE, 'Canela');
// Caso real.
const COMBITO = await prod('Combito de Chilaquiles', 150);
const gSalsa = await grupo(COMBITO, 'Salsa'); for (const x of ['Suiza', 'Roja', 'Verde']) await op(gSalsa, x);
const gProt = await grupo(COMBITO, 'Proteína'); for (const x of ['Pollo', 'Res']) await op(gProt, x);
const HOT = await prod('Hotcakes Tradicionales', 120);
const gHW = await grupo(HOT, 'Hotcakes o Waffles'); for (const x of ['Hotcakes', 'Waffles']) await op(gHW, x);
const gTop = await grupo(HOT, 'Topping'); for (const x of ['Cajeta', 'Miel']) await op(gTop, x);
// Multi-palabra, para no reintroducir el bug anterior.
const MEDIDO = await prod('Medido');
const gMed = await grupo(MEDIDO, 'Medida'); await op(gMed, 'Chico'); await op(gMed, 'Grande 1 Litro');
const DOBLE = await prod('Doble');
const gDob = await grupo(DOBLE, 'Medida'); await op(gDob, 'Grande 1 Litro'); await op(gDob, 'Grande 2 Litros');

const item = (nombre, mods = [], extra = {}) => ({ nombre, cantidad: 1, modificadores: mods, ...extra });
const mod = (g, ...o) => ({ grupo: g, opciones: o });
const val = (items, texto, menciones) =>
  validarBorradorPedido({ items }, NEG, { textoCiclo: texto, menciones });
const noResueltas = (rc) => (rc.mencionesNoResueltas || []).map((m) => m.texto);
const elegidasDe = (rc, n) => (rc.productos.find((p) => p.producto === n)?.elegidas || []).map((e) => `${e.grupo}:${e.opcion}`);

// ═══ M1 — dos artículos, todo válido: CERO contaminación cruzada ══════════
await t('M1. dos artículos con catálogos distintos no se invalidan entre sí', async () => {
  const rc = await val(
    [item('Alfa', [mod('Color', 'Roja')]), item('Beta', [mod('Sabor', 'Dulce')])],
    'quiero un alfa roja y un beta dulce', ['roja', 'dulce']);
  assert.deepStrictEqual(noResueltas(rc), [], 'ninguna mención puede quedar sin resolver');
  assert.deepStrictEqual(elegidasDe(rc, 'Alfa'), ['Color:Roja']);
  assert.deepStrictEqual(elegidasDe(rc, 'Beta'), ['Sabor:Dulce']);
  assert.strictEqual(rc.ok, true, mensajeBorradorParaCliente(rc) || '');
});

// ═══ M2 — mención que solo existe en el segundo artículo ══════════════════
await t('M2. una mención propia del artículo 2 no la puede rechazar el artículo 1', async () => {
  const rc = await val(
    [item('Alfa', [mod('Color', 'Roja')]), item('Beta', [])],
    'un alfa roja y un beta dulce', ['dulce']);
  assert.deepStrictEqual(noResueltas(rc), [], 'Alfa no maneja "dulce", pero Beta sí: es válida');
  assert.deepStrictEqual(elegidasDe(rc, 'Beta'), ['Sabor:Dulce'], 'se asigna al artículo que sí puede recibirla');
});

// ═══ M3 — mención inválida para TODOS ═════════════════════════════════════
await t('M3. una mención que ningún artículo maneja sí se bloquea', async () => {
  const rc = await val(
    [item('Alfa', [mod('Color', 'Roja')]), item('Beta', [mod('Sabor', 'Dulce')])],
    'un alfa roja y un beta dulce de mango', ['mango']);
  assert.deepStrictEqual(noResueltas(rc), ['mango']);
  assert.strictEqual(rc.ok, false);
  const msg = mensajeBorradorParaCliente(rc);
  assert.match(msg, /no manejamos "mango"/, msg);
  assert.doesNotMatch(msg, /mango.*en (Alfa|Beta)\b/, `no se le atribuye a un artículo concreto: ${msg}`);
});

// ═══ M4 — la misma opción en dos artículos: se pregunta ═══════════════════
await t('M4. si dos artículos aceptan la misma mención, NO se elige por orden', async () => {
  const rc = await val(
    [item('Delta', []), item('Epsilon', [])],
    'un delta y un epsilon con canela', ['canela']);
  assert.deepStrictEqual(elegidasDe(rc, 'Delta'), [], 'no se asigna a ciegas al primero');
  assert.deepStrictEqual(elegidasDe(rc, 'Epsilon'), []);
  assert.strictEqual(rc.mencionesAmbiguas.length, 1);
  assert.deepStrictEqual(rc.mencionesAmbiguas[0].productos.sort(), ['Delta', 'Epsilon']);
  assert.match(mensajeBorradorParaCliente(rc), /"canela" puede ir en Delta y Epsilon/, mensajeBorradorParaCliente(rc));
});

// ═══ M5 — tres artículos ══════════════════════════════════════════════════
await t('M5. funciona con TRES artículos, no solo con dos', async () => {
  const rc = await val(
    [item('Alfa', [mod('Color', 'Roja')]), item('Beta', [mod('Sabor', 'Dulce')]), item('Gamma', [mod('Tamaño', 'Maxi')])],
    'alfa roja, beta dulce y gamma maxi', ['roja', 'dulce', 'maxi']);
  assert.deepStrictEqual(noResueltas(rc), []);
  assert.strictEqual(rc.ok, true, mensajeBorradorParaCliente(rc) || '');
});

// ═══ M6 — el caso real de producción ══════════════════════════════════════
await t('M6. caso real: salsa suiza + pollo / hotcakes + cajeta, sin cruzarse', async () => {
  const rc = await val([
    item('Combito de Chilaquiles', [mod('Salsa', 'Suiza'), mod('Proteína', 'Pollo')]),
    item('Hotcakes Tradicionales', [mod('Hotcakes o Waffles', 'Hotcakes'), mod('Topping', 'Cajeta')]),
  ], 'Los primeros serán en salsa suiza con pollo y hotcakes con cajeta',
  ['salsa suiza', 'pollo', 'hotcakes', 'cajeta']);

  assert.deepStrictEqual(noResueltas(rc), [], 'el borrador venía correcto: el backend no puede destruirlo');
  assert.deepStrictEqual(elegidasDe(rc, 'Combito de Chilaquiles'), ['Salsa:Suiza', 'Proteína:Pollo']);
  assert.deepStrictEqual(elegidasDe(rc, 'Hotcakes Tradicionales'), ['Hotcakes o Waffles:Hotcakes', 'Topping:Cajeta']);
  assert.strictEqual(rc.ok, true, mensajeBorradorParaCliente(rc) || '');
});

// ═══ M7/M8 — la fidelidad original NO se pierde ═══════════════════════════
await t('M7. sigue detectándose lo que el borrador OMITE', async () => {
  const rc = await val([item('Medido', [])], 'quiero un medido de mango', ['mango']);
  assert.deepStrictEqual(noResueltas(rc), ['mango'], 'la omisión sigue detectándose con la reconciliación global');
});

await t('M8. una selección SIN respaldo del cliente se sigue descartando', async () => {
  const rc = await val([item('Alfa', [mod('Color', 'Azul')])], 'quiero un alfa roja', ['roja']);
  const p = rc.productos[0];
  assert.deepStrictEqual(p.sinRespaldo.map((s) => `${s.grupo}:${s.opcion}`), ['Color:Azul'],
    'el modelo puso Azul y el cliente dijo Roja');
  assert.deepStrictEqual(p.elegidas, [{ grupo: 'Color', opcion: 'Roja' }], 'se recupera lo que SÍ dijo');
});

// ═══ M9/M10 — multi-palabra ═══════════════════════════════════════════════
await t('M9. la abreviación de una opción multi-palabra sigue resolviendo', async () => {
  const rc = await val([item('Medido', [])], 'quiero un medido grande', ['grande']);
  assert.deepStrictEqual(elegidasDe(rc, 'Medido'), ['Medida:Grande 1 Litro']);
  assert.deepStrictEqual(noResueltas(rc), [], 'jamás negar algo que sí se vende');
});

await t('M10. una abreviación que encaja en DOS opciones del mismo artículo se pregunta', async () => {
  const rc = await val([item('Doble', [])], 'quiero un doble grande', ['grande']);
  assert.deepStrictEqual(elegidasDe(rc, 'Doble'), [], 'no se elige por el cliente');
  assert.strictEqual(rc.productos[0].ambiguos.length, 1);
});

// ── Resumen ────────────────────────────────────────────────────────────────
console.log(`\n${fallidas === 0 ? 'TODO VERDE' : 'CON FALLOS'} — ${pasadas} pasadas, ${fallidas} fallidas`);
if (fallos.length) for (const f of fallos) console.log(`  · ${f}`);
await pool.end().catch(() => {});
process.exit(fallidas === 0 ? 0 : 1);
