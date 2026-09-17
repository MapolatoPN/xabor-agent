// ─── EL CIERRE TAMBIÉN SE AUTORIZA CON EL TEXTO DEL CLIENTE ───────────────
//
// La auditoría del cierre transaccional (16-sep) midió tres cosas que el
// Mesero daba por buenas:
//
//   1. el cliente dice «con salsa suiza porfa» y el modelo afirma, de su
//      cosecha, modalidad="entrega a domicilio", pago="terminal" y
//      cliente={Quien Sea, Calle Falsa 123}. Los tres entraban al carrito con
//      `autorizado: []`, y el pedido quedaba `listoParaConfirmar: true`. Una
//      dirección inventada por GPT, lista para cerrar.
//
//   2. «sí, confirmo» sin modalidad ni pago devolvía `fase: 'confirmando'`
//      con `falta: ["modalidad","pago"]`. La intención ganaba antes de que
//      nadie mirara lo que falta.
//
//   3. `huellaDelResumen` y `resumenSigueVigente` existían y no las llamaba
//      nadie: un «sí» confirmaba un resumen que ya no describía el pedido.
//
// La regla de la comida —el modelo PROPONE, el catálogo IDENTIFICA, el texto
// del cliente AUTORIZA— no tenía por qué detenerse en la comida. Aquí se
// extiende a modalidad, pago y datos de cliente, y la confirmación se ata al
// resumen que el cliente acaba de leer.
import assert from 'node:assert/strict';
import { atenderTurno } from '../src/mesero-whatsapp/meseroDigital.js';
import { faseDelTurno, loQueFalta } from '../src/mesero-whatsapp/faseConversacional.js';

let pasadas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); pasadas += 1; console.log(`    OK  ${nombre}`); }
  catch (e) { fallos.push(`${nombre}: ${e.message}`); console.log(`> FALLO ${nombre}: ${e.message}`); }
}

// ── La carta ─────────────────────────────────────────────────────────────
const g = (nombre, minimo, maximo, opciones, requerido = true) => ({
  nombre, requerido, minimo, maximo,
  opciones: opciones.map((n) => ({ nombre: n, disponible: true, precio_extra: 0 })),
});
const CARTA = [
  { id: 26, nombre: 'CHILAQUILES', orden: 1, productos: [
    { id: 85, nombre: 'Chilaquiles Sencillos', orden: 0, precio: 195, disponible: true,
      opciones: { variante: { base: true } },
      modificadores: [g('Salsa', 1, 1, ['Roja', 'Suiza', 'Chipotle']),
        g('Proteina', 1, 1, ['Huevos Estrellados', 'Pechuga de pollo'])] },
  ] },
  { id: 40, nombre: 'BEBIDAS', orden: 2, productos: [
    { id: 90, nombre: 'Coca Cola', orden: 0, precio: 35, disponible: true },
    { id: 91, nombre: 'Agua Mineral', orden: 1, precio: 30, disponible: true },
  ] },
];

// Un renglón ya elegido y completo: el cierre es lo único bajo examen.
const LINEA = () => ({
  lid: 'L1', nombre: 'Chilaquiles Sencillos', id: 85, cantidad: 1, notas: '',
  modificadores: [{ grupo: 'Salsa', opciones: ['Suiza'] },
    { grupo: 'Proteina', opciones: ['Huevos Estrellados'] }],
});
const CARRITO = (datos = {}) => ({ items: [LINEA()], datos: { ...datos } });

// ── El conductor: una conversación, turno a turno, con su contexto ───────
function conversacion(id, { requierePago = true } = {}) {
  let contexto = null;
  let carrito = CARRITO();
  return {
    get carrito() { return carrito; },
    get contexto() { return contexto; },
    async turno(mensaje, borrador = null, extra = {}) {
      const r = await atenderTurno({
        negocioId: 'n-cierre', conversacionId: id, mensaje,
        catalogo: CARTA, requierePago,
        contextoGuardado: contexto, carrito,
        proponer: async () => borrador,
        ...extra,
      });
      contexto = r.contexto;
      carrito = r.carrito;
      return r;
    },
  };
}

