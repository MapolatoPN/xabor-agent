// QUIÉN PARTICIPA EN UNA PROMOCIÓN LO DICE EL CATÁLOGO, NO EL MODELO.
//
// Caso real: "Jueves de Combitos" participa con el Combito de Chilaquiles
// preparado con HOTCAKES. La opción vive en un grupo que el negocio llamó
// "Hotcakes o Waffles". El agente leyó "participan los preparados con
// Hotcakes" junto a un grupo cuyo NOMBRE es una disyuntiva y contestó al
// cliente: "los preparados con Hotcakes o Waffles".
//
// El motor económico nunca se equivocó —pedir Waffles jamás dio descuento—,
// pero la promesa conversacional era falsa: el cliente pide Waffles esperando
// el 2x1/descuento, ve el total sin rebaja y se siente engañado.
//
// Lo que se fija aquí: cuando las opciones participantes son un subconjunto
// estricto de las de su grupo, el texto que recibe el agente dice EXPLÍCITAMENTE
// cuáles quedan fuera. Sale del catálogo, no de una lista escrita a mano.
//
// Uso: DATABASE_URL=... node test/fase-promo-participantes.mjs
import assert from 'assert';

const { fraseCondiciones } = await import('../src/services/tiendaPromociones.js');

let pasadas = 0, fallidas = 0; const fallos = [];
function t(nombre, fn) {
  try { fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

// Grupo cuyo NOMBRE es en sí mismo una alternativa — la trampa del caso real.
const grupos = (opciones) => new Map([[106, [{ id: 36, nombre: 'Hotcakes o Waffles', opciones }]]]);
const HOT = { id: 240, nombre: 'Hotcakes' };
const WAF = { id: 241, nombre: 'Waffles' };
const cond = (ids) => [{ grupo_id: 36, operador: 'una_de', option_ids: ids, producto_id: 106 }];

// ═══ P1 — solo una opción participa ═══════════════════════════════════════
t('P1. con una sola opción participante, se nombra ESA y se excluye la otra', () => {
  const txt = fraseCondiciones(cond([240]), grupos([HOT, WAF]));
  assert.match(txt, /Participan los preparados con Hotcakes\./, txt);
  assert.match(txt, /Waffles NO participa en esta promoción/, `debe decir qué queda fuera: ${txt}`);
  assert.doesNotMatch(txt, /con Hotcakes o Waffles/, `nunca presentar ambas como participantes: ${txt}`);
});

// ═══ P2 — el nombre del grupo no se cuela ═════════════════════════════════
t('P2. el nombre del grupo NUNCA se presenta como lista de participantes', () => {
  const txt = fraseCondiciones(cond([240]), grupos([HOT, WAF]));
  assert.doesNotMatch(txt, /Hotcakes o Waffles Hotcakes/, `no concatena grupo+opción: ${txt}`);
  // La única aparición de "Waffles" debe ser la de la exclusión.
  const idx = txt.indexOf('Waffles');
  assert.ok(idx > txt.indexOf('Participan'), txt);
  assert.match(txt.slice(idx), /^Waffles NO participa/, `"Waffles" solo puede aparecer excluido: ${txt}`);
});

// ═══ P3 — la opción excluida se nombra tal cual del catálogo ══════════════
t('P3. la exclusión sale del catálogo, no de una lista escrita a mano', () => {
  const OTRA = { id: 242, nombre: 'Crepas' };
  const txt = fraseCondiciones(cond([240]), grupos([HOT, WAF, OTRA]));
  assert.match(txt, /Waffles y Crepas NO participan en esta promoción/, txt);
});

// ═══ P4 — si SÍ participan las dos, se dicen las dos ══════════════════════
t('P4. cuando participan ambas opciones, se mencionan ambas y no hay exclusión', () => {
  const txt = fraseCondiciones(cond([240, 241]), grupos([HOT, WAF]));
  assert.match(txt, /Participan los preparados con Hotcakes o Waffles\./, txt);
  assert.doesNotMatch(txt, /NO participa/, `no hay nada que excluir: ${txt}`);
});

// ═══ P5 — promoción sin condición por modificadores ═══════════════════════
t('P5. una promoción sin condiciones no cambia de comportamiento', () => {
  assert.strictEqual(fraseCondiciones([], grupos([HOT, WAF])), '');
  assert.strictEqual(fraseCondiciones(null, grupos([HOT, WAF])), '');
});

// ═══ P6 — una opción agotada no se anuncia como excluida ═════════════════
t('P6. una opción no disponible no aparece como "no participa"', () => {
  const txt = fraseCondiciones(cond([240]), grupos([HOT, { ...WAF, disponible: false }]));
  assert.doesNotMatch(txt, /Waffles/, `lo que no se vende no se menciona: ${txt}`);
});

console.log(`\n${fallidas === 0 ? 'TODO VERDE' : 'CON FALLOS'} — ${pasadas} pasadas, ${fallidas} fallidas`);
if (fallos.length) for (const f of fallos) console.log(`  · ${f}`);
process.exit(fallidas === 0 ? 0 : 1);
