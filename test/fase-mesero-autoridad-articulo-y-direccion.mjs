// ─── DOS COSAS QUE EL PRIMER HANDOFF REAL DEJÓ VER ────────────────────────
//
// El 19-sep-2026 el Mesero en sombra llegó por primera vez a un handoff listo
// sobre tráfico real. Cruzar ese punto enseñó dos cosas que ninguna corrida
// anterior había podido enseñar.
//
// ── 1. LA AUTORIDAD DEL ARTÍCULO LEÍA EL CICLO ENTERO ────────────────────
//
// Con el cliente escribiendo sólo «Confirmo» sobre un pedido ya completo,
// entró un segundo platillo que nadie pidió: «Huevos revueltos con chorizo».
// Lo autorizó `articulo|dicho`, y esa vía medía contra el texto del CICLO. En
// el ciclo estaban «huevos» (turno 2, una PROTEÍNA) y «chorizo» (turno 3, una
// GUARNICIÓN), las dos ya puestas en el renglón que existía.
//
// El efecto fue peor que el conocido de septiembre: la fase retrocedió de
// `confirmando` a `completando_producto` y la confirmación quedó invalidada.
// Un pedido que el cliente ya había confirmado dejó de poder cruzar.
//
// ── 2. UN DOMICILIO CERRABA SIN DIRECCIÓN ────────────────────────────────
//
// El handoff salió `listo`, con `bloqueos: []`, modalidad «entrega a
// domicilio» y sin una dirección a la que llevarlo. `loQueFalta` miraba
// producto, grupo, modalidad y pago, y ninguna de las cuatro depende de qué
// modalidad se eligió.
//
// Aquí se fija la definición que zanja el asunto: «listo» significa que el
// pedido CRUZARÍA el borde y se volvería real. Un domicilio sin dirección no
// cruza. Y entra por `falta`, no por un bloqueo mudo, para que el mesero la
// pregunte y el pedido se complete solo.
//
// Sin modelo, sin base, sin WhatsApp.
import assert from 'node:assert/strict';
import { atenderTurno } from '../src/mesero-whatsapp/meseroDigital.js';
import { handoffDeSombra } from '../src/mesero-whatsapp/handoffDeSombra.js';
import { reconciliar } from '../src/orders/carritoDelPedido.js';

let pasadas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); pasadas += 1; console.log(`    OK  ${nombre}`); }
  catch (e) { fallos.push(`${nombre}: ${e.message}`); console.log(`> FALLO ${nombre}: ${e.message}`); }
}

// ── La carta de Obispado, recortada a lo que estas pruebas necesitan ─────
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
        g('Proteína', 1, 1, ['Huevos Estrellados', 'Huevos Revueltos', 'Pechuga de pollo']),
        g('Guarniciones', 1, 2, ['Frijolitos naturales', 'Frijolitos con chorizo', 'Papas a la mexicana']),
      ] },
  ] },
  { id: 30, nombre: 'DESAYUNOS', orden: 2, productos: [
    { id: 90, nombre: 'Huevos revueltos con chorizo', orden: 0, precio: 130, disponible: true },
    { id: 91, nombre: 'Enchiladas de chipotle', orden: 1, precio: 160, disponible: true },
  ] },
  { id: 40, nombre: 'BEBIDAS', orden: 3, productos: [
    { id: 95, nombre: 'Coca Cola', orden: 0, precio: 35, disponible: true },
    { id: 96, nombre: 'Café Americano', orden: 1, precio: 40, disponible: true },
  ] },
];

const NEGOCIO = '5de544d8-9a0a-4972-9c92-fd48ff22de66';
const SELLO = { negocioId: NEGOCIO, canal: 'whatsapp', telefonoConversacion: '5218781234567' };

