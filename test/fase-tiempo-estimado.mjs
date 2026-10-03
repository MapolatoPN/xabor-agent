// Tiempo estimado al confirmar y al preguntar por el pedido (3-oct-2026).
// Sin base de datos: las respuestas se arman desde las reglas del negocio.
import assert from 'node:assert/strict';
import { estadoNuevo } from '../src/mesero-agente/ejecutorDeHerramientas.js';
import { aplicarRespuestaDeConfirmacion, aplicarRespuestaDePago } from '../src/mesero-agente/canalDelAgente.js';
import { respuestaOperativaVerificada } from '../src/mesero-agente/estadoOperativoDelPedido.js';
import { reglasDelAsistenteEnTexto } from '../src/mesero-agente/reglasDelAsistente.js';
import { fraseTiempoEstimado, rangoEnMinutos } from '../src/mesero-agente/tiempoEstimado.js';
import { atenderTurnoConHerramientas } from '../src/mesero-agente/agenteDelMesero.js';

const reglas = { pedidos: { tiempo_entrega_min_minutos: 45, tiempo_entrega_max_minutos: 45, tiempo_preparacion_minutos: 25 } };
let ok = 0;
const t = async (nombre, fn) => { await fn(); ok++; console.log('OK', nombre); };

const confirmar = (datos, resultado = {}) => {
  const estado = estadoNuevo({ negocioId: 'n', conversacionId: 'c' });
  estado.carrito.datos = datos;
  const salida = { texto: 'x', operaciones: [{ herramienta: 'confirmar_pedido',
    resultado: { aplicado: true, folio: 'XAB-9001', total: 265, costo_envio: 60, ...resultado } }] };
  aplicarRespuestaDeConfirmacion({ salida, estado, reglas });
  aplicarRespuestaDePago({ salida, estado, reglas });
  return salida.texto;
};

await t('T1 rango: igual, distinto, inválido', () => {
  assert.equal(rangoEnMinutos(45, 45), 'unos 45 minutos');
  assert.equal(rangoEnMinutos(45, 0), 'unos 45 minutos');
  assert.equal(rangoEnMinutos(46, 55), 'de 46 a 55 minutos');
  assert.equal(rangoEnMinutos(0, 55), null);
  assert.equal(rangoEnMinutos(null, null), null);
  assert.equal(fraseTiempoEstimado(null, 'entrega a domicilio'), null);
});

await t('T2 confirmación a domicilio en efectivo trae el tiempo', () => {
  const texto = confirmar({ modalidad: 'entrega a domicilio', forma_pago: 'efectivo', cliente: { direccion: 'Sierra 119' } });
  assert.match(texto, /XAB-9001/);
  assert.match(texto, /Pago en efectivo\. Tiempo estimado de entrega: unos 45 minutos\.$/);
});

await t('T3 confirmación con enlace: el tiempo cuenta desde el pago y el enlace sigue', () => {
  const texto = confirmar({ modalidad: 'entrega a domicilio', forma_pago: 'enlace_pago', cliente: { direccion: 'Rio 230' } },
    { enlace_pago: 'https://pago.example/abc' });
  assert.match(texto, /Tiempo estimado de entrega: unos 45 minutos después de recibir tu pago\./);
  assert.match(texto, /Paga aquí con el enlace seguro:\nhttps:\/\/pago\.example\/abc$/);
});

await t('T4 recoger usa el tiempo de preparación', () => {
  const texto = confirmar({ modalidad: 'recoger en tienda', forma_pago: 'terminal' });
  assert.match(texto, /Estará listo para recoger en unos 25 minutos\.$/);
});

await t('T5 un programado no promete tiempo de hoy', () => {
  const texto = confirmar({ modalidad: 'entrega a domicilio', forma_pago: 'efectivo', programado_para: '2026-10-05T15:00:00.000Z',
    cliente: { direccion: 'Sierra 119' } }, { programado_para: '2026-10-05T15:00:00.000Z' });
  assert.doesNotMatch(texto, /Tiempo estimado/);
});

await t('T6 estado del pedido: tiempo mientras se prepara, sin la frase del pago', () => {
  const estado = estadoNuevo({ negocioId: 'n', conversacionId: 'c' });
  estado.hechos.confirmado = true; estado.folio = 'XAB-9001';
  const actual = (e) => ({ folio: 'XAB-9001', estado: e, modalidad: 'entrega a domicilio' });
  const nuevo = respuestaOperativaVerificada(estado, actual('nuevo'), reglas);
  assert.match(nuevo, /recibido, en espera de preparación\. Tiempo estimado de entrega: unos 45 minutos, contando desde tu pedido\./);
  assert.doesNotMatch(nuevo, /acredita/);
  assert.match(respuestaOperativaVerificada(estado, actual('en_preparacion'), reglas), /unos 45 minutos/);
  assert.doesNotMatch(respuestaOperativaVerificada(estado, actual('listo'), reglas), /minutos/);
  assert.doesNotMatch(respuestaOperativaVerificada(estado, actual('nuevo')), /minutos/);
});

await t('T7 instrucciones del asistente: «unos 45 minutos», no «45 a 45»', () => {
  assert.match(reglasDelAsistenteEnTexto(reglas), /Tiempo estimado de entrega: unos 45 minutos\./);
  assert.doesNotMatch(reglasDelAsistenteEnTexto(reglas), /45 a 45/);
  assert.match(reglasDelAsistenteEnTexto({ pedidos: { tiempo_entrega_min_minutos: 46, tiempo_entrega_max_minutos: 55 } }),
    /Tiempo estimado de entrega: de 46 a 55 minutos\./);
});

await t('T8 el turno del agente responde el estado con el tiempo del negocio', async () => {
  const estado = estadoNuevo({ negocioId: 'n', conversacionId: 'c' });
  estado.hechos.confirmado = true; estado.folio = 'XAB-9001';
  const r = await atenderTurnoConHerramientas({ estado, mensaje: '¿En cuánto tiempo llega?', catalogo: [], reglas,
    contexto: { resolverEstadoOperativo: async () => ({ folio: 'XAB-9001', estado: 'nuevo', modalidad: 'entrega a domicilio' }) },
    llamarModelo: async () => ({ content: [{ type: 'text', text: 'Llega en 5 minutos.' }], stop_reason: 'end_turn' }) });
  assert.match(r.texto, /unos 45 minutos, contando desde tu pedido/);
  assert.doesNotMatch(r.texto, /Llega en 5 minutos/);
});

console.log(`fase-tiempo-estimado: ${ok}/8`);
