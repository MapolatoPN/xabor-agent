// Incidente 28-sep: corregir una presentación no crea otro plato. Sin DB,
// proveedor, transporte, pago ni impresión; todos los efectos son inyectados.
import assert from 'node:assert/strict';
import { estadoNuevo, crearEjecutor } from '../src/mesero-agente/ejecutorDeHerramientas.js';
import { atenderTurnoConHerramientas } from '../src/mesero-agente/agenteDelMesero.js';
import { acusarDialogo } from '../src/mesero-agente/contratoConversacional.js';
import { varianteDelPedido } from '../src/mesero-agente/varianteDelPedido.js';

const grupo = (nombre, opciones, maximo = 1) => ({ nombre, requerido: true, minimo: 1, maximo,
  opciones: opciones.map(nombre => ({ nombre, disponible: true, precio_extra: 0 })) });
const grupos = maximo => [
  grupo('Salsa', ['Suiza', 'Chipotle', 'Roja', 'Verde', 'Mole'], maximo),
  grupo('Proteína', ['Pechuga de pollo', 'Huevos estrellados'], maximo),
  grupo('Guarniciones', ['Frijolitos naturales', 'Frijolitos con chorizo', 'Papas a la mexicana', 'Papas con chorizo'], 2),
];
// Sin aliases artificiales: producción no necesita declarar «mixtos» otra vez.
const catalogo = [{ nombre: 'Desayunos', productos: [
  { id: 85, nombre: 'Chilaquiles Sencillos', precio: 195, orden: 0, disponible: true, modificadores: grupos(1) },
  { id: 107, nombre: 'Chilaquiles Mixtos', precio: 205, orden: 1, disponible: true, modificadores: grupos(2) },
  { id: 112, nombre: 'Licuado', precio: 90, disponible: true, modificadores: [
    grupo('Tamaño', ['Grande 1 Litro', 'Chico']), grupo('Frutas', ['Platáno', 'Fresa'], 2),
    grupo('Complementos', ['Chocolate', 'Vainilla'], 2), grupo('Leche', ['Entera']), grupo('Endulzante', ['Splenda']),
  ] },
] }];
const elecciones = [
  { grupo: 'Salsa', opciones: ['Suiza'] },
  { grupo: 'Proteína', opciones: ['Pechuga de pollo'] },
  { grupo: 'Guarniciones', opciones: ['Frijolitos con chorizo', 'Papas a la mexicana'] },
];
const nuevo = () => {
  const e = estadoNuevo({ negocioId: 'local-variante', conversacionId: 'incidente-variante' });
  e.carrito.items = [{ lid: 'plato', id: 85, nombre: 'Chilaquiles Sencillos', cantidad: 1,
    notas: 'sin cebolla', modificadores: structuredClone(elecciones) }];
  e.foco = { tipo: 'modalidad' };
  return e;
};
const conBebida = () => {
  const e = nuevo();
  e.carrito.items.push({ lid: 'bebida', id: 112, nombre: 'Licuado', cantidad: 1, notas: '', modificadores: [] });
  e.foco = { tipo: 'opcion', linea_id: 'bebida', grupo: 'Tamaño' };
  return e;
};
const ejecutar = (e, mensaje, herramienta, args, extra = {}) => crearEjecutor({
  estado: e, catalogo, mensaje, textoCiclo: mensaje, ...extra,
}).ejecutar(herramienta, args);
const noModelo = async () => { throw Error('Una corrección inequívoca debe resolverse sin el modelo'); };
let numero = 0;
async function turno(e, mensaje, llamarModelo = noModelo, efectos = {}) {
  let llamadas = 0;
  const r = await atenderTurnoConHerramientas({ estado: e, catalogo, mensaje, turnoId: `correccion-${++numero}`,
    modalidades: ['recoger en tienda'], metodosPago: ['efectivo'],
    llamarModelo: async args => { llamadas++; return llamarModelo(args); }, efectos });
  if (llamarModelo === noModelo) assert.equal(llamadas, 0, `No delegar esta corrección al modelo: ${mensaje}`);
  assert.equal(r.escalado, false, r.texto);
  assert(acusarDialogo(e, r.dialogoId, r.texto));
  return r;
}
let fallos = 0, casos = 0;
async function t(nombre, fn) {
  casos++;
  try { await fn(); console.log(`OK ${nombre}`); }
  catch (e) { fallos++; console.error(`FALLO ${nombre}: ${e.message}`); }
}
function comprobarPlato(e, salsas = ['Chipotle', 'Suiza']) {
  const p = e.carrito.items.find(i => i.lid === 'plato');
  assert.equal(p.id, 107); assert.equal(p.cantidad, 1); assert.equal(p.notas, 'sin cebolla');
  assert.deepEqual(p.modificadores.find(g => g.grupo === 'Salsa').opciones.slice().sort(), salsas);
  assert.deepEqual(p.modificadores.find(g => g.grupo === 'Guarniciones').opciones,
    ['Frijolitos con chorizo', 'Papas a la mexicana']);
  assert.deepEqual(p.modificadores.find(g => g.grupo === 'Proteína').opciones, ['Pechuga de pollo']);
}

