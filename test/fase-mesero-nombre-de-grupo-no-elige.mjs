// ─── DECIR EL NOMBRE DE UN GRUPO NO ES ELEGIR EN OTRO ─────────────────────
//
// Smoke del 19-sep, turno 9, sobre un pedido YA CONFIRMADO. El cliente escribió
// «Mejor salsa roja». La salsa cambió bien, pero además se le preguntó
// «¿Bistec en Salsa, Queso Panela en Salsa o Chicharron Cuerito en Salsa?»
// —tres opciones del grupo PROTEÍNA— y con esa pregunta abierta el pedido dejó
// de poder cerrarse: `falta` vacío, `listoParaConfirmar` en false.
//
// La carta de Obispado tiene tres proteínas y tres guarniciones que se llaman
// «… en Salsa». La palabra «salsa» las sostiene a todas por igual y ninguna
// separa, que es la forma exacta de una ambigüedad legítima. Pero no lo era: el
// cliente estaba nombrando el GRUPO.
//
// Reproducido en el commit base (c09854c, lo que corría en producción antes de
// este arreglo) con las cinco formas plausibles de devolver ese turno: las
// cinco levantaban la misma pregunta.
//
// ── LO QUE ESTA SUITE VIGILA POR EL OTRO LADO ────────────────────────────
//
// Que no se callen las ambigüedades de verdad. Un cambio explícito de proteína
// sigue eligiendo, una elección realmente ambigua sigue preguntando, y un
// mensaje que toca los dos grupos resuelve los dos.
//
// Sin modelo, sin base, sin WhatsApp.
import assert from 'node:assert/strict';
import { atenderTurno } from '../src/mesero-whatsapp/meseroDigital.js';
import { handoffDeSombra } from '../src/mesero-whatsapp/handoffDeSombra.js';

let pasadas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); pasadas += 1; console.log(`    OK  ${nombre}`); }
  catch (e) { fallos.push(`${nombre}: ${e.message}`); console.log(`> FALLO ${nombre}: ${e.message}`); }
}

// ── La carta de Obispado en lo que importa ──────────────────────────────
//
// Tres proteínas y tres guarniciones que llevan «en Salsa» en el nombre, y el
// grupo Salsa listado DESPUÉS: ese orden es el de la carta real y hace que el
// desempate por grupo no baste por sí solo.
const g = (nombre, minimo, maximo, opciones, requerido = true) => ({
  nombre, requerido, minimo, maximo,
  opciones: opciones.map((n) => ({ nombre: n, disponible: true, precio_extra: 0 })),
});
const PROTS = ['Huevos Estrellados', 'Huevos Revueltos', 'Pechuga de pollo',
  'Chicharron Prensado', 'Bistec en Salsa', 'Queso Panela en Salsa', 'Chicharron Cuerito en Salsa'];
const GUARNS = ['Frijolitos naturales', 'Frijolitos con chorizo', 'Papas a la mexicana',
  'Papas con chorizo', 'Bistec en salsa', 'Queso panela en salsa', 'Chicharron cuerito en salsa'];
const SALSAS = ['Roja', 'Suiza', 'Verde', 'Chipotle'];
const CARTA = [
  { id: 26, nombre: 'CHILAQUILES', orden: 1, productos: [
    { id: 85, nombre: 'Chilaquiles Sencillos', orden: 0, precio: 195, disponible: true,
      opciones: { variante: { base: true } },
      modificadores: [g('Proteína', 1, 1, PROTS), g('Guarniciones', 1, 2, GUARNS), g('Salsa', 1, 1, SALSAS)] },
  ] },
];
const NEGOCIO = '5de544d8-9a0a-4972-9c92-fd48ff22de66';
const SELLO = { negocioId: NEGOCIO, canal: 'whatsapp', telefonoConversacion: '5218781234567' };

let n = 0;
function conversacion(id = `c${n += 1}`) {
  let contexto = null; let carrito = null; let handoffPrevio = null;
  return {
    get carrito() { return carrito; },
    async turno(mensaje, borrador = null) {
      const r = await atenderTurno({
        negocioId: NEGOCIO, conversacionId: id, mensaje, catalogo: CARTA, requierePago: true,
        contextoGuardado: contexto, carrito, proponer: async () => borrador,
      });
      contexto = r.contexto; carrito = r.carrito;
      r.handoff = handoffDeSombra(r, { ...SELLO, catalogo: CARTA, handoffPrevio });
      if (r.handoff.listo) handoffPrevio = r.handoff.huella;
      return r;
    },
  };
}

const MODS = [
  { grupo: 'Salsa', opciones: ['Suiza'] },
  { grupo: 'Proteína', opciones: ['Huevos Estrellados'] },
  { grupo: 'Guarniciones', opciones: ['Frijolitos con chorizo'] },
];
const ITEM = (mods) => ({ nombre: 'Chilaquiles Sencillos', cantidad: 1, modificadores: mods });
const opcionesDe = (carrito, grupo) => ((carrito?.items?.[0]?.modificadores || [])
  .find((m) => m.grupo === grupo)?.opciones || []);