const ITEMS = () => [{ nombre: 'Chilaquiles Sencillos', cantidad: 1, notas: '',
  modificadores: [{ grupo: 'Salsa', opciones: ['Suiza'] },
    { grupo: 'Proteina', opciones: ['Huevos Estrellados'] }] }];

const CON_ROJA = () => [{ nombre: 'Chilaquiles Sencillos', cantidad: 1, notas: '',
  modificadores: [{ grupo: 'Salsa', opciones: ['Roja'] },
    { grupo: 'Proteina', opciones: ['Huevos Estrellados'] }] }];

console.log('\n══ A. AUTORIDAD DE LOS DATOS OPERATIVOS ══');

await t('A1. el texto habla de comida y el modelo inventa la modalidad: NO entra', async () => {
  const c = conversacion('a1');
  const r = await c.turno('con salsa suiza porfa',
    { items: ITEMS(), modalidad: 'entrega a domicilio' });
  assert.equal(r.carrito.datos.modalidad, undefined,
    `entró una modalidad que nadie pidió: ${JSON.stringify(r.carrito.datos)}`);
  assert.ok(r.falta.includes('modalidad'), `debería seguir faltando: ${JSON.stringify(r.falta)}`);
});

await t('A2. el texto habla de comida y el modelo inventa el pago: NO entra', async () => {
  const c = conversacion('a2');
  const r = await c.turno('con salsa suiza porfa', { items: ITEMS(), forma_pago: 'terminal' });
  assert.equal(r.carrito.datos.forma_pago, undefined,
    `entró un pago que nadie eligió: ${JSON.stringify(r.carrito.datos)}`);
  assert.ok(r.falta.includes('pago'), `debería seguir faltando: ${JSON.stringify(r.falta)}`);
});

await t('A3. el modelo inventa nombre y dirección: NO entran', async () => {
  const c = conversacion('a3');
  const r = await c.turno('con salsa suiza porfa',
    { items: ITEMS(), cliente: { nombre: 'Quien Sea', direccion: 'Calle Falsa 123' } });
  assert.equal(r.carrito.datos.cliente, undefined,
    `entraron datos de cliente fabricados: ${JSON.stringify(r.carrito.datos.cliente)}`);
});

await t('A3b. lo inventado deja rastro: no se cae en silencio', async () => {
  const c = conversacion('a3b');
  const r = await c.turno('con salsa suiza porfa',
    { items: ITEMS(), modalidad: 'entrega a domicilio', forma_pago: 'terminal',
      cliente: { nombre: 'Quien Sea', direccion: 'Calle Falsa 123' } });
  const campos = (r.cambios?.sinRespaldo || []).map((s) => s.campo);
  for (const esperado of ['modalidad', 'forma_pago', 'cliente:nombre', 'cliente:direccion']) {
    assert.ok(campos.includes(esperado),
      `${esperado} se descartó sin dejar traza: ${JSON.stringify(campos)}`);
  }
});

await t('A4. «para recoger» SÍ define la modalidad', async () => {
  const c = conversacion('a4');
  const r = await c.turno('para recoger', { items: [], modalidad: 'recoger en tienda' });
  assert.equal(r.carrito.datos.modalidad, 'recoger en tienda',
    `el cliente la dijo y no entró: ${JSON.stringify(r.carrito.datos)}`);
});

await t('A4b. «a domicilio» SÍ define la modalidad', async () => {
  const c = conversacion('a4b');
  const r = await c.turno('mándamelo a domicilio', { items: [], modalidad: 'entrega a domicilio' });
  assert.equal(r.carrito.datos.modalidad, 'entrega a domicilio', JSON.stringify(r.carrito.datos));
});

