// ─── «Chilaquiles» son cuatro cosas, y una es la normal ───────────────────
//
// V1–V10. Una mención genérica de una familia no puede activar variantes que
// comercialmente hay que pedir por su nombre. «Unos chilaquiles» no significa
// «un combito», por mucho que el combito lleve chilaquiles.
//
// ── Lo que se deduce y lo que se declara ─────────────────────────────────
//
// LA FAMILIA no se declara: es el conjunto de candidatos que una mención
// genérica ya produce, y su núcleo son las palabras que todos comparten. Lo que
// cada variante añade encima es su discriminador, y sale de su nombre.
//
// LO QUE SÍ SE DECLARA son dos cosas que ningún nombre dice por sí solo: cuál
// es la base y cuál hay que nombrar. Viajan en el jsonb `opciones` que cada
// producto YA tiene —no hay esquema nuevo— y si el negocio no declara nada,
// `orden` hace de base, que es el campo con el que ya decide qué enseña primero
// en su carta.
//
// ── Y sigue sin saber qué es un chilaquil ────────────────────────────────
//
// V9 corre el mismo motor sobre hamburguesas. V8 lee el código del resolvedor y
// falla si menciona un solo producto.
import assert from 'node:assert/strict';
import { anclarLinea, resolverVariante } from '../src/mesero-whatsapp/anclajeAlCatalogo.js';
import { fichaDeProducto, leerVariante } from '../src/mesero-whatsapp/consultasDelMenu.js';

let pasadas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); pasadas += 1; console.log(`    OK  ${nombre}`); }
  catch (e) { fallos.push(`${nombre}: ${e.message}`); console.log(`> FALLO ${nombre}: ${e.message}`); }
}

const g = (nombre, minimo, maximo, opciones, requerido = true) => ({
  nombre, requerido, minimo, maximo,
  opciones: opciones.map((n) => ({ nombre: n, disponible: true, precio_extra: 0 })),
});
const SALSAS = ['Roja', 'Suiza', 'Verde', 'Mole', 'Chipotle'];
const PROTS = ['Huevos Estrellados', 'Pechuga de pollo'];

// La familia del enunciado, con los datos SINTÉTICOS del §10: Sencillos una
// salsa, Mixtos dos. Bowl y Combito se declaran «hay que nombrarlas».
const CARTA = [
  { id: 1, nombre: 'CHILAQUILES', productos: [
    { id: 11, nombre: 'Chilaquiles Sencillos', orden: 0, precio: 195, disponible: true,
      opciones: { variante: { base: true } },
      modificadores: [g('Salsa', 1, 1, SALSAS), g('Proteína', 1, 1, PROTS)] },
    { id: 12, nombre: 'Chilaquiles Mixtos', orden: 1, precio: 205, disponible: true,
      modificadores: [g('Salsa', 2, 2, SALSAS), g('Proteína', 1, 2, PROTS)] },
    { id: 13, nombre: 'Bowl de Chilaquiles', orden: 2, precio: 140, disponible: true,
      opciones: { variante: { requiere_mencion: true } },
      modificadores: [g('Salsa', 1, 1, SALSAS), g('Proteína', 1, 1, PROTS)] },
    { id: 14, nombre: 'Combito de Chilaquiles', orden: 3, precio: 195, disponible: true,
      opciones: { variante: { requiere_mencion: true, discriminadores: ['combito', 'combo'] } },
      modificadores: [g('Salsa', 1, 1, SALSAS), g('Proteína', 1, 1, PROTS)] },
  ] },
];

// Una familia SIN nada declarado: sólo `orden`. Sirve para probar que el dato
// que el negocio ya tiene alcanza para decir cuál es la normal.
const SOLO_ORDEN = [
  { id: 1, nombre: 'CAFE', productos: [
    { id: 21, nombre: 'Café Americano', orden: 0, precio: 45, disponible: true, modificadores: [] },
    { id: 22, nombre: 'Café Americano Grande', orden: 1, precio: 60, disponible: true, modificadores: [] },
  ] },
];

// Y una carta que no comparte una palabra con ninguna de las otras (V9).
const HAMBURGUESAS = [
  { id: 1, nombre: 'HAMBURGUESAS', productos: [
    { id: 31, nombre: 'Hamburguesa Clasica', orden: 0, precio: 120, disponible: true,
      opciones: { variante: { base: true } },
      modificadores: [g('Carne', 1, 1, ['Res', 'Pollo'])] },
    { id: 32, nombre: 'Hamburguesa Doble', orden: 1, precio: 160, disponible: true,
      modificadores: [g('Carne', 2, 2, ['Res', 'Pollo'])] },
    { id: 33, nombre: 'Hamburguesa Combo', orden: 2, precio: 180, disponible: true,
      opciones: { variante: { requiere_mencion: true, discriminadores: ['combo'] } },
      modificadores: [g('Carne', 1, 1, ['Res', 'Pollo'])] },
  ] },
];

const anclar = (catalogo, pista, evidencia = pista) =>
  anclarLinea({ catalogo, nombrePropuesto: pista, evidencia });
