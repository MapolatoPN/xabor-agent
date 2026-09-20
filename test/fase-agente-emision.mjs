import assert from 'node:assert/strict';
import { confirmarYEmitir, ordenDesdeElCarrito } from '../src/mesero-agente/canalDelAgente.js';
import { estadoNuevo } from '../src/mesero-agente/ejecutorDeHerramientas.js';

const estado = estadoNuevo({ negocioId: 'negocio-prueba', conversacionId: 'conversacion-prueba' });
const pedidoRegistrado = { id: 'XAB-9001', negocioId: 'negocio-prueba', estado: 'nuevo' };
assert.equal(ordenDesdeElCarrito({ negocioId: 'negocio-prueba', carrito: estado.carrito,
  telefono: '528781234567', nombre: 'Prueba' }).telefono_conversacion, '528781234567');
let registros = 0;
let emisiones = 0;
let emitido = null;
let historicos = 0;

const args = {
  negocioId: 'negocio-prueba', telefono: '528781234567', nombre: 'Prueba',
  canal: 'whatsapp', estado, pedido: { total: 100 },
  registrar: async () => { registros += 1; return pedidoRegistrado; },
  emitir: async (pedido) => { emisiones += 1; emitido = pedido; },
  guardar: async (telefono, pedido, negocioId) => {
    assert.equal(telefono, '528781234567');
    assert.equal(pedido, pedidoRegistrado);
    assert.equal(negocioId, 'negocio-prueba');
    historicos += 1;
  },
};

const registrado = await confirmarYEmitir(args);
await new Promise((resolve) => setImmediate(resolve));
assert.equal(registrado.ok, true);
assert.equal(registrado.folio, 'XAB-9001');
assert.equal(registros, 1);
assert.equal(emisiones, 1, 'el pedido no llegó a la ruta operacional existente');
assert.equal(emitido, pedidoRegistrado);
assert.equal(historicos, 1, 'el pedido no se guardó en el historial del cliente');

const emisionFallida = await confirmarYEmitir({ ...args,
  emitir: async () => { throw new Error('impresora no disponible'); } });
await new Promise((resolve) => setImmediate(resolve));
assert.equal(emisionFallida.ok, true, 'un pedido ya registrado no puede volver al bot viejo por una falla de emisión');

const rechazado = await confirmarYEmitir({ ...args,
  registrar: async () => { const e = new Error('pedido rechazado'); e.codigo = 'ORDEN_INVALIDA'; throw e; } });
await new Promise((resolve) => setImmediate(resolve));
assert.equal(rechazado.ok, false);
assert.equal(emisiones, 1, 'se emitió un pedido que nunca se registró');
assert.equal(historicos, 2, 'se historizó un pedido que nunca se registró');

await assert.rejects(() => confirmarYEmitir({ ...args,
  registrar: async () => { throw new Error('respuesta perdida tras el COMMIT'); } }),
  /respuesta perdida/, 'un resultado incierto no debe degradarse a rechazo seguro');

console.log('Emisión del agente: pedido registrado llega una vez a la ruta operacional; rechazo no emite.');