await t('dos salsas con guarniciones guardadas no inventan papas con chorizo', async () => {
  const e = nuevo();
  assert.equal(varianteDelPedido({ estado: e, catalogo, mensaje: 'Serían las dos, Suiza y chipotle' })?.producto.id, 107);
  const r = await turno(e, 'Serían las dos, Suiza y chipotle');
  comprobarPlato(e); assert.equal(e.carrito.items.length, 1); assert.equal(r.pedido.total, 205);
  assert.match(r.texto, /Mixtos/); assert.match(r.texto, /Suiza/); assert.match(r.texto, /Chipotle/);
  assert.match(r.texto, /205/);
});
await t('la identidad y ambas salsas se aplican juntas por la herramienta existente', async () => {
  const e = nuevo();
  const r = await ejecutar(e, 'Serían las dos, Suiza y chipotle', 'modificar_linea', { linea_id: 'plato', reclasificar: true });
  assert.equal(r.aplicado, true); comprobarPlato(e);
});
await t('mixtos explícitos no requieren alias ni foco en el plato', async () => {
  const e = conBebida(), bebida = structuredClone(e.carrito.items[1]);
  await turno(e, 'Los chilaquiles son mixtos');
  comprobarPlato(e, ['Suiza']); assert.deepEqual(e.carrito.items[1], bebida);
  assert.equal(e.carrito.items.length, 2);
});
await t('corrección después de resumen invalida la huella anterior', async () => {
  const e = nuevo(); e.carrito.datos = { modalidad: 'recoger en tienda', forma_pago: 'efectivo' };
  const previo = await turno(e, 'Efectivo', async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: '¿Confirmas este pedido?' }] }));
  const r = await turno(e, 'Los chilaquiles son mixtos');
  assert.notEqual(r.pedido.huella, previo.pedido.huella);
  assert.match(r.texto, /Mixtos/); assert.match(r.texto, /205/); assert.equal(e.folio, null);
});
await t('quitar rechazado no permite agregar una variante como plato extra', async () => {
  const e = conBebida(), antes = structuredClone(e.carrito);
  const ex = crearEjecutor({ estado: e, catalogo, mensaje: 'Los chilaquiles', textoCiclo: 'Los chilaquiles son mixtos' });
  assert.equal((await ex.ejecutar('quitar_linea', { linea_id: 'plato' })).aplicado, false);
  assert.equal((await ex.ejecutar('agregar_producto', { producto_id: '107', cantidad: 1 })).aplicado, false);
  assert.deepEqual(e.carrito, antes);
});
for (const mensaje of ['Tienen mixtos?', 'Agrega otros mixtos', 'Suiza', 'Suiza o chipotle', 'No quiero mixtos', 'Mejor chipotle']) {
  await t(`no reclasifica indebidamente: ${mensaje}`, async () => {
    const e = nuevo(), antes = structuredClone(e.carrito);
    assert.equal((await ejecutar(e, mensaje, 'modificar_linea', { linea_id: 'plato', reclasificar: true })).aplicado, false);
    assert.deepEqual(e.carrito, antes);
  });
}
await t('agregar otro plato explícitamente sigue permitido', async () => {
  const e = nuevo();
  assert.equal((await ejecutar(e, 'Agrega otros chilaquiles mixtos', 'agregar_producto', { producto_id: '107', cantidad: 1 })).aplicado, true);
  assert.equal(e.carrito.items.length, 2); assert.equal(e.carrito.items[0].id, 85);
});
await t('dos platos posibles no autorizan escoger uno por su foco', async () => {
  const e = nuevo(); e.carrito.items.push({ ...structuredClone(e.carrito.items[0]), lid: 'otro' });
  e.foco = { tipo: 'opcion', linea_id: 'plato', grupo: 'Salsa' };
  const antes = structuredClone(e.carrito);
  assert.equal((await ejecutar(e, 'Los chilaquiles son mixtos', 'modificar_linea', { linea_id: 'plato', reclasificar: true })).aplicado, false);
  assert.deepEqual(e.carrito, antes);
});
await t('no pierde opciones que no existen en la variante destino', async () => {
  const e = nuevo(); e.carrito.items[0].modificadores.push({ grupo: 'Exclusivo', opciones: ['Extra'] });
  const antes = structuredClone(e.carrito);
  assert.equal((await ejecutar(e, 'Los chilaquiles son mixtos', 'modificar_linea', { linea_id: 'plato', reclasificar: true })).aplicado, false);
  assert.deepEqual(e.carrito, antes);
});
await t('repetir la corrección recargando estado no duplica ni pierde elecciones', async () => {
  let e = nuevo();
  await turno(e, 'Serían las dos, Suiza y chipotle');
  e = JSON.parse(JSON.stringify(e)); const antes = structuredClone(e.carrito);
  await ejecutar(e, 'Los chilaquiles son mixtos', 'modificar_linea', { linea_id: 'plato', reclasificar: true });
  assert.deepEqual(e.carrito, antes);
  assert.equal((await ejecutar(e, 'Los chilaquiles son mixtos', 'agregar_producto', { producto_id: '107' })).aplicado, false);
});