const resuelveA = (catalogo, pista, evidencia) => {
  const r = anclar(catalogo, pista, evidencia);
  return r.producto ? r.producto.nombre : `{${r.candidatos.map((c) => c.nombre).join('|')}}`;
};

// ═══════════════════════════════════════════════════════════════════════════

await t('V1. familia genérica con una base declarada → la base', async () => {
  const r = anclar(CARTA, 'chilaquiles', 'quiero unos chilaquiles');
  assert.equal(r.estado, 'resuelto', `quedó ${JSON.stringify(r.candidatos?.map((c) => c.nombre))}`);
  assert.equal(r.producto.nombre, 'Chilaquiles Sencillos');
  assert.equal(r.motivo, 'variante_base_declarada');
});

await t('V2. una variante que hay que nombrar NO compite si no la nombraron', async () => {
  // La familia no tiene base declarada ni `orden` que distinga: lo ÚNICO que
  // separa a las dos es que una hay que pedirla por su nombre. Si esa regla no
  // existiera, esto sería una pregunta — y por eso aquí se ve si existe.
  // Comprobar sólo que la explícita acaba en `descartados` no probaba nada:
  // ahí acaba igual cuando simplemente pierde contra la base.
  // Y la pista tiene que ser GENÉRICA: con el nombre entero el desempate por
  // coincidencia completa resuelve antes y la regla no se ejercita.
  const SOLO_MENCION = [{ id: 1, nombre: 'X', productos: [
    { id: 51, nombre: 'Ramen Tonkotsu', orden: 0, precio: 190, disponible: true, modificadores: [] },
    { id: 52, nombre: 'Ramen Especial', orden: 0, precio: 240, disponible: true,
      opciones: { variante: { requiere_mencion: true } }, modificadores: [] },
  ] }];
  const r = anclar(SOLO_MENCION, 'ramen', 'quiero un ramen');
  assert.equal(r.estado, 'resuelto',
    `siguió compitiendo la que hay que nombrar: ${JSON.stringify(r.candidatos?.map((c) => c.nombre))}`);
  assert.equal(r.producto.nombre, 'Ramen Tonkotsu');
  assert.equal(r.motivo, 'unica_sin_mencion',
    `resolvió por otra vía (${r.motivo}): la regla no se ejercitó`);
  // Y nombrándola, entra.
  assert.equal(resuelveA(SOLO_MENCION, 'ramen', 'quiero el ramen especial'), 'Ramen Especial');
});

await t('V3. nombrarla la activa, y gana a la base', async () => {
  assert.equal(resuelveA(CARTA, 'chilaquiles', 'quiero un bowl de chilaquiles suizos'),
    'Bowl de Chilaquiles');
  assert.equal(resuelveA(CARTA, 'chilaquiles', 'quiero el combito de chilaquiles'),
    'Combito de Chilaquiles');
});

await t('V4. las restricciones pueden mover base → otra variante', async () => {
  // Dos salsas no caben en la base; sólo Mixtos las admite.
  const r = anclar(CARTA, 'chilaquiles', 'quiero chilaquiles suizos con chipotle');
  assert.equal(r.estado, 'resuelto');
  assert.equal(r.producto.nombre, 'Chilaquiles Mixtos');
  assert.equal(r.motivo, 'unico_compatible', 'no lo decidió la cardinalidad');
});

await t('V5. y también variante → base, cuando los datos lo determinan', async () => {
  // Una sola salsa: Mixtos exige dos, así que queda fuera por el mínimo.
  const r = anclar(CARTA, 'Chilaquiles Mixtos', 'quiero chilaquiles suizos');
  assert.equal(r.estado, 'resuelto');
  assert.equal(r.producto.nombre, 'Chilaquiles Sencillos',
    `no volvió a la base: ${r.producto.nombre}`);
});

await t('V6. dos variantes compatibles y ninguna es la base → se pregunta', async () => {
  // El cliente nombra las dos explícitas: no se elige por él.
  const r = anclar(CARTA, 'chilaquiles', 'quiero un bowl o el combito de chilaquiles');
  assert.equal(r.estado, 'ambiguo', `eligió ${r.producto?.nombre}`);
  assert.deepEqual(r.candidatos.map((c) => c.nombre).sort(),
    ['Bowl de Chilaquiles', 'Combito de Chilaquiles']);
  assert.equal(r.motivo, 'varias_nombradas');
});

await t('V6b. y sin base declarada ni orden que distinga, tampoco se elige', async () => {
  const EMPATE = [{ id: 1, nombre: 'X', productos: [
    { id: 41, nombre: 'Torta Ahogada', orden: 0, precio: 90, disponible: true, modificadores: [] },
    { id: 42, nombre: 'Torta Bañada', orden: 0, precio: 90, disponible: true, modificadores: [] },
  ] }];
  const r = anclar(EMPATE, 'torta', 'quiero una torta');
  assert.equal(r.estado, 'ambiguo', `eligió ${r.producto?.nombre} sin que nadie dijera cuál es la normal`);
  assert.equal(r.candidatos.length, 2);
});

