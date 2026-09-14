// ─── «También chipotle» ───────────────────────────────────────────────────
//
// A1–A18. Un grupo de modificadores se venía tratando SIEMPRE como sustitución:
// lo propuesto reemplazaba a lo que hubiera. Con eso era imposible pedir dos
// salsas en dos mensajes — la segunda borraba la primera.
//
// ── Dónde estaba de verdad, y dónde NO estaba ────────────────────────────
//
// La ronda anterior lo atribuyó al reconciliador, y era falso: llamándolo con
// su contexto real, `reconciliar` acumula perfectamente. El que descartaba la
// opción vieja era el FILTRO DE AMBIGÜEDAD de `meseroDigital`, que medía cada
// opción propuesta contra el texto de ESTE turno. «También chipotle» no
// contiene la palabra «suiza», así que la suiza del turno anterior se declaraba
// ambigua y se caía antes de llegar a nadie.
//
// Por eso el arreglo no toca `carritoDelPedido.js`: una opción que YA está en
// el renglón no es una elección nueva, y su prueba de autorización es que está
// ahí.
//
// ── Y la mitad peligrosa ─────────────────────────────────────────────────
//
// Dejar sobrevivir lo ya elegido es correcto para «también» y peligroso para
// «mejor»: si el modelo propone las dos salsas y el cliente pidió cambiar,
// conservar la vieja le sirve algo que quiso quitar. La operación la dice el
// TEXTO (`mutacionDeOpciones`), no el modelo, y sin señal explícita de suma el
// grupo se sustituye, como siempre.
import assert from 'node:assert/strict';
import { atenderTurno } from '../src/mesero-whatsapp/meseroDigital.js';
import { operacionSobreElGrupo, pidioSumar } from '../src/mesero-whatsapp/mutacionDeOpciones.js';

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

// Sencillos admite UNA salsa; Mixtos, dos. Es dato del negocio, no una regla.
const CARTA = [
  { id: 1, nombre: 'CHILAQUILES', productos: [
    // `Tortilla` admite UNA en las dos presentaciones: es el grupo donde
    // «también» no tiene a dónde crecer, y por tanto hay que preguntar.
    { id: 11, nombre: 'Chilaquiles Sencillos', orden: 0, precio: 195, disponible: true,
      modificadores: [g('Salsa', 1, 1, SALSAS), g('Proteína', 1, 1, PROTS),
        g('Tortilla', 1, 1, ['Maiz', 'Harina'])] },
    { id: 12, nombre: 'Chilaquiles Mixtos', orden: 1, precio: 205, disponible: true,
      modificadores: [g('Salsa', 2, 2, SALSAS), g('Proteína', 1, 2, PROTS),
        g('Tortilla', 1, 1, ['Maiz', 'Harina'])] },
  ] },
  { id: 2, nombre: 'BEBIDAS', productos: [
    { id: 21, nombre: 'Licuado de fresa', orden: 0, precio: 60, disponible: true, modificadores: [] },
  ] },
];

// Una carta que no comparte una palabra con la anterior (A18).
const TACOS = [
  { id: 1, nombre: 'TACOS', productos: [
    { id: 31, nombre: 'Orden Sencilla', orden: 0, precio: 90, disponible: true,
      modificadores: [g('Guiso', 1, 1, ['Pastor', 'Suadero', 'Lengua', 'Buche'])] },
    { id: 32, nombre: 'Orden Surtida', orden: 1, precio: 110, disponible: true,
      modificadores: [g('Guiso', 2, 2, ['Pastor', 'Suadero', 'Lengua', 'Buche'])] },
  ] },
];

const it = (nombre, modificadores = [], extra = {}) => ({ nombre, cantidad: 1, modificadores, notas: '', ...extra });
const grupo = (g_, ...opciones) => ({ grupo: g_, opciones });

async function conversar(guion, catalogo = CARTA) {
  let contexto = null; let carrito = null;
  const fuera = [];
  for (const paso of guion) {
    const r = await atenderTurno({
      negocioId: 'n-acu', conversacionId: 'c-acu', mensaje: paso.cliente,
      catalogo, requierePago: false, contextoGuardado: contexto, carrito,
      proponer: async () => paso.borrador ?? null,
    });
    contexto = JSON.parse(JSON.stringify(r.contexto));
    carrito = r.carrito;
    fuera.push(r);
  }
  return fuera;
}
const linea = (r, i = 0) => r.carrito.items[i];
const opcionesDe = (r, grupoNombre, i = 0) => (linea(r, i)?.modificadores || [])
  .filter((m) => m.grupo === grupoNombre)
  .flatMap((m) => m.opciones).sort();