// ── El conductor: una conversación de verdad, turno a turno ──────────────
let n = 0;
function conversacion(id = `c${n += 1}`, { requierePago = true } = {}) {
  let contexto = null;
  let carrito = null;
  let handoffPrevio = null;
  return {
    get carrito() { return carrito; },
    get contexto() { return contexto; },
    async turno(mensaje, borrador = null, extra = {}) {
      const r = await atenderTurno({
        negocioId: NEGOCIO, conversacionId: id, mensaje, catalogo: CARTA, requierePago,
        contextoGuardado: contexto, carrito, proponer: async () => borrador, ...extra,
      });
      contexto = r.contexto;
      carrito = r.carrito;
      r.handoff = handoffDeSombra(r, { ...SELLO, catalogo: CARTA, handoffPrevio });
      if (r.handoff.listo) handoffPrevio = r.handoff.huella;
      return r;
    },
  };
}

const nombres = (c) => (c?.items || []).map((i) => i.nombre);
const ITEM = (mods) => ({ nombre: 'Chilaquiles Sencillos', cantidad: 1, modificadores: mods });
const MODS = [
  { grupo: 'Salsa', opciones: ['Suiza'] },
  { grupo: 'Proteína', opciones: ['Huevos Estrellados'] },
  { grupo: 'Guarniciones', opciones: ['Frijolitos con chorizo'] },
];

/** El pedido del smoke, armado como lo armó el cliente real. */
async function elPedidoDelSmoke(id, { conDireccion = false } = {}) {
  const c = conversacion(id);
  await c.turno('Quiero chilaquiles suizos',
    { items: [{ nombre: 'chilaquiles suizos', cantidad: 1, modificadores: [] }] });
  await c.turno('Con huevos estrellados', { items: [ITEM(MODS.slice(0, 2))] });
  await c.turno('Con frijolitos con chorizo', { items: [ITEM(MODS)] });
  await c.turno('A domicilio', { items: [ITEM(MODS)], modalidad: 'entrega a domicilio' });
  if (conDireccion) {
    await c.turno('Mi dirección es Reforma 200 colonia Centro',
      { items: [ITEM(MODS)], cliente: { calle: 'Reforma 200', colonia: 'Centro' } });
  }
  const r = await c.turno('Pago con tarjeta',
    { items: [ITEM(MODS)], modalidad: 'entrega a domicilio', forma_pago: 'tarjeta' });
  return { c, r };
}

console.log('\n══ A. LA AUTORIDAD DEL ARTÍCULO ══');

await t('A1. el fallo del 19-sep: «Confirmo» no mete un platillo hecho de palabras viejas', async () => {
  const { c, r } = await elPedidoDelSmoke('a1', { conDireccion: true });
  assert.equal(r.listoParaConfirmar, true, `no llegó a listo: ${JSON.stringify(r.falta)}`);
  // Exactamente lo que devolvió el modelo aquel turno.
  const f = await c.turno('Confirmo',
    { items: [ITEM(MODS), { nombre: 'Huevos revueltos con chorizo', cantidad: 1, modificadores: [] }] });
  assert.deepEqual(nombres(f.carrito), ['Chilaquiles Sencillos'],
    `entró un platillo fantasma: ${JSON.stringify(nombres(f.carrito))}`);
  assert.ok((f.cambios?.sinRespaldo || []).some((x) => /Huevos revueltos/i.test(x.nombre || '')),
    `no quedó constancia del rechazo: ${JSON.stringify(f.cambios?.sinRespaldo)}`);
  // Y lo que de verdad importa: la confirmación sobrevive.
  assert.equal(f.fase, 'confirmando', `la confirmación se cayó: fase=${f.fase}`);
  assert.equal(f.handoff.listo, true, JSON.stringify(f.handoff.bloqueos));
});

await t('A2. MORDIDA: si el cliente SÍ lo nombra en el turno, entra', async () => {
  const { c } = await elPedidoDelSmoke('a2', { conDireccion: true });
  const f = await c.turno('Agrégame unos huevos revueltos con chorizo',
    { items: [ITEM(MODS), { nombre: 'Huevos revueltos con chorizo', cantidad: 1, modificadores: [] }] });
  assert.equal(nombres(f.carrito).length, 2, JSON.stringify(nombres(f.carrito)));
  assert.ok(nombres(f.carrito).includes('Huevos revueltos con chorizo'), JSON.stringify(nombres(f.carrito)));
});

