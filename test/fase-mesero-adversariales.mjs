// LOS VEINTE CASOS QUE ROMPEN UN BOT DE PEDIDOS.
//
// Fase X del Mesero Digital. Cada uno es una forma real de que un asistente
// conversacional le cobre a alguien algo que no pidió, o le quite algo que sí.
//
// El modelo está simulado, y en varios casos se le hace fallar A PROPÓSITO —
// inventar, sustituir, reescribir— porque el sistema tiene que aguantar eso: un
// modelo que siempre acierta no necesita ninguna de estas capas.
//
// Regla de lectura: donde la prueba espera una pregunta, esperar una elección
// sería el fallo. Preguntar cuesta un turno; equivocarse llega a la mesa.
import assert from 'node:assert/strict';

const { atenderTurno, contextoSerializable } = await import('../src/mesero/meseroDigital.js');

let ok = 0, fail = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); ok++; console.log(`  OK  ${nombre}`); }
  catch (e) { fail++; fallos.push(`${nombre}: ${e.message}`); console.log(`FALLO ${nombre}: ${e.message}`); }
}

// ── La carta ────────────────────────────────────────────────────────────────
const g = (nombre, opciones, requerido = false) => ({
  nombre, requerido, minimo: requerido ? 1 : 0, maximo: 1,
  opciones: opciones.map((n) => ({ nombre: n, disponible: true, precio_extra: 0 })),
});
const CATALOGO = [
  { id: 1, nombre: 'Fuertes', productos: [
    { id: 11, nombre: 'Chilaquiles', precio: 130, disponible: true, agotado: false, descripcion: 'Llenador.',
      modificadores: [g('Salsa', ['Salsa Verde', 'Salsa Roja']), g('Proteina', ['Pollo', 'Res'])] },
    { id: 12, nombre: 'Hotcakes', precio: 95, disponible: true, agotado: false, descripcion: 'Dulce.',
      modificadores: [g('Acompanamiento', ['Fruta', 'Tocino'])] },
  ] },
  { id: 2, nombre: 'Bebidas', productos: [
    { id: 21, nombre: 'Coca Cola', precio: 35, disponible: true, agotado: false, modificadores: [] },
    { id: 22, nombre: 'Cafe de Olla', precio: 25, disponible: true, agotado: false, destacado: true, modificadores: [] },
  ] },
];

const mod = (grupo, ...opciones) => ({ grupo, opciones });
const it = (nombre, cantidad = 1, modificadores = [], notas = '') => ({ nombre, cantidad, modificadores, notas });

/**
 * Corre una conversación. `guion` es una lista de `{ cliente, borrador }` o de
 * funciones que reciben el carrito actual y devuelven el borrador del modelo.
 */
async function conversar(guion, { negocioId = 'nX', conversacionId = 'cX', ...resto } = {}) {
  let contexto = null, carrito = null;
  const turnos = [];
  for (const paso of guion) {
    const r = await atenderTurno({
      negocioId, conversacionId, mensaje: paso.cliente, contextoGuardado: contexto, carrito,
      catalogo: CATALOGO, ...resto,
      proponer: async () => (typeof paso.borrador === 'function' ? paso.borrador(carrito) : paso.borrador),
    });
    contexto = JSON.parse(JSON.stringify(contextoSerializable(r.contexto)));
    carrito = r.carrito;
    turnos.push(r);
  }
  return { turnos, carrito, contexto, ultimo: turnos.at(-1) };
}

const linea = (carrito, nombre) => (carrito?.items || []).filter((i) => i.nombre === nombre);
const opcionesDe = (item) => (item?.modificadores || []).flatMap((m) => m.opciones || []).sort();
const resumen = (carrito) => (carrito?.items || []).map((i) => `${i.cantidad}x ${i.nombre}`).join(' | ');