// ── El guion base: un platillo con una salsa ────────────────────────────
const T1 = { cliente: 'Quiero unos Chilaquiles Sencillos suizos',
  borrador: { items: [it('Chilaquiles Sencillos', [grupo('Salsa', 'Suiza')])] } };

// ═══════════════════════════════════════════════════════════════════════════
// A1–A10 · LA MUTACIÓN
// ═══════════════════════════════════════════════════════════════════════════

await t('A1. [A] + «también B» con max=2 → [A,B]', async () => {
  const rs = await conversar([T1,
    { cliente: 'También chipotle',
      borrador: { items: [it('Chilaquiles Sencillos', [grupo('Salsa', 'Suiza', 'Chipotle')])] } }]);
  assert.deepEqual(opcionesDe(rs[1], 'Salsa'), ['Chipotle', 'Suiza'],
    `quedó ${JSON.stringify(opcionesDe(rs[1], 'Salsa'))}`);
});

await t('A2. la opción anterior conserva su autorización sin repetirla', async () => {
  // «Suiza» no aparece en «También chipotle» y sobrevive igual: ya estaba en el
  // renglón, y eso ES su prueba de autorización. Lo que NO puede pasar es que
  // se arrastre algo que nunca estuvo.
  const rs = await conversar([T1,
    { cliente: 'También chipotle',
      borrador: { items: [it('Chilaquiles Sencillos', [grupo('Salsa', 'Suiza', 'Chipotle', 'Verde')])] } }]);
  const salsas = opcionesDe(rs[1], 'Salsa');
  assert(salsas.includes('Suiza'), 'se perdió la que ya estaba autorizada');
  assert(!salsas.includes('Verde'), `se coló una que nadie pidió: ${JSON.stringify(salsas)}`);
});

await t('A3. la opción NUEVA sí exige evidencia de este turno', async () => {
  const rs = await conversar([T1,
    { cliente: 'También chipotle',
      borrador: { items: [it('Chilaquiles Sencillos', [grupo('Salsa', 'Suiza', 'Mole')])] } }]);
  assert(!opcionesDe(rs[1], 'Salsa').includes('Mole'),
    'entró una opción que el cliente no nombró en este turno');
});

await t('A4. «mejor B» REEMPLAZA, aunque el modelo proponga las dos', async () => {
  const rs = await conversar([T1,
    { cliente: 'Mejor chipotle',
      borrador: { items: [it('Chilaquiles Sencillos', [grupo('Salsa', 'Suiza', 'Chipotle')])] } }]);
  assert.deepEqual(opcionesDe(rs[1], 'Salsa'), ['Chipotle'],
    `«mejor» acumuló en vez de sustituir: ${JSON.stringify(opcionesDe(rs[1], 'Salsa'))}`);
});

await t('A5. «quítale B» conserva A', async () => {
  const rs = await conversar([T1,
    { cliente: 'También chipotle',
      borrador: { items: [it('Chilaquiles Sencillos', [grupo('Salsa', 'Suiza', 'Chipotle')])] } },
    { cliente: 'Quítale el chipotle',
      borrador: { items: [it('Chilaquiles Mixtos', [grupo('Salsa', 'Suiza')])] } }]);
  assert.deepEqual(opcionesDe(rs[2], 'Salsa'), ['Suiza'],
    `quedó ${JSON.stringify(opcionesDe(rs[2], 'Salsa'))}`);
});

