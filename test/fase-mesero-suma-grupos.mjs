// ─── SUMAR, SUSTITUIR O QUITAR: LO DICE EL CLIENTE, NO EL BORRADOR ────────
//
// El smoke real del 16-sep, conversación nueva, turno 4:
//
//   estado    Salsa = [Suiza]          (pedida en T1, autorizada entonces)
//   cliente   «Tambien chipotle»
//   borrador  Salsa = [Chipotle]       ← el modelo manda SOLO lo nuevo
//   resultado Salsa = [Chipotle]       ← la Suiza desapareció
//
// El texto decía sumar —`operacionSobreElGrupo` devuelve 'agregar'— y aun así
// el grupo se sustituyó entero. La causa: el filtro que decide qué sobrevive
// sólo rescataba opciones que el MODELO hubiera repetido; las que ya estaban y
// el modelo omitió no las miraba nadie, aunque `valorAnterior` las traiga.
//
// Un grupo parcial del modelo es una PROPUESTA DE MUTACIÓN, no una foto del
// estado final. Quien dice si suma, sustituye o resta es el texto del cliente,
// y esa semántica ya vive en `mutacionDeOpciones`: aquí sólo se comprueba que
// llega hasta donde se escribe el grupo.
import assert from 'node:assert/strict';
import { atenderTurno } from '../src/mesero-whatsapp/meseroDigital.js';

let pasadas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); pasadas += 1; console.log(`    OK  ${nombre}`); }
  catch (e) { fallos.push(`${nombre}: ${e.message}`); console.log(`> FALLO ${nombre}: ${e.message}`); }
}

// ── La carta real de Obispado ────────────────────────────────────────────
const g = (nombre, minimo, maximo, opciones, requerido = true) => ({
  nombre, requerido, minimo, maximo,
  opciones: opciones.map((n) => ({ nombre: n, disponible: true, precio_extra: 0 })),
});
const SALSAS = ['Roja', 'Suiza', 'Verde', 'Mole', 'Chipotle'];
const PROTS = ['Huevos Estrellados', 'Huevos Revueltos', 'Pechuga de pollo', 'Chicharron Prensado'];
const GUARNS = ['Frijolitos naturales', 'Frijolitos con chorizo', 'Papas a la mexicana', 'Papas con chorizo'];
const CARTA = [
  { id: 26, nombre: 'CHILAQUILES', orden: 1, productos: [
    { id: 85, nombre: 'Chilaquiles Sencillos', orden: 0, precio: 195, disponible: true,
      opciones: { variante: { base: true } },
      modificadores: [g('Salsa', 1, 1, SALSAS), g('Proteína', 1, 1, PROTS), g('Guarniciones', 1, 2, GUARNS)] },
    { id: 107, nombre: 'Chilaquiles Mixtos', orden: 1, precio: 205, disponible: true,
      opciones: { variante: { discriminadores: ['mixto', 'mixtos'] } },
      modificadores: [g('Salsa', 1, 2, SALSAS), g('Proteína', 1, 2, PROTS), g('Guarniciones', 1, 2, GUARNS)] },
  ] },
  { id: 40, nombre: 'LICUADOS', orden: 3, productos: [
    { id: 200, nombre: 'Licuado de fresa', orden: 0, precio: 60, disponible: true, modificadores: [] },
    { id: 201, nombre: 'Licuado de platano', orden: 1, precio: 60, disponible: true, modificadores: [] },
  ] },
];

const renglon = (mods, nombre = 'Chilaquiles Sencillos', id = 85) => ({
  lid: 'L1', nombre, id, cantidad: 1, notas: '',
  modificadores: Object.entries(mods).map(([grupo, opciones]) => ({ grupo, opciones })),
});

/** Un turno suelto sobre un carrito dado. Es el camino real, entero. */
async function turno({ mods, dicho, borrador, nombre = 'Chilaquiles Sencillos', id = 85 }) {
  const carrito = { items: [renglon(mods, nombre, id)], datos: {} };
  const r = await atenderTurno({
    negocioId: 'n-suma', conversacionId: `c-${Math.abs(dicho.length * 7 + id)}`,
    mensaje: dicho, catalogo: CARTA, requierePago: false,
    contextoGuardado: { foco: 'L1', contador: 3, lineas: [{ lid: 'L1' }] },
    carrito, proponer: async () => borrador,
  });
  return r;
}
const items = (r) => r.carrito?.items || [];
const linea = (r) => items(r)[0] || null;
const opcs = (r, gr) => (linea(r)?.modificadores || [])
  .filter((m) => String(m.grupo).toLowerCase() === gr.toLowerCase())
  .flatMap((m) => (m.opciones || []).map((o) => (typeof o === 'string' ? o : o?.nombre))).sort();