// ── 1 ───────────────────────────────────────────────────────────────────────
await t('X1. «con fruta» va a los hotcakes, no a los chilaquiles', async () => {
  const { carrito } = await conversar([
    { cliente: 'quiero unos chilaquiles', borrador: { items: [it('Chilaquiles')] } },
    { cliente: 'con pollo', borrador: { items: [it('Chilaquiles', 1, [mod('Proteina', 'Pollo')])] } },
    { cliente: 'y unos hotcakes', borrador: { items: [it('Chilaquiles', 1, [mod('Proteina', 'Pollo')]), it('Hotcakes')] } },
    { cliente: 'con fruta', borrador: (c) => ({ items: [
      { ...linea(c, 'Chilaquiles')[0] },
      { ...linea(c, 'Hotcakes')[0], modificadores: [mod('Acompanamiento', 'Fruta')] },
    ] }) },
  ]);
  assert.deepEqual(opcionesDe(linea(carrito, 'Hotcakes')[0]), ['Fruta']);
  assert.deepEqual(opcionesDe(linea(carrito, 'Chilaquiles')[0]), ['Pollo'],
    'la fruta se contagió al platillo de al lado');
});

// ── 2 ───────────────────────────────────────────────────────────────────────
await t('X2. «mejor sin» a secas no quita nada', async () => {
  const { carrito, ultimo } = await conversar([
    { cliente: 'unos chilaquiles con pollo y salsa verde',
      borrador: { items: [it('Chilaquiles', 1, [mod('Proteina', 'Pollo'), mod('Salsa', 'Salsa Verde')])] } },
    { cliente: 'mejor sin', borrador: (c) => ({ items: [{ ...linea(c, 'Chilaquiles')[0], modificadores: [] }] }) },
  ]);
  assert.deepEqual(opcionesDe(linea(carrito, 'Chilaquiles')[0]), ['Pollo', 'Salsa Verde'],
    'un «sin» sin objeto vació el platillo');
  assert.equal(ultimo.carrito.items.length, 1);
});

// ── 3 ───────────────────────────────────────────────────────────────────────
await t('X3. «quita el otro» quita el otro, y con tres pregunta', async () => {
  const dos = await conversar([
    { cliente: 'unos chilaquiles', borrador: { items: [it('Chilaquiles')] } },
    { cliente: 'y unos hotcakes', borrador: { items: [it('Chilaquiles'), it('Hotcakes')] } },
    { cliente: 'quita el otro', borrador: (c) => ({ items: c.items.map((x) => ({ ...x })) }) },
  ]);
  // El cliente acaba de pedir los hotcakes, así que el foco está ahí y «el
  // otro» son los chilaquiles: se van ellos y quedan los hotcakes.
  assert.equal(resumen(dos.carrito), '1x Hotcakes',
    `«el otro» no resolvió al que no está en foco: quedó ${resumen(dos.carrito)}`);
  assert.equal(dos.ultimo.cambios.autorizados.some((a) => a.via === 'la_referencia_lo_identifica'), true,
    'se quitó por otra vía que no fue la referencia');

  const tres = await conversar([
    { cliente: 'unos chilaquiles', borrador: { items: [it('Chilaquiles')] } },
    { cliente: 'y unos hotcakes', borrador: { items: [it('Chilaquiles'), it('Hotcakes')] } },
    { cliente: 'y un cafe de olla', borrador: { items: [it('Chilaquiles'), it('Hotcakes'), it('Cafe de Olla')] } },
    { cliente: 'quita el otro', borrador: (c) => ({ items: c.items.map((x) => ({ ...x })) }) },
  ]);
  assert.equal(tres.carrito.items.length, 3, 'quitó uno de tres sin saber cuál');
  assert(tres.ultimo.aclaraciones.some((a) => a.tipo === 'referencia_ambigua'),
    JSON.stringify(tres.ultimo.aclaraciones));
});

// ── 4 ───────────────────────────────────────────────────────────────────────
await t('X4. «ponme dos» sube el renglón del que se venía hablando', async () => {
  const { carrito } = await conversar([
    { cliente: 'un cafe de olla', borrador: { items: [it('Cafe de Olla')] } },
    { cliente: 'ponme dos', borrador: (c) => ({ items: [{ ...c.items[0], cantidad: 2 }] }) },
  ]);
  assert.equal(linea(carrito, 'Cafe de Olla')[0].cantidad, 2);
});