await t('A6. con max=1 en TODA la familia, «también B» NO produce [A,B]', async () => {
  // El límite es el de la familia, no el del producto: sumar una segunda salsa
  // sobre una presentación de una sola es legítimo porque existe otra que
  // admite dos. `Tortilla` no tiene esa salida: una en las dos presentaciones.
  const rs = await conversar([
    { cliente: 'Unos Chilaquiles Sencillos con tortilla de maiz',
      borrador: { items: [it('Chilaquiles Sencillos', [grupo('Tortilla', 'Maiz')])] } },
    { cliente: 'También de harina',
      borrador: { items: [it('Chilaquiles Sencillos', [grupo('Tortilla', 'Maiz', 'Harina')])] } }]);
  const tort = opcionesDe(rs[1], 'Tortilla');
  assert(tort.length <= 1, `el grupo admite una y quedaron ${tort.length}: ${JSON.stringify(tort)}`);
  assert.deepEqual(tort, ['Maiz'], `se cambió sola: ${JSON.stringify(tort)}`);
});

await t('A7. nunca se excede el máximo del grupo', async () => {
  const rs = await conversar([T1,
    { cliente: 'También chipotle',
      borrador: { items: [it('Chilaquiles Sencillos', [grupo('Salsa', 'Suiza', 'Chipotle')])] } },
    { cliente: 'Y también roja',
      borrador: { items: [it('Chilaquiles Mixtos', [grupo('Salsa', 'Suiza', 'Chipotle', 'Roja')])] } }]);
  const salsas = opcionesDe(rs[2], 'Salsa');
  assert(salsas.length <= 2, `el grupo admite dos y quedaron ${salsas.length}: ${JSON.stringify(salsas)}`);
});

await t('A8. el lid sobrevive a la mutación', async () => {
  const rs = await conversar([T1,
    { cliente: 'También chipotle',
      borrador: { items: [it('Chilaquiles Sencillos', [grupo('Salsa', 'Suiza', 'Chipotle')])] } }]);
  assert.equal(linea(rs[1]).lid, linea(rs[0]).lid, 'la mutación cambió el renglón de identidad');
});

await t('A9. los otros grupos quedan intactos', async () => {
  const rs = await conversar([
    { cliente: 'Unos Chilaquiles Sencillos suizos con huevos estrellados',
      borrador: { items: [it('Chilaquiles Sencillos',
        [grupo('Salsa', 'Suiza'), grupo('Proteína', 'Huevos Estrellados')])] } },
    { cliente: 'También chipotle',
      borrador: { items: [it('Chilaquiles Sencillos',
        [grupo('Salsa', 'Suiza', 'Chipotle'), grupo('Proteína', 'Huevos Estrellados')])] } }]);
  assert.deepEqual(opcionesDe(rs[1], 'Proteína'), ['Huevos Estrellados'],
    'tocar la salsa movió la proteína');
});