await t('A5. «pago en efectivo» SÍ define el pago', async () => {
  const c = conversacion('a5');
  const r = await c.turno('pago en efectivo', { items: [], forma_pago: 'efectivo' });
  assert.equal(r.carrito.datos.forma_pago, 'efectivo', JSON.stringify(r.carrito.datos));
});

await t('A5b. «con tarjeta» respalda el método que el negocio llama «terminal»', async () => {
  // El cliente habló de pago; CÓMO se llama ese método en la carta del negocio
  // no lo decide él. Lo que se exige es que el pago viniera de su boca.
  const c = conversacion('a5b');
  const r = await c.turno('con tarjeta', { items: [], forma_pago: 'terminal' });
  assert.equal(r.carrito.datos.forma_pago, 'terminal', JSON.stringify(r.carrito.datos));
});

await t('A6. un pendiente de dirección lo resuelve la respuesta; el nombre de más, no', async () => {
  const c = conversacion('a6');
  const r = await c.turno('Reforma 200',
    { items: [], cliente: { direccion: 'Reforma 200', nombre: 'Quien Sea' } },
    { datoOperativoPendiente: 'direccion' });
  assert.equal(r.carrito.datos.cliente?.direccion, 'Reforma 200',
    `el cliente contestó a lo que se le preguntó: ${JSON.stringify(r.carrito.datos.cliente)}`);
  assert.equal(r.carrito.datos.cliente?.nombre, undefined,
    `se coló un nombre que nadie dijo: ${JSON.stringify(r.carrito.datos.cliente)}`);
});

console.log('\n══ F. LA FASE NO SUGIERE CERRAR LO QUE NO ESTÁ ══');

await t('F1. CONFIRMAR con la modalidad en el aire → esperando_modalidad', async () => {
  const c = conversacion('f1');
  const r = await c.turno('sí, confirmo', { items: ITEMS() });
  assert.equal(r.fase, 'esperando_modalidad', `fase=${r.fase} falta=${JSON.stringify(r.falta)}`);
  assert.equal(r.listoParaConfirmar, false);
});

await t('F2. CONFIRMAR con el pago en el aire → esperando_pago', async () => {
  const c = conversacion('f2');
  await c.turno('para recoger', { items: [], modalidad: 'recoger en tienda' });
  const r = await c.turno('sí, confirmo', { items: ITEMS() });
  assert.equal(r.fase, 'esperando_pago', `fase=${r.fase} falta=${JSON.stringify(r.falta)}`);
  assert.equal(r.listoParaConfirmar, false);
});

await t('F3. CONFIRMAR con una aclaración abierta no confirma', async () => {
  const c = conversacion('f3');
  await c.turno('para recoger', { items: [], modalidad: 'recoger en tienda' });
  await c.turno('pago en efectivo', { items: [], forma_pago: 'efectivo' });
  // Un renglón nuevo sin sus grupos requeridos: hay algo abierto.
  const r = await c.turno('y otros chilaquiles, sí confirmo',
    { items: [...ITEMS(), { nombre: 'Chilaquiles Sencillos', cantidad: 1, modificadores: [], notas: '' }] });
  assert.notEqual(r.fase, 'confirmando',
    `fase=${r.fase} aclaraciones=${JSON.stringify(r.aclaraciones.map((a) => a.tipo))}`);
  assert.equal(r.listoParaConfirmar, false);
});

await t('F4. todo completo, resumen vigente y CONFIRMAR → confirmando', async () => {
  const c = conversacion('f4');
  await c.turno('para recoger', { items: [], modalidad: 'recoger en tienda' });
  const listo = await c.turno('pago en efectivo', { items: [], forma_pago: 'efectivo' });
  assert.equal(listo.listoParaConfirmar, true, `no llegó a listo: ${JSON.stringify(listo.falta)}`);
  const r = await c.turno('sí, así está bien', null);
  assert.equal(r.fase, 'confirmando', `fase=${r.fase} falta=${JSON.stringify(r.falta)}`);
});

