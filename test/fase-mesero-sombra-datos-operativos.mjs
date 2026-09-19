// ─── D6: LA MODALIDAD QUE ACABABA COMO NOTA DE COCINA ─────────────────────
//
// Smoke en sombra del 19-sep-2026, Obispado, T4 «A domicilio»: el clasificador
// dio DEFINIR_MODALIDAD, el modelo propuso `agregar_nota`, el renglón salió
// con `nota: "A domicilio"` y `datos.modalidad` siguió en null. La corrida
// anterior había hecho lo mismo con una dirección.
//
// La causa no estaba en el modelo ni en el clasificador: el extractor de la
// sombra pedía un JSON con sólo `items` (nombre, cantidad, modificadores,
// notas), y `propuestasDesdeBorrador` únicamente produce `definir_modalidad`
// si el borrador trae `modalidad` en la RAÍZ. La única ranura libre era
// `notas`, y ahí la puso.
//
// Las suites no lo veían porque inyectan borradores «perfectos», con
// `modalidad` y `cliente` en la raíz, que el prompt real nunca pidió. Esta
// suite cierra ese hueco: comprueba el CONTRATO, no sólo el motor.
//
// Sin modelo, sin base, sin WhatsApp: todo offline.
import assert from 'node:assert/strict';
import { atenderTurno } from '../src/mesero-whatsapp/meseroDigital.js';
import { propuestasDesdeBorrador } from '../src/mesero-whatsapp/motorTransaccional.js';
import { INSTRUCCION_BORRADOR_SOMBRA, INSTRUCCION_BORRADOR_FORZADO, extraerBorradorParaSombra }
  from '../src/agent/brain.js';

let pasadas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); pasadas += 1; console.log(`    OK  ${nombre}`); }
  catch (e) { fallos.push(`${nombre}: ${e.message}`); console.log(`> FALLO ${nombre}: ${e.message}`); }
}

// ── La carta mínima de Obispado ──────────────────────────────────────────
const g = (nombre, minimo, maximo, opciones, requerido = true) => ({
  nombre, requerido, minimo, maximo,
  opciones: opciones.map((n) => ({ nombre: n, disponible: true, precio_extra: 0 })),
});
const CARTA = [
  { id: 26, nombre: 'CHILAQUILES', orden: 1, productos: [
    { id: 85, nombre: 'Chilaquiles Sencillos', orden: 0, precio: 195, disponible: true,
      opciones: { variante: { base: true } },
      modificadores: [
        g('Salsa', 1, 1, ['Roja', 'Suiza', 'Verde', 'Chipotle']),
        g('Proteína', 1, 1, ['Huevos Estrellados', 'Pechuga de pollo']),
        g('Guarniciones', 1, 2, ['Frijolitos naturales', 'Frijolitos con chorizo', 'Papas a la mexicana']),
      ] },
  ] },
];
const NEGOCIO = '5de544d8-9a0a-4972-9c92-fd48ff22de66';

// El JSON de ejemplo que lleva una instrucción, tal cual lo leería el modelo.
function ejemploDe(instruccion) {
  const m = String(instruccion).match(/\{"items":[\s\S]*?\}\}\.|\{"items":[\s\S]*?\]\}\./);
  assert.ok(m, 'la instrucción no trae un JSON de ejemplo');
  return JSON.parse(m[0].slice(0, -1));
}

// Un borrador con TODOS los campos raíz que el ejemplo declara, rellenos con
// valores plausibles. Si el ejemplo no declara un campo, el borrador no lo trae.
function borradorSegunEjemplo(instruccion) {
  const ej = ejemploDe(instruccion);
  const b = { items: [] };
  if ('modalidad' in ej) b.modalidad = 'entrega a domicilio';
  if ('forma_pago' in ej) b.forma_pago = 'tarjeta';
  if ('cliente' in ej) b.cliente = { direccion: 'Reforma 200' };
  return b;
}

const acciones = (ps) => ps.map((p) => p.accion).sort();

// El prompt productivo tal como corre en producción (ea1eb4e). Esta rama NO lo
// toca; si alguien lo cambia, que sea a propósito y con esta línea delante.
const FORZADO_EN_PRODUCCION =
  'Extrae el pedido que el cliente está armando en esta conversación, TAL CUAL lo pidió, '
  + 'incluso si algo parece no existir en el menú (no lo corrijas ni lo sustituyas). '
  + 'Responde SOLO con JSON: {"items":[{"nombre":"...","cantidad":1,'
  + '"modificadores":[{"grupo":"...","opciones":["..."]}],"notas":"..."}]}. '
  + 'Usa el nombre del grupo que corresponda a cada opción (sabor, tamaño, leche, etc.). '
  + 'Si el cliente solo pregunta algo y NO está armando un pedido, responde {"items":[]}.';