await t('no reclasifica un producto de otra familia aunque no tenga opciones', async () => {
  const e = nuevo(); e.carrito.items[0].modificadores = [];
  const antes = structuredClone(e.carrito);
  assert.equal(varianteDelPedido({ estado: e, catalogo, mensaje: 'Quiero un licuado' }), null);
  assert.deepEqual(e.carrito, antes);
});
await t('tres salsas se rechazan sin cambiar identidad ni opciones', async () => {
  const e = nuevo(), antes = structuredClone(e);
  assert.equal((await ejecutar(e, 'Suiza, Chipotle y Roja', 'modificar_linea', { linea_id: 'plato', reclasificar: true })).aplicado, false);
  assert.deepEqual(e, antes);
});
await t('un modelo no puede escoger otra línea con reclasificar', async () => {
  const e = conBebida(), antes = structuredClone(e.carrito);
  assert.equal((await ejecutar(e, 'Los chilaquiles son mixtos', 'modificar_linea', { linea_id: 'bebida', reclasificar: true })).aplicado, false);
  assert.deepEqual(e.carrito, antes);
});
await t('agotados y pedidos confirmados permanecen protegidos', async () => {
  const e = nuevo(), sinMixtos = structuredClone(catalogo);
  sinMixtos[0].productos[1].disponible = false;
  assert.equal(varianteDelPedido({ estado: e, catalogo: sinMixtos, mensaje: 'Los chilaquiles son mixtos' }), null);
  e.hechos.confirmado = true; e.folio = 'SIMULADO';
  const antes = structuredClone(e.carrito);
  assert.equal((await ejecutar(e, 'Los chilaquiles son mixtos', 'modificar_linea', { linea_id: 'plato', reclasificar: true })).aplicado, false);
  assert.deepEqual(e.carrito, antes);
});
await t('una reclasificación no pasa por alto una exclusión explícita', async () => {
  const e = nuevo(), antes = structuredClone(e);
  const r = await ejecutar(e, 'Los chilaquiles son mixtos sin Suiza, con Chipotle',
    'modificar_linea', { linea_id: 'plato', reclasificar: true });
  assert.equal(r.aplicado, false);
  assert.deepEqual(e, antes, 'una corrección incompatible no debe persistir a medias');
});
await t('la misma corrección funciona en otro catálogo sin nombres especiales', async () => {
  const carta = [{ nombre: 'Pizzas', productos: [
    { id: 1, nombre: 'Pizza Individual', disponible: true, precio: 120, orden: 0,
      modificadores: [grupo('Sabor', ['Pepperoni', 'Hawaiana'], 1)] },
    { id: 2, nombre: 'Pizza Combinada', disponible: true, precio: 160, orden: 1,
      modificadores: [grupo('Sabor', ['Pepperoni', 'Hawaiana'], 2)] },
  ] }];
  const e = estadoNuevo({ negocioId: 'otra-carta', conversacionId: 'pizza' });
  e.carrito.items = [{ lid: 'pizza', id: 1, nombre: 'Pizza Individual', cantidad: 1,
    notas: '', modificadores: [{ grupo: 'Sabor', opciones: ['Pepperoni'] }] }];
  const r = await ejecutar(e, 'Pepperoni y Hawaiana', 'modificar_linea',
    { linea_id: 'pizza', reclasificar: true }, { catalogo: carta });
  assert.equal(r.aplicado, true); assert.equal(r.pedido.total, 160);
  assert.equal(e.carrito.items.length, 1); assert.equal(e.carrito.items[0].id, 2);
  assert.deepEqual(e.carrito.items[0].modificadores[0].opciones.slice().sort(), ['Hawaiana', 'Pepperoni']);
});