await t('A3. el fallo del 18-sep: una SALSA del ciclo no autoriza un platillo entero', async () => {
  const c = conversacion('a3');
  await c.turno('Quiero chilaquiles', { items: [{ nombre: 'chilaquiles', cantidad: 1, modificadores: [] }] });
  await c.turno('Con salsa chipotle',
    { items: [{ nombre: 'Chilaquiles Sencillos', cantidad: 1, modificadores: [{ grupo: 'Salsa', opciones: ['Chipotle'] }] }] });
  // Cinco turnos después, sin que el cliente vuelva a decir «chipotle».
  const f = await c.turno('A domicilio', {
    items: [{ nombre: 'Chilaquiles Sencillos', cantidad: 1, modificadores: [{ grupo: 'Salsa', opciones: ['Chipotle'] }] },
      { nombre: 'Enchiladas de chipotle', cantidad: 1, modificadores: [] }],
    modalidad: 'entrega a domicilio' });
  assert.ok(!nombres(f.carrito).some((x) => /Enchiladas/i.test(x)),
    `la salsa autorizó un platillo: ${JSON.stringify(nombres(f.carrito))}`);
});

await t('A4. el ciclo SIGUE valiendo cuando su palabra está libre (el modelo tarda un turno)', async () => {
  const c = conversacion('a4');
  await c.turno('Quiero chilaquiles suizos y un café americano',
    // El modelo sólo estructura el platillo; se deja el café para el turno siguiente.
    { items: [ITEM([{ grupo: 'Salsa', opciones: ['Suiza'] }])] });
  const f = await c.turno('Con huevos estrellados',
    { items: [ITEM(MODS.slice(0, 2)), { nombre: 'Café Americano', cantidad: 1, modificadores: [] }] });
  assert.ok(nombres(f.carrito).includes('Café Americano'),
    `se perdió lo que el cliente pidió un turno antes: ${JSON.stringify(nombres(f.carrito))}`);
});

await t('A5. «otra igual» sigue duplicando aunque su palabra esté ocupada', async () => {
  const c = conversacion('a5');
  await c.turno('Una coca', { items: [{ nombre: 'Coca Cola', cantidad: 1, modificadores: [] }] });
  const f = await c.turno('Otra igual', {
    items: [{ nombre: 'Coca Cola', cantidad: 1, modificadores: [] },
      { nombre: 'Coca Cola', cantidad: 1, modificadores: [] }] });
  assert.equal(nombres(f.carrito).filter((x) => x === 'Coca Cola').length, 2,
    `no duplicó: ${JSON.stringify(nombres(f.carrito))}`);
});

await t('A6. aceptar una sugerencia del bot sigue metiendo el producto', async () => {
  // Contra `reconciliar` directamente, que es la capa donde vive el cambio y
  // donde `evidenciaAceptada` es una opción de verdad: dentro del mesero ese
  // canal lo arma `desenlace.aceptadas`, y su recorrido de punta a punta ya lo
  // certifica X23 en `fase-mesero-adversariales`.
  //
  // El cliente NUNCA escribe «café» —ni en el turno ni en el ciclo—: lo único
  // que autoriza el renglón es haber aceptado la oferta. Si el cambio de la
  // autoridad del artículo tocara esa vía, aquí se vería.
  const previo = { items: [{ lid: 'L1', nombre: 'Chilaquiles Sencillos', cantidad: 1,
    modificadores: [{ grupo: 'Salsa', opciones: ['Suiza'] }], notas: '' }], datos: {} };
  const r = reconciliar(previo, {
    items: [{ nombre: 'Chilaquiles Sencillos', cantidad: 1, modificadores: [{ grupo: 'Salsa', opciones: ['Suiza'] }] },
      { nombre: 'Café Americano', cantidad: 1, modificadores: [] }],
  }, {
    mensaje: 'Sí, porfa',
    textoCiclo: 'Quiero chilaquiles suizos \n Sí, porfa',
    evidenciaAceptada: ['Café Americano'],
  });
  const puestos = r.carrito.items.map((i) => i.nombre);
  assert.ok(puestos.includes('Café Americano'), `la aceptación dejó de autorizar: ${JSON.stringify(puestos)}`);
  assert.ok((r.cambios.autorizados || []).some((a) => a.campo === 'articulo' && a.via === 'acepto_propuesta'),
    JSON.stringify(r.cambios.autorizados));
});