console.log('\n══ C1-C3. EL CONTRATO: LO QUE SE LE PIDE AL MODELO ES LO QUE EL MOTOR LEE ══');

await t('C1. el ejemplo de la sombra declara modalidad, forma_pago y cliente en la raíz', async () => {
  const ej = ejemploDe(INSTRUCCION_BORRADOR_SOMBRA);
  for (const k of ['items', 'modalidad', 'forma_pago', 'cliente']) assert.ok(k in ej, `falta ${k}`);
  assert.ok(Array.isArray(ej.items) && 'notas' in ej.items[0], 'los items siguen llevando notas');
});

await t('C2. un borrador con la forma del ejemplo de sombra produce las tres propuestas operativas', async () => {
  const ps = propuestasDesdeBorrador({ items: [], datos: {} }, borradorSegunEjemplo(INSTRUCCION_BORRADOR_SOMBRA));
  assert.deepEqual(acciones(ps), ['definir_cliente', 'definir_modalidad', 'definir_pago']);
});

await t('C3. MORDIDA: con la forma del prompt productivo no sale ninguna (el hueco de D6)', async () => {
  const ps = propuestasDesdeBorrador({ items: [], datos: {} }, borradorSegunEjemplo(INSTRUCCION_BORRADOR_FORZADO));
  assert.deepEqual(acciones(ps), [], 'el contrato viejo no puede llevar modalidad, por eso D6');
});

await t('C4. el prompt productivo sigue siendo byte a byte el desplegado', async () => {
  assert.equal(INSTRUCCION_BORRADOR_FORZADO, FORZADO_EN_PRODUCCION);
});

await t('C5. la instrucción de sombra prohíbe meter la modalidad en notas', async () => {
  assert.match(INSTRUCCION_BORRADOR_SOMBRA, /nunca en "notas"/);
  assert.match(INSTRUCCION_BORRADOR_SOMBRA, /SOLO si el cliente los dijo/);
});

console.log('\n══ E1-E5. EL EXTRACTOR CON UN MODELO SIMULADO ══');

const respuesta = (texto) => ({ content: [{ type: 'text', text: texto }] });
const MENSAJES = [{ role: 'user', content: 'Quiero chilaquiles suizos' }, { role: 'user', content: 'A domicilio' }];

await t('E1. le manda al modelo la instrucción de sombra, no la productiva', async () => {
  let recibido = null;
  await extraerBorradorParaSombra(MENSAJES, NEGOCIO, {
    llamar: async (params) => { recibido = params; return respuesta('{"items":[]}'); },
  });
  assert.equal(recibido.system, INSTRUCCION_BORRADOR_SOMBRA);
  assert.notEqual(recibido.system, INSTRUCCION_BORRADOR_FORZADO);
  assert.deepEqual(recibido.messages, MENSAJES);
});

await t('E2. items vacíos + modalidad NO es un turno vacío: devuelve el borrador', async () => {
  const b = await extraerBorradorParaSombra(MENSAJES, NEGOCIO, {
    llamar: async () => respuesta('{"items":[],"modalidad":"entrega a domicilio"}'),
  });
  assert.ok(b, 'devolvió null y la modalidad se perdió');
  assert.equal(b.modalidad, 'entrega a domicilio');
});

await t('E3. items vacíos sin datos operativos sigue siendo null (una consulta)', async () => {
  const b = await extraerBorradorParaSombra(MENSAJES, NEGOCIO, { llamar: async () => respuesta('{"items":[]}') });
  assert.equal(b, null);
});

await t('E4. prosa sin JSON sigue siendo null, no un error (incidente 11-sep)', async () => {
  const b = await extraerBorradorParaSombra(MENSAJES, NEGOCIO, {
    llamar: async () => respuesta('Todavía no hay pedido que extraer.'),
  });
  assert.equal(b, null);
});

await t('E5. JSON sin items sigue lanzando BORRADOR_SIN_ITEMS', async () => {
  await assert.rejects(
    () => extraerBorradorParaSombra(MENSAJES, NEGOCIO, { llamar: async () => respuesta('{"modalidad":"x"}') }),
    /BORRADOR_SIN_ITEMS/);
});