const tipos = (r) => (r.aclaraciones || []).map((a) => `${a.tipo}:${a.grupo || ''}`);

/** El pedido del smoke, completo y a un «Confirmo» de cruzar. */
async function hastaListo(id) {
  const c = conversacion(id);
  await c.turno('Quiero chilaquiles suizos', { items: [ITEM([MODS[0]])] });
  await c.turno('Con huevos estrellados', { items: [ITEM(MODS.slice(0, 2))] });
  await c.turno('Con frijolitos con chorizo', { items: [ITEM(MODS)] });
  await c.turno('Paso a recogerlo', { items: [ITEM(MODS)], modalidad: 'recoger en tienda' });
  const r = await c.turno('Pago con tarjeta',
    { items: [ITEM(MODS)], modalidad: 'recoger en tienda', forma_pago: 'tarjeta' });
  assert.equal(r.listoParaConfirmar, true, `no llegó a listo: ${JSON.stringify(r.falta)}`);
  return c;
}

console.log('\n══ A. LA REPRODUCCIÓN, EN SUS CINCO FORMAS ══');

// Las cinco maneras plausibles en que el modelo devuelve «mejor salsa roja».
// En el commit base las CINCO levantaban la pregunta por la proteína.
const FORMAS = {
  'A1 reemite el item entero': [ITEM([{ grupo: 'Salsa', opciones: ['Roja'] }, MODS[1], MODS[2]])],
  'A2 sólo el grupo Salsa': [ITEM([{ grupo: 'Salsa', opciones: ['Roja'] }])],
  'A3 la opción se llama «Salsa Roja»': [ITEM([{ grupo: 'Salsa', opciones: ['Salsa Roja'] }, MODS[1], MODS[2]])],
  'A4 el modelo se equivoca de grupo': [ITEM([{ grupo: 'Proteína', opciones: ['Salsa Roja'] }, MODS[2]])],
  'A5 todo en minúscula': [ITEM([{ grupo: 'salsa', opciones: ['roja'] }, MODS[1], MODS[2]])],
};
let i = 0;
for (const [etiqueta, items] of Object.entries(FORMAS)) {
  await t(`${etiqueta}: cambia sólo la salsa y no pregunta por la proteína`, async () => {
    const c = await hastaListo(`a${i += 1}`);
    const r = await c.turno('Mejor salsa roja', { items });
    assert.deepEqual(opcionesDe(r.carrito, 'Salsa'), ['Roja'], JSON.stringify(opcionesDe(r.carrito, 'Salsa')));
    assert.deepEqual(opcionesDe(r.carrito, 'Proteína'), ['Huevos Estrellados'],
      `se perdió o cambió la proteína: ${JSON.stringify(opcionesDe(r.carrito, 'Proteína'))}`);
    assert.deepEqual(opcionesDe(r.carrito, 'Guarniciones'), ['Frijolitos con chorizo'],
      JSON.stringify(opcionesDe(r.carrito, 'Guarniciones')));
    assert.deepEqual(tipos(r), [], `preguntó por un grupo que el cliente no tocó: ${JSON.stringify(tipos(r))}`);
    assert.equal(r.listoParaConfirmar, true, `el pedido dejó de poder cerrarse: ${JSON.stringify(r.falta)}`);
  });
}

console.log('\n══ B. LO QUE NO SE PUEDE SILENCIAR ══');

await t('B1. un cambio EXPLÍCITO de proteína sigue eligiendo', async () => {
  const c = await hastaListo('b1');
  const r = await c.turno('Mejor bistec en salsa',
    { items: [ITEM([MODS[0], { grupo: 'Proteína', opciones: ['Bistec en Salsa'] }, MODS[2]])] });
  assert.deepEqual(opcionesDe(r.carrito, 'Proteína'), ['Bistec en Salsa'],
    `no eligió la proteína que el cliente nombró: ${JSON.stringify(opcionesDe(r.carrito, 'Proteína'))}`);
  assert.deepEqual(opcionesDe(r.carrito, 'Salsa'), ['Suiza'], 'le cambió la salsa de paso');
});

await t('B2. y también cuando el modelo NO la propone (sale del texto)', async () => {
  const c = await hastaListo('b2');
  const r = await c.turno('Mejor bistec en salsa', { items: [ITEM([MODS[0], MODS[2]])] });
  assert.deepEqual(opcionesDe(r.carrito, 'Proteína'), ['Bistec en Salsa'],
    JSON.stringify(opcionesDe(r.carrito, 'Proteína')));
});

