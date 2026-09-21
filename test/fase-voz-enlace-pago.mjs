import assert from 'node:assert/strict';
import { esPagoPorEnlace } from '../src/orders/pagoPorEnlace.js';
import { readFileSync } from 'node:fs';

for (const valor of ['enlace de pago', 'enlace_pago', 'link de pago', ' ENLACE DE PAGO ']) {
  assert.equal(esPagoPorEnlace(valor), true, `${valor} debe crear un pedido pendiente de pago`);
}
for (const valor of ['efectivo', 'terminal', 'transferencia', '', null]) {
  assert.equal(esPagoPorEnlace(valor), false, `${valor} no debe activar el gate de enlace`);
}

const voz = readFileSync(new URL('../src/channels/voice.js', import.meta.url), 'utf8');
const posFlag = voz.indexOf('requierePagoAnticipado = true');
const posRegistro = voz.indexOf('registrarPedido(resultado.orden', posFlag);
assert.ok(posFlag >= 0 && posRegistro > posFlag, 'la voz debe fijar el gate antes de registrar');
assert.match(voz, /pedido\.forma_pago === 'enlace_pago'/, 'la respuesta de voz debe aceptar la forma canónica');

console.log('Voz enlace de pago: 7 invariantes pasadas, 0 fallidas.');