// ── 5 ───────────────────────────────────────────────────────────────────────
await t('X5. cambiar de idea tres veces deja la última, no las tres', async () => {
  const { carrito } = await conversar([
    { cliente: 'unos chilaquiles con salsa verde',
      borrador: { items: [it('Chilaquiles', 1, [mod('Salsa', 'Salsa Verde')])] } },
    { cliente: 'mejor roja', borrador: { items: [it('Chilaquiles', 1, [mod('Salsa', 'Salsa Roja')])] } },
    { cliente: 'no, mejor verde', borrador: { items: [it('Chilaquiles', 1, [mod('Salsa', 'Salsa Verde')])] } },
    { cliente: 'ya, que sea roja', borrador: { items: [it('Chilaquiles', 1, [mod('Salsa', 'Salsa Roja')])] } },
  ]);
  assert.equal(carrito.items.length, 1, 'cada cambio de idea creó un renglón');
  assert.deepEqual(opcionesDe(carrito.items[0]), ['Salsa Roja']);
});

// ── 6 ───────────────────────────────────────────────────────────────────────
await t('X6. preguntar por algo no lo pide, aunque el modelo lo meta', async () => {
  const { carrito, ultimo } = await conversar([
    { cliente: 'tienen coca cola?', borrador: { items: [it('Coca Cola')] } },
  ]);
  assert.deepEqual(carrito.items, [], 'una pregunta metió el producto al pedido');
  assert(ultimo.consulta, 'no se contestó la pregunta');
});

// ── 7 ───────────────────────────────────────────────────────────────────────
await t('X7. una recomendación ignorada no se cuela ni se repite', async () => {
  const { carrito, turnos } = await conversar([
    { cliente: 'unos chilaquiles', borrador: { items: [it('Chilaquiles')] } },
    { cliente: 'que me recomiendas?', borrador: null },
    { cliente: 'y unos hotcakes', borrador: (c) => ({ items: [...c.items.map((x) => ({ ...x })), it('Hotcakes')] }) },
  ]);
  const recomendado = turnos[1].recomendaciones[0]?.nombre;
  assert(recomendado, 'no recomendó nada a quien se lo pidió');
  assert.equal(linea(carrito, recomendado).length, 0,
    `la recomendación "${recomendado}" entró sola al pedido`);
  assert.deepEqual(turnos[2].recomendaciones, [], 'volvió a ofrecer en el turno siguiente');
});

// ── 8 ───────────────────────────────────────────────────────────────────────
await t('X8. una recomendación aceptada por su nombre entra', async () => {
  const { carrito, turnos } = await conversar([
    { cliente: 'unos chilaquiles', borrador: { items: [it('Chilaquiles')] } },
    { cliente: 'que me recomiendas?', borrador: null },
    { cliente: 'va el cafe', borrador: (c) => ({ items: [...c.items.map((x) => ({ ...x })), it('Cafe de Olla')] }) },
  ]);
  assert(turnos[1].recomendaciones.some((r) => r.nombre === 'Cafe de Olla'),
    JSON.stringify(turnos[1].recomendaciones));
  assert.equal(linea(carrito, 'Cafe de Olla').length, 1,
    'el cliente aceptó una sugerencia y no entró');
  assert.equal(turnos[2].desenlace.aceptadas[0].referencia, 'Cafe de Olla');
});

// ── 9 ───────────────────────────────────────────────────────────────────────
await t('X9. dos renglones del mismo producto no se fusionan', async () => {
  const { carrito } = await conversar([
    { cliente: 'dos cocas por favor, una para mi y otra para ella',
      borrador: { items: [it('Coca Cola'), it('Coca Cola')] } },
  ]);
  assert.equal(linea(carrito, 'Coca Cola').length, 2, resumen(carrito));
  const lids = linea(carrito, 'Coca Cola').map((x) => x.lid);
  assert.notEqual(lids[0], lids[1], 'los dos renglones comparten identidad');
});