await t('F5. la fase pura tampoco confirma con algo pendiente', async () => {
  // La garantía vive en el módulo, no sólo en quien lo llama.
  const entrada = { intenciones: ['CONFIRMAR'], carrito: CARRITO(), datos: {},
    aclaraciones: [], requierePago: true, confirmacionVigente: true };
  assert.notEqual(faseDelTurno(entrada), 'confirmando',
    `confirmó con falta=${JSON.stringify(loQueFalta(entrada))}`);
});

console.log('\n══ H. LA HUELLA DEL RESUMEN ══');

const hastaListo = async (id) => {
  const c = conversacion(id);
  await c.turno('para recoger', { items: [], modalidad: 'recoger en tienda' });
  const r = await c.turno('pago en efectivo', { items: [], forma_pago: 'efectivo' });
  assert.equal(r.listoParaConfirmar, true, `no llegó a listo: ${JSON.stringify(r.falta)}`);
  return c;
};

await t('H1. resumen enseñado y sin cambios → el «sí» vale', async () => {
  const c = await hastaListo('h1');
  const r = await c.turno('sí, confirmo', null);
  assert.equal(r.fase, 'confirmando', `fase=${r.fase}`);
  assert.equal(r.confirmacionVigente, true);
});

await t('H1b. un «sí» pelado en revisando no era CONFIRMAR, y sigue sin serlo', async () => {
  // Comportamiento que YA existía y esta ronda no cambia: un monosílabo sin
  // pregunta abierta a la que contestar no confirma. Queda fijado para que
  // nadie lo relaje por accidente al conectar la huella.
  const c = await hastaListo('h1b');
  const r = await c.turno('sí', null);
  assert.equal(r.intenciones.includes('CONFIRMAR'), false, JSON.stringify(r.intenciones));
  assert.notEqual(r.fase, 'confirmando');
});

await t('H2. cambia un modificador en el mismo turno del «sí» → no vale', async () => {
  const c = await hastaListo('h2');
  const r = await c.turno('mejor con salsa roja, sí confirmo', { items: CON_ROJA() });
  const salsas = (r.carrito.items[0].modificadores || [])
    .filter((m) => m.grupo === 'Salsa').flatMap((m) => m.opciones);
  assert.deepEqual(salsas, ['Roja'], `el cambio no se aplicó: ${JSON.stringify(salsas)}`);
  assert.notEqual(r.fase, 'confirmando', 'confirmó un resumen que el propio turno invalidó');
  assert.equal(r.confirmacionVigente, false);
});

await t('H3. cambia la modalidad en el mismo turno del «sí» → no vale', async () => {
  const c = await hastaListo('h3');
  const r = await c.turno('mejor a domicilio, sí confirmo',
    { items: [], modalidad: 'entrega a domicilio' });
  assert.equal(r.carrito.datos.modalidad, 'entrega a domicilio', JSON.stringify(r.carrito.datos));
  assert.notEqual(r.fase, 'confirmando', 'confirmó con la modalidad recién cambiada');
  assert.equal(r.confirmacionVigente, false);
});

await t('H4. cambia el pago en el mismo turno del «sí» → no vale', async () => {
  const c = await hastaListo('h4');
  const r = await c.turno('mejor con tarjeta, confirmo', { items: [], forma_pago: 'terminal' });
  assert.equal(r.carrito.datos.forma_pago, 'terminal', JSON.stringify(r.carrito.datos));
  assert.notEqual(r.fase, 'confirmando', 'confirmó con el pago recién cambiado');
  assert.equal(r.confirmacionVigente, false);
});

