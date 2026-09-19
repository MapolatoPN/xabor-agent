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
    // Los dos de abajo reproducen la carta real de Obispado en lo que importa:
    // «Frijol» existe como producto suelto —por eso el modelo pudo anclarlo— y
    // hay VARIOS huevos, que es lo que convierte «huevos estrellados» en una
    // familia reconocida con un atributo que no lo es.
    { id: 92, nombre: 'Huevos revueltos con jamón', orden: 2, precio: 130, disponible: true },
    { id: 93, nombre: 'Frijol', orden: 3, precio: 45, disponible: true },
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

// ── De dónde más puede venir una palabra histórica ──────────────────────
//
// «Palabra libre» no basta por sí sola, y esto lo midió una sonda: la palabra
// de un producto RETIRADO y la de uno NEGADO quedan libres justamente porque
// no están en el carrito, así que la regla de la palabra las dejaba pasar. Lo
// que las para es la puerta 3: un turno que sólo confirma no da de alta nada.
const COCA = { nombre: 'Coca Cola', cantidad: 1, modificadores: [] };
const CAFE = { nombre: 'Café Americano', cantidad: 1, modificadores: [] };
const ENCH = { nombre: 'Enchiladas de chipotle', cantidad: 1, modificadores: [] };

/** Completa el pedido desde donde esté y lo deja a un «Confirmo» de cruzar. */
async function hastaListo(c) {
  await c.turno('Con huevos estrellados', { items: [ITEM(MODS.slice(0, 2))] });
  await c.turno('Con frijolitos con chorizo', { items: [ITEM(MODS)] });
  await c.turno('Paso a recogerlo', { items: [ITEM(MODS)], modalidad: 'recoger en tienda' });
  const r = await c.turno('Pago con tarjeta',
    { items: [ITEM(MODS)], modalidad: 'recoger en tienda', forma_pago: 'tarjeta' });
  assert.equal(r.listoParaConfirmar, true, `no llegó a listo: ${JSON.stringify(r.falta)}`);
  return c;
}

await t('A8. un producto RETIRADO no vuelve durante «Confirmo»', async () => {
  const c = conversacion('a8');
  await c.turno('Quiero chilaquiles suizos', { items: [ITEM([MODS[0]])] });
  await c.turno('Y una coca', { items: [ITEM([MODS[0]]), COCA] });
  const q = await c.turno('Quita la coca', { items: [ITEM([MODS[0]])] });
  assert.deepEqual(nombres(q.carrito), ['Chilaquiles Sencillos'], JSON.stringify(nombres(q.carrito)));
  await hastaListo(c);
  const f = await c.turno('Confirmo', { items: [ITEM(MODS), COCA] });
  assert.deepEqual(nombres(f.carrito), ['Chilaquiles Sencillos'],
    `resucitó un producto retirado: ${JSON.stringify(nombres(f.carrito))}`);
  assert.equal(f.fase, 'confirmando', `y además tiró la confirmación: fase=${f.fase}`);
});

await t('A9. una petición NEGADA no entra durante «Confirmo»', async () => {
  const c = conversacion('a9');
  await c.turno('Quiero chilaquiles suizos', { items: [ITEM([MODS[0]])] });
  // El cliente pide algo que la carta no tiene con ese nombre; queda «enchiladas»
  // suelto en el ciclo, y la carta SÍ tiene unas de chipotle.
  const neg = await c.turno('Y unas enchiladas de pollo',
    { items: [ITEM([MODS[0]]), { nombre: 'Enchiladas de pollo', cantidad: 1, modificadores: [] }] });
  assert.deepEqual(nombres(neg.carrito), ['Chilaquiles Sencillos'], JSON.stringify(nombres(neg.carrito)));
  await hastaListo(c);
  const f = await c.turno('Confirmo', { items: [ITEM(MODS), ENCH] });
  assert.deepEqual(nombres(f.carrito), ['Chilaquiles Sencillos'],
    `entró lo que se le había negado: ${JSON.stringify(nombres(f.carrito))}`);
  assert.equal(f.fase, 'confirmando', `fase=${f.fase}`);
});

await t('A10. una CONSULTA no entra durante «Confirmo»', async () => {
  const c = conversacion('a10');
  await c.turno('Quiero chilaquiles suizos', { items: [ITEM([MODS[0]])] });
  const q = await c.turno('¿Tienen café americano?', { items: [ITEM([MODS[0]])] });
  assert.deepEqual(nombres(q.carrito), ['Chilaquiles Sencillos'], JSON.stringify(nombres(q.carrito)));
  await hastaListo(c);
  const f = await c.turno('Confirmo', { items: [ITEM(MODS), CAFE] });
  assert.deepEqual(nombres(f.carrito), ['Chilaquiles Sencillos'],
    `preguntar por algo acabó pidiéndolo: ${JSON.stringify(nombres(f.carrito))}`);
  assert.equal(f.fase, 'confirmando', `fase=${f.fase}`);
});

