// QUÉ INCLUYE UN PRODUCTO: SOLO LO QUE EL CATÁLOGO DICE.
//
// Smoke real: el bot anunció que el combo "incluye chilaquiles, hotcakes o
// waffles y una bebida". El combo NO incluye bebida y el menú tampoco lo dice.
// El pedido se registró bien —la invención fue solo prosa— pero el cliente
// pagó esperando una bebida que la cocina nunca vio.
//
// El mecanismo es estructural, no un desliz: `formatearMenu` imprime la
// descripción SOLO si existe (`if (p.descripcion)`). Un producto sin
// descripción llega al modelo como nombre + precio + grupos, y nada sobre su
// contenido. Ese silencio es el que se rellena con conocimiento general de qué
// suele traer un platillo así.
//
// Estas pruebas fijan el contrato del prompt. NO pueden probar que el modelo
// obedezca —eso solo lo dice un smoke real—, pero sí que la regla existe, que
// llega, y que la descripción real manda cuando la hay.
//
// Uso: DATABASE_URL=... PANEL_SECRET=... ADMIN_PASSWORD=... SESSION_SECRET=...
//      INTEGRATIONS_ENCRYPTION_KEY=... node test/fase-verdad-composicion.mjs
import assert from 'assert';

const { pool } = await import('../src/services/database.js');
const { construirSystemPrompt } = await import('../src/agent/prompts.js');

let pasadas = 0, fallidas = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

const q1 = async (s, p) => (await pool.query(s, p)).rows[0];
const NEG = (await q1(`INSERT INTO negocios (nombre, slug) VALUES ('Verdad Composicion','verdad-composicion')
   ON CONFLICT (slug) DO UPDATE SET nombre='Verdad Composicion' RETURNING id`)).id;
for (const tb of ['menu_modificadores_opciones', 'menu_modificadores_grupos', 'menu_productos', 'menu_categorias']) {
  await pool.query(`DELETE FROM ${tb} WHERE negocio_id=$1`, [NEG]).catch(() => {});
}
const CAT = (await q1(`INSERT INTO menu_categorias (negocio_id,nombre,orden) VALUES ($1,'Paquetes',0) RETURNING id`, [NEG])).id;
// Uno SIN descripción (el vacío que se rellena) y uno CON descripción real.
await pool.query(`INSERT INTO menu_productos (negocio_id,categoria_id,nombre,precio) VALUES ($1,$2,'Paquete Sin Texto',195)`, [NEG, CAT]);
await pool.query(`INSERT INTO menu_productos (negocio_id,categoria_id,nombre,descripcion,precio)
  VALUES ($1,$2,'Paquete Con Texto','Dos piezas y una guarnición a elegir.',210)`, [NEG, CAT]);

const prompt = await construirSystemPrompt(null, 'whatsapp', NEG);
const menu = prompt.split('## MENÚ ACTUAL')[1] || '';

await t('C1. la regla de composición llega al modelo', () => {
  assert.match(prompt, /QUÉ INCLUYE UN PRODUCTO/,
    'sin la regla, el silencio del catálogo queda abierto a la invención');
  for (const verbo of ['incluye', 'trae', 'viene con', 'va acompañado de']) {
    assert.ok(prompt.includes(`"${verbo}"`) || prompt.includes(`"${verbo}"`),
      `el verbo de composición "${verbo}" no está cubierto por la regla`);
  }
});

await t('C2. la regla dice POR QUÉ importa, no solo que está prohibido', () => {
  assert.match(prompt, /el cliente lo paga esperándolo y la cocina nunca lo ve/,
    'una prohibición sin consecuencia es la más fácil de racionalizar');
});

await t('C3. un producto sin descripción no aporta NADA sobre su contenido', () => {
  const bloque = menu.split('- Paquete Sin Texto')[1]?.split('\n- ')[0] || '';
  assert.ok(bloque.length > 0, 'el producto debe aparecer en el menú');
  assert.doesNotMatch(bloque, /incluye|trae|viene con|acompañ/i,
    'el catálogo no puede insinuar contenido que nadie registró');
});

await t('C4. cuando SÍ hay descripción, llega literal: esa es la autoridad', () => {
  assert.match(menu, /Dos piezas y una guarnición a elegir\./,
    'la descripción real del catálogo es lo único que puede describir el producto');
});

await t('C5. la regla no inventa reglas de negocio de nadie', () => {
  const regla = prompt.split('QUÉ INCLUYE UN PRODUCTO')[1]?.split('\n\n')[0] || '';
  assert.ok(regla.length > 0, 'la regla debe existir para poder revisarla');
  assert.doesNotMatch(regla, /bebida|refresco|combito|chilaquil/i,
    'la regla es general: no puede nombrar productos ni negocios concretos');
});

console.log(`\n${fallidas === 0 ? 'TODO VERDE' : 'CON FALLOS'} — ${pasadas} pasadas, ${fallidas} fallidas`);
if (fallos.length) for (const f of fallos) console.log(`  · ${f}`);
await pool.end().catch(() => {});
process.exit(fallidas === 0 ? 0 : 1);
