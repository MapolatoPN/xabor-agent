import assert from 'node:assert/strict';
import { estadoNuevo, crearEjecutor, pendientePublico } from '../src/mesero-agente/ejecutorDeHerramientas.js';
import { atenderTurnoConHerramientas } from '../src/mesero-agente/agenteDelMesero.js';
import { acusarDialogo, fijarRecepcionDelTurno } from '../src/mesero-agente/contratoConversacional.js';
import { fijarPendiente, sellarEstado } from '../src/mesero-agente/estadoCanonico.js';
import { iniciarSeleccion, resolverSeleccion } from '../src/mesero-agente/seleccionDeProducto.js';

const grupo = (nombre, opciones, maximo = 1) => ({ nombre, requerido: true, minimo: 1, maximo,
  opciones: opciones.map(nombre => ({ nombre, disponible: true })) });
export const cartaFragmentada = [{ nombre: 'Desayunos', productos: [
  ...[85, 107].map((id, i) => ({ id, nombre: `Chilaquiles ${i ? 'Mixtos' : 'Sencillos'}`,
    precio: i ? 205 : 195, orden: i, disponible: true, modificadores: [
      grupo('Salsa', ['Roja', 'Verde', 'Suiza', 'Chipotle'], i + 1),
      grupo('Proteína', ['Pechuga de pollo', 'Huevos estrellados', 'Bistec en Salsa', 'Queso Panela en Salsa'], i + 1),
      grupo('Guarniciones', ['Frijolitos naturales', 'Frijolitos con chorizo', 'Papas a la mexicana'], 2),
    ] })),
  { id: 201, nombre: 'Jugo verde grande', precio: 75, disponible: true },
] }];
const nuevo = () => estadoNuevo({ negocioId: 'fragmentada-local', conversacionId: 'fragmentada' });
const noModelo = async () => { throw Error('La continuación explícita no debe depender del modelo'); };
const textoModelo = async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: '¿Qué deseas pedir?' }] });
let turnos = 0, casos = 0;
async function turno(estado, mensaje, llamarModelo = noModelo, efectos = {}) {
  const r = await atenderTurnoConHerramientas({ estado, mensaje, catalogo: cartaFragmentada,
    turnoId: `fragmentada-${++turnos}`, llamarModelo, efectos,
    modalidades: ['recoger en tienda'], metodosPago: ['efectivo'],
    nombresOcultos: ['Chilaquiles antiguos'] });
  assert.equal(r.error, undefined); assert.equal(r.escalado, false, r.texto);
  sellarEstado(estado, r.pedido);
  assert(acusarDialogo(estado, r.dialogoId, r.texto, { acusadoAt: '2026-09-28T12:45:33Z' }));
  return r;
}
async function t(nombre, fn) { await fn(); casos++; console.log(`OK selección fragmentada: ${nombre}`); }
const pendiente = (e, solicitud = 'Quiero unos chilaquiles') => fijarPendiente(e,
  iniciarSeleccion({ estado: e, catalogo: cartaFragmentada, mensaje: solicitud }));

