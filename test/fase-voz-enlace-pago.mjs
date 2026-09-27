// Nació para la voz; el canal de voz se retiró el 27-sep-2026 y su parte
// (voice.js fijaba el gate antes de registrar) se fue con él. Queda lo que
// sigue vivo: `esPagoPorEnlace` decide en el Mesero de WhatsApp
// (canalDelAgente.js) si un pedido nace pendiente de pago por enlace.
import assert from 'node:assert/strict';
import { esPagoPorEnlace } from '../src/orders/pagoPorEnlace.js';

for (const valor of ['enlace de pago', 'enlace_pago', 'link de pago', ' ENLACE DE PAGO ']) {
  assert.equal(esPagoPorEnlace(valor), true, `${valor} debe crear un pedido pendiente de pago`);
}
for (const valor of ['efectivo', 'terminal', 'transferencia', '', null]) {
  assert.equal(esPagoPorEnlace(valor), false, `${valor} no debe activar el gate de enlace`);
}

console.log('Enlace de pago: 9 invariantes pasadas, 0 fallidas.');