// ── 10 ──────────────────────────────────────────────────────────────────────
await t('X10. «otra igual» agrega un renglón, no sube la cantidad', async () => {
  const { carrito } = await conversar([
    { cliente: 'una coca', borrador: { items: [it('Coca Cola')] } },
    { cliente: 'otra igual', borrador: (c) => ({ items: c.items.map((x) => ({ ...x })) }) },
  ]);
  assert.equal(linea(carrito, 'Coca Cola').length, 2, `no duplicó: ${resumen(carrito)}`);
  assert(linea(carrito, 'Coca Cola').every((x) => x.cantidad === 1));
});

// ── 11 ──────────────────────────────────────────────────────────────────────
await t('X11. «una para mí y otra para ella» no inventa dueños', async () => {
  const { carrito } = await conversar([
    { cliente: 'una coca para mi y otra para ella',
      borrador: { items: [it('Coca Cola', 1, [], 'para mi'), it('Coca Cola', 1, [], 'para ella')] } },
  ]);
  assert.equal(linea(carrito, 'Coca Cola').length, 2);
  // Las notas que el modelo inventó pueden entrar o no, pero NO puede aparecer
  // un dueño que el cliente no dijo.
  const notas = linea(carrito, 'Coca Cola').map((x) => x.notas).join(' ');
  assert(!/el|ellos|nosotros/i.test(notas.replace(/para ella|para mi/gi, '')),
    `se inventó un dueño: "${notas}"`);
});

// ── 12 ──────────────────────────────────────────────────────────────────────
await t('X12. lo que el sistema ve en una foto no lo pidió el cliente', async () => {
  const turnoConFoto = '[CONTEXTO VISUAL]\nAnálisis automático: productos que parecen aparecer: '
    + 'Chilaquiles (confianza 0.9)\n[/CONTEXTO VISUAL]\nquiero esto porfa';
  const { carrito, ultimo } = await conversar([
    { cliente: turnoConFoto, borrador: { items: [it('Chilaquiles', 2, [mod('Salsa', 'Salsa Roja')])] } },
  ]);
  assert.deepEqual(carrito.items, [],
    'la visión metió al pedido un platillo que nadie nombró');
  assert(ultimo.cambios.porConfirmar.length > 0 || ultimo.cambios.sinRespaldo.length > 0,
    'no quedó rastro de lo que se percibió y no se aplicó');
});

// ── 13 ──────────────────────────────────────────────────────────────────────
await t('X13. una ambigüedad irresoluble se pregunta y no se resuelve sola', async () => {
  const { carrito, ultimo } = await conversar([
    { cliente: 'unos chilaquiles', borrador: { items: [it('Chilaquiles')] } },
    { cliente: 'y unos hotcakes', borrador: { items: [it('Chilaquiles'), it('Hotcakes')] } },
    // Sin foco reciente y sin nombrar: «quítalo» no tiene antecedente único.
    { cliente: 'quitalo', borrador: (c) => ({ items: c.items.map((x) => ({ ...x })) }) },
  ]);
  // El foco está en los hotcakes (el último nacido), así que «quítalo» SÍ tiene
  // antecedente. Lo que no puede pasar es que se lleve los dos.
  assert.equal(carrito.items.length, 1, `se llevó de más: ${resumen(carrito)}`);
  assert.equal(carrito.items[0].nombre, 'Chilaquiles');
  assert.equal(ultimo.referencia.resuelta, true);
});

await t('X13b. sin foco y con dos candidatos, «quítalo» no quita nada', async () => {
  const { carrito, ultimo } = await conversar([
    { cliente: 'unos chilaquiles y unos hotcakes',
      borrador: { items: [it('Chilaquiles'), it('Hotcakes')] } },
    { cliente: 'quitalo', borrador: (c) => ({ items: c.items.map((x) => ({ ...x })) }) },
  ]);
  assert.equal(carrito.items.length, 2, `quitó sin saber cuál: ${resumen(carrito)}`);
  assert.equal(ultimo.referencia.resuelta, false);
  assert(ultimo.aclaraciones.some((a) => a.tipo === 'referencia_ambigua'));
});