await t('A11. MORDIDA: un turno que confirma Y PIDE sí da de alta lo que pide', async () => {
  // La puerta 3 dice «sólo confirma», y es literal: si el turno además pide
  // algo, manda lo que pide. Sin esta prueba, la regla podría endurecerse
  // hasta negarle al cliente un «confirmo y ponme una coca».
  const c = conversacion('a11');
  await c.turno('Quiero chilaquiles suizos', { items: [ITEM([MODS[0]])] });
  await hastaListo(c);
  const f = await c.turno('Confirmo, y ponme una coca', { items: [ITEM(MODS), COCA] });
  assert.ok(nombres(f.carrito).includes('Coca Cola'),
    `le negó lo que pidió en el mismo turno: ${JSON.stringify(nombres(f.carrito))}`);
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

console.log('\n══ D. EL TURNO 7 DEL SMOKE: NI CARRITO NI ACLARACIÓN ══');

// Lo que el modelo devolvió de verdad el 19-sep sobre un «Confirmo»: el pedido
// tal cual, más DOS artículos sacados del texto del ciclo. «Frijol» ancla a un
// producto real de la carta; «Con huevos estrellados» es la frase del turno 2
// del cliente y no ancla a nada — el anclaje reconoce la familia «huevos» y
// rechaza el atributo «estrellados».
const LO_QUE_DIJO_EL_MODELO_EN_T7 = {
  items: [ITEM(MODS),
    { nombre: 'Frijol', cantidad: 1, modificadores: [] },
    { nombre: 'Con huevos estrellados', cantidad: 1, modificadores: [] }],
};
const bloqueados = (r) => (r.cambios?.sinRespaldo || [])
  .filter((x) => x.campo === 'articulo').map((x) => x.nombre);

await t('D1. REPRODUCCIÓN: el turno 7 real no toca el carrito NI levanta aclaración', async () => {
  const { c, r } = await elPedidoDelSmoke('d1', { conDireccion: true });
  assert.equal(r.listoParaConfirmar, true, JSON.stringify(r.falta));
  const huellaAntes = r.handoff.huella;

  const f = await c.turno('Confirmo', LO_QUE_DIJO_EL_MODELO_EN_T7);

  // El carrito, intacto.
  assert.deepEqual(nombres(f.carrito), ['Chilaquiles Sencillos'], JSON.stringify(nombres(f.carrito)));
  assert.equal(String(f.carrito.items[0].notas || ''), '');
  // La aclaración que tumbaba la fase, ausente.
  assert.deepEqual(f.falta, [], `algo quedó bloqueando el cierre: ${JSON.stringify(f.falta)}`);
  assert.deepEqual((f.aclaraciones || []).map((a) => a.tipo), [],
    `se preguntó por un artículo que el cliente no puso: ${JSON.stringify(f.aclaraciones)}`);
  // La huella, la misma: el pedido no se movió.
  assert.equal(f.handoff.huella, huellaAntes, 'la huella cambió sin que cambiara el pedido');
  // Y el handoff ocurre.
  assert.equal(f.fase, 'confirmando', `fase=${f.fase}`);
  assert.equal(f.handoff.listo, true, JSON.stringify(f.handoff.bloqueos));
  assert.equal(f.handoff.nuevo, true);
  // El rechazo QUEDA REGISTRADO, los dos.
  const b = bloqueados(f);
  assert.ok(b.includes('Frijol'), `no se registró el rechazo de Frijol: ${JSON.stringify(b)}`);
  assert.ok(b.some((x) => /huevos estrellados/i.test(x)),
    `no se registró el rechazo de «Con huevos estrellados»: ${JSON.stringify(b)}`);
});

await t('D2. y repetir el «Confirmo» con la misma basura no duplica el handoff', async () => {
  const { c } = await elPedidoDelSmoke('d2', { conDireccion: true });
  const primero = await c.turno('Confirmo', LO_QUE_DIJO_EL_MODELO_EN_T7);
  assert.equal(primero.handoff.nuevo, true, JSON.stringify(primero.handoff.bloqueos));
  const segundo = await c.turno('Confirmo', LO_QUE_DIJO_EL_MODELO_EN_T7);
  assert.deepEqual(nombres(segundo.carrito), ['Chilaquiles Sencillos']);
  assert.equal(segundo.handoff.huella, primero.handoff.huella);
  assert.equal(segundo.handoff.nuevo, false, 'segundo handoff para la misma confirmación');
});

await t('D3. un cambio autorizado sigue invalidando la confirmación anterior', async () => {
  const { c } = await elPedidoDelSmoke('d3', { conDireccion: true });
  await c.turno('Confirmo', LO_QUE_DIJO_EL_MODELO_EN_T7);
  const cambio = await c.turno('Mejor salsa roja, confirmo', {
    items: [ITEM([{ grupo: 'Salsa', opciones: ['Roja'] }, ...MODS.slice(1)])] });
  const salsa = (cambio.carrito.items[0].modificadores || []).find((m) => m.grupo === 'Salsa');
  assert.deepEqual(salsa.opciones, ['Roja'], JSON.stringify(salsa));
  assert.notEqual(cambio.fase, 'confirmando');
  assert.equal(cambio.confirmacionVigente, false);
  assert.equal(cambio.handoff.listo, false, JSON.stringify(cambio.handoff.bloqueos));
});

console.log('\n══ E. LO QUE NO SE PUEDE SILENCIAR ══');

await t('E1. si el cliente PIDE en el turno algo que no existe, se le pregunta', async () => {
  // La contraprueba de D1, y la que marca el límite: no se callan las
  // aclaraciones de un turno de confirmación, se callan las de un artículo que
  // el cliente no puso. Aquí sí lo puso, en el mismo turno.
  const { c } = await elPedidoDelSmoke('e1', { conDireccion: true });
  const f = await c.turno('Confirmo, y agrégame unas enchiladas de pollo',
    { items: [ITEM(MODS), { nombre: 'Enchiladas de pollo', cantidad: 1, modificadores: [] }] });
  assert.ok((f.aclaraciones || []).some((a) => /producto_(inexistente|ambiguo)/.test(a.tipo)),
    `se calló un producto que el cliente pidió: ${JSON.stringify(f.aclaraciones)}`);
  assert.ok(f.falta.some((x) => String(x).startsWith('producto:')), JSON.stringify(f.falta));
  assert.notEqual(f.fase, 'confirmando', 'confirmó con un producto sin resolver');
  assert.equal(f.handoff.listo, false);
});

await t('E2. «Confirmo y agrega una coca»: la coca entra y la confirmación NO vale', async () => {
  const { c } = await elPedidoDelSmoke('e2', { conDireccion: true });
  const f = await c.turno('Confirmo, y agrega una coca', { items: [ITEM(MODS), COCA] });
  assert.ok(nombres(f.carrito).includes('Coca Cola'),
    `le negó lo que pidió en el mismo turno: ${JSON.stringify(nombres(f.carrito))}`);
  // El pedido cambió en el mismo turno del «confirmo»: ese «confirmo» ya no
  // habla del pedido que el cliente leyó.
  assert.notEqual(f.fase, 'confirmando', 'confirmó un pedido que acababa de cambiar');
  assert.equal(f.handoff.listo, false, JSON.stringify(f.handoff.bloqueos));
});

await t('E3. y al turno siguiente, el pedido con la coca sí se confirma', async () => {
  const { c } = await elPedidoDelSmoke('e3', { conDireccion: true });
  await c.turno('Confirmo, y agrega una coca', { items: [ITEM(MODS), COCA] });
  const f = await c.turno('Confirmo', { items: [ITEM(MODS), COCA] });
  assert.equal(f.fase, 'confirmando', `fase=${f.fase}`);
  assert.equal(f.handoff.listo, true, JSON.stringify(f.handoff.bloqueos));
  assert.equal(f.handoff.items_count ?? f.handoff.propuesta?.items?.length, 2,
    'el handoff no llevó los dos renglones');
});

await t('E4. una aclaración de línea existente NO se calla (no es un alta)', async () => {
  // `rechazados` también recibe la rama de `cambiar_modificador`, con `lid` y
  // motivo `linea_sin_ancla`. Ésa habla de un renglón que YA está en el
  // carrito: callarla escondería un renglón roto. El filtro sólo mira las
  // entradas de alta, y esta prueba fija esa frontera.
  const c = conversacion('e4');
  const r = await c.turno('Quiero algo rico', { items: [{ nombre: 'Platillo Fantasma', cantidad: 1, modificadores: [] }] });
  // No entra (nadie lo nombró), pero tampoco se pierde la constancia.
  assert.deepEqual(nombres(r.carrito), [], JSON.stringify(nombres(r.carrito)));
  assert.ok((r.cambios?.sinRespaldo || []).length > 0 || (r.aclaraciones || []).length > 0,
    'el rechazo no dejó rastro por ningún canal');
});

console.log(`\n${fallos.length ? 'HAY FALLOS' : 'TODO VERDE'} — ${pasadas} pasadas, ${fallos.length} fallidas`);
for (const f of fallos) console.log(`  · ${f}`);
process.exit(fallos.length ? 1 : 0);
