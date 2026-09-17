// ─── EL CLIENTE Y SU DIRECCIÓN, BAJO AUTORIDAD Y BAJO VIGENCIA ───────────
//
// Certificado el cierre (5cf2406) quedaron dos huecos, y los dos viven en el
// mismo sitio: los datos del cliente.
//
// HUECO A — la huella del resumen miraba items, modalidad y pago. El cliente
// no. Se le enseñaba al cliente un resumen con su dirección, cambiaba la
// dirección, decía «sí», y la huella seguía coincidiendo: confirmaba un
// resumen que ya no describía a dónde iba su comida.
//
// HUECO B — el respaldo textual de un campo de cliente se daba por bueno con
// UNA palabra:
//
//   cliente   «Reforma 200»
//   modelo    «Reforma 200, Depto 5B»
//   respaldo  «reforma» aparece → el campo entero entraba, Depto incluido
//
// Un repartidor subiendo a un departamento que nadie pidió.
//
// ── POR QUÉ NO SIRVE `palabrasSinExplicar` TAL CUAL ─────────────────────
//
// Existe y hace casi exactamente esto, pero tiene la regla del género: sólo
// descalifica lo que va DESPUÉS de la primera palabra explicada, porque en
// «chile jalapeño» el negocio no tiene por qué haber escrito «chile». Medido
// contra los casos de este mandato acierta ocho de nueve y falla el que
// importa:
//
//   propuesta «Depto 5B Reforma 200» · cliente «Reforma 200» → [] , aceptado
//
// En una dirección no hay género que perdonar: toda palabra que el cliente no
// dijo es una invención, vaya delante o detrás. De ahí `palabrasSinRespaldo`,
// que es la misma función sin ese salto.
import assert from 'node:assert/strict';
import { atenderTurno } from '../src/mesero-whatsapp/meseroDigital.js';
import { resumenDelPedido, huellaDelResumen, resumenSigueVigente } from '../src/mesero-whatsapp/resumenDelPedido.js';

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
];
const LINEA = () => ({
  lid: 'L1', nombre: 'Chilaquiles Sencillos', id: 85, cantidad: 1, notas: '',
  modificadores: [{ grupo: 'Salsa', opciones: ['Suiza'] },
    { grupo: 'Proteina', opciones: ['Huevos Estrellados'] }],
});
const CARRITO = (datos = {}) => ({ items: [LINEA()], datos: { ...datos } });

