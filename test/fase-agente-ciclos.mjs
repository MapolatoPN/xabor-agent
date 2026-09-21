import assert from 'node:assert/strict';
import { estadoNuevo } from '../src/mesero-agente/ejecutorDeHerramientas.js';
import { cicloParaTurno } from '../src/mesero-agente/cicloDelAgente.js';

const estado = estadoNuevo({ negocioId: 'n1', conversacionId: 'agente:528781234567' });
assert.equal(cicloParaTurno(estado, 'quiero hacer otro pedido'), estado,
  'un pedido en curso no debe perder su carrito');

estado.hechos.confirmado = true;
estado.folio = 'XAB-9001';
assert.equal(cicloParaTurno(estado, '¿dónde va mi pedido?'), estado,
  'preguntar por el pedido confirmado no abre otro ciclo');

const nuevo = cicloParaTurno(estado, 'Hola, quiero hacer otro pedido');
assert.notEqual(nuevo, estado);
assert.equal(nuevo.conversacionId, 'agente:528781234567:c1');
assert.equal(nuevo.hechos.confirmado, false);
assert.deepEqual(nuevo.carrito.items, []);
assert.equal(estado.folio, 'XAB-9001', 'el ciclo anterior no debe mutarse');

const nuevoPorVerbo = cicloParaTurno(estado, 'Quiero ordenar unos chilaquiles suizos');
assert.notEqual(nuevoPorVerbo, estado, '«quiero ordenar» dejó vivo el pedido confirmado');
assert.equal(nuevoPorVerbo.conversacionId, 'agente:528781234567:c1');
assert.deepEqual(nuevoPorVerbo.carrito.items, []);

nuevo.hechos.confirmado = true;
const tercero = cicloParaTurno(nuevo, 'Quisiera pedir de nuevo');
assert.equal(tercero.conversacionId, 'agente:528781234567:c2');

tercero.hechos.escalado = true;
tercero.confirmacionIncierta = true;
assert.equal(cicloParaTurno(tercero, 'quiero otro pedido'), tercero,
  'una confirmación incierta no permite otro ciclo hasta la conciliación');

console.log('Ciclos del agente: consultas conservan el pedido; una nueva orden usa identidad nueva.');