await t('B3. una elección REALMENTE ambigua sigue preguntando', async () => {
  // «frijolitos» sostiene a dos guarniciones por igual y no es nombre de
  // ningún grupo: la duda es de verdad y tiene que salir.
  const c = conversacion('b3');
  await c.turno('Quiero chilaquiles suizos', { items: [ITEM([MODS[0]])] });
  const r = await c.turno('Con frijolitos', { items: [ITEM([MODS[0]])] });
  assert.ok(tipos(r).some((x) => x.startsWith('opcion_ambigua')),
    `se calló una ambigüedad legítima: ${JSON.stringify(tipos(r))}`);
  assert.deepEqual(opcionesDe(r.carrito, 'Guarniciones'), [],
    `eligió una guarnición que el cliente no separó: ${JSON.stringify(opcionesDe(r.carrito, 'Guarniciones'))}`);
});

await t('B4. un mensaje que cambia LOS DOS grupos resuelve los dos', async () => {
  const c = await hastaListo('b4');
  const r = await c.turno('Mejor salsa roja y pechuga de pollo', {
    items: [ITEM([{ grupo: 'Salsa', opciones: ['Roja'] },
      { grupo: 'Proteína', opciones: ['Pechuga de pollo'] }, MODS[2]])] });
  assert.deepEqual(opcionesDe(r.carrito, 'Salsa'), ['Roja'], JSON.stringify(opcionesDe(r.carrito, 'Salsa')));
  assert.deepEqual(opcionesDe(r.carrito, 'Proteína'), ['Pechuga de pollo'],
    JSON.stringify(opcionesDe(r.carrito, 'Proteína')));
  assert.deepEqual(tipos(r), [], JSON.stringify(tipos(r)));
  assert.equal(r.listoParaConfirmar, true, JSON.stringify(r.falta));
});

await t('B5. una proteína inexistente sigue siendo una pregunta', async () => {
  const c = await hastaListo('b5');
  const r = await c.turno('Mejor con pulpo',
    { items: [ITEM([MODS[0], { grupo: 'Proteína', opciones: ['Pulpo'] }, MODS[2]])] });
  assert.deepEqual(opcionesDe(r.carrito, 'Proteína'), ['Huevos Estrellados'],
    `entró una proteína que no existe: ${JSON.stringify(opcionesDe(r.carrito, 'Proteína'))}`);
});

console.log('\n══ C. EL SEGUNDO RESUMEN Y LA NUEVA CONFIRMACIÓN ══');

await t('C1. tras el cambio de salsa, el pedido se vuelve a confirmar', async () => {
  const c = await hastaListo('c1');
  const primero = await c.turno('Confirmo', { items: [ITEM(MODS)] });
  assert.equal(primero.handoff.listo, true, JSON.stringify(primero.handoff.bloqueos));
  const huella1 = primero.handoff.huella;

  const cambio = await c.turno('Mejor salsa roja',
    { items: [ITEM([{ grupo: 'Salsa', opciones: ['Roja'] }, MODS[1], MODS[2]])] });
  assert.deepEqual(opcionesDe(cambio.carrito, 'Salsa'), ['Roja']);
  assert.equal(cambio.confirmacionVigente, false, 'la confirmación vieja siguió valiendo');
  assert.equal(cambio.handoff.listo, false, JSON.stringify(cambio.handoff.bloqueos));
  // Y el pedido QUEDA CERRABLE: es lo que el defecto impedía.
  assert.equal(cambio.listoParaConfirmar, true, `no se puede recerrar: ${JSON.stringify(cambio.falta)}`);

  // Segundo resumen enseñado (lo produce el propio turno anterior) y confirma.
  const segundo = await c.turno('Confirmo',
    { items: [ITEM([{ grupo: 'Salsa', opciones: ['Roja'] }, MODS[1], MODS[2]])] });
  assert.equal(segundo.fase, 'confirmando', `fase=${segundo.fase}`);
  assert.equal(segundo.handoff.listo, true, JSON.stringify(segundo.handoff.bloqueos));
  assert.equal(segundo.handoff.nuevo, true, 'el handoff del pedido cambiado se dio por ya visto');
  assert.notEqual(segundo.handoff.huella, huella1, 'la huella no cambió pese a cambiar el pedido');
});

await t('C2. y repetir esa segunda confirmación tampoco duplica', async () => {
  const c = await hastaListo('c2');
  await c.turno('Confirmo', { items: [ITEM(MODS)] });
  const nuevos = [ITEM([{ grupo: 'Salsa', opciones: ['Roja'] }, MODS[1], MODS[2]])];
  await c.turno('Mejor salsa roja', { items: nuevos });
  const a = await c.turno('Confirmo', { items: nuevos });
  const b = await c.turno('Confirmo', { items: nuevos });
  assert.equal(a.handoff.nuevo, true);
  assert.equal(b.handoff.huella, a.handoff.huella);
  assert.equal(b.handoff.nuevo, false, 'segundo handoff para la misma confirmación');
});

console.log(`\n${fallos.length ? 'HAY FALLOS' : 'TODO VERDE'} — ${pasadas} pasadas, ${fallos.length} fallidas`);
for (const f of fallos) console.log(`  · ${f}`);
process.exit(fallos.length ? 1 : 0);
