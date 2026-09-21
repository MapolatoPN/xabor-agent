import assert from 'node:assert/strict';
import {
  confirmarYEmitir, ordenDesdeElCarrito, aplicarRespuestaDePago,
  aplicarRespuestaDeEntrega,
} from '../src/mesero-agente/canalDelAgente.js';
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

const estadoEnlace = estadoNuevo({ negocioId: 'negocio-prueba', conversacionId: 'conversacion-enlace' });
estadoEnlace.carrito.datos.forma_pago = 'enlace_pago';
const eventosEnlace = [];
const conEnlace = await confirmarYEmitir({
  ...args,
  estado: estadoEnlace,
  registrar: async () => { eventosEnlace.push('registrar'); return { id: 'XAB-9002' }; },
  emitir: async () => { eventosEnlace.push('emitir'); },
  guardar: async () => { eventosEnlace.push('guardar'); },
  crearPago: async ({ negocioId, pedidoId }) => {
    eventosEnlace.push('crearPago');
    assert.equal(negocioId, 'negocio-prueba');
    assert.equal(pedidoId, 'XAB-9002', 'intentó cobrar antes de tener folio');
    return { url: 'https://sandbox.clip.mx/pago-seguro', estado: 'pendiente', reutilizado: false };
  },
});
await new Promise((resolve) => setImmediate(resolve));
assert.equal(conEnlace.ok, true);
assert.equal(conEnlace.enlacePago.url, 'https://sandbox.clip.mx/pago-seguro');
assert.equal(eventosEnlace[0], 'registrar', 'se intentó crear el enlace antes de persistir el pedido');
assert.equal(eventosEnlace.filter((e) => e === 'crearPago').length, 1);

const enlaceFallido = await confirmarYEmitir({
  ...args,
  estado: estadoEnlace,
  registrar: async () => ({ id: 'XAB-9003' }),
  emitir: async () => {},
  guardar: async () => {},
  crearPago: async () => { throw Object.assign(new Error('timeout simulado'), { code: 'ETIMEDOUT' }); },
});
assert.equal(enlaceFallido.ok, true, 'el pedido ya registrado no puede fingirse rechazado si Clip falla');
assert.equal(enlaceFallido.folio, 'XAB-9003');
assert.equal(enlaceFallido.enlacePagoError.codigo, 'ETIMEDOUT');

const estadoRespuesta = estadoNuevo({ negocioId: 'negocio-prueba', conversacionId: 'respuesta-pago' });
const rechazoTransferencia = aplicarRespuestaDePago({
  estado: estadoRespuesta,
  metodosPago: [{ tipo: 'efectivo' }, { tipo: 'enlace_pago' }],
  salida: {
    texto: 'texto libre incorrecto', operaciones: [{ herramienta: 'definir_pago', resultado: {
      aplicado: false, codigo: 'forma_pago_no_disponible', metodo_solicitado: 'transferencia',
    } }],
  },
});
assert.match(rechazoTransferencia.texto, /No contamos con pagos por transferencia/);
assert.match(rechazoTransferencia.texto, /similar a pagar con transferencia/);
assert.equal(estadoRespuesta.pagoOfrecido, 'enlace_pago');

const estadoViejo = estadoNuevo({ negocioId: 'negocio-prueba', conversacionId: 'respuesta-vieja' });
const respuestaEstadoViejo = aplicarRespuestaDePago({
  estado: estadoViejo, pagoDescartado: 'transferencia',
  metodosPago: [{ tipo: 'efectivo' }, { tipo: 'enlace_pago' }],
  salida: { texto: 'respuesta libre', operaciones: [] },
});
assert.match(respuestaEstadoViejo.texto, /No contamos con pagos por transferencia/,
  'un carrito persistido antes del arreglo debe recibir la misma política');
assert.equal(estadoViejo.pagoOfrecido, 'enlace_pago');

const rechazoComerAqui = aplicarRespuestaDeEntrega({
  modalidades: ['recoger en tienda', 'entrega a domicilio'],
  salida: {
    texto: 'respuesta libre incorrecta', operaciones: [{ herramienta: 'definir_entrega', resultado: {
      aplicado: false, codigo: 'modalidad_no_disponible', modalidad_solicitada: 'consumo_sitio',
    } }],
  },
});
assert.equal(rechazoComerAqui.texto,
  'No contamos con servicio para comer aquí. Podemos preparar tu pedido para recoger o enviarlo a domicilio. ¿Cuál prefieres?');

const respuestaConLink = aplicarRespuestaDePago({
  estado: estadoRespuesta,
  salida: { texto: 'Tu pedido quedó confirmado.', operaciones: [{ herramienta: 'confirmar_pedido',
    resultado: { aplicado: true, folio: 'XAB-9004', enlace_pago: 'https://sandbox.clip.mx/unico' } }] },
});
assert.match(respuestaConLink.texto, /Paga aquí con el enlace seguro/);
assert.equal((respuestaConLink.texto.match(/https:\/\/sandbox\.clip\.mx\/unico/g) || []).length, 1,
  'la URL de Clip debe enviarse exactamente una vez');

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