await t('A7. y sin esa aceptación, el mismo café NO entra', async () => {
  // La mordida de A6: lo único que cambia es que nadie ofreció el café.
  const previo = { items: [{ lid: 'L1', nombre: 'Chilaquiles Sencillos', cantidad: 1,
    modificadores: [{ grupo: 'Salsa', opciones: ['Suiza'] }], notas: '' }], datos: {} };
  const r = reconciliar(previo, {
    items: [{ nombre: 'Chilaquiles Sencillos', cantidad: 1, modificadores: [{ grupo: 'Salsa', opciones: ['Suiza'] }] },
      { nombre: 'Café Americano', cantidad: 1, modificadores: [] }],
  }, { mensaje: 'Sí, porfa', textoCiclo: 'Quiero chilaquiles suizos \n Sí, porfa' });
  assert.deepEqual(r.carrito.items.map((i) => i.nombre), ['Chilaquiles Sencillos'],
    JSON.stringify(r.carrito.items.map((i) => i.nombre)));
});

console.log('\n══ B. LA DIRECCIÓN DE UN DOMICILIO ══');

await t('B1. a domicilio sin dirección: no está listo y el handoff se bloquea', async () => {
  const { r } = await elPedidoDelSmoke('b1', { conDireccion: false });
  assert.ok(r.falta.includes('direccion'), JSON.stringify(r.falta));
  assert.equal(r.listoParaConfirmar, false);
  assert.equal(r.handoff.listo, false);
  assert.ok(r.handoff.bloqueos.some((b) => String(b).includes('direccion')),
    JSON.stringify(r.handoff.bloqueos));
});

await t('B2. MORDIDA: con dirección, el mismo pedido cierra', async () => {
  const { r } = await elPedidoDelSmoke('b2', { conDireccion: true });
  assert.deepEqual(r.falta, [], JSON.stringify(r.falta));
  assert.equal(r.listoParaConfirmar, true);
});

await t('B3. recoger no pide dirección', async () => {
  const c = conversacion('b3');
  await c.turno('Quiero chilaquiles suizos', { items: [ITEM([{ grupo: 'Salsa', opciones: ['Suiza'] }])] });
  await c.turno('Con huevos estrellados', { items: [ITEM(MODS.slice(0, 2))] });
  await c.turno('Con frijolitos con chorizo', { items: [ITEM(MODS)] });
  await c.turno('Paso a recogerlo', { items: [ITEM(MODS)], modalidad: 'recoger en tienda' });
  const r = await c.turno('Pago con tarjeta',
    { items: [ITEM(MODS)], modalidad: 'recoger en tienda', forma_pago: 'tarjeta' });
  assert.deepEqual(r.falta, [], JSON.stringify(r.falta));
  assert.equal(r.listoParaConfirmar, true);
});

await t('B4. la dirección se PREGUNTA, no se calla', async () => {
  const { r } = await elPedidoDelSmoke('b4', { conDireccion: false });
  assert.equal(r.siguiente, 'direccion', `siguiente=${r.siguiente}`);
});

console.log('\n══ C. LA SECUENCIA COMPLETA: COMPLETO → CONFIRMAR → REPETIR → CAMBIAR ══');

