import { resumenEnviadoParaPrueba } from './fixture-dialogo.mjs';
import assert from 'node:assert/strict';
import { atenderTurnoConHerramientas } from '../src/mesero-agente/agenteDelMesero.js';
import { estadoNuevo, estadoSerializable, crearEjecutor } from '../src/mesero-agente/ejecutorDeHerramientas.js';
import { cicloParaTurno } from '../src/mesero-agente/cicloDelAgente.js';
import { pedidoEnTexto } from '../src/mesero-agente/instrucciones.js';

// Datos sintéticos, sin DB, proveedor ni efectos externos. Reproduce 25-sep.
const catalogo = [{ nombre: 'Desayunos', productos: [{
  id: 85, nombre: 'Chilaquiles Sencillos', precio: 195, disponible: true,
  modificadores: [{ nombre: 'Guarniciones', requerido: true, minimo: 1, maximo: 2,
    opciones: ['Frijolitos naturales', 'Frijolitos con chorizo',
      'Papas a la mexicana', 'Papas con chorizo'].map((nombre) => ({ nombre, disponible: true })) }],
}] }];
const nuevo = () => {
  const e = estadoNuevo({ negocioId: 'prueba', conversacionId: 'incidente' });
  e.carrito.items = [{ id: 85, lid: 'l1', nombre: 'Chilaquiles Sencillos', cantidad: 1,
    modificadores: [], notas: '' }];
  return e;
};
let turnoId = 0;
const turno = (estado, mensaje) => atenderTurnoConHerramientas({
  negocioId: estado.negocioId, conversacionId: estado.conversacionId,
  turnoId: `regresion-${++turnoId}`, estado, mensaje, catalogo,
  modalidades: ['recoger en tienda', 'entrega a domicilio'],
  llamarModelo: async () => { throw new Error('Esta continuación no requiere al modelo'); },
});
let estado = nuevo();
let salida = await turno(estado, 'Frijolitos y papas a la mexicana');
assert.equal(salida.llamadasAlModelo, 0);
assert.deepEqual(salida.pedido.lineas[0].opciones, [{ grupo: 'Guarniciones', opcion: 'Papas a la mexicana' }]);
assert.equal(salida.pedido.estado, 'aclarando');
assert.equal(salida.pedido.resumen.completo, false);
assert.match(salida.texto, /Frijolitos naturales.*Frijolitos con chorizo/);
assert.doesNotMatch(salida.texto, /dirección|recoger/);
assert.match(pedidoEnTexto(salida.pedido), /Elección pendiente.*Frijolitos naturales/);

// Ni un reinicio ni el mínimo satisfecho deben eliminar la segunda elección.
estado = estadoSerializable(estado);
estado.carrito.datos = { modalidad: 'recoger en tienda', forma_pago: 'efectivo' };
let efectos = 0;
const ejecutor = crearEjecutor({ estado, catalogo, mensaje: 'sí',
  efectos: { confirmar: async () => { efectos += 1; } } });
assert.equal(ejecutor.vista().estado, 'aclarando');
const confirmacion = await ejecutor.ejecutar('confirmar_pedido', { huella_resumen: ejecutor.vista().huella });
assert.equal(confirmacion.aplicado, false);
assert.equal(efectos, 0);
estado.carrito.datos = {};
salida = await turno(estado, 'Naturales');
assert.equal(salida.pedido.aclaraciones.length, 0);
assert.deepEqual(salida.pedido.lineas[0].opciones.map((o) => o.opcion).sort(),
  ['Frijolitos naturales', 'Papas a la mexicana'].sort());
assert.match(salida.texto, /recoger.*domicilio/);
assert.deepEqual(estado.opcionesPendientes, []);
const entrega = crearEjecutor({ estado, catalogo, mensaje: 'Paso a recoger' });
assert.equal((await entrega.ejecutar('definir_entrega', { modalidad: 'recoger en tienda' })).aplicado, true);
const pago = crearEjecutor({ estado, catalogo, mensaje: 'Efectivo' });
assert.equal((await pago.ejecutar('definir_pago', { forma_pago: 'efectivo' })).aplicado, true);
const cierre = crearEjecutor({ estado, catalogo, mensaje: 'Sí, confirmo',
  efectos: { confirmar: async ({ pedido }) => {
    efectos += 1;
    assert.equal(pedido.total, 195);
    assert.equal(pedido.lineas[0].opciones.length, 2);
    return { ok: true, folio: 'PRUEBA-SIN-EFECTOS' };
  } } });