await t('fallo original sin pendiente; historial del modelo no es permiso', async () => {
  const e = nuevo(); e.historialDialogo = [{ rol: 'user', texto: 'Quiero unos chilaquiles' }];
  const r = await crearEjecutor({ estado: e, catalogo: cartaFragmentada,
    mensaje: 'Serían verdes\nCon pollo' }).ejecutar('agregar_producto', { producto_id: '85', cantidad: 1,
    opciones: [{ grupo: 'Salsa', opcion: 'Verde' }, { grupo: 'Proteína', opcion: 'Pechuga de pollo' }] });
  assert.equal(r.aplicado, false); assert.equal(e.carrito.items.length, 0);
});
for (const fragmentos of [['Serían verdes', 'Con pollo'], ['Serían verdes\nCon pollo'], ['Con pollo', 'Serían verdes']]) {
  await t(`recorrido completo con recarga y mensajes previos al acuse: ${fragmentos.join(' / ')}`, async () => {
    let e = nuevo(); let confirmaciones = 0;
    const efectos = { confirmar: async () => { confirmaciones++; return { ok: true, folio: 'SIM-FRAGMENTADO' }; } };
    const enviar = async (m, modelo = noModelo, anticipado = false) => {
      e = JSON.parse(JSON.stringify(e));
      if (anticipado) fijarRecepcionDelTurno(e, '2026-09-28T12:45:29Z');
      return turno(e, m, modelo, efectos);
    };
    await enviar('Quiero unos chilaquiles');
    assert.equal(e.pendiente.tipo, 'elegir_producto'); assert.equal(e.carrito.items.length, 0);
    assert.doesNotMatch(e.dialogo.texto, /Qué te gustaría pedir|antiguos/i);
    assert.equal(JSON.stringify(pendientePublico(e.pendiente)).includes('"id"'), false);
    for (const m of fragmentos) await enviar(m, noModelo, true);
    assert.equal(e.carrito.items.length, 1); const lid = e.carrito.items[0].lid;
    await enviar('Frijolitos naturales y papas a la mexicana');
    await enviar('¿Me puedes agregar salsa roja?');
    assert.equal(e.carrito.items[0].lid, lid); assert.equal(e.carrito.items[0].id, 107);
    assert.deepEqual(e.carrito.items[0].modificadores.find(g => g.grupo === 'Salsa').opciones.slice().sort(), ['Roja', 'Verde']);
    await enviar('Recoger'); const resumen = await enviar('Efectivo');
    assert.equal(resumen.pedido.total, 205); assert.equal(confirmaciones, 0);
    await enviar('Sí, confirmo'); assert.equal(confirmaciones, 1);
    await enviar('Sí, confirmo', textoModelo); assert.equal(confirmaciones, 1);
    assert.equal(e.carrito.items.length, 1);
  });
}
await t('cantidad del mensaje inicial, no del modelo; consumo único', async () => {
  const e = nuevo(); pendiente(e, 'Quiero dos chilaquiles');
  const mensaje = 'Verdes con pollo';
  const s = resolverSeleccion({ estado: e, catalogo: cartaFragmentada, mensaje });
  const executor = crearEjecutor({ estado: e, catalogo: cartaFragmentada, mensaje });
  const { producto, ...args } = s;
  assert.equal((await executor.ejecutar('agregar_producto', { ...args, cantidad: 20 },
    { autorizacion: { tipo: 'seleccion_de_producto' } })).aplicado, false);
  assert.equal((await executor.ejecutar('agregar_producto', args)).aplicado, false, 'el modelo no hereda permisos');
  assert.equal((await executor.ejecutar('agregar_producto', args,
    { autorizacion: { tipo: 'seleccion_de_producto' } })).aplicado, true);
  assert.equal(e.carrito.items[0].cantidad, 2); assert.equal(e.pendiente, null);
  assert.equal((await executor.ejecutar('agregar_producto', args,
    { autorizacion: { tipo: 'seleccion_de_producto' } })).aplicado, false);
  assert.equal(e.carrito.items.length, 1);
});
for (const mensaje of ['Sí', 'No', 'Cancela todo', '¿Tienen salsa verde?', 'Verdes si son gratis',
  'Roja o verde', 'Jugo verde grande', 'Verdes y agrega un jugo', 'Sin pollo']) {
  await t(`sin autorización por aceptación, consulta, condición u otra intención: ${mensaje}`, () => {
    const e = nuevo(); pendiente(e);
    assert.equal(resolverSeleccion({ estado: e, catalogo: cartaFragmentada, mensaje }), null);
  });
}
await t('ciclo nuevo, producto agotado y selección alterada fallan cerrado', () => {
  const e = nuevo(); pendiente(e); e.conversacionId = 'otro-ciclo';
  assert.equal(resolverSeleccion({ estado: e, catalogo: cartaFragmentada, mensaje: 'Verdes' }), null);
  e.conversacionId = 'fragmentada'; e.pendiente.cantidad = 20;
  assert.equal(resolverSeleccion({ estado: e, catalogo: cartaFragmentada, mensaje: 'Verdes' }), null);
  e.pendiente.cantidad = 1;
  const agotada = structuredClone(cartaFragmentada); agotada[0].productos[0].disponible = false;
  assert.equal(resolverSeleccion({ estado: e, catalogo: agotada, mensaje: 'Verdes' }), null);
});
await t('intención abandonada no vuelve desde el historial', async () => {
  const e = nuevo(); await turno(e, 'Quiero unos chilaquiles');
  await turno(e, 'No, gracias', textoModelo);
  assert.notEqual(e.pendiente?.tipo, 'elegir_producto');
  assert.equal(resolverSeleccion({ estado: e, catalogo: cartaFragmentada, mensaje: 'Verdes' }), null);
});
await t('no abre selección durante efectos inciertos o ciclos terminales', () => {
  for (const datos of [{ confirmacionIncierta: true }, { folio: 'YA-REGISTRADO' },
    { hechos: { cancelado: true } }, { hechos: { escalado: true } }, { evento: {} }]) {
    const e = Object.assign(nuevo(), datos);
    assert.equal(iniciarSeleccion({ estado: e, catalogo: cartaFragmentada, mensaje: 'Quiero unos chilaquiles' }), null);
  }
});
await t('no captura consultas, cantidades ambiguas ni productos compuestos', () => {
  for (const mensaje of ['¿Quiero chilaquiles?', 'Quiero veinte o dos chilaquiles', 'Quiero 50 chilaquiles',
    'Quiero chilaquiles y jugo', 'Quiero chilaquiles con pollo', 'Quiero chilaquiles sin pollo', 'Quiero chilaquiles para mañana']) {
    assert.equal(iniciarSeleccion({ estado: nuevo(), catalogo: cartaFragmentada, mensaje }), null, mensaje);
  }
});
console.log(`Selección fragmentada: ${casos}/${casos}`);
