import assert from 'node:assert/strict';
import { estadoNuevo, crearEjecutor } from '../src/mesero-agente/ejecutorDeHerramientas.js';
import { atenderTurnoConHerramientas } from '../src/mesero-agente/agenteDelMesero.js';
import { marcarProgramacionRequerida } from '../src/mesero-agente/canalDelAgente.js';
import { palabrasQueLaSostienen } from '../src/orders/evidenciaDeEleccion.js';
const catalogo = [{ nombre: 'Desayunos', productos: [{ id: 107, nombre: 'Chilaquiles Mixtos', precio: 205, disponible: true,
  modificadores: [{ nombre: 'Guarniciones', requerido: true, minimo: 1, maximo: 2,
    opciones: ['Frijolitos naturales', 'Frijolitos con chorizo', 'Papas a la mexicana', 'Papas con chorizo'].map(nombre => ({ nombre, disponible: true })) }] }] }];
const nuevo = () => {
  const e = estadoNuevo({ negocioId: 'alcance', conversacionId: 'prueba' });
  e.carrito.items = [{ id: 107, lid: 'l1', nombre: 'Chilaquiles Mixtos', cantidad: 1, modificadores: [] }];
  e.foco = { tipo: 'opcion', linea_id: 'l1', grupo: 'Guarniciones' }; return e;
};
const noModelo = async () => { throw Error('El catálogo resuelve este paso'); };
for (const mensaje of ['Frijolitos y papas con chorizo', 'Papas con chorizo y frijolitos', 'Frijolitos, papas con chorizo']) {
  const e = nuevo();
  const r = await atenderTurnoConHerramientas({ estado: e, catalogo, mensaje, llamarModelo: noModelo });
  assert.equal(r.escalado, false);
  assert.deepEqual(r.pedido.lineas[0].opciones.map(o => o.opcion), ['Papas con chorizo']);
  assert.equal(e.opcionesPendientes.length, 1);
  assert.deepEqual(e.opcionesPendientes[0].candidatos.sort(), ['Frijolitos con chorizo', 'Frijolitos naturales']);
  const recargado = JSON.parse(JSON.stringify(e));
  const listo = await atenderTurnoConHerramientas({ estado: recargado, catalogo, mensaje: 'Naturales', llamarModelo: noModelo });
  assert.deepEqual(listo.pedido.lineas[0].opciones.map(o => o.opcion).sort(), ['Frijolitos naturales', 'Papas con chorizo']);
}
const rechazo = await crearEjecutor({ estado: nuevo(), catalogo, mensaje: 'Frijolitos y papas con chorizo' }).ejecutar('modificar_linea', {
  linea_id: 'l1', opciones: [{ grupo: 'Guarniciones', opcion: 'Frijolitos con chorizo' }],
});
assert.equal(rechazo.aplicado, false, 'El modelo tampoco puede trasladar chorizo a los frijoles');
const explicitas = await atenderTurnoConHerramientas({ estado: nuevo(), catalogo,
  mensaje: 'Frijolitos con chorizo y papas con chorizo', llamarModelo: noModelo });
assert.deepEqual(explicitas.pedido.lineas[0].opciones.map(o => o.opcion).sort(), ['Frijolitos con chorizo', 'Papas con chorizo']);
assert.equal(palabrasQueLaSostienen('Miel y Mantequilla', 'Miel y mantequilla').size, 2);
for (const mensaje of ['Los quiero mixtos', 'Lo quiero sin azúcar', 'Que sean suizos', 'Ponlo grande', 'Quiero hacer un pedido']) {
  const e = nuevo(); marcarProgramacionRequerida(e, mensaje);
  assert.equal(e.programacionRequerida, false, mensaje);
}
const futuro = nuevo(); marcarProgramacionRequerida(futuro, 'Los quiero para mañana');
assert.equal(futuro.programacionRequerida, true);
console.log('OK alcance: atributos de cada guarnición y programación únicamente con intención temporal.');