resumenEnviadoParaPrueba(estado, cierre.vista());
assert.equal((await cierre.ejecutar('confirmar_pedido', { huella_resumen: cierre.vista().huella })).aplicado, true);
assert.equal(efectos, 1);

// Dos ambigüedades independientes sobreviven hasta resolver ambas.
const dobles = nuevo();
salida = await turno(dobles, 'Frijolitos y papas');
assert.equal(dobles.opcionesPendientes.length, 2);
assert.equal(salida.pedido.aclaraciones.length, 2);
const ambasEnUnTurno = estadoSerializable(dobles);
salida = await turno(ambasEnUnTurno, 'Frijolitos naturales y papas a la mexicana');
assert.equal(salida.pedido.lineas[0].opciones.length, 2);
assert.equal(salida.pedido.aclaraciones.length, 0);
salida = await turno(dobles, 'Papas a la mexicana');
assert.equal(salida.pedido.aclaraciones.length, 1);
assert.match(salida.texto, /Frijolitos naturales.*Frijolitos con chorizo/);
salida = await turno(dobles, 'Con chorizo');
assert.deepEqual(salida.pedido.lineas[0].opciones.map((o) => o.opcion).sort(),
  ['Frijolitos con chorizo', 'Papas a la mexicana'].sort());
assert.equal(salida.pedido.aclaraciones.length, 0);

// Retirar explícitamente la elección pendiente no retira la ya guardada.
const retiro = nuevo();
await turno(retiro, 'Frijolitos y papas a la mexicana');
salida = await turno(retiro, 'Sin frijoles');
assert.equal(salida.pedido.aclaraciones.length, 0);
assert.deepEqual(salida.pedido.lineas[0].opciones, [{ grupo: 'Guarniciones', opcion: 'Papas a la mexicana' }]);
assert.match(salida.texto, /recoger.*domicilio/);

// Una petición de dos opciones exactas sigue resolviéndose en un solo turno.
const exactas = nuevo();
salida = await turno(exactas, 'Frijolitos naturales y papas a la mexicana');
assert.equal(salida.pedido.lineas[0].opciones.length, 2);
assert.equal(salida.pedido.aclaraciones.length, 0);

const ahora = new Date('2026-09-25T14:00:00Z');
const antiguo = nuevo();
antiguo._actualizadoAt = '2026-09-24T20:00:00Z';
antiguo.carrito.datos = { modalidad: 'entrega a domicilio', forma_pago: 'efectivo' };
antiguo.programacionRequerida = true;
antiguo.opcionesPendientes = [{ lid: 'l1', grupo: 'Guarniciones', candidatos: ['Frijolitos naturales'] }];
const limpio = cicloParaTurno(antiguo, 'Hola', { ahora });
assert.notEqual(limpio.conversacionId, antiguo.conversacionId);
assert.deepEqual(limpio.carrito, { items: [], datos: {} });
assert.equal(limpio.programacionRequerida, false);
assert.equal(limpio.opcionesPendientes?.length || 0, 0);
assert.equal(antiguo.carrito.datos.modalidad, 'entrega a domicilio');
for (const protegido of [
  { ...antiguo, _actualizadoAt: '2026-09-25T13:59:00Z' },
  { ...antiguo, _actualizadoAt: null },
  { ...antiguo, _inactividadMs: 60_000 },
  { ...antiguo, confirmacionIncierta: true },
  { ...antiguo, folio: 'PEDIDO-REGISTRADO' },
  { ...antiguo, evento: { tipo: 'catering' } },
]) assert.equal(cicloParaTurno(protegido, 'Hola', { ahora }), protegido);
assert.notEqual(cicloParaTurno({ ...antiguo, _actualizadoAt: ahora.toISOString(),
  _inactividadMs: 24 * 3600_000 }, 'Hola', { ahora }).conversacionId, antiguo.conversacionId);
console.log('OK: guarnición parcial durable, confirmación bloqueada, aclaración y ciclo nuevo sin modalidad heredada.');
