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
]) assert.equal(esSolicitudDePedidoProgramado(texto), true, texto);

for (const texto of [
  '¿Qué promociones hay mañana?',
  '¿Abren el martes?',
  'Quiero un desayuno para hoy',
]) assert.equal(esSolicitudDePedidoProgramado(texto), false, texto);
assert.equal(esSolicitudDePedidoProgramado('Mañana a las 10', { hayPedidoEnCurso: true }), true);
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