function conversacion(id) {
  let contexto = null;
  let carrito = CARRITO();
  return {
    get carrito() { return carrito; },
    async turno(mensaje, borrador = null, extra = {}) {
      const r = await atenderTurno({
        negocioId: 'n-cli', conversacionId: id, mensaje,
        catalogo: CARTA, requierePago: true,
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

// ── LOS CAMPOS REALES. Medidos en produccion, no inventados ─────────────
//
//   nombre 319 · telefono 295 · calle 167 · colonia 167 · entre_calles 167
//   numero_interior 49 · referencia 49 · numero_exterior 49 · direccion 1
//
// Los nueve son operativos: los lee la comanda o el repartidor. Ninguno es
// metadata incidental, y por eso entran todos a la huella.
const CAMPOS_REALES = ['nombre', 'telefono', 'calle', 'colonia', 'entre_calles',
  'numero_exterior', 'numero_interior', 'referencia', 'direccion'];

const resumenCon = (cliente) => resumenDelPedido(
  CARRITO({ modalidad: 'entrega a domicilio', forma_pago: 'efectivo', cliente }),
  { requierePago: true });

console.log('\n══ D. LA HUELLA INCLUYE AL CLIENTE ══');

await t('D1. cambia la calle → huella obsoleta', () => {
  const a = resumenCon({ nombre: 'Mario', calle: 'Reforma 200' });
  const b = resumenCon({ nombre: 'Mario', calle: 'Reforma 350' });
  assert.equal(resumenSigueVigente(a, b), false,
    `la dirección cambió y la huella no se enteró: ${huellaDelResumen(a)}`);
});

await t('D2. cambia el nombre → huella obsoleta', () => {
  const a = resumenCon({ nombre: 'Mario', calle: 'Reforma 200' });
  const b = resumenCon({ nombre: 'Daniela', calle: 'Reforma 200' });
  assert.equal(resumenSigueVigente(a, b), false);
});

await t('D3. cambia el teléfono → huella obsoleta', () => {
  const a = resumenCon({ nombre: 'Mario', telefono: '8781234567' });
  const b = resumenCon({ nombre: 'Mario', telefono: '8787654321' });
  assert.equal(resumenSigueVigente(a, b), false);
});

await t('D4. cambia la referencia de entrega → huella obsoleta', () => {
  const a = resumenCon({ nombre: 'Mario', calle: 'Reforma 200', referencia: 'porton negro' });
  const b = resumenCon({ nombre: 'Mario', calle: 'Reforma 200', referencia: 'zaguan azul' });
  assert.equal(resumenSigueVigente(a, b), false);
});

await t('D4b. y los demás campos reales también', () => {
  for (const campo of CAMPOS_REALES) {
    const a = resumenCon({ [campo]: 'uno' });
    const b = resumenCon({ [campo]: 'dos' });
    assert.equal(resumenSigueVigente(a, b), false, `${campo} no entra en la huella`);
  }
});

await t('D4c. aparecer un campo donde no había nada también obsoleta', () => {
  const a = resumenCon({ nombre: 'Mario' });
  const b = resumenCon({ nombre: 'Mario', entre_calles: 'Juarez y Morelos' });
  assert.equal(resumenSigueVigente(a, b), false, 'se añadió un dato de entrega sin invalidar');
});

await t('D5. un campo ajeno al pedido NO invalida la vigencia', () => {
  // La huella representa el pedido observable, no lo que alguien haya metido
  // de paso en el objeto. Si esto se hiciera con JSON.stringify del cliente
  // entero, el día que alguien añada un `_origen` se caerían todas las
  // confirmaciones en vuelo sin que nada del pedido hubiera cambiado.
  const a = resumenCon({ nombre: 'Mario', calle: 'Reforma 200' });
  const b = resumenCon({ nombre: 'Mario', calle: 'Reforma 200', _origen: 'panel', id_interno: 42 });
  assert.equal(resumenSigueVigente(a, b), true,
    'un campo incidental rompió la vigencia de un pedido idéntico');
});

await t('D6. sólo cambia el formato → misma huella', () => {
  const a = resumenCon({ nombre: 'Mario', calle: 'Av. Reforma 200' });
  const b = resumenCon({ nombre: 'mario', calle: '  av reforma  #200 ' });
  assert.equal(resumenSigueVigente(a, b), true,
    `mayúsculas y puntuación no son un cambio de pedido:\n  ${huellaDelResumen(a)}\n  ${huellaDelResumen(b)}`);
});

await t('D6b. pero un número distinto NO es formato', () => {
  const a = resumenCon({ calle: 'Av. Reforma 200' });
  const b = resumenCon({ calle: 'av reforma 2000' });
  assert.equal(resumenSigueVigente(a, b), false, 'confundió un cambio de número con formato');
});

await t('D7. sin cliente en ninguno de los dos, la huella sigue funcionando', () => {
  const a = resumenCon(null);
  const b = resumenCon(null);
  assert.equal(resumenSigueVigente(a, b), true);
  assert.equal(resumenSigueVigente(a, resumenCon({ nombre: 'Mario' })), false);
});

console.log('\n══ A. AUTORIDAD ESTRICTA DE LOS DATOS DE CLIENTE ══');

await t('A7. el cliente lo dijo igual → entra', async () => {
  const c = conversacion('a7');
  const r = await c.turno('vivo en Reforma 200', { items: [], cliente: { calle: 'Reforma 200' } });
  assert.equal(r.carrito.datos.cliente?.calle, 'Reforma 200', JSON.stringify(r.carrito.datos.cliente));
});

await t('A8. sólo cambia mayúsculas/puntuación → entra', async () => {
  const c = conversacion('a8');
  const r = await c.turno('vivo en reforma 200', { items: [], cliente: { calle: 'Reforma 200' } });
  assert.equal(r.carrito.datos.cliente?.calle, 'Reforma 200', JSON.stringify(r.carrito.datos.cliente));
});

await t('A8b. «av reforma #200» → «Av. Reforma 200» entra: normalizar no es añadir', async () => {
  const c = conversacion('a8b');
  const r = await c.turno('av reforma #200', { items: [], cliente: { calle: 'Av. Reforma 200' } });
  assert.equal(r.carrito.datos.cliente?.calle, 'Av. Reforma 200', JSON.stringify(r.carrito.datos.cliente));
});

await t('A9. el modelo añade «Depto 5B» que nadie dijo → NO entra', async () => {
  const c = conversacion('a9');
  const r = await c.turno('vivo en Reforma 200', { items: [], cliente: { calle: 'Reforma 200, Depto 5B' } });
  assert.equal(r.carrito.datos.cliente, undefined,
    `entró un departamento inventado: ${JSON.stringify(r.carrito.datos.cliente)}`);
});

await t('A9b. y da igual que lo ponga delante', async () => {
  // El caso que `palabrasSinExplicar` dejaba pasar por su regla del género.
  const c = conversacion('a9b');
  const r = await c.turno('vivo en Reforma 200', { items: [], cliente: { calle: 'Depto 5B Reforma 200' } });
  assert.equal(r.carrito.datos.cliente, undefined,
    `la invención colada por delante: ${JSON.stringify(r.carrito.datos.cliente)}`);
});

await t('A10. el cliente SÍ dijo el departamento → entra completo', async () => {
  const c = conversacion('a10');
  const r = await c.turno('vivo en Reforma 200 Depto 5B', { items: [], cliente: { calle: 'Reforma 200, Depto 5B' } });
  assert.equal(r.carrito.datos.cliente?.calle, 'Reforma 200, Depto 5B', JSON.stringify(r.carrito.datos.cliente));
});

await t('A11. el modelo añade una colonia que nadie dijo → NO entra', async () => {
  const c = conversacion('a11');
  const r = await c.turno('vivo en Reforma 200',
    { items: [], cliente: { calle: 'Reforma 200, Colonia Centro' } });
  assert.equal(r.carrito.datos.cliente, undefined,
    `entró una colonia inventada: ${JSON.stringify(r.carrito.datos.cliente)}`);
});

await t('A12. campo a campo: nombre y calle entran, la referencia inventada no', async () => {
  const c = conversacion('a12');
  const r = await c.turno('Soy Mario, Reforma 200',
    { items: [], cliente: { nombre: 'Mario', calle: 'Reforma 200', referencia: 'porton negro' } });
  const cli = r.carrito.datos.cliente || {};
  assert.equal(cli.nombre, 'Mario', JSON.stringify(cli));
  assert.equal(cli.calle, 'Reforma 200', JSON.stringify(cli));
  assert.equal(cli.referencia, undefined, `se coló una referencia que nadie dijo: ${JSON.stringify(cli)}`);
});

await t('A12b. y el campo inventado que SÍ comparte una palabra tampoco pasa', async () => {
  // A12 no separa las dos reglas: «portón negro» no comparte nada con lo que
  // dijo el cliente, así que ya lo tiraba la regla vieja. El caso que de
  // verdad distingue «basta una palabra» de «todas» es el que se apoya en una
  // palabra real del cliente para colar otra que nunca dijo.
  const c = conversacion('a12b');
  const r = await c.turno('Soy Mario, vivo en Reforma 200',
    { items: [], cliente: { nombre: 'Mario', calle: 'Reforma 200', referencia: 'porton de Reforma' } });
  const cli = r.carrito.datos.cliente || {};
  assert.equal(cli.nombre, 'Mario', JSON.stringify(cli));
  assert.equal(cli.calle, 'Reforma 200', JSON.stringify(cli));
  assert.equal(cli.referencia, undefined,
    `«portón» se coló a hombros de «Reforma»: ${JSON.stringify(cli)}`);
});

await t('A13. el pendiente sigue abriendo la puerta (A6b no se rompe)', async () => {
  const c = conversacion('a13');
  const r = await c.turno('Av 5 #3', { items: [], cliente: { direccion: 'Av 5 #3' } },
    { datoOperativoPendiente: 'direccion' });
  assert.equal(r.carrito.datos.cliente?.direccion, 'Av 5 #3', JSON.stringify(r.carrito.datos.cliente));
});

await t('A13b. y con el nombre de campo real que usa el sistema', async () => {
  const c = conversacion('a13b');
  const r = await c.turno('Av 5 #3', { items: [], cliente: { calle: 'Av 5 #3' } },
    { datoOperativoPendiente: 'calle' });
  assert.equal(r.carrito.datos.cliente?.calle, 'Av 5 #3', JSON.stringify(r.carrito.datos.cliente));
});

await t('A13c. pero el pendiente abre SU campo, no los demás', async () => {
  const c = conversacion('a13c');
  const r = await c.turno('Av 5 #3',
    { items: [], cliente: { calle: 'Av 5 #3', nombre: 'Quien Sea', telefono: '8781234567' } },
    { datoOperativoPendiente: 'calle' });
  const cli = r.carrito.datos.cliente || {};
  assert.equal(cli.calle, 'Av 5 #3');
  assert.equal(cli.nombre, undefined, `el pendiente de calle coló un nombre: ${JSON.stringify(cli)}`);
  assert.equal(cli.telefono, undefined, `el pendiente de calle coló un teléfono: ${JSON.stringify(cli)}`);
});

await t('A14. nombre, teléfono y dirección enteramente inventados → ninguno entra', async () => {
  const c = conversacion('a14');
  const r = await c.turno('con salsa suiza porfa',
    { items: [{ nombre: 'Chilaquiles Sencillos', cantidad: 1, notas: '',
      modificadores: [{ grupo: 'Salsa', opciones: ['Suiza'] },
        { grupo: 'Proteina', opciones: ['Huevos Estrellados'] }] }],
    cliente: { nombre: 'Quien Sea', telefono: '8781234567', calle: 'Calle Falsa 123',
      colonia: 'Centro', referencia: 'porton negro' } });
  assert.equal(r.carrito.datos.cliente, undefined, JSON.stringify(r.carrito.datos.cliente));
  const campos = (r.cambios?.sinRespaldo || []).map((s) => s.campo);
  for (const f of ['cliente:nombre', 'cliente:telefono', 'cliente:calle', 'cliente:colonia', 'cliente:referencia']) {
    assert.ok(campos.includes(f), `${f} se descartó sin dejar traza: ${JSON.stringify(campos)}`);
  }
});

console.log('\n══ §13-§15. NO BORRAR, ACTUALIZAR, Y CONFIRMAR LO VIGENTE ══');

await t('N1. el borrador que no repite la calle NO la borra', async () => {
  // La lección de M2: el borrador es una propuesta, no el estado completo.
  const c = conversacion('n1');
  await c.turno('vivo en Reforma 200', { items: [], cliente: { calle: 'Reforma 200' } });
  const r = await c.turno('soy Mario', { items: [], cliente: { nombre: 'Mario' } });
  assert.equal(r.carrito.datos.cliente?.calle, 'Reforma 200',
    `perdió la calle por no repetirla: ${JSON.stringify(r.carrito.datos.cliente)}`);
  assert.equal(r.carrito.datos.cliente?.nombre, 'Mario');
});

await t('N1b. y un turno que no habla de cliente tampoco lo toca', async () => {
  const c = conversacion('n1b');
  await c.turno('vivo en Reforma 200', { items: [], cliente: { calle: 'Reforma 200' } });
  const r = await c.turno('para recoger', { items: [], modalidad: 'recoger en tienda' });
  assert.equal(r.carrito.datos.cliente?.calle, 'Reforma 200', JSON.stringify(r.carrito.datos.cliente));
});

await t('N2. «mejor mándalo a Reforma 350» actualiza, no acumula', async () => {
  const c = conversacion('n2');
  await c.turno('vivo en Reforma 200', { items: [], cliente: { calle: 'Reforma 200' } });
  const r = await c.turno('mejor mándalo a Reforma 350', { items: [], cliente: { calle: 'Reforma 350' } });
  assert.equal(r.carrito.datos.cliente?.calle, 'Reforma 350',
    `no actualizó: ${JSON.stringify(r.carrito.datos.cliente)}`);
});

const hastaResumenConCalle = async (id) => {
  const c = conversacion(id);
  await c.turno('a domicilio, vivo en Reforma 200',
    { items: [], modalidad: 'entrega a domicilio', cliente: { calle: 'Reforma 200' } });
  const r = await c.turno('pago en efectivo', { items: [], forma_pago: 'efectivo' });
  assert.equal(r.listoParaConfirmar, true, `no llegó a listo: ${JSON.stringify(r.falta)}`);
  assert.equal(r.carrito.datos.cliente?.calle, 'Reforma 200', JSON.stringify(r.carrito.datos.cliente));
  return c;
};

await t('V1. cambiar la dirección en el turno del «sí» invalida la confirmación', async () => {
  const c = await hastaResumenConCalle('v1');
  const r = await c.turno('mejor a Reforma 350, sí confirmo', { items: [], cliente: { calle: 'Reforma 350' } });
  assert.equal(r.carrito.datos.cliente?.calle, 'Reforma 350', 'el cambio no se aplicó');
  assert.equal(r.confirmacionVigente, false, 'confirmó un resumen con la dirección vieja');
  assert.notEqual(r.fase, 'confirmando');
});

await t('V2. enseñado el resumen nuevo, el «sí» siguiente SÍ confirma', async () => {
  const c = await hastaResumenConCalle('v2');
  await c.turno('mejor a Reforma 350', { items: [], cliente: { calle: 'Reforma 350' } });
  const r = await c.turno('sí, confirmo', null);
  assert.equal(r.fase, 'confirmando', `fase=${r.fase} vigente=${r.confirmacionVigente}`);
});

await t('V3. sin tocar nada, el «sí» sigue confirmando', async () => {
  const c = await hastaResumenConCalle('v3');
  const r = await c.turno('sí, confirmo', null);
  assert.equal(r.fase, 'confirmando', `fase=${r.fase} vigente=${r.confirmacionVigente}`);
});

console.log(`\n${'─'.repeat(70)}`);
console.log(`PASADAS: ${pasadas}   FALLOS: ${fallos.length}`);
for (const f of fallos) console.log(`  · ${f}`);
process.exit(fallos.length ? 1 : 0);