await t('H5. sin resumen previo, un «sí» no confirma nada', async () => {
  const c = conversacion('h5');
  // Todo llega en el MISMO turno: nunca se le enseñó un resumen que revisar.
  const r = await c.turno('para recoger, pago en efectivo, sí confirmo',
    { items: [], modalidad: 'recoger en tienda', forma_pago: 'efectivo' });
  assert.equal(r.falta.length, 0, `el pedido no quedó completo: ${JSON.stringify(r.falta)}`);
  assert.notEqual(r.fase, 'confirmando', 'confirmó un resumen que nunca se enseñó');
  assert.equal(r.confirmacionVigente, false);
});

await t('H6. tras el cambio, el resumen nuevo SÍ se confirma al turno siguiente', async () => {
  // La huella no es un candado: es una relectura. Enseñado el resumen nuevo,
  // el «sí» del turno siguiente vale.
  const c = await hastaListo('h6');
  await c.turno('mejor a domicilio', { items: [], modalidad: 'entrega a domicilio' });
  const r = await c.turno('sí, así está bien', null);
  assert.equal(r.fase, 'confirmando', `fase=${r.fase}`);
});

console.log('\n══ C. LAS GARANTÍAS DEL CIERRE ══');

await t('C1. no se confirma sin modalidad', async () => {
  const c = conversacion('c1');
  await c.turno('pago en efectivo', { items: [], forma_pago: 'efectivo' });
  const r = await c.turno('sí, confirmo', null);
  assert.notEqual(r.fase, 'confirmando');
  assert.equal(r.listoParaConfirmar, false);
  assert.ok(r.falta.includes('modalidad'), JSON.stringify(r.falta));
});

await t('C2. no se confirma sin pago', async () => {
  const c = conversacion('c2');
  await c.turno('para recoger', { items: [], modalidad: 'recoger en tienda' });
  const r = await c.turno('sí, confirmo', null);
  assert.notEqual(r.fase, 'confirmando');
  assert.equal(r.listoParaConfirmar, false);
  assert.ok(r.falta.includes('pago'), JSON.stringify(r.falta));
});

await t('C3. hoy NO existe metadata que diga qué modalidad exige dirección', async () => {
  // Esta prueba no certifica C3: declara que hoy no se puede certificar.
  // `loQueFalta` conoce cuatro clases de hueco —producto, grupo, modalidad y
  // pago— y ninguna depende de QUÉ modalidad se eligió. Exigir la dirección
  // pediría inventar la regla, y eso no es de esta ronda. El día que alguien
  // la escriba, esta prueba falla y obliga a certificar C3 de verdad.
  const aDomicilio = { carrito: CARRITO({ modalidad: 'entrega a domicilio', forma_pago: 'efectivo' }),
    datos: { modalidad: 'entrega a domicilio', pago: 'efectivo' }, aclaraciones: [], requierePago: true };
  const enTienda = { ...aDomicilio, carrito: CARRITO({ modalidad: 'recoger en tienda', forma_pago: 'efectivo' }),
    datos: { modalidad: 'recoger en tienda', pago: 'efectivo' } };
  assert.deepEqual(loQueFalta(aDomicilio), [],
    'ya hay una regla de dirección por modalidad: certifica C3 de verdad');
  assert.deepEqual(loQueFalta(aDomicilio), loQueFalta(enTienda),
    'la modalidad ya cambia lo que falta: C3 es certificable y hay que escribirla');
});

await t('C4. cambiar de modalidad no duplica el renglón', async () => {
  const c = await hastaListo('c4');
  const antes = c.carrito.items.map((i) => i.lid);
  const r = await c.turno('mejor a domicilio', { items: [], modalidad: 'entrega a domicilio' });
  assert.equal(r.carrito.items.length, 1, JSON.stringify(r.carrito.items.map((i) => i.nombre)));
  assert.deepEqual(r.carrito.items.map((i) => i.lid), antes);
  assert.equal(r.carrito.datos.modalidad, 'entrega a domicilio');
});