/** El borrador PARCIAL que devuelve GPT: el grupo con sólo lo nuevo. */
const parcial = (grupo, ...opciones) => ({ items: [{
  nombre: 'Chilaquiles Sencillos', cantidad: 1, notas: '',
  modificadores: [{ grupo, opciones }] }] });

// ═══════════════════════════════════════════════════════════════════════════
// ADICIÓN — lo que ya estaba sobrevive
// ═══════════════════════════════════════════════════════════════════════════

await t('R1. [Suiza] + «también chipotle» → [Suiza, Chipotle]', async () => {
  const r = await turno({ mods: { Salsa: ['Suiza'] }, dicho: 'Tambien chipotle',
    borrador: parcial('Salsa', 'Chipotle') });
  assert.deepEqual(opcs(r, 'Salsa'), ['Chipotle', 'Suiza'],
    `Salsa=${JSON.stringify(opcs(r, 'Salsa'))}`);
});

await t('R2. [Suiza] + «además chipotle» → [Suiza, Chipotle]', async () => {
  const r = await turno({ mods: { Salsa: ['Suiza'] }, dicho: 'Ademas chipotle',
    borrador: parcial('Salsa', 'Chipotle') });
  assert.deepEqual(opcs(r, 'Salsa'), ['Chipotle', 'Suiza'],
    `Salsa=${JSON.stringify(opcs(r, 'Salsa'))}`);
});