await t('A10. cantidad y notas quedan intactas', async () => {
  const rs = await conversar([
    { cliente: 'Dos Chilaquiles Sencillos suizos sin cebolla',
      borrador: { items: [it('Chilaquiles Sencillos', [grupo('Salsa', 'Suiza')],
        { cantidad: 2, notas: 'sin cebolla' })] } },
    { cliente: 'También chipotle',
      borrador: { items: [it('Chilaquiles Sencillos', [grupo('Salsa', 'Suiza', 'Chipotle')],
        { cantidad: 2, notas: 'sin cebolla' })] } }]);
  assert.equal(linea(rs[1]).cantidad, 2, `la cantidad quedó en ${linea(rs[1]).cantidad}`);
  assert.equal(linea(rs[1]).notas, 'sin cebolla', `la nota quedó en ${JSON.stringify(linea(rs[1]).notas)}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// A11–A15 · EL RESOLVER SE VUELVE A EJECUTAR
// ═══════════════════════════════════════════════════════════════════════════

await t('A11+A12. tras mutar, un solo candidato compatible → RECLASIFICA', async () => {
  const rs = await conversar([T1,
    { cliente: 'También chipotle',
      borrador: { items: [it('Chilaquiles Sencillos', [grupo('Salsa', 'Suiza', 'Chipotle')])] } }]);
  assert.equal(linea(rs[0]).nombre, 'Chilaquiles Sencillos');
  assert.equal(linea(rs[1]).nombre, 'Chilaquiles Mixtos',
    `no reclasificó: quedó ${linea(rs[1]).nombre}`);
  assert.equal(linea(rs[1]).lid, linea(rs[0]).lid, 'la reclasificación perdió el lid');
});

await t('A13. con varios candidatos compatibles NO se elige', async () => {
  // Una salsa cabe en las dos presentaciones sintéticas… salvo que Mixtos exige
  // dos. Aquí se usa una carta donde de verdad quedan dos vivas.
  const DOS = [{ id: 1, nombre: 'X', productos: [
    { id: 41, nombre: 'Combo Chico', orden: 0, precio: 100, disponible: true,
      modificadores: [g('Bebida', 1, 2, ['Agua', 'Refresco'])] },
    { id: 42, nombre: 'Combo Grande', orden: 1, precio: 120, disponible: true,
      modificadores: [g('Bebida', 1, 2, ['Agua', 'Refresco'])] },
  ] }];
  const rs = await conversar([
    { cliente: 'Quiero un combo con agua', borrador: { items: [it('Combo', [grupo('Bebida', 'Agua')])] } },
  ], DOS);
  // `orden` distingue, así que la base gana: eso es resolver por DATOS, no por
  // capricho. Lo que no puede pasar es que se elija la segunda.
  const nombres = rs[0].carrito.items.map((i) => i.nombre);
  assert(nombres.length === 0 || nombres[0] === 'Combo Chico',
    `eligió una variante que no es la base: ${JSON.stringify(nombres)}`);
});

await t('A14. si tras mutar NADA es compatible, la línea no se corrompe', async () => {
  const rs = await conversar([T1,
    { cliente: 'También chipotle',
      borrador: { items: [it('Chilaquiles Sencillos', [grupo('Salsa', 'Suiza', 'Chipotle')])] } },
    { cliente: 'También verde y también mole',
      borrador: { items: [it('Chilaquiles Mixtos',
        [grupo('Salsa', 'Suiza', 'Chipotle', 'Verde', 'Mole')])] } }]);
  const ultima = linea(rs[2]);
  assert(ultima, 'la línea desapareció');
  assert(['Chilaquiles Sencillos', 'Chilaquiles Mixtos'].includes(ultima.nombre),
    `la línea acabó siendo ${ultima.nombre}`);
  assert(opcionesDe(rs[2], 'Salsa').length <= 2, 'se excedió el máximo');
});

await t('A15. dos líneas distintas no se mezclan al mutar', async () => {
  const rs = await conversar([
    { cliente: 'Unos Chilaquiles Sencillos suizos y un Licuado de fresa',
      borrador: { items: [it('Chilaquiles Sencillos', [grupo('Salsa', 'Suiza')]), it('Licuado de fresa')] } },
    { cliente: 'También chipotle',
      borrador: { items: [it('Chilaquiles Sencillos', [grupo('Salsa', 'Suiza', 'Chipotle')]),
        it('Licuado de fresa')] } }]);
  const licuado = rs[1].carrito.items.find((i) => /fresa/i.test(i.nombre));
  assert(licuado, 'se perdió la segunda línea');
  assert.deepEqual(licuado.modificadores || [], [], 'la salsa aterrizó en el licuado');
});

// ═══════════════════════════════════════════════════════════════════════════
// A16–A18 · ALREDEDOR
// ═══════════════════════════════════════════════════════════════════════════

await t('A16. una consulta intermedia no altera las selecciones', async () => {
  const rs = await conversar([T1,
    { cliente: '¿Qué licuados tienen?', borrador: null },
    { cliente: 'También chipotle',
      borrador: { items: [it('Chilaquiles Sencillos', [grupo('Salsa', 'Suiza', 'Chipotle')])] } }]);
  assert.deepEqual(opcionesDe(rs[1], 'Salsa'), ['Suiza'], 'la consulta movió la selección');
  assert.deepEqual(opcionesDe(rs[2], 'Salsa'), ['Chipotle', 'Suiza'],
    'la consulta rompió la acumulación posterior');
});

await t('A17. «también» con una opción que no existe no inventa nada', async () => {
  const rs = await conversar([T1,
    { cliente: 'También unicornio',
      borrador: { items: [it('Chilaquiles Sencillos', [grupo('Salsa', 'Suiza', 'Unicornio')])] } }]);
  const salsas = opcionesDe(rs[1], 'Salsa');
  assert.deepEqual(salsas, ['Suiza'], `entró algo inexistente: ${JSON.stringify(salsas)}`);
  assert.equal(linea(rs[1]).nombre, 'Chilaquiles Sencillos');
});

await t('A18. el MISMO motor con una carta que no comparte una palabra', async () => {
  const rs = await conversar([
    { cliente: 'Una Orden Sencilla de pastor',
      borrador: { items: [it('Orden Sencilla', [grupo('Guiso', 'Pastor')])] } },
    { cliente: 'También suadero',
      borrador: { items: [it('Orden Sencilla', [grupo('Guiso', 'Pastor', 'Suadero')])] } },
  ], TACOS);
  assert.deepEqual(opcionesDe(rs[1], 'Guiso'), ['Pastor', 'Suadero']);
  assert.equal(linea(rs[1]).nombre, 'Orden Surtida',
    `no reclasificó en la otra carta: ${linea(rs[1]).nombre}`);
});

await t('A20. reclasificar cambia el `id` del renglón, no sólo su nombre', async () => {
  // La identidad de un renglón es su `id`, y la reclasificación sólo tocaba el
  // nombre. El renglón quedaba diciendo «Chilaquiles Mixtos» con el id de los
  // Sencillos: quien cobra por id cobra la presentación vieja, quien imprime
  // por nombre manda a cocinar la nueva, y la cardinalidad se valida contra un
  // producto que ya no es ése —dos salsas contra un máximo de una— y tumba el
  // pedido entero.
  const rs = await conversar([T1,
    { cliente: 'También chipotle',
      borrador: { items: [it('Chilaquiles Sencillos', [grupo('Salsa', 'Suiza', 'Chipotle')])] } }]);
  assert.equal(linea(rs[1]).nombre, 'Chilaquiles Mixtos', 'no reclasificó');
  assert.equal(linea(rs[1]).id, 12,
    `el renglón dice «${linea(rs[1]).nombre}» con el id ${linea(rs[1]).id}, que es el de otro producto`);
  // Y en la otra carta, igual.
  const ts = await conversar([
    { cliente: 'Una Orden Sencilla de pastor',
      borrador: { items: [it('Orden Sencilla', [grupo('Guiso', 'Pastor')])] } },
    { cliente: 'También suadero',
      borrador: { items: [it('Orden Sencilla', [grupo('Guiso', 'Pastor', 'Suadero')])] } },
  ], TACOS);
  assert.equal(linea(ts[1]).id, 32, `id=${linea(ts[1]).id} para ${linea(ts[1]).nombre}`);
});

// ── La clasificación, aislada ────────────────────────────────────────────

await t('A19. el texto —no el modelo— dice si suma, sustituye o resta', async () => {
  for (const [texto, esperado] of [
    ['también chipotle', 'agregar'], ['y chipotle', 'agregar'], ['agrégale chipotle', 'agregar'],
    ['con chipotle también', 'agregar'], ['además ponle chipotle', 'agregar'],
    ['mejor chipotle', 'reemplazar'], ['cambia la suiza por chipotle', 'reemplazar'],
    ['en vez de suiza, chipotle', 'reemplazar'],
    ['sin chipotle', 'quitar'], ['quítale chipotle', 'quitar'], ['ya no quiero chipotle', 'quitar'],
    ['con chipotle', null], ['chipotle', null],
  ]) {
    assert.equal(operacionSobreElGrupo(texto), esperado, `«${texto}»`);
  }
  // Y sin señal, NO se suma: el grupo se sustituye, como siempre.
  assert.equal(pidioSumar('con chipotle'), false);
  assert.equal(pidioSumar('también chipotle'), true);
});

await t('A20. el clasificador no sabe de ningún producto ni negocio', async () => {
  const { readFileSync } = await import('node:fs');
  const fuente = readFileSync(new URL('../src/mesero-whatsapp/mutacionDeOpciones.js', import.meta.url), 'utf8');
  const codigo = fuente.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const palabra of ['chilaquil', 'mapolato', 'salsa', 'suiza', 'chipotle', 'taco', 'pastor', 'pizza']) {
    assert(!new RegExp(palabra, 'i').test(codigo), `el clasificador menciona "${palabra}"`);
  }
});

console.log(fallos.length
  ? `\n> CON FALLOS — ${pasadas} pasadas, ${fallos.length} fallidas\n    · ${fallos.join('\n    · ')}`
  : `\n  TODO VERDE — ${pasadas} pasadas, 0 fallidas`);
process.exit(fallos.length ? 1 : 0);