await t('C5. cambiar de pago actualiza el pago y no toca la comida', async () => {
  const c = await hastaListo('c5');
  const antes = JSON.stringify(c.carrito.items);
  const r = await c.turno('mejor con tarjeta', { items: [], forma_pago: 'terminal' });
  assert.equal(r.carrito.datos.forma_pago, 'terminal');
  assert.equal(JSON.stringify(r.carrito.items), antes, 'el pago movió la comida');
});

await t('C6. el «sí» sólo confirma un resumen vigente', async () => {
  const bueno = await (await hastaListo('c6')).turno('sí, confirmo', null);
  assert.equal(bueno.fase, 'confirmando');
  const malo = await (await hastaListo('c6b')).turno('mejor con salsa roja, sí confirmo', { items: CON_ROJA() });
  assert.notEqual(malo.fase, 'confirmando');
});

await t('C7. un «sí» fuera de contexto no crea ni confirma nada', async () => {
  const c = conversacion('c7');
  const r = await c.turno('sí', null);
  assert.notEqual(r.fase, 'confirmando');
  assert.equal(r.confirmacionVigente, false);
  assert.equal(r.carrito.items.length, 1, 'un «sí» suelto movió el pedido');
  assert.equal(r.carrito.datos.modalidad, undefined);
  assert.equal(r.carrito.datos.forma_pago, undefined);
});

await t('C8. «no, mejor…» conserva el carrito y vuelve a edición', async () => {
  const c = await hastaListo('c8');
  const antes = c.carrito.items.map((i) => i.lid);
  const r = await c.turno('no, mejor con salsa roja', { items: CON_ROJA() });
  assert.equal(r.carrito.items.length, 1, 'perdió el pedido');
  assert.deepEqual(r.carrito.items.map((i) => i.lid), antes, 'el renglón cambió de identidad');
  assert.equal(r.carrito.datos.modalidad, 'recoger en tienda', 'perdió la modalidad');
  assert.equal(r.carrito.datos.forma_pago, 'efectivo', 'perdió el pago');
  assert.notEqual(r.fase, 'confirmando');
});

await t('C9. una consulta durante el cierre no muta el pedido', async () => {
  const c = await hastaListo('c9');
  const antes = JSON.stringify(c.carrito);
  const r = await c.turno('¿qué bebidas tienes?', null);
  assert.equal(JSON.stringify(r.carrito), antes, 'la consulta tocó el pedido');
  assert.notEqual(r.fase, 'confirmando');
});

await t('C10. confirmar dos veces no duplica la confirmación', async () => {
  const c = await hastaListo('c10');
  const uno = await c.turno('sí, confirmo', null);
  assert.equal(uno.fase, 'confirmando');
  const dos = await c.turno('sí, confirmo', null);
  assert.notEqual(dos.fase, 'confirmando', 'el mismo resumen se autorizó dos veces');
  assert.equal(dos.confirmacionVigente, false);
  assert.equal(dos.carrito.items.length, 1);
});

await t('C11. el lid es el mismo de punta a punta', async () => {
  const c = conversacion('c11');
  const lids = [c.carrito.items[0].lid];
  lids.push((await c.turno('para recoger', { items: [], modalidad: 'recoger en tienda' })).carrito.items[0].lid);
  lids.push((await c.turno('pago en efectivo', { items: [], forma_pago: 'efectivo' })).carrito.items[0].lid);
  lids.push((await c.turno('sí, confirmo', null)).carrito.items[0].lid);
  assert.equal(new Set(lids).size, 1, `el renglón cambió de identidad: ${JSON.stringify(lids)}`);
});

await t('C12. un resumen vigente autoriza como máximo una confirmación', async () => {
  const c = await hastaListo('c12');
  const fases = [];
  for (let i = 0; i < 4; i += 1) fases.push((await c.turno('sí, confirmo', null)).fase);
  const veces = fases.filter((f) => f === 'confirmando').length;
  assert.equal(veces, 1, `el mismo resumen autorizó ${veces} veces: ${JSON.stringify(fases)}`);
});