await t('V7. el discriminador declarado funciona («combo» además de «combito»)', async () => {
  assert.equal(resuelveA(CARTA, 'chilaquiles', 'quiero el combo de chilaquiles'),
    'Combito de Chilaquiles');
  // Y el derivado del nombre también, sin declarar nada: «bowl».
  assert.equal(resuelveA(CARTA, 'chilaquiles', 'un bowl de chilaquiles'),
    'Bowl de Chilaquiles');
});

await t('V7b. sin nada declarado, `orden` basta para decir cuál es la normal', async () => {
  // La pista tiene que ser GENÉRICA: con «café americano» el desempate por
  // nombre completo ya resuelve antes, y entonces esta prueba no probaría la
  // regla que dice probar.
  const r = anclar(SOLO_ORDEN, 'cafe', 'quiero un café');
  assert.equal(r.estado, 'resuelto', `quedó ${JSON.stringify(r.candidatos?.map((c) => c.nombre))}`);
  assert.equal(r.producto.nombre, 'Café Americano');
  assert.equal(r.motivo, 'variante_base_por_orden',
    `resolvió por otra vía (${r.motivo}): la regla del orden no se ejercitó`);
  // Y nombrando la otra, gana la otra.
  assert.equal(resuelveA(SOLO_ORDEN, 'cafe', 'un café grande'), 'Café Americano Grande');
});

await t('V8. el resolvedor no menciona ningún producto, grupo ni negocio', async () => {
  const { readFileSync } = await import('node:fs');
  const fuente = readFileSync(new URL('../src/mesero-whatsapp/anclajeAlCatalogo.js', import.meta.url), 'utf8');
  const codigo = fuente.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const palabra of ['chilaquil', 'mapolato', 'bowl', 'combito', 'sencillo', 'mixto',
    'hamburguesa', 'pizza', 'salsa', 'suiza', 'cafe']) {
    assert(!new RegExp(palabra, 'i').test(codigo),
      `el resolvedor menciona "${palabra}" fuera de los comentarios`);
  }
});

await t('V9. el MISMO motor sobre hamburguesas', async () => {
  assert.equal(resuelveA(HAMBURGUESAS, 'hamburguesa', 'quiero una hamburguesa'),
    'Hamburguesa Clasica');
  assert.equal(resuelveA(HAMBURGUESAS, 'hamburguesa', 'quiero una hamburguesa con doble carne de res y pollo'),
    'Hamburguesa Doble');
  assert.equal(resuelveA(HAMBURGUESAS, 'hamburguesa', 'quiero el combo de hamburguesa'),
    'Hamburguesa Combo');
});

await t('V10. las familias de dos negocios no se contaminan', async () => {
  // La misma palabra genérica en dos cartas distintas resuelve en cada una a lo
  // suyo, y nunca a lo del otro.
  const A = anclar(CARTA, 'chilaquiles', 'unos chilaquiles');
  const B = anclar(HAMBURGUESAS, 'hamburguesa', 'una hamburguesa');
  assert.equal(A.producto.nombre, 'Chilaquiles Sencillos');
  assert.equal(B.producto.nombre, 'Hamburguesa Clasica');
  // Y buscar en una lo que sólo existe en la otra no devuelve nada.
  assert.equal(anclar(CARTA, 'hamburguesa', 'una hamburguesa').estado, 'sin_candidatos');
  assert.equal(anclar(HAMBURGUESAS, 'chilaquiles', 'unos chilaquiles').estado, 'sin_candidatos');
});

// ── La lectura de los datos, aislada ─────────────────────────────────────

await t('V11. la metadata se lee del jsonb que YA existe, sin esquema nuevo', async () => {
  assert.deepEqual(leerVariante({ opciones: { variante: { base: true } } }), { base: true });
  assert.deepEqual(leerVariante({ opciones: { variante: { requiere_mencion: true } } }),
    { requiereMencion: true });
  assert.deepEqual(leerVariante({}), {}, 'inventó metadata donde no la hay');
  assert.deepEqual(leerVariante({ opciones: { imagen: 'x.png' } }), {},
    'confundió otro contenido del jsonb con metadata de variante');
  // Y `orden` llega a la ficha, que es de donde sale la base por omisión.
  const f = fichaDeProducto({ id: 1, nombre: 'X', orden: 3, modificadores: [] });
  assert.equal(f.orden, 3);
});

await t('V12. resolverVariante no elige cuando no tiene con qué', async () => {
  const sinDatos = [
    fichaDeProducto({ id: 1, nombre: 'Algo Uno', modificadores: [] }),
    fichaDeProducto({ id: 2, nombre: 'Algo Dos', modificadores: [] }),
  ];
  const r = resolverVariante(sinDatos, 'quiero algo');
  assert.equal(r.elegidas.length, 2, 'eligió sin que nadie dijera cuál es la normal');
});

console.log(fallos.length
  ? `\n> CON FALLOS — ${pasadas} pasadas, ${fallos.length} fallidas\n    · ${fallos.join('\n    · ')}`
  : `\n  TODO VERDE — ${pasadas} pasadas, 0 fallidas`);
process.exit(fallos.length ? 1 : 0);
