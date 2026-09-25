import assert from 'node:assert/strict';
import { estadoNuevo, crearEjecutor } from '../src/mesero-agente/ejecutorDeHerramientas.js';
import { atenderTurnoConHerramientas } from '../src/mesero-agente/agenteDelMesero.js';
const grupo = (nombre, opciones, maximo) => ({ nombre, requerido: true, minimo: 1, maximo,
  opciones: opciones.map(nombre => ({ nombre, disponible: true })) });
const catalogo = [{ nombre: 'Desayunos', productos: [
  { id: 85, nombre: 'Chilaquiles Sencillos', precio: 195, disponible: true, opciones: { variante: { base: true } },
    modificadores: [grupo('Salsa', ['Suiza', 'Chipotle', 'Roja'], 1), grupo('Proteína', ['Huevos Estrellados'], 1), grupo('Guarniciones', ['Papas', 'Frijoles'], 2)] },
  { id: 107, nombre: 'Chilaquiles Mixtos', precio: 205, disponible: true, opciones: { variante: { discriminadores: ['mixto', 'mixtos'] } },
    modificadores: [grupo('Salsa', ['Suiza', 'Chipotle', 'Roja'], 2), grupo('Proteína', ['Huevos Estrellados'], 2), grupo('Guarniciones', ['Papas', 'Frijoles'], 2)] },
] }];
const nuevo = () => {
  const e = estadoNuevo({ negocioId: 'variante', conversacionId: 'prueba' });
  e.carrito.items = [{ id: 85, lid: 'l1', nombre: 'Chilaquiles Sencillos', cantidad: 1, notas: 'sin cebolla',
    modificadores: [{ grupo: 'Proteína', opciones: ['Huevos Estrellados'] }] }];
  e.foco = { tipo: 'opcion', linea_id: 'l1', grupo: 'Salsa' }; return e;
};
for (const mensaje of ['Serían suizos y chipotle', 'Quiero suizos con chipotle', 'Serían mixtos']) {
  const e = nuevo();
  const r = await atenderTurnoConHerramientas({ estado: e, catalogo, mensaje,
    llamarModelo: async () => { throw Error('La variante debe resolverse con catálogo y estado'); } });
  assert.equal(r.escalado, false);
  assert.equal(e.carrito.items.length, 1);
  assert.equal(e.carrito.items[0].id, 107);
  assert.equal(e.carrito.items[0].lid, 'l1');
  assert.equal(e.carrito.items[0].notas, 'sin cebolla');
  assert.equal(r.pedido.total, 205);
  assert(r.pedido.lineas[0].opciones.some(o => o.opcion === 'Huevos Estrellados'));
  if (!/mixtos/.test(mensaje)) assert.deepEqual(r.pedido.lineas[0].opciones.filter(o => o.grupo === 'Salsa').map(o => o.opcion).sort(), ['Chipotle', 'Suiza']);
}
for (const mensaje of ['Tienen mixtos?', 'Agrega otros mixtos', 'Suiza', 'Suiza o chipotle', 'No quiero mixtos']) {
  const e = nuevo(); const antes = JSON.stringify(e.carrito);
  assert.equal((await crearEjecutor({ estado: e, catalogo, mensaje }).ejecutar('modificar_linea', { linea_id: 'l1', reclasificar: true })).aplicado, false);
  assert.equal(JSON.stringify(e.carrito), antes);
}
const reemplazo = nuevo();
reemplazo.carrito.items[0].modificadores.push({ grupo: 'Salsa', opciones: ['Suiza'] });
assert.equal((await crearEjecutor({ estado: reemplazo, catalogo, mensaje: 'Mejor chipotle' }).ejecutar('modificar_linea', { linea_id: 'l1', reclasificar: true })).aplicado, false);
const e = nuevo();
e.opcionesPendientes = [{ lid: 'l1', grupo: 'Salsa', producto: 'Chilaquiles Sencillos', tipo: 'eleccion_ambigua', maximo: 1, candidatos: ['Suiza', 'Chipotle'] }];
await atenderTurnoConHerramientas({ estado: e, catalogo, mensaje: 'Serían mixtos', llamarModelo: async () => { throw Error('No usar modelo'); } });
assert.equal(e.opcionesPendientes[0].maximo, 2);
const recargado = JSON.parse(JSON.stringify(e));
const r = await atenderTurnoConHerramientas({ estado: recargado, catalogo, mensaje: 'Suiza y chipotle', llamarModelo: async () => { throw Error('No usar modelo'); } });
assert.equal(r.escalado, false);
assert.equal(recargado.opcionesPendientes.length, 0);
assert.equal(r.pedido.total, 205);
console.log('OK variantes: dos salsas reclasifican, conservan proteína/línea/notas, actualizan precio y no mutan consultas.');