await t('R3. [Suiza] + «y chipotle» al abrir el mensaje → [Suiza, Chipotle]', async () => {
  // La «y» que ABRE continúa el turno anterior. A media frase sólo enumera, y
  // eso lo distingue `mutacionDeOpciones`, no esta suite.
  const r = await turno({ mods: { Salsa: ['Suiza'] }, dicho: 'Y chipotle',
    borrador: parcial('Salsa', 'Chipotle') });
  assert.deepEqual(opcs(r, 'Salsa'), ['Chipotle', 'Suiza'],
    `Salsa=${JSON.stringify(opcs(r, 'Salsa'))}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// REEMPLAZO Y BAJA — que sumar no se coma las otras dos intenciones
// ═══════════════════════════════════════════════════════════════════════════

await t('R4. [Suiza] + «mejor chipotle» → [Chipotle]', async () => {
  const r = await turno({ mods: { Salsa: ['Suiza'] }, dicho: 'Mejor chipotle',
    borrador: parcial('Salsa', 'Chipotle') });
  assert.deepEqual(opcs(r, 'Salsa'), ['Chipotle'],
    `sumó donde el cliente sustituía: ${JSON.stringify(opcs(r, 'Salsa'))}`);
});

await t('R5. [Suiza] + «en vez de suiza, chipotle» → [Chipotle]', async () => {
  const r = await turno({ mods: { Salsa: ['Suiza'] }, dicho: 'En vez de suiza, chipotle',
    borrador: parcial('Salsa', 'Chipotle') });
  assert.deepEqual(opcs(r, 'Salsa'), ['Chipotle'],
    `Salsa=${JSON.stringify(opcs(r, 'Salsa'))}`);
});

await t('R6. [Suiza, Chipotle] + «sin suiza» → [Chipotle]', async () => {
  const r = await turno({ mods: { Salsa: ['Suiza', 'Chipotle'] }, dicho: 'Sin suiza',
    borrador: parcial('Salsa', 'Chipotle'), nombre: 'Chilaquiles Mixtos', id: 107 });
  assert.deepEqual(opcs(r, 'Salsa'), ['Chipotle'],
    `no quitó lo que el cliente pidió quitar: ${JSON.stringify(opcs(r, 'Salsa'))}`);
});

await t('R7. [Suiza] + «también suiza» → [Suiza], sin duplicar', async () => {
  const r = await turno({ mods: { Salsa: ['Suiza'] }, dicho: 'Tambien suiza',
    borrador: parcial('Salsa', 'Suiza') });
  assert.deepEqual(opcs(r, 'Salsa'), ['Suiza'],
    `duplicó: ${JSON.stringify(opcs(r, 'Salsa'))}`);
});

await t('R8. grupo vacío + «suiza y chipotle» → [Suiza, Chipotle]', async () => {
  const r = await turno({ mods: {}, dicho: 'Con suiza y chipotle',
    borrador: parcial('Salsa', 'Suiza', 'Chipotle') });
  assert.deepEqual(opcs(r, 'Salsa'), ['Chipotle', 'Suiza'],
    `Salsa=${JSON.stringify(opcs(r, 'Salsa'))}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// LO QUE LA SUMA ARRASTRA: variante, renglón y procedencia
// ═══════════════════════════════════════════════════════════════════════════

await t('R9. la segunda salsa reclasifica la variante a Mixtos 107', async () => {
  const r = await turno({ mods: { Salsa: ['Suiza'] }, dicho: 'Tambien chipotle',
    borrador: parcial('Salsa', 'Chipotle') });
  assert.equal(linea(r).nombre, 'Chilaquiles Mixtos', `producto=${linea(r).nombre}`);
  assert.equal(linea(r).id, 107, `id=${linea(r).id}`);
});

await t('R10. el lid no cambia al sumar', async () => {
  const r = await turno({ mods: { Salsa: ['Suiza'] }, dicho: 'Tambien chipotle',
    borrador: parcial('Salsa', 'Chipotle') });
  assert.equal(items(r).length, 1, `${items(r).length} renglones`);
  assert.equal(linea(r).lid, 'L1', `lid=${linea(r).lid}`);
});

await t('R11. lo heredado sobrevive SIN volver a demostrarse en este turno', async () => {
  // La procedencia, medida donde de verdad se puede medir.
  //
  // El primer intento de esta prueba buscaba la palabra «suiza» dentro de las
  // autorizaciones, y era vacua: el reconciliador registra UNA autorización
  // por GRUPO —`modificador:Salsa`— y nunca por opción, así que esa búsqueda
  // no podía fallar jamás. Lo comprobé con una mordida que no tumbaba nada.
  //
  // Lo que sí distingue: el texto de este turno NO nombra la Suiza, y aun así
  // la Suiza se queda. Su autorización es la del turno en que se pidió; este
  // turno sólo autoriza el cambio del grupo, una vez.
  const DICHO = 'Tambien chipotle';
  assert(!/suiza/i.test(DICHO), 'el caso no ejercita la regla: el texto nombra la suiza');
  const r = await turno({ mods: { Salsa: ['Suiza'] }, dicho: DICHO,
    borrador: parcial('Salsa', 'Chipotle') });
  assert(opcs(r, 'Salsa').includes('Suiza'),
    `la heredada tuvo que volver a demostrarse y se perdió: ${JSON.stringify(opcs(r, 'Salsa'))}`);
  const aut = r.cambios?.autorizados || [];
  assert.equal(aut.length, 1, `se autorizó más de una cosa: ${JSON.stringify(aut)}`);
  assert.equal(aut[0].campo, 'modificador:Salsa', `campo=${aut[0].campo}`);
  assert.equal(aut[0].via, 'este_turno', `via=${aut[0].via}`);
});

await t('R12. un grupo parcial NO es una foto del estado cuando el texto suma', async () => {
  // La afirmación desnuda: el mismo borrador parcial, leído con dos textos
  // distintos, tiene que dar dos resultados distintos. Si el borrador mandara,
  // los dos darían [Chipotle].
  const suma = await turno({ mods: { Salsa: ['Suiza'] }, dicho: 'Tambien chipotle',
    borrador: parcial('Salsa', 'Chipotle') });
  const cambio = await turno({ mods: { Salsa: ['Suiza'] }, dicho: 'Mejor chipotle',
    borrador: parcial('Salsa', 'Chipotle') });
  assert.deepEqual(opcs(suma, 'Salsa'), ['Chipotle', 'Suiza'], 'el texto que suma no sumó');
  assert.deepEqual(opcs(cambio, 'Salsa'), ['Chipotle'], 'el texto que sustituye no sustituyó');
});

console.log(fallos.length
  ? `\n> CON FALLOS — ${pasadas} pasadas, ${fallos.length} fallidas\n    · ${fallos.join('\n    · ')}`
  : `\n  TODO VERDE — ${pasadas} pasadas, 0 fallidas`);
process.exit(fallos.length ? 1 : 0);