console.log('\n══ T1-T4. LA CONVERSACIÓN DEL SMOKE, OFFLINE ══');

// La conversación real del 19-sep, con lo que el modelo devolvió en T1–T3 (se
// sabe por los renglones que dejó) y las dos formas posibles de T4.
const ITEM = (mods) => ({ nombre: 'Chilaquiles Sencillos', cantidad: 1, modificadores: mods });
const MODS_T3 = [
  { grupo: 'Salsa', opciones: ['Suiza'] },
  { grupo: 'Proteína', opciones: ['Huevos Estrellados'] },
  { grupo: 'Guarniciones', opciones: ['Frijolitos con chorizo'] },
];

async function hastaT3(id) {
  let contexto = null;
  let carrito = null;
  const turno = async (mensaje, borrador) => {
    const r = await atenderTurno({
      negocioId: NEGOCIO, conversacionId: id, mensaje, catalogo: CARTA, requierePago: true,
      contextoGuardado: contexto, carrito, proponer: async () => borrador,
    });
    contexto = r.contexto; carrito = r.carrito;
    return r;
  };
  await turno('Quiero chilaquiles suizos', { items: [{ nombre: 'chilaquiles suizos', cantidad: 1, modificadores: [] }] });
  await turno('Con huevos estrellados', { items: [ITEM(MODS_T3.slice(0, 2))] });
  const r3 = await turno('Con frijolitos con chorizo', { items: [ITEM(MODS_T3)] });
  assert.equal(r3.carrito.items.length, 1, `T3 dejó ${r3.carrito.items.length} renglones`);
  assert.equal(r3.fase, 'esperando_modalidad', `T3 acabó en ${r3.fase}`);
  return turno;
}

await t('T4-nuevo. «A domicilio» con modalidad en la raíz: la modalidad se pone y no hay nota', async () => {
  const turno = await hastaT3('t4-nuevo');
  const r = await turno('A domicilio', { items: [ITEM(MODS_T3)], modalidad: 'entrega a domicilio' });
  assert.equal(r.carrito.datos?.modalidad, 'entrega a domicilio', JSON.stringify(r.carrito.datos));
  assert.notEqual(r.fase, 'esperando_modalidad', `sigue en ${r.fase}`);
  assert.ok(!(r.falta || []).includes('modalidad'), JSON.stringify(r.falta));
  assert.equal(r.carrito.items.length, 1);
  assert.equal(String(r.carrito.items[0].notas || ''), '', 'la modalidad volvió a caer como nota');
});

await t('T4-viejo. MORDIDA: la misma frase con la forma vieja (nota) reproduce D6', async () => {
  const turno = await hastaT3('t4-viejo');
  const r = await turno('A domicilio', { items: [{ ...ITEM(MODS_T3), notas: 'A domicilio' }] });
  assert.equal(r.carrito.datos?.modalidad ?? null, null);
  assert.equal(r.fase, 'esperando_modalidad');
  assert.equal(String(r.carrito.items[0].notas || ''), 'A domicilio');
});

await t('T4-sin-respaldo. la modalidad del borrador NO es autoridad: sin que el cliente la diga, no entra', async () => {
  const turno = await hastaT3('t4-sin-respaldo');
  const r = await turno('gracias', { items: [ITEM(MODS_T3)], modalidad: 'entrega a domicilio' });
  assert.equal(r.carrito.datos?.modalidad ?? null, null, 'el modelo decidió la modalidad por el cliente');
  assert.equal(r.fase, 'esperando_modalidad');
});

await t('T5. «Pago con tarjeta» con forma_pago en la raíz cierra el pago', async () => {
  const turno = await hastaT3('t5');
  await turno('A domicilio', { items: [ITEM(MODS_T3)], modalidad: 'entrega a domicilio' });
  const r = await turno('Pago con tarjeta', { items: [ITEM(MODS_T3)], modalidad: 'entrega a domicilio', forma_pago: 'tarjeta' });
  assert.equal(r.carrito.datos?.forma_pago, 'tarjeta', JSON.stringify(r.carrito.datos));
  assert.ok(!(r.falta || []).includes('pago'), JSON.stringify(r.falta));
});

console.log(`\n${fallos.length ? 'HAY FALLOS' : 'TODO VERDE'} — ${pasadas} pasadas, ${fallos.length} fallidas`);
for (const f of fallos) console.log(`  · ${f}`);
process.exit(fallos.length ? 1 : 0);