const modeloGuion = (...pasos) => async () => {
  const paso = pasos.shift();
  assert(paso, 'El modelo simulado agotó su guion');
  return typeof paso === 'string'
    ? { stop_reason: 'end_turn', content: [{ type: 'text', text: paso }] }
    : { stop_reason: 'tool_use', content: paso.map(([name, input], i) => ({ type: 'tool_use', id: `sim-${numero}-${pasos.length}-${i}`, name, input })) };
};
await t('conversación completa, recarga entre turnos, dos líneas, $295 y una confirmación', async () => {
  let e = estadoNuevo({ negocioId: 'local-variante', conversacionId: 'recorrido-completo' });
  let registros = 0;
  const efectos = { confirmar: async () => { registros++; return { ok: true, folio: 'SIMULADO-295' }; } };
  const darTurno = async (mensaje, modelo = noModelo) => {
    const r = await turno(e, mensaje, modelo, efectos);
    e = JSON.parse(JSON.stringify(e));
    return r;
  };
  await darTurno('Voy a querer unos chilaquiles suizos con pollo frijoles y papas a la mexicana', modeloGuion([
    ['agregar_producto', { producto_id: '85', cantidad: 1, opciones: [
      { grupo: 'Salsa', opcion: 'Suiza' }, { grupo: 'Proteína', opcion: 'Pechuga de pollo' },
      { grupo: 'Guarniciones', opcion: 'Papas a la mexicana' },
    ] }],
  ], '¿Qué frijolitos prefieres?'));
  const lid = e.carrito.items[0].lid;
  await darTurno('Con chorizo porfs', modeloGuion('¿Será para recoger?'));
  const antesChipotle = structuredClone(e.carrito);
  await darTurno('Le podrías agregar chipotle?', modeloGuion([
    ['buscar_producto', { texto: 'chipotle' }],
  ], 'Ahora tienes Suiza. ¿Quieres cambiarla a Chipotle?'));
  assert.deepEqual(e.carrito, antesChipotle, 'la consulta no autoriza aún otro producto');
  await darTurno('Serían las dos, Suiza y chipotle');
  assert.equal(e.carrito.items[0].id, 107); assert.equal(e.carrito.items[0].lid, lid);
  await darTurno('Recoger. Me agregas un licuado', modeloGuion([
    ['definir_entrega', { modalidad: 'recoger en tienda' }],
    ['agregar_producto', { producto_id: '112', cantidad: 1 }],
  ], '¿Qué tamaño de licuado?'));
  await darTurno('Grande de plátano con fresa', modeloGuion('¿Qué complementos prefieres?'));
  await darTurno('Chocolate y vainilla', modeloGuion('¿Qué leche prefieres?'));
  await darTurno('Entera y splenda', modeloGuion('¿Cómo deseas pagar?'));
  const resumen = await darTurno('Efectivo', modeloGuion('¿Confirmas este pedido?'));
  assert.equal(e.carrito.items.length, 2);
  const plato = e.carrito.items.find(i => i.lid === lid);
  assert.equal(plato.id, 107); assert.equal(plato.cantidad, 1);
  assert.deepEqual(plato.modificadores.find(g => g.grupo === 'Salsa').opciones.slice().sort(), ['Chipotle', 'Suiza']);
  assert.deepEqual(plato.modificadores.find(g => g.grupo === 'Guarniciones').opciones.slice().sort(),
    ['Frijolitos con chorizo', 'Papas a la mexicana']);
  assert.equal(resumen.pedido.total, 295); assert.match(resumen.texto, /295/);
  assert.equal(registros, 0);
  await darTurno('Sí, confirmo');
  assert.equal(registros, 1); assert.equal(e.folio, 'SIMULADO-295');
  await darTurno('Sí, confirmo', modeloGuion('Tu pedido ya quedó registrado.'));
  assert.equal(registros, 1);
});
console.log(`Corrección de variante: ${casos - fallos}/${casos}`);
if (fallos) throw new Error(`${fallos} regresiones de corrección de variante`);
