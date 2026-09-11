// EL CANDADO: no se puede negar lo que sí tenemos.
//
// Pruebas puras -- sin DB, sin servidor -- del último filtro por el que pasa
// todo lo que el bot le dice a un cliente.
//
// Los ocho incidentes de esta familia se arreglaron uno por uno, cada cual con
// una regla para su frase. Esta suite no prueba otra regla: prueba la GARANTÍA
// de que el daño no puede salir, venga de donde venga el texto.
//
// La mitad de los casos son de lo contrario: que el candado NO se dispare en
// mensajes legítimos. Un candado que estorba se acaba quitando, y entonces no
// protege de nada.
import assert from 'assert';
import {
  terminosDelCatalogo, contradiceElCatalogo, revisarNegativas, mensajeEnLugarDeLaNegativa,
} from '../src/agent/negativaVerificada.js';

let pasadas = 0, fallidas = 0; const fallos = [];
function t(nombre, fn) {
  try { fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

// El catálogo real de Mapolato Obispado, en la forma que devuelve
// obtenerMenuCompleto (categorías -> productos -> modificadores -> opciones).
const PROTEINAS = ['Huevos Estrellados', 'Huevos Revueltos', 'Pechuga de pollo',
  'Chicharron Prensado', 'Bistec en Salsa', 'Queso Panela en Salsa', 'Chicharron Cuerito en Salsa'];
const conGrupos = (nombre, precio) => ({
  nombre, precio, disponible: true, agotado: false,
  modificadores: [
    { nombre: 'Salsa', opciones: ['Roja', 'Suiza', 'Verde', 'Mole', 'Chipotle'].map((n) => ({ nombre: n, disponible: true })) },
    { nombre: 'Proteína', opciones: PROTEINAS.map((n) => ({ nombre: n, disponible: true })) },
  ],
});
const CATALOGO = [
  { nombre: 'CHILAQUILES', productos: [
    conGrupos('Chilaquiles Sencillos', 195),
    conGrupos('Chilaquiles Mixtos', 205),
    conGrupos('Bowl de Chilaquiles', 140),
  ] },
  { nombre: 'DESAYUNOS', productos: [
    { nombre: 'Hotcakes de Sarten', precio: 179, modificadores: [] },
    { nombre: 'Waffles', precio: 159, modificadores: [] },
  ] },
];
const TERMINOS = terminosDelCatalogo(CATALOGO);

// ─── 1-6. Lo que el candado DEBE atajar ────────────────────────────────────

t('1. el incidente de los chilaquiles no puede salir', () => {
  const r = revisarNegativas('Una disculpa: no manejamos "Chilaquiles". ¿Te comparto lo que sí tenemos?', TERMINOS);
  assert.strictEqual(r.seguro, false, 'la negativa tenía que atajarse');
  assert.strictEqual(r.hallazgos.length, 1);
  assert.strictEqual(r.hallazgos[0].existen.length, 3, 'los tres chilaquiles la desmienten');
});

t('2. y en su lugar sale la verdad, construida con los nombres reales', () => {
  const r = revisarNegativas('Una disculpa: no manejamos "Chilaquiles".', TERMINOS);
  const msg = mensajeEnLugarDeLaNegativa(r.hallazgos);
  assert.match(msg, /Chilaquiles Sencillos/);
  assert.match(msg, /Chilaquiles Mixtos/);
  assert.match(msg, /Bowl de Chilaquiles/);
  assert.match(msg, /¿Cuál prefieres\?/);
  assert.doesNotMatch(msg, /no manejamos|no tenemos/i, 'el sustituto no puede volver a negar');
});

t('3. da igual quién lo escriba: también ataja al modelo', () => {
  // El validador escribe «no manejamos "X"»; el modelo escribe en prosa. El
  // candado está después de los dos, así que los cubre igual.
  for (const texto of [
    'Lo siento, no tenemos chilaquiles en el menú.',
    'Fíjate que no contamos con Bistec en Salsa por el momento.',
    'No hay hotcakes de sarten hoy.',
    'No disponemos de waffles.',
  ]) {
    const r = revisarNegativas(texto, TERMINOS);
    assert.strictEqual(r.seguro, false, `se escapó: ${texto}`);
  }
});

t('4. una opción de modificador también cuenta como carta', () => {
  const r = revisarNegativas('No manejamos Pechuga de pollo.', TERMINOS);
  assert.strictEqual(r.seguro, false);
  assert.ok(r.hallazgos[0].existen.includes('Pechuga de pollo'));
});

t('5. varias negativas en un mismo mensaje se detectan todas', () => {
  const r = revisarNegativas('No tenemos chilaquiles y tampoco hay waffles.', TERMINOS);
  assert.strictEqual(r.seguro, false);
  assert.ok(r.hallazgos.length >= 2, `esperaba dos hallazgos, hubo ${r.hallazgos.length}`);
});

t('6. con una sola coincidencia se ofrece, no se pregunta de más', () => {
  const r = revisarNegativas('No tenemos Waffles.', TERMINOS);
  const msg = mensajeEnLugarDeLaNegativa(r.hallazgos);
  assert.match(msg, /Sí tenemos Waffles/);
  assert.doesNotMatch(msg, /¿Cuál prefieres\?/, 'con una sola no hay nada que elegir');
});

// ─── 7-13. Lo que el candado NO debe tocar ─────────────────────────────────
//
// Esta mitad importa tanto como la otra. Un candado que salta en mensajes
// legítimos vuelve tonto al bot, y un bot tonto se apaga.

t('7. negar algo que de verdad no está en la carta se permite', () => {
  for (const texto of [
    'Una disculpa: no manejamos "Sushi de Kobe".',
    'No tenemos pizza.',
    'No contamos con hamburguesas.',
  ]) {
    assert.strictEqual(revisarNegativas(texto, TERMINOS).seguro, true, `no debió atajarse: ${texto}`);
  }
});

t('8. negar una VARIANTE que no existe se permite, aunque la familia sí exista', () => {
  // "chilaquiles veganos" no está en la carta aunque "chilaquiles" sí. Negarlo
  // es correcto y el candado no puede estorbarlo.
  assert.strictEqual(revisarNegativas('No tenemos chilaquiles veganos.', TERMINOS).seguro, true);
  assert.strictEqual(revisarNegativas('No manejamos waffles sin gluten.', TERMINOS).seguro, true);
});

t('9. una palabra de estructura no identifica nada', () => {
  // "salsa" aparece en media carta. Si el candado saltara aquí, el bot no
  // podría decir una frase perfectamente normal.
  for (const texto of [
    'No tenemos esa salsa.',
    'No hay más opciones de ese grupo.',
    'No tenemos ese tamaño.',
  ]) {
    assert.strictEqual(revisarNegativas(texto, TERMINOS).seguro, true, `no debió atajarse: ${texto}`);
  }
});

t('10. las negativas que no son de carta pasan intactas', () => {
  for (const texto of [
    'No tenemos servicio a domicilio en esa zona.',
    'No hay repartidores disponibles en este momento.',
    'No manejamos pago con transferencia.',
    'No tenemos mesas para diez personas.',
  ]) {
    assert.strictEqual(revisarNegativas(texto, TERMINOS).seguro, true, `no debió atajarse: ${texto}`);
  }
});

t('11. un mensaje sin ninguna negativa ni se revisa', () => {
  const r = revisarNegativas('Claro que sí, con gusto. ¿Para recoger o a domicilio?', TERMINOS);
  assert.strictEqual(r.seguro, true);
  assert.strictEqual(r.hallazgos.length, 0);
});

t('12. una palabra corta suelta no dispara nada', () => {
  // "pan", "te", "ya": emparejan con demasiado. No son identificación.
  assert.deepStrictEqual(contradiceElCatalogo('pan', TERMINOS), []);
  assert.deepStrictEqual(contradiceElCatalogo('te', TERMINOS), []);
});

t('13. sin catálogo, el bot no se queda mudo', () => {
  // Si el catálogo no se puede leer, el candado se abre. Un bot silencioso es
  // peor que el problema que esto resuelve.
  assert.strictEqual(revisarNegativas('No manejamos Chilaquiles.', []).seguro, true);
  assert.strictEqual(revisarNegativas('', TERMINOS).seguro, true);
  assert.strictEqual(revisarNegativas(null, TERMINOS).seguro, true);
});

// ─── 14. El catálogo entero, contra sí mismo ───────────────────────────────

t('14. NINGÚN nombre de la carta puede negarse, ni uno', () => {
  // La prueba de fuerza bruta: se intenta negar cada cosa que el negocio
  // vende, con cada forma de decir que no. Ni una sola puede pasar.
  const formas = ['no manejamos', 'no tenemos', 'no contamos con', 'no disponemos de', 'no hay'];
  const escapados = [];
  for (const { nombre } of TERMINOS) {
    for (const forma of formas) {
      if (revisarNegativas(`Una disculpa: ${forma} ${nombre}.`, TERMINOS).seguro) {
        escapados.push(`${forma} ${nombre}`);
      }
    }
  }
  assert.deepStrictEqual(escapados, [],
    `se pudo negar algo que sí vendemos:\n  ${escapados.join('\n  ')}`);
});

console.log(`\n${fallidas === 0 ? 'TODO VERDE' : 'CON FALLOS'} — ${pasadas} pasadas, ${fallidas} fallidas`);
if (fallos.length) for (const f of fallos) console.log(`  · ${f}`);
process.exit(fallidas === 0 ? 0 : 1);
