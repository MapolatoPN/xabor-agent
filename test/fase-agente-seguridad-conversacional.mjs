import assert from 'node:assert/strict';
import {
  esSolicitudDePedidoProgramado, respuestaAfirmaCambioSinAplicar,
  textoAfirmaCambioGuardado,
} from '../src/mesero-agente/seguridadConversacional.js';

// Conversación real de Tania: el primer mensaje futuro debe salir del agente
// antes de que pueda prometer una hora que no escribió en programado_para.
for (const texto of [
  'Si por favor sería para enviarlo mañana',
  'Hola quisiera pedir desayuno sorpresa para mañana',
  'Quiero apartar dos desayunos para el martes',
  'Prepara mi pedido para 23/09/2026',
  'Quiero pedir para el 25 de septiembre',
  'Quiero pedir dos waffles para el 25 sep',
  'Quiero pedir para 2026-09-25',
  'Necesito dos desayunos para el viernes',
  'Me das tacos para el viernes',
  'Me gustaría una charola para el viernes',
  'Quiero dos waffles este viernes a las 10',
  'Quiero dos waffles viernes a las 10',
  'Necesito desayuno este sábado',
  'Dos waffles para el viernes a las 10',
  '2 desayunos mañana a las 10',
  'Unos chilaquiles el sábado',
  'Chilaquiles para mañana',
  'Para mañana dos waffles',
  'Quiero pedir para el 25',
  'Dos waffles el 25',
  'Dos waffles el 25 a las 10',
  'Dos waffles 25/09',
  'Dos waffles el 25 de septiembre',
]) assert.equal(esSolicitudDePedidoProgramado(texto), true, texto);

for (const texto of [
  '¿Qué promociones hay mañana?',
  '¿Abren el martes?',
  '¿Qué promociones hay el 25 de septiembre?',
  'Quiero saber si abren el 25 sep',
  '¿Hay servicio el 2026-09-25?',
  '¿Tienen pedidos para el 25 de septiembre?',
  'No quiero pedir mañana',
  'Quiero 2-3 tacos',
  '¿Dónde entregan el 25 sep?',
  'Quiero 25 tacos',
  'Necesito 25 tacos',
  'Quiero un desayuno para hoy',
  'Quiero que me avisen el viernes',
  'Quiero cancelar mi pedido del viernes',
  'Necesito facturar el pedido del viernes',
  'Quiero reservar una mesa para el viernes a las 8',
]) assert.equal(esSolicitudDePedidoProgramado(texto), false, texto);
assert.equal(esSolicitudDePedidoProgramado('Mañana a las 10', { hayPedidoEnCurso: true }), true);
assert.equal(esSolicitudDePedidoProgramado('El 25 de septiembre a las 10', { hayPedidoEnCurso: true }), true);
assert.equal(esSolicitudDePedidoProgramado('El viernes a las 10', { hayPedidoEnCurso: true }), true);
assert.equal(esSolicitudDePedidoProgramado('Mañana por la tarde', { hayPedidoEnCurso: true }), true);
assert.equal(esSolicitudDePedidoProgramado('Viernes a las 10', { hayPedidoEnCurso: true }), true);
assert.equal(esSolicitudDePedidoProgramado('El 25 a las 10', { hayPedidoEnCurso: true }), true);
for (const [texto, esperado] of [
  ['Sí, el viernes a las 10', true],
  ['Ok, el viernes a las 10', true],
  ['Este viernes a las 10', true],
  ['El viernes que viene a las 10', true],
  ['Mejor el viernes a las 10', true],
  ['Sería el viernes a las 10', true],
  ['Déjalo para el viernes a las 10', true],
  ['A las 10 del viernes', true],
  ['¿Sería el viernes a las 10?', false],
  ['No, el viernes a las 10', false],
  ['¿A las 10 del viernes tienen servicio?', false],
]) {
  assert.equal(esSolicitudDePedidoProgramado(texto, { hayPedidoEnCurso: true }), esperado, texto);
}
assert.equal(esSolicitudDePedidoProgramado('¿Qué promociones hay mañana?', { hayPedidoEnCurso: true }), false);

assert.equal(textoAfirmaCambioGuardado('Va, apunto los chilaquiles suizos.'), true);
assert.equal(textoAfirmaCambioGuardado('Para las 10 anotamos la entrega.'), true);
assert.equal(textoAfirmaCambioGuardado('¡Listo, salsa suiza anotada!'), true);
assert.equal(textoAfirmaCambioGuardado('No lo registré porque falta la dirección.'), false);
assert.equal(textoAfirmaCambioGuardado('No quedó registrado.'), false);
assert.equal(textoAfirmaCambioGuardado('Tu pedido anterior quedó registrado.'), false,
  'una consulta de estado anterior se confundió con una mutación nueva');

assert.equal(respuestaAfirmaCambioSinAplicar({
  texto: 'Va, apunto los chilaquiles suizos.', operaciones: [],
}), true, 'permitió afirmar un producto sin agregar_producto');

assert.equal(respuestaAfirmaCambioSinAplicar({
  texto: 'Perfecto, ya lo registré.',
  operaciones: [{ herramienta: 'agregar_producto', resultado: { aplicado: false } }],
}), true, 'un rechazo de herramienta contó como cambio guardado');

assert.equal(respuestaAfirmaCambioSinAplicar({
  texto: '¡Listo, salsa suiza anotada!',
  operaciones: [{ herramienta: 'modificar_linea', resultado: { aplicado: true } }],
}), false, 'bloqueó una afirmación respaldada por una herramienta aplicada');

assert.equal(respuestaAfirmaCambioSinAplicar({
  texto: 'Tenemos Desayuno Sorpresa por $345. ¿Te lo preparo?', operaciones: [],
}), false, 'una consulta de carta se confundió con una mutación');

console.log('Seguridad conversacional: programados y afirmaciones sin guardar protegidos.');