// ── 14 ──────────────────────────────────────────────────────────────────────
await t('X14. un cliente molesto sale del bot con su equipaje', async () => {
  const { ultimo, carrito } = await conversar([
    { cliente: 'unos chilaquiles', borrador: { items: [it('Chilaquiles')] } },
    { cliente: 'esto es pesimo, llevo una hora esperando', borrador: null },
  ]);
  assert.equal(ultimo.handoff.escalar, true, 'el bot siguió tomando el pedido');
  assert.equal(ultimo.fase, 'escalado_humano');
  assert.equal(ultimo.handoff.equipaje.pedido_provisional.items.length, 1,
    'quien entre no ve lo que el cliente ya había pedido');
  assert.equal(carrito.items.length, 1, 'el escalado borró el pedido en curso');
});

// ── 15 ──────────────────────────────────────────────────────────────────────
await t('X15. un pedido completo en un solo mensaje se resuelve entero', async () => {
  const { carrito, ultimo } = await conversar([
    { cliente: 'dame dos chilaquiles con salsa roja y pollo, para recoger y pago en efectivo',
      borrador: { items: [it('Chilaquiles', 2, [mod('Salsa', 'Salsa Roja'), mod('Proteina', 'Pollo')])],
        modalidad: 'recoger', forma_pago: 'efectivo' } },
  ]);
  assert.equal(carrito.items[0].cantidad, 2);
  assert.deepEqual(opcionesDe(carrito.items[0]), ['Pollo', 'Salsa Roja']);
  assert.equal(carrito.datos.modalidad, 'recoger');
  assert.equal(carrito.datos.forma_pago, 'efectivo');
  assert.deepEqual(ultimo.falta, [], JSON.stringify(ultimo.falta));
});

// ── 16 ──────────────────────────────────────────────────────────────────────
await t('X16. el mismo mensaje dos veces no duplica el pedido', async () => {
  const borrador = { items: [it('Chilaquiles')] };
  const { carrito } = await conversar([
    { cliente: 'quiero unos chilaquiles', borrador },
    { cliente: 'quiero unos chilaquiles', borrador },
  ]);
  assert.equal(linea(carrito, 'Chilaquiles').length, 1,
    `un reenvío duplicó el platillo: ${resumen(carrito)}`);
  assert.equal(carrito.items[0].cantidad, 1);
});

// ── 17 ──────────────────────────────────────────────────────────────────────
await t('X17. un producto que el modelo se inventa no entra', async () => {
  const { carrito, ultimo } = await conversar([
    { cliente: 'para recoger', borrador: { items: [it('Coca Cola', 3)], modalidad: 'recoger' } },
  ]);
  assert.deepEqual(carrito.items, [], 'entraron tres cocas que nadie pidió');
  assert.equal(carrito.datos.modalidad, 'recoger', 'la modalidad sí era del cliente');
  assert(ultimo.cambios.sinRespaldo.some((s) => s.nombre === 'Coca Cola'));
});

// ── 18 ──────────────────────────────────────────────────────────────────────
await t('X18. el modelo no puede sustituir un platillo por otro sin evidencia', async () => {
  const { carrito } = await conversar([
    { cliente: 'unos chilaquiles', borrador: { items: [it('Chilaquiles')] } },
    // El cliente contesta la modalidad; el modelo cambia el platillo.
    { cliente: 'para recoger', borrador: { items: [it('Hotcakes')], modalidad: 'recoger' } },
  ]);
  assert.equal(linea(carrito, 'Chilaquiles').length, 1, 'se perdió el platillo del cliente');
  assert.equal(linea(carrito, 'Hotcakes').length, 0, 'entró un platillo que nadie pidió');
  assert.equal(carrito.datos.modalidad, 'recoger');
});