// ── C13-C16: LA BARRERA. Se prueba por el grafo, no por la intención ─────
const grafoDeSombra = async () => {
  const { readFileSync } = await import('node:fs');
  const { dirname, resolve, relative } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const vistos = new Set();
  const cola = [resolve(RAIZ, 'src/mesero-whatsapp/sombraDelMesero.js')];
  while (cola.length) {
    const archivo = cola.pop();
    if (vistos.has(archivo)) continue;
    vistos.add(archivo);
    const fuente = readFileSync(archivo, 'utf8');
    for (const m of fuente.matchAll(/(?:^import[^;]*from|^import|await import\()\s*'([^']+)'/gm)) {
      const spec = m[1];
      if (spec.startsWith('node:')) continue;
      assert(spec.startsWith('.'), `la sombra alcanza el paquete "${spec}" vía ${relative(RAIZ, archivo)}`);
      cola.push(resolve(dirname(archivo), spec));
    }
  }
  const lista = [...vistos];
  return {
    modulos: lista.map((a) => relative(RAIZ, a).replace(/\\/g, '/')),
    fuentes: lista.map((a) => readFileSync(a, 'utf8')),
  };
};

await t('C13. la sombra no puede persistir un pedido', async () => {
  const { modulos, fuentes } = await grafoDeSombra();
  for (const m of modulos) {
    for (const p of ['services/database', 'orders/orderManager', 'channels/', 'server.js']) {
      assert.equal(m.includes(p), false, `la sombra alcanza ${m} (prohibido: ${p})`);
    }
  }
  for (const [i, src] of fuentes.entries()) {
    for (const fn of ['registrarPedido', 'guardarPedidoActivo', 'INSERT INTO pedidos']) {
      assert.equal(src.includes(fn), false, `${modulos[i]} nombra ${fn}`);
    }
  }
});

await t('C14. la sombra no puede imprimir', async () => {
  const { modulos, fuentes } = await grafoDeSombra();
  for (const m of modulos) {
    assert.equal(m.includes('services/impresion'), false, `la sombra alcanza ${m}`);
  }
  for (const [i, src] of fuentes.entries()) {
    for (const fn of ['imprimirComanda', 'imprimirTicketCliente', 'encolarImpresion']) {
      assert.equal(src.includes(fn), false, `${modulos[i]} nombra ${fn}`);
    }
  }
});

await t('C15. la sombra no consume folio', async () => {
  const { modulos, fuentes } = await grafoDeSombra();
  assert.ok(modulos.length > 0, 'el caminante no recorrió nada');
  for (const [i, src] of fuentes.entries()) {
    for (const fn of ['siguienteFolio', 'reservarFolio', 'nextval', 'folios_negocio']) {
      assert.equal(src.includes(fn), false, `${modulos[i]} nombra ${fn}`);
    }
  }
});

await t('C16. y nadie en el cierre cobra', async () => {
  const { modulos, fuentes } = await grafoDeSombra();
  for (const m of modulos) {
    for (const p of ['services/clip-api', 'services/pagosService', 'services/webhookPagos', 'services/facturapi']) {
      assert.equal(m.includes(p), false, `la sombra alcanza ${m} (prohibido: ${p})`);
    }
  }
  for (const [i, src] of fuentes.entries()) {
    for (const fn of ['crearEnlacePago', 'fetch(']) {
      assert.equal(src.includes(fn), false, `${modulos[i]} nombra ${fn}`);
    }
  }
});

console.log(`\n${'─'.repeat(70)}`);
console.log(`PASADAS: ${pasadas}   FALLOS: ${fallos.length}`);
for (const f of fallos) console.log(`  · ${f}`);
process.exit(fallos.length ? 1 : 0);