await t('C1. pedido completo y confirmado → UN handoff, nuevo', async () => {
  const { c, r } = await elPedidoDelSmoke('c1', { conDireccion: true });
  assert.equal(r.listoParaConfirmar, true, JSON.stringify(r.falta));
  const f = await c.turno('Confirmo', { items: [ITEM(MODS)] });
  assert.equal(f.fase, 'confirmando', `fase=${f.fase}`);
  assert.equal(f.handoff.listo, true, JSON.stringify(f.handoff.bloqueos));
  assert.equal(f.handoff.nuevo, true);
  assert.equal(f.handoff.yaObservado, false);
});

await t('C2. IDEMPOTENCIA: confirmar otra vez sin cambios no genera un segundo handoff', async () => {
  const { c } = await elPedidoDelSmoke('c2', { conDireccion: true });
  const primero = await c.turno('Confirmo', { items: [ITEM(MODS)] });
  assert.equal(primero.handoff.nuevo, true);
  const segundo = await c.turno('Confirmo', { items: [ITEM(MODS)] });
  // El pedido no se movió: mismo renglón, misma huella.
  assert.deepEqual(nombres(segundo.carrito), ['Chilaquiles Sencillos'], JSON.stringify(nombres(segundo.carrito)));
  assert.equal(segundo.handoff.huella, primero.handoff.huella, 'la huella cambió sin que cambiara el pedido');
  assert.equal(segundo.handoff.nuevo, false, 'se generó un SEGUNDO handoff para la misma confirmación');
});

await t('C3. INVALIDACIÓN: un cambio autorizado tira la confirmación anterior', async () => {
  const { c } = await elPedidoDelSmoke('c3', { conDireccion: true });
  const primero = await c.turno('Confirmo', { items: [ITEM(MODS)] });
  assert.equal(primero.handoff.listo, true);
  // Cambio que el cliente SÍ pide, en el mismo turno que un «confirmo».
  const cambio = await c.turno('Mejor salsa roja, confirmo', {
    items: [ITEM([{ grupo: 'Salsa', opciones: ['Roja'] }, ...MODS.slice(1)])] });
  const salsa = (cambio.carrito.items[0].modificadores || []).find((m) => m.grupo === 'Salsa');
  assert.deepEqual(salsa.opciones, ['Roja'], JSON.stringify(salsa));
  assert.notEqual(cambio.fase, 'confirmando', 'confirmó un pedido que acababa de cambiar');
  assert.equal(cambio.confirmacionVigente, false);
  assert.equal(cambio.handoff.listo, false, JSON.stringify(cambio.handoff.bloqueos));
});

await t('C4. y el resumen nuevo SÍ se confirma al turno siguiente', async () => {
  const { c } = await elPedidoDelSmoke('c4', { conDireccion: true });
  await c.turno('Confirmo', { items: [ITEM(MODS)] });
  const cambio = await c.turno('Mejor salsa roja', {
    items: [ITEM([{ grupo: 'Salsa', opciones: ['Roja'] }, ...MODS.slice(1)])] });
  assert.equal(cambio.listoParaConfirmar, true, JSON.stringify(cambio.falta));
  const f = await c.turno('Confirmo', { items: [ITEM([{ grupo: 'Salsa', opciones: ['Roja'] }, ...MODS.slice(1)])] });
  assert.equal(f.fase, 'confirmando', `fase=${f.fase}`);
  assert.equal(f.handoff.listo, true, JSON.stringify(f.handoff.bloqueos));
  assert.equal(f.handoff.nuevo, true, 'el handoff del pedido CAMBIADO se dio por ya visto');
});

console.log(`\n${fallos.length ? 'HAY FALLOS' : 'TODO VERDE'} — ${pasadas} pasadas, ${fallos.length} fallidas`);
for (const f of fallos) console.log(`  · ${f}`);
process.exit(fallos.length ? 1 : 0);