// ── 19 ──────────────────────────────────────────────────────────────────────
await t('X19. un «va» después de una consulta no agrega lo consultado', async () => {
  const { carrito } = await conversar([
    { cliente: 'que bebidas tienen?', borrador: null },
    { cliente: 'va', borrador: { items: [it('Coca Cola')] } },
  ]);
  assert.deepEqual(carrito.items, [],
    'un «va» sin objeto agregó lo último que se mencionó en la carta');
});

// ── 20 ──────────────────────────────────────────────────────────────────────
await t('X20. un «sí» después de dos preguntas se pregunta, no se elige', async () => {
  // El bot ofrece dos cosas en el mismo turno.
  const { carrito, ultimo } = await conversar([
    { cliente: 'unos chilaquiles', borrador: { items: [it('Chilaquiles')] } },
    { cliente: 'que me recomiendas?', borrador: null },
    { cliente: 'si', borrador: (c) => ({ items: c.items.map((x) => ({ ...x })) }) },
  ]);
  const ofrecidas = ultimo.contexto.propuestas.filter((p) => p.turno >= 3);
  if (ofrecidas.length > 1) {
    assert.equal(ultimo.desenlace.ambigua, true, 'eligió una de dos con un sí pelado');
    assert(ultimo.aclaraciones.some((a) => a.tipo === 'respuesta_ambigua'));
  }
  assert.equal(linea(carrito, 'Chilaquiles').length, 1);
  assert.equal(carrito.items.length, ofrecidas.length > 1 ? 1 : carrito.items.length,
    `un sí ambiguo agregó algo: ${resumen(carrito)}`);
});

// ── 21 ──────────────────────────────────────────────────────────────────────
await t('X21. «ponme dos cocas» no sube la cantidad de lo que está en foco', async () => {
  // El foco está en los chilaquiles y el cliente NOMBRA otra cosa. La
  // referencia elíptica casa con «ponme dos», y si se dejara atribuir por foco
  // el pedido acabaría con dos chilaquiles que nadie pidió.
  const { carrito } = await conversar([
    { cliente: 'unos chilaquiles', borrador: { items: [it('Chilaquiles')] } },
    { cliente: 'ponme dos cocas',
      borrador: (c) => ({ items: [{ ...c.items[0], cantidad: 2 }, it('Coca Cola', 2)] }) },
  ]);
  assert.equal(linea(carrito, 'Chilaquiles')[0].cantidad, 1,
    `el foco autorizó una cantidad que el cliente dijo de OTRO producto: ${resumen(carrito)}`);
  assert.equal(linea(carrito, 'Coca Cola')[0]?.cantidad, 2, resumen(carrito));
});

// ── 22 ──────────────────────────────────────────────────────────────────────
await t('X22. un renglón duplicado nace con identidad propia', async () => {
  const { carrito } = await conversar([
    { cliente: 'una coca', borrador: { items: [it('Coca Cola')] } },
    { cliente: 'otra igual', borrador: (c) => ({ items: c.items.map((x) => ({ ...x })) }) },
    // Y ahora se cambia SOLO uno de los dos.
    { cliente: 'al primero ponle nota de sin hielo',
      borrador: (c) => ({ items: c.items.map((x, i) => (i === 0 ? { ...x, notas: 'sin hielo' } : { ...x })) }) },
  ]);
  const cocas = linea(carrito, 'Coca Cola');
  assert.equal(cocas.length, 2, resumen(carrito));
  assert.notEqual(cocas[0].lid, cocas[1].lid, 'los dos renglones comparten identidad');
  assert.equal(cocas[1].notas, '', `la nota se contagió al otro renglón: "${cocas[1].notas}"`);
});

console.log(`\n${fail === 0 ? 'TODO VERDE' : 'CON FALLOS'} — ${ok} pasadas, ${fail} fallidas`);
if (fallos.length) for (const f of fallos) console.log(`  · ${f}`);
process.exit(fail ? 1 : 0);
