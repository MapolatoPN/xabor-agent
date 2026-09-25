// Regresiones productivas del 21-sep que Railway ejecuta ANTES de desplegar.
// Este archivo vive en scripts/ porque .dockerignore excluye test/ y la
// barrera tiene que existir dentro de la imagen, no solo en el checkout local.
import assert from 'node:assert/strict';
import './check-guarniciones-ciclo.mjs';
import './check-recuperacion-turno.mjs';
import './check-presupuesto-turno.mjs';
import './check-cardinalidad-canario.mjs';
import './check-contrato-turno.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { libroDeOperaciones, almacenEnMemoria } from '../src/mesero-agente/libroDeOperaciones.js';
import { cicloParaTurno } from '../src/mesero-agente/cicloDelAgente.js';
import { pedidoActivoDesdeFila } from '../src/orders/proyeccionPedidoActivo.js';
import { puedeProcesarTurno } from '../src/orders/modoDelPedido.js';
import {
  crearEjecutor, estadoNuevo, estadoSerializable,
} from '../src/mesero-agente/ejecutorDeHerramientas.js';
import { vistaDelPedido } from '../src/mesero-agente/vistaDelPedido.js';
import {
  aplicarRespuestaDeConfirmacion, aplicarSalidaSeguraDeCatering, confirmarYEmitir,
  consumirCancelacionCatering, marcarProgramacionRequerida, prepararEstadoCatering,
  resultadoDelCanalAgente, TEXTO_CATERING_CANCELADO,
} from '../src/mesero-agente/canalDelAgente.js';
import { atenderTurnoConHerramientas, CIERRE } from '../src/mesero-agente/agenteDelMesero.js';
import {
  diagnosticarRespuestaTruncada, RespuestaModeloTruncadaError, textoCompletoDeRespuesta,
} from '../src/agent/respuestaTruncada.js';
import {
  detectarSalidaInterna, exigirSalidaPublicable,
} from '../src/mesero-agente/salidaPublicable.js';
import {
  autorizaProgramarParaDesdeMensaje, esConsultaDePosibilidadDePedido,
  esSolicitudDePedidoProgramado, fechasExactasDePedido, horasExactasDePedido,
  respuestaAfirmaCambioSinAplicar,
} from '../src/mesero-agente/seguridadConversacional.js';
import { esPagoPorEnlace } from '../src/orders/pagoPorEnlace.js';
import {
  MENSAJE_CATERING_ENTREGADO, decidirSalidaCatering, esSolicitudCatering,
  motivoRespuestaCateringProhibida,
} from '../src/agent/catering.js';
import { camposObligatoriosCompletos } from '../src/agent/comercialMarkers.js';
import { filtrarDatosEventoCatering } from '../src/agent/evidenciaCatering.js';
import { construirBloqueModoComercial, obtenerEstadoRestaurante } from '../src/agent/prompts.js';
import { mensajePideMenu } from '../src/services/menuAutomatico.js';
import { construirAvisoFueraDeHorario } from '../src/mesero-agente/horarioDelAgente.js';
import { resolverPedidoCobrablePorFolio } from '../src/channels/pagoFolioSeguro.js';
import {
  reglasDelAsistenteEnTexto, respuestaProhibidaEncontrada,
} from '../src/mesero-agente/reglasDelAsistente.js';
import {
  solicitaAtencionHumana, payloadsSolicitanAtencionHumana,
} from '../src/utils/solicitudPersona.js';

const RAIZ = fileURLToPath(new URL('..', import.meta.url));

// El interruptor que usa el negocio en el panel es el corte maestro. El
// agente nuevo no puede saltárselo aunque su propia bandera y alcance sigan
// encendidos por error.
assert.equal(puedeProcesarTurno({ botGlobalActivo: false, agenteCanario: true }), false,
  'apagar el bot visible dejó al agente nuevo respondiendo');
assert.equal(puedeProcesarTurno({ botGlobalActivo: true, agenteCanario: true }), true);
for (const solicitud of [
  '¿Me puedes pasar con una persona?', 'Necesito un humano',
  'Quiero atención de una persona', 'Quiero hablar con alguien',
  'Pásame con alguien del equipo', 'Ya no quiero hablar con el bot, quiero una persona',
  '¿Podría hablar con un asesor?', 'Me pasas con un asesor',
  'Me comunicas con alguien?', 'Hablar con una persona', 'Atención humana',
]) assert.equal(solicitaAtencionHumana(solicitud), true,
  `una solicitud explícita de persona no llegó al handoff durable: ${solicitud}`);
for (const negativa of [
  'No quiero un humano', 'Una persona quiere catering', 'pedido para una persona',
]) assert.equal(solicitaAtencionHumana(negativa), false,
  `una mención no dirigida pidió handoff: ${negativa}`);
assert.equal(payloadsSolicitanAtencionHumana([{
  message: { type: 'image', image: { caption: 'Quiero hablar con una persona' } },
}]), true, 'una solicitud humana en caption de imagen se perdió antes de los cortes del bot');
assert.equal(payloadsSolicitanAtencionHumana([{
  message: { type: 'document', document: { caption: 'Foto del comprobante' } },
}]), false, 'un caption documental normal activó handoff');

// Conversación del 23-sep terminada en 9919: el proveedor agotó tokens y el
// texto visible incluyó un ORDEN_PREVIEW JSON a medias. La metadata manda aun
// si no hay marcador, y tanto un bloque abierto como uno cerrado son carga
// interna que el CANARIO jamás puede publicar.
const textoIncidenteTruncado = 'Grande\n<ORDEN_PREVIEW>{"items":[{"nombre":"Waffle"}],"total":660,';
assert.deepEqual(
  diagnosticarRespuestaTruncada({ stop_reason: 'max_tokens' }, textoIncidenteTruncado),
  { truncada: true, motivo: 'max_tokens', marcador: 'ORDEN_PREVIEW' },
  'max_tokens dejó de invalidar la respuesta que filtró el JSON interno');
assert.equal(
  diagnosticarRespuestaTruncada({ stop_reason: 'max_tokens' }, 'Tu pedido está casi listo').truncada,
  true, 'max_tokens sin marcador dejó de fallar cerrado');
assert.equal(
  diagnosticarRespuestaTruncada(
    { stop_reason: 'model_context_window_exceeded' }, 'Tu pedido está casi listo',
  ).truncada,
  true, 'model_context_window_exceeded dejó de fallar cerrado');
assert.throws(
  () => textoCompletoDeRespuesta({
    stop_reason: 'max_tokens', content: [{ type: 'text', text: textoIncidenteTruncado }],
  }),
  (error) => error instanceof RespuestaModeloTruncadaError
    && error.codigo === 'RESPUESTA_MODELO_TRUNCADA',
  'el consumidor pudo leer texto antes de validar stop_reason');
for (const fuga of [
  '<ORDEN_PREVIEW>{"total":660}</ORDEN_PREVIEW>',
  'ORDEN_PREVIEW {"total":660}',
  '{"type":"tool_use","name":"confirmar_pedido"}',
  '{"producto_id":"42","cantidad":2,"opciones":[]}',
  '{}',
  '{"texto":"waffle"}',
  '{"tipo_servicio":"catering","personas":50}',
  'Aquí va:\n```json\n{"texto":"waffle"}\n```',
  'Primero {"texto":"normal"}; luego {"linea_id":"l1"}',
  'Claro. {"producto_id":"secret-123"',
  'Claro. {"texto":"waffle"',
  'Resultado: {“total”: 660, “items”: []}',
  '{“texto”: “waffle”}',
  'Entrada: {‘fecha’: ‘2026-09-25’, ‘hora’: ‘11:00’}',
  'Aquí va:\n```json\n{"texto":"waffle"',
  'No pude registrar: TENANT_CONTEXT_REQUIRED.',
  'No pude registrar: TENANT\\_CONTEXT\\_REQUIRED.',
  'TenantContextRequiredError: negocioId requerido.',
  'Más detalle: https://x.invalid/TENANT_CONTEXT_REQUIRED',
  'Falló el cupón TENANT_CONTEXT_REQUIRED.',
  'El código promocional es TENANT_CONTEXT_REQUIRED.',
  'No pude completar la acción. aplicado: false; estado: rechazada.',
  '| aplicado | false |\n| estado | rechazada |',
  '<aplicado>false</aplicado><estado>rechazada</estado>',
  'Resultado: {“aplicado”: false, “estado”: “rechazada”}',
  'Aplicado: no. Estado: rechazada.',
  'Aplicado: sí. Estado: ok.',
  'aplicado: falso; estado: rechazada',
  'aplicado = 0; estado = error',
  'Motivo no_se_pudo_registrar: desconocido.',
  'El motivo fue producto_id_inexistente.',
]) assert.ok(detectarSalidaInterna(fuga), `el cortafuegos no reconoció: ${fuga}`);
assert.equal(detectarSalidaInterna('Tu descuento aplicado: $50'), null,
  'el cortafuegos bloqueó prosa normal por la palabra aplicado');
assert.equal(detectarSalidaInterna('Usa {sin cebolla}'), null,
  'el cortafuegos confundió una indicación humana entre llaves con JSON');
assert.equal(detectarSalidaInterna('El costo usa {subtotal} como referencia.'), null,
  'el cortafuegos confundió un marcador de prosa sin dos puntos con JSON');
assert.equal(detectarSalidaInterna('Usa {“sin cebolla”} y dímelo.'), null,
  'el cortafuegos confundió prosa entre comillas tipográficas con JSON');
assert.equal(detectarSalidaInterna('Escríbeme a mario_lopez@example.com.'), null,
  'el cortafuegos confundió un correo público con un código interno');
assert.equal(detectarSalidaInterna('Usa el cupón PROMO_2X1.'), null,
  'el cortafuegos confundió un cupón permitido con un código interno');
assert.throws(() => exigirSalidaPublicable('Claro. {"producto_id":"secret-123"'),
  /salida_interna_no_publicable/,
  'la puerta compartida dejó pasar JSON parcial con end_turn');

const catalogoFuga = [{ id: 1, nombre: 'Desayunos', productos: [{
  id: 90, nombre: 'Waffle', precio: 100, disponible: true, modificadores: [],
}] }];
const estadoFuga = estadoNuevo({ negocioId: 'gate-fuga', conversacionId: 'gate-fuga' });
estadoFuga.carrito = {
  items: [{ lid: 'linea-fuga', nombre: 'Waffle', cantidad: 1, modificadores: [], notas: '' }],
  datos: {
    modalidad: 'recoger en tienda', forma_pago: 'efectivo',
    cliente: { nombre: 'Prueba', telefono: '5200000000000' },
  },
};
const huellaFuga = crearEjecutor({
  estado: estadoFuga, catalogo: catalogoFuga, precios: { Waffle: 100 }, mensaje: 'Grande',
}).vista().huella;
let registrosFuga = 0;
let handoffsFuga = 0;
const salidaFuga = await atenderTurnoConHerramientas({
  negocioId: 'gate-fuga', conversacionId: 'gate-fuga', turnoId: 'gate-fuga-1',
  mensaje: 'Grande', estado: estadoFuga, catalogo: catalogoFuga, precios: { Waffle: 100 },
  llamarModelo: async () => ({
    stop_reason: 'max_tokens', content: [
      { type: 'text', text: textoIncidenteTruncado },
      {
        type: 'tool_use', id: 'confirmacion-truncada', name: 'confirmar_pedido',
        input: { huella_resumen: huellaFuga },
      },
    ],
  }),
  efectos: {
    confirmar: async () => { registrosFuga += 1; return { ok: true }; },
    escalar: async () => { handoffsFuga += 1; return { ok: true }; },
  },
});
assert.equal(registrosFuga, 0, 'una respuesta max_tokens alcanzó el registro del pedido');
assert.equal(handoffsFuga, 1, 'una respuesta max_tokens no se entregó a revisión humana');
assert.equal(salidaFuga.motivoCierre, CIERRE.ERROR);
assert.doesNotMatch(salidaFuga.texto, /ORDEN_PREVIEW|"total"|tool_use/i,
  'el texto interno truncado llegó a la respuesta pública');

// El segundo escape del mismo incidente: una herramienta puede fallar con un
// código interno y el modelo intentar repetirlo como prosa. El detalle se
// conserva para operaciones, pero no vuelve al contexto de redacción; además,
// la puerta final lo retiene aunque el proveedor lo fabrique por su cuenta.
const estadoCodigoTool = estadoNuevo({
  negocioId: 'gate-fuga', conversacionId: 'gate-fuga-codigo-tool',
});
estadoCodigoTool.carrito = {
  items: [{ lid: 'linea-codigo', nombre: 'Waffle', cantidad: 1, modificadores: [], notas: '' }],
  datos: {
    modalidad: 'recoger en tienda', forma_pago: 'efectivo',
    cliente: { nombre: 'Prueba', telefono: '5200000000000' },
  },
};
const huellaCodigoTool = crearEjecutor({
  estado: estadoCodigoTool, catalogo: catalogoFuga, precios: { Waffle: 100 }, mensaje: 'sí',
}).vista().huella;
const detalleCodigoTool = 'TENANT_CONTEXT_REQUIRED: registrarPedido sin negocioId resuelto (canal=whatsapp)';
let vueltasCodigoTool = 0;
let contextoCodigoTool = '';
let handoffsCodigoTool = 0;
const salidaCodigoTool = await atenderTurnoConHerramientas({
  negocioId: 'gate-fuga', conversacionId: estadoCodigoTool.conversacionId,
  turnoId: 'gate-fuga-codigo-tool-1', mensaje: 'sí', estado: estadoCodigoTool,
  catalogo: catalogoFuga, precios: { Waffle: 100 },
  llamarModelo: async (peticion) => {
    vueltasCodigoTool += 1;
    if (vueltasCodigoTool === 1) {
      return {
        stop_reason: 'tool_use',
        content: [{
          type: 'tool_use', id: 'confirmacion-codigo', name: 'confirmar_pedido',
          input: { huella_resumen: huellaCodigoTool },
        }],
      };
    }
    contextoCodigoTool = JSON.stringify(peticion.messages.at(-1));
    return {
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: `No pude registrar: ${detalleCodigoTool}.` }],
    };
  },
  efectos: {
    confirmar: async () => ({ ok: false, motivo: detalleCodigoTool }),
    escalar: async () => { handoffsCodigoTool += 1; return { ok: true }; },
  },
});
assert.doesNotMatch(contextoCodigoTool,
  /TENANT_CONTEXT_REQUIRED|registrarPedido|negocioId|canal=whatsapp/,
  'el tool_result devolvió detalles técnicos al modelo');
assert.doesNotMatch(contextoCodigoTool, /aplicado|rechazada/,
  'el tool_result devolvió aplicado/estado al modelo');
assert.match(contextoCodigoTool, /resultado[^\n]*La acción no se aplicó/,
  'el tool_result no dejó un desenlace público mínimo');
assert.match(contextoCodigoTool, /No muestres detalles técnicos/,
  'el modelo no recibió una instrucción segura tras el fallo técnico');
assert.equal(salidaCodigoTool.motivoCierre, CIERRE.ERROR,
  'el eco de un código interno salió como respuesta normal');
assert.equal(handoffsCodigoTool, 1,
  'el eco de un código interno no produjo exactamente un handoff');
assert.doesNotMatch(salidaCodigoTool.texto,
  /TENANT_CONTEXT_REQUIRED|registrarPedido|negocioId|canal=whatsapp/,
  'el código interno llegó a la respuesta pública');

// Incluso un rechazo sin código debe quedarse en el mensaje técnico cuando su
// estado es `rechazada`; solo `ilegal` lleva la explicación accionable.
const estadoRechazoPlano = estadoNuevo({
  negocioId: 'gate-fuga', conversacionId: 'gate-fuga-rechazo-plano',
});
estadoRechazoPlano.carrito = estadoCodigoTool.carrito;
const huellaRechazoPlano = crearEjecutor({
  estado: estadoRechazoPlano, catalogo: catalogoFuga, precios: { Waffle: 100 }, mensaje: 'sí',
}).vista().huella;
let vueltasRechazoPlano = 0;
let contextoRechazoPlano = '';
await atenderTurnoConHerramientas({
  negocioId: 'gate-fuga', conversacionId: estadoRechazoPlano.conversacionId,
  turnoId: 'gate-fuga-rechazo-plano-1', mensaje: 'sí', estado: estadoRechazoPlano,
  catalogo: catalogoFuga, precios: { Waffle: 100 },
  llamarModelo: async (peticion) => {
    vueltasRechazoPlano += 1;
    if (vueltasRechazoPlano === 1) return {
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'confirmacion-rechazo-plano', name: 'confirmar_pedido',
        input: { huella_resumen: huellaRechazoPlano } }],
    };
    contextoRechazoPlano = JSON.stringify(peticion.messages.at(-1));
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Lo revisaré.' }] };
  },
  efectos: {
    confirmar: async () => ({ ok: false, motivo: 'No se pudo registrar la acción.' }),
    escalar: async () => ({ ok: true }),
  },
});
assert.doesNotMatch(contextoRechazoPlano, /No se pudo registrar la acción/,
  'un rechazo rechazado sin código filtró su detalle al modelo');
assert.match(contextoRechazoPlano, /La acción no se aplicó\. No muestres detalles técnicos/,
  'un rechazo rechazado sin código no recibió el mensaje técnico');

// Un rechazo de negocio (`invalido()` / estado ilegal) no es una traza: el
// modelo necesita el motivo y las instrucciones para corregir la llamada.
const estadoMotivoIlegal = estadoNuevo({
  negocioId: 'gate-fuga', conversacionId: 'gate-fuga-motivo-ilegal',
});
let vueltasMotivoIlegal = 0;
let contextoMotivoIlegal = '';
await atenderTurnoConHerramientas({
  negocioId: 'gate-fuga', conversacionId: estadoMotivoIlegal.conversacionId,
  turnoId: 'gate-fuga-motivo-ilegal-1', mensaje: 'quiero un waffle',
  estado: estadoMotivoIlegal, catalogo: catalogoFuga, precios: { Waffle: 100 },
  llamarModelo: async (peticion) => {
    vueltasMotivoIlegal += 1;
    if (vueltasMotivoIlegal === 1) {
      return {
        stop_reason: 'tool_use',
        content: [{
          type: 'tool_use', id: 'producto-inexistente', name: 'agregar_producto',
          input: { producto_id: 'p1', cantidad: 1 },
        }],
      };
    }
    contextoMotivoIlegal = JSON.stringify(peticion.messages.at(-1));
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Puedo corregir el producto.' }] };
  },
});
assert.match(contextoMotivoIlegal, /Usa buscar_producto|Llama a ver_pedido/,
  'el modelo perdió la explicación accionable de un rechazo ilegal');
assert.doesNotMatch(contextoMotivoIlegal, /La acción no se aplicó\. No muestres detalles técnicos/,
  'un rechazo ilegal fue ocultado como fallo técnico');

const estadoFugaParcial = estadoNuevo({
  negocioId: 'gate-fuga', conversacionId: 'gate-fuga-json-parcial',
});
let handoffsFugaParcial = 0;
const salidaFugaParcial = await atenderTurnoConHerramientas({
  negocioId: 'gate-fuga', conversacionId: estadoFugaParcial.conversacionId,
  turnoId: 'gate-fuga-json-parcial-1', mensaje: 'quiero pedir',
  estado: estadoFugaParcial, catalogo: [],
  llamarModelo: async () => ({
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: 'Claro. {"producto_id":"secret-123"' }],
  }),
  efectos: {
    escalar: async () => { handoffsFugaParcial += 1; return { ok: true }; },
  },
});
assert.equal(salidaFugaParcial.motivoCierre, CIERRE.ERROR,
  'un JSON parcial con end_turn salió como respuesta normal');
assert.equal(handoffsFugaParcial, 1,
  'un JSON parcial con end_turn no produjo exactamente un handoff');
assert.doesNotMatch(salidaFugaParcial.texto, /producto_id|secret-123/i,
  'un argumento JSON parcial llegó a la respuesta pública');
assert.equal(resultadoDelCanalAgente({
  texto: 'te paso con alguien', handoffPendiente: true,
}).ok, false, 'el canal declaró atendido un handoff no confirmado');

const fuenteBrain = readFileSync(join(RAIZ, 'src', 'agent', 'brain.js'), 'utf8');
const bloquePrincipalBrain = fuenteBrain.slice(
  fuenteBrain.indexOf('async function procesarMensajeInterno'),
  fuenteBrain.indexOf('// ─── Simulador'));
const posicionValidaRespuesta = bloquePrincipalBrain.indexOf('textoCompletoDeRespuesta(respuesta)');
assert.ok(posicionValidaRespuesta >= 0
  && posicionValidaRespuesta < bloquePrincipalBrain.indexOf('extraerOrden(textoRespuesta)'),
  'el bot legacy volvió a interpretar la orden antes de validar stop_reason');
const posicionCortafuegosTemprano = bloquePrincipalBrain.indexOf(
  'exigirSalidaPublicable(limpiarBloqueComercial(limpiarTexto(textoRespuesta)))');
assert.ok(posicionCortafuegosTemprano > posicionValidaRespuesta
  && posicionCortafuegosTemprano < bloquePrincipalBrain.indexOf("agregarMensaje(sessionId, 'assistant'"),
  'el bot legacy guarda JSON residual en el historial antes de retenerlo');
assert.ok(posicionCortafuegosTemprano < bloquePrincipalBrain.indexOf('extraerOrden(textoRespuesta)'),
  'el bot legacy ejecuta efectos antes de retener JSON residual');
assert.match(bloquePrincipalBrain, /textoFinal\s*=\s*exigirSalidaPublicable\(textoFinal\)/,
  'el bot legacy no aplica el cortafuegos al texto final que publica');

// Conversación terminada en 7753: el agente prometió un envío para mañana y
// dijo «apunto» sin haber aplicado ninguna herramienta.
assert.equal(esSolicitudDePedidoProgramado('Si por favor sería para enviarlo mañana'), true,
  'un pedido futuro volvió a entrar al agente sin herramienta de programación');
assert.equal(esSolicitudDePedidoProgramado('Mañana a las 10', { hayPedidoEnCurso: true }), true,
  'una continuación temporal corta no se reconoció con un carrito en curso');
assert.equal(esSolicitudDePedidoProgramado('¿Qué promociones hay mañana?'), false,
  'una consulta futura inocente se mandó innecesariamente a revisión');
assert.equal(esSolicitudDePedidoProgramado('Quiero pedir para el 25 de septiembre'), true,
  'una fecha natural volvió a bloquearse con el local cerrado');
assert.equal(esSolicitudDePedidoProgramado('Quiero pedir para 2026-09-25'), true,
  'una fecha ISO completa no se reconoció como pedido futuro');
assert.equal(esSolicitudDePedidoProgramado('Quiero saber si abren el 25 sep'), false,
  'una pregunta de horario con fecha natural secuestró el flujo de pedido');
for (const inocua of [
  '¿Tienen pedidos para el 25 de septiembre?', 'No quiero pedir mañana',
  'Quiero 2-3 tacos', '¿Dónde entregan el 25 sep?',
]) assert.equal(esSolicitudDePedidoProgramado(inocua), false,
  `falso positivo de programación: ${inocua}`);
for (const continuacion of ['El viernes a las 10', 'Viernes a las 10', 'Mañana por la tarde']) {
  assert.equal(esSolicitudDePedidoProgramado(continuacion, { hayPedidoEnCurso: true }), true,
    `continuación temporal no detectada: ${continuacion}`);
}
for (const pedidoNatural of [
  'Necesito dos desayunos para el viernes', 'Me das tacos para el viernes',
  'Me gustaría una charola para el viernes', 'Dos waffles el 25',
  'Dos waffles el 25 a las 10', 'Dos waffles 25/09',
  'Dos waffles el 25 de septiembre',
]) assert.equal(esSolicitudDePedidoProgramado(pedidoNatural), true,
  `pedido futuro natural no detectado: ${pedidoNatural}`);
for (const noEsPedidoProgramado of [
  'Quiero que me avisen el viernes',
  'Quiero cancelar mi pedido del viernes',
  'Necesito facturar el pedido del viernes',
  'Quiero reservar una mesa para el viernes a las 8',
]) assert.equal(esSolicitudDePedidoProgramado(noEsPedidoProgramado), false,
  `una gestión ajena a ordenar activó programación: ${noEsPedidoProgramado}`);
for (const [fragmento, esperada] of [
  ['para el día veinticinco', '2026-09-25'],
  ['para el veinticinco', '2026-09-25'],
  ['para el primero', '2026-10-01'],
]) assert.deepEqual(fechasExactasDePedido(fragmento, { fechaAncla: '2026-09-23' }), [esperada],
  `una fecha escrita con palabras no llegó a fecha exacta: ${fragmento}`);
for (const natural of [
  'voy a recogerlo mañana a las 10 am', 'me lo llevo mañana a las 10 am',
  'tráemelo mañana a las 10 am', 'mándamelo mañana a las 10 am',
  'envíamelo mañana a las 10 am', 'recógelo mañana a las 10 am',
  'pásamelo mañana a las 10 am', 'prepáralo mañana a las 10 am',
]) assert.equal(autorizaProgramarParaDesdeMensaje(natural, { hayPedidoEnCurso: true }), true,
  `una asignación natural perdió autoridad: ${natural}`);
assert.equal(esConsultaDePosibilidadDePedido('Será posible que llegue mañana a las 10 am'), true,
  'una pregunta de posibilidad sin signos se convirtió en asignación');
for (const ajena of [
  'quiero trabajar mañana a las 10 am', 'quiero ir al médico mañana a las 10 am',
  'necesito una cita el viernes a las 10 am', 'quisiera descansar mañana a las 10 am',
  'me gustaría viajar mañana a las 10 am',
]) assert.equal(autorizaProgramarParaDesdeMensaje(ajena, { hayPedidoEnCurso: true }), false,
  `un deseo ajeno al pedido obtuvo autoridad temporal: ${ajena}`);
assert.equal(respuestaAfirmaCambioSinAplicar({
  texto: 'Va, apunto los chilaquiles suizos.', operaciones: [],
}), true, 'el agente volvió a afirmar un cambio que no guardó');
assert.equal(respuestaAfirmaCambioSinAplicar({
  texto: 'Listo, salsa suiza anotada.',
  operaciones: [{ herramienta: 'modificar_linea', resultado: { aplicado: true } }],
}), false, 'se bloqueó una afirmación respaldada por una herramienta aplicada');
const fuenteCanalAgente = readFileSync(join(RAIZ, 'src', 'mesero-agente', 'canalDelAgente.js'), 'utf8');
assert.match(fuenteCanalAgente, /esSolicitudDePedidoProgramado\(mensaje/,
  'el detector de programados existe pero quedó desconectado del adaptador productivo');
assert.match(fuenteCanalAgente, /respuestaAfirmaCambioSinAplicar\(salida\)/,
  'la barrera de afirmaciones existe pero quedó desconectada de la respuesta productiva');

// La fecha y la hora suelen llegar en turnos separados. El estado durable
// conserva únicamente los fragmentos temporales permitidos y la herramienta
// nunca toma sus propios argumentos como evidencia del cliente.
const estadoMemoriaProgramado = estadoNuevo({
  negocioId: 'gate-programado', conversacionId: 'gate-memoria-programado',
});
assert.equal(marcarProgramacionRequerida(
  estadoMemoriaProgramado, 'quiero hacer un pedido mañana',
  { fechaHoy: '2026-09-23' }), true);
const estadoMemoriaRestaurado = JSON.parse(JSON.stringify(
  estadoSerializable(estadoMemoriaProgramado),
));
assert.equal(marcarProgramacionRequerida(
  estadoMemoriaRestaurado, 'a las 10', { fechaHoy: '2026-09-24' }), true,
  'la hora en el segundo turno dejó de completar una fecha durable sin carrito');
assert.deepEqual(estadoMemoriaRestaurado.referenciaProgramacion, {
  fechaCliente: 'manana', horaCliente: 'a las 10',
  fechaAncla: '2026-09-23',
  fechaValidada: null, horaValidada: null, isoValidado: null,
}, 'el roundtrip perdió o amplió la memoria temporal whitelist');
const vistaMemoriaProgramado = crearEjecutor({
  estado: estadoMemoriaRestaurado, mensaje: 'a las 10', catalogo: [], precios: {},
}).vista();
assert.equal(vistaMemoriaProgramado.programacion_pendiente?.fecha, 'manana');
assert.equal(vistaMemoriaProgramado.programacion_pendiente?.hora, 'a las 10');
assert.equal(vistaMemoriaProgramado.programacion_pendiente?.fuente_fecha, 'cliente');
assert.equal(vistaMemoriaProgramado.programacion_pendiente?.fuente_hora, 'cliente');

// Una referencia que el ejecutor rechazó en T1 no puede quedar como evidencia
// y ser promovida por una hora tersa en T2. Este fue el bypass multturno que no
// aparecía en las pruebas same-turn.
for (const primerTurno of ['mañana imposible', 'mañana trabajo', 'mi opción es el 2']) {
  const estado = estadoNuevo({ negocioId: 'gate-programado', conversacionId: `gate-${primerTurno}` });
  estado.carrito.items = [{ nombre: 'Waffle', cantidad: 1, modificadores: [] }];
  estado.programacionRequerida = true;
  estado.carrito.datos.programado_para = '2099-01-03T15:00:00.000Z';
  estado.referenciaProgramacion = {
    fechaCliente: 'el sabado', horaCliente: 'a las 10 am',
    fechaValidada: '2099-01-03', horaValidada: '10:00',
    isoValidado: '2099-01-03T15:00:00.000Z',
  };
  const antes = JSON.stringify(estado);
  assert.equal(marcarProgramacionRequerida(estado, primerTurno, {
    fechaHoy: '2026-09-23', catalogo: catalogoFuga,
  }), false, primerTurno);
  assert.equal(JSON.stringify(estado), antes, `T1 contaminó el estado: ${primerTurno}`);
  assert.equal(marcarProgramacionRequerida(estado, 'a las 10 am', {
    fechaHoy: '2026-09-23', catalogo: catalogoFuga,
  }), true, primerTurno);
  const secuestrada = await crearEjecutor({
    estado, mensaje: 'a las 10 am', catalogo: catalogoFuga, precios: { Waffle: 100 },
    zonaDelNegocio: 'America/Matamoros',
  }).ejecutar('programar_para', { fecha: '2099-01-02', hora: '10:00' });
  assert.equal(secuestrada.aplicado, false, primerTurno);
  assert.match(secuestrada.motivo, /fecha_no_coincide_con_programacion_validada/, primerTurno);
}
for (const primerTurno of ['viernes posterior', 'crees que me lo entreguen mañana']) {
  const estado = estadoNuevo({ negocioId: 'gate-programado', conversacionId: `gate-${primerTurno}` });
  estado.carrito.items = [{ nombre: 'Waffle', cantidad: 1, modificadores: [] }];
  marcarProgramacionRequerida(estado, primerTurno, {
    fechaHoy: '2026-09-23', catalogo: catalogoFuga,
  });
  marcarProgramacionRequerida(estado, 'a las 10 am', {
    fechaHoy: '2026-09-23', catalogo: catalogoFuga,
  });
  const inventada = await crearEjecutor({
    estado, mensaje: 'a las 10 am', catalogo: catalogoFuga, precios: { Waffle: 100 },
  }).ejecutar('programar_para', { fecha: '2099-01-02', hora: '10:00' });
  assert.equal(inventada.aplicado, false, `T2 promovió una fecha sin autoridad: ${primerTurno}`);
}
for (const ambigua of ['para la semana entrante', 'para el próximo mes']) {
  const estado = estadoNuevo({ negocioId: 'gate-programado', conversacionId: `gate-${ambigua}` });
  estado.carrito.items = [{ nombre: 'Waffle', cantidad: 1, modificadores: [] }];
  assert.equal(marcarProgramacionRequerida(estado, ambigua, {
    fechaHoy: '2026-09-23', catalogo: catalogoFuga,
  }), true, ambigua);
  assert.equal(estado.referenciaProgramacion?.fechaCliente ?? null, null, ambigua);
}

const estadoCorreccionMixta = estadoNuevo({
  negocioId: 'gate-programado', conversacionId: 'gate-correccion-mixta',
});
estadoCorreccionMixta.carrito.items = [{ nombre: 'Waffle', cantidad: 1, modificadores: [] }];
estadoCorreccionMixta.carrito.datos.programado_para = '2099-01-02T15:00:00.000Z';
estadoCorreccionMixta.programacionRequerida = true;
estadoCorreccionMixta.referenciaProgramacion = {
  fechaValidada: '2099-01-02', horaValidada: '10:00',
  isoValidado: '2099-01-02T15:00:00.000Z',
};
assert.equal(marcarProgramacionRequerida(
  estadoCorreccionMixta, 'sábado, no a las 10',
  { fechaHoy: '2098-12-31', catalogo: catalogoFuga },
), true);
assert.equal(estadoCorreccionMixta.referenciaProgramacion?.horaValidada ?? null, null,
  'una corrección mixta revivió la hora que el cliente negó');
assert.equal(estadoCorreccionMixta.referenciaProgramacion?.isoValidado ?? null, null,
  'una corrección mixta conservó el ISO ya rechazado');

const estadoSinEvidenciaTemporal = estadoNuevo({
  negocioId: 'gate-programado', conversacionId: 'gate-modelo-inventa-programacion',
});
const programacionInventada = await crearEjecutor({
  estado: estadoSinEvidenciaTemporal, mensaje: 'sí, está bien', catalogo: [], precios: {},
}).ejecutar('programar_para', { fecha: '2099-01-02', hora: '10:00' });
assert.equal(programacionInventada.aplicado, false,
  'los argumentos del modelo fabricaron fecha/hora sin palabras del cliente');
assert.match(programacionInventada.motivo, /programacion_sin_evidencia_cliente/);
assert.equal(estadoSinEvidenciaTemporal.carrito.datos.programado_para, undefined);

const estadoHoraCambiada = estadoNuevo({
  negocioId: 'gate-programado', conversacionId: 'gate-hora-cambiada',
});
assert.equal(marcarProgramacionRequerida(
  estadoHoraCambiada, 'quiero pedir mañana a las 13:00',
  { fechaHoy: '2026-09-23' }), true);
const horaCambiada = await crearEjecutor({
  estado: estadoHoraCambiada, mensaje: 'quiero pedir mañana a las 13:00',
  catalogo: [], precios: {}, zonaDelNegocio: 'America/Matamoros',
}).ejecutar('programar_para', { fecha: '2026-09-24', hora: '10:00' });
assert.equal(horaCambiada.aplicado, false,
  'el modelo sustituyó por su cuenta la hora literal del cliente');
assert.match(horaCambiada.motivo, /hora_no_coincide_con_cliente/);

const estadoFechaCambiada = estadoNuevo({
  negocioId: 'gate-programado', conversacionId: 'gate-fecha-cambiada',
});
const mensajeFechaCambiada = 'quiero pedir el 2 de enero de 2099 a las 10 am';
assert.equal(marcarProgramacionRequerida(
  estadoFechaCambiada, mensajeFechaCambiada,
  { fechaHoy: '2026-09-23' }), true);
const fechaCambiada = await crearEjecutor({
  estado: estadoFechaCambiada, mensaje: mensajeFechaCambiada,
  catalogo: [], precios: {}, zonaDelNegocio: 'America/Matamoros',
}).ejecutar('programar_para', { fecha: '2099-01-03', hora: '10:00' });
assert.equal(fechaCambiada.aplicado, false,
  'el modelo sustituyó por su cuenta la fecha literal del cliente');
assert.match(fechaCambiada.motivo, /fecha_no_coincide_con_cliente/);

const estadoFranja = estadoNuevo({
  negocioId: 'gate-programado', conversacionId: 'gate-franja-inexacta',
});
assert.equal(marcarProgramacionRequerida(
  estadoFranja, 'quiero pedir mañana por la mañana',
  { fechaHoy: '2026-09-23' }), true);
const horaDesdeFranja = await crearEjecutor({
  estado: estadoFranja, mensaje: 'quiero pedir mañana por la mañana',
  catalogo: [], precios: {}, zonaDelNegocio: 'America/Matamoros',
}).ejecutar('programar_para', { fecha: '2026-09-24', hora: '10:00' });
assert.equal(horaDesdeFranja.aplicado, false,
  'una franja vaga autorizó una hora inventada por el modelo');
assert.match(horaDesdeFranja.motivo, /es una franja, no una hora exacta/);

const estadoConsultaProgramado = estadoNuevo({
  negocioId: 'gate-programado', conversacionId: 'gate-consulta-programado',
});
assert.equal(marcarProgramacionRequerida(
  estadoConsultaProgramado, '¿se puede pedir mañana a las 10?',
  { fechaHoy: '2026-09-23' }), false,
'una consulta de capacidad se convirtió en instrucción de programar');
const programacionDesdeConsulta = await crearEjecutor({
  estado: estadoConsultaProgramado, mensaje: '¿se puede pedir mañana a las 10?',
  catalogo: [], precios: {}, zonaDelNegocio: 'America/Matamoros',
}).ejecutar('programar_para', { fecha: '2026-09-24', hora: '10:00' });
assert.equal(programacionDesdeConsulta.aplicado, false,
  'la herramienta aceptó una programación nacida de una pregunta');
assert.match(programacionDesdeConsulta.motivo, /programacion_sin_intencion_cliente/);

const estadoAlternativa = estadoNuevo({
  negocioId: 'gate-programado', conversacionId: 'gate-alternativa-modelo',
});
const mensajeAlternativa = 'quiero pedir el 2 de enero de 2099 a las 10';
assert.equal(marcarProgramacionRequerida(
  estadoAlternativa, mensajeAlternativa, { fechaHoy: '2026-09-23' }), true);
const ejecutorAlternativa = crearEjecutor({
  estado: estadoAlternativa, mensaje: mensajeAlternativa,
  catalogo: [], precios: {}, zonaDelNegocio: 'America/Matamoros',
});
const primerIntento = await ejecutorAlternativa.ejecutar('programar_para', {
  fecha: '2099-01-02', hora: '10:00',
});
assert.equal(primerIntento.aplicado, false,
  'el primer intento de la guarda debía llegar a una política que lo rechazara');
const alternativaSinCliente = await ejecutorAlternativa.ejecutar('programar_para', {
  fecha: '2099-01-03', hora: '10:00',
});
assert.equal(alternativaSinCliente.aplicado, false,
  'el modelo eligió otra fecha después del rechazo sin mensaje nuevo');
assert.match(alternativaSinCliente.motivo, /programacion_alternativa_sin_cliente/);

const fechaAmbiguaGate = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
const estadoHoraAmbigua = estadoNuevo({
  negocioId: 'gate-programado', conversacionId: 'gate-hora-ambigua',
});
const mensajeHoraAmbigua = `quiero pedir el ${fechaAmbiguaGate} a las 8`;
assert.equal(marcarProgramacionRequerida(
  estadoHoraAmbigua, mensajeHoraAmbigua, { fechaHoy: '2026-09-23' }), true);
const horariosTodoElDia = Object.fromEntries([
  'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo',
].map((dia) => [dia, { abierto: true, apertura: '00:00', cierre: '23:59' }]));
const horaAmbigua = await crearEjecutor({
  estado: estadoHoraAmbigua, mensaje: mensajeHoraAmbigua,
  catalogo: [], precios: {}, zonaDelNegocio: 'UTC',
  reglas: { horarios: horariosTodoElDia, pedidos: { tiempo_preparacion_minutos: 25 } },
  configTienda: { aceptaProgramados: true },
}).ejecutar('programar_para', { fecha: fechaAmbiguaGate, hora: '20:00' });
assert.equal(horaAmbigua.aplicado, false,
  'una hora con dos lecturas válidas no obligó a preguntar AM/PM');
assert.match(horaAmbigua.motivo, /hora_ambigua_cliente/);
assert.deepEqual(horasExactasDePedido('a las doce de la noche'), ['00:00'],
  'doce de la noche volvió a interpretarse como mediodía');

const estadoSemanaVaga = estadoNuevo({
  negocioId: 'gate-programado', conversacionId: 'gate-semana-vaga',
});
const mensajeSemanaVaga = 'quiero pedir la próxima semana a las 10 am';
assert.equal(marcarProgramacionRequerida(
  estadoSemanaVaga, mensajeSemanaVaga, { fechaHoy: '2026-09-23' }), true);
const diaInventadoDeSemana = await crearEjecutor({
  estado: estadoSemanaVaga, mensaje: mensajeSemanaVaga,
  catalogo: [], precios: {}, zonaDelNegocio: 'UTC',
}).ejecutar('programar_para', { fecha: fechaAmbiguaGate, hora: '10:00' });
assert.equal(diaInventadoDeSemana.aplicado, false,
  'una semana vaga autorizó al modelo a elegir un día');
assert.match(diaInventadoDeSemana.motivo,
  /no identifica un día exacto|falta que el cliente indique la fecha|programacion_sin_intencion_cliente/);

const estadoVuelveInmediato = estadoNuevo({
  negocioId: 'gate-programado', conversacionId: 'gate-vuelve-inmediato',
});
estadoVuelveInmediato.programacionRequerida = true;
estadoVuelveInmediato.carrito.datos.programado_para = '2026-09-25T15:00:00.000Z';
assert.equal(marcarProgramacionRequerida(
  estadoVuelveInmediato, 'ya no mañana, mejor hoy',
  { fechaHoy: '2026-09-24' }), false,
'una corrección a hoy revivió la fecha negada');
assert.equal(estadoVuelveInmediato.programacionRequerida, false);
assert.equal(estadoVuelveInmediato.referenciaProgramacion, null);
assert.equal(estadoVuelveInmediato.carrito.datos.programado_para, undefined);

// Pedidos recibidos después del cierre: el corte ocurre antes del modelo, la
// tienda solo se ofrece si está publicada y admite pedidos programados, y los
// minutos de 07:30 no se redondean a 07:00.
const horariosCierre = Object.fromEntries([
  'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo',
].map((dia) => [dia, { abierto: true, apertura: '07:30', cierre: '14:45' }]));
const reglasCierre = { timezone: 'UTC', horarios: horariosCierre, cierres_especiales: [], promociones: [] };
assert.equal(obtenerEstadoRestaurante(reglasCierre, new Date('2026-09-21T07:29:00Z')).abierto, false,
  '07:30 volvió a interpretarse como 07:00');
assert.equal(obtenerEstadoRestaurante(reglasCierre, new Date('2026-09-21T07:30:00Z')).abierto, true);
const estadoCerrado = obtenerEstadoRestaurante(reglasCierre, new Date('2026-09-21T15:00:00Z'));
const avisoCierre = construirAvisoFueraDeHorario({
  estadoRestaurante: estadoCerrado,
  reglas: reglasCierre,
  configTienda: { estado: 'publicada', aceptaProgramados: true, slug: 'mapolato-obispado' },
  baseUrl: 'https://xabor.mx',
});
assert.match(avisoCierre, /https:\/\/xabor\.mx\/t\/mapolato-obispado/,
  'el aviso de cierre perdió la tienda programable del negocio');
assert.match(avisoCierre, /mañana a las 7:30 a\. m\./,
  'el aviso de cierre no informa cuándo vuelve el personal');
const posicionAvisoCierre = fuenteCanalAgente.indexOf('construirAvisoFueraDeHorario({',
  fuenteCanalAgente.indexOf('export async function atenderConAgente'));
const posicionModelo = fuenteCanalAgente.indexOf('salida = await atenderTurnoConHerramientas({', posicionAvisoCierre);
assert.ok(posicionAvisoCierre >= 0 && posicionModelo > posicionAvisoCierre,
  'el agente puede llegar al modelo antes de responder que el negocio está cerrado');

// ── EL FRENO DE LOS PROGRAMADOS SE MOVIÓ AL PASO IRREVERSIBLE ────────────
//
// Hasta el 23-sep esta comprobación exigía que el desvío de pedidos
// programados quedara ENTRE el aviso de cierre y el modelo. Ese desvío se
// retiró cuando el agente aprendió a fijar la fecha (`programar_para`):
// frenarlo antes del modelo también le impedía hacerlo bien.
//
// Se prueba el comportamiento, no nombres de implementación: el caller puede
// inyectar `convertir` y un grep a convertirPedidoAProgramado daba un falso
// positivo/negativo cada vez que se refactorizaba sin cambiar la semántica.
const estadoProgramadoGate = estadoNuevo({ negocioId: 'gate-programado', conversacionId: 'gate-programado' });
estadoProgramadoGate.programacionRequerida = true;
estadoProgramadoGate.carrito.datos = {
  modalidad: 'recoger en tienda', forma_pago: 'efectivo',
  cliente: { nombre: 'Prueba', telefono: '5200000000000' },
  programado_para: '2026-09-25T15:00:00.000Z',
};
const secuenciaProgramado = [];
const gateProgramado = await confirmarYEmitir({
  negocioId: 'gate-programado', telefono: '5200000000000', canal: 'whatsapp',
  estado: estadoProgramadoGate, pedido: { total: 100 },
  registrar: async () => {
    secuenciaProgramado.push('registrar');
    return { id: 'XAB-GATE', negocioId: 'gate-programado', total: 100 };
  },
  convertir: async () => { secuenciaProgramado.push('convertir'); return { ok: true }; },
  emitir: async () => { secuenciaProgramado.push('EMITIR_PROHIBIDO'); },
  guardar: async () => { secuenciaProgramado.push('guardar'); },
});
assert.equal(gateProgramado.ok, true);
assert.deepEqual(secuenciaProgramado, ['registrar', 'convertir', 'guardar'],
  'un programado no se reservó antes de cualquier posible emisión');

const estadoCorreccionHora = estadoNuevo({
  negocioId: 'gate-programado', conversacionId: 'gate-correccion-hora',
});
estadoCorreccionHora.programacionRequerida = true;
estadoCorreccionHora.carrito.items = [{ nombre: 'Waffle', cantidad: 1, modificadores: [] }];
estadoCorreccionHora.carrito.datos = {
  modalidad: 'recoger en tienda', forma_pago: 'efectivo',
  programado_para: '2026-09-25T15:00:00.000Z',
};
assert.equal(marcarProgramacionRequerida(estadoCorreccionHora, 'mejor a las once'), true,
  'una corrección de solo hora no se reconoció sobre la reserva existente');
assert.equal(estadoCorreccionHora.carrito.datos.programado_para, undefined,
  'la corrección de hora dejó confirmable la hora anterior');
const ejecutorCorreccionHora = crearEjecutor({
  estado: estadoCorreccionHora, mensaje: 'mejor a las once',
  catalogo: [], precios: {}, zonaDelNegocio: 'America/Matamoros',
});
const vistaCorreccionHora = ejecutorCorreccionHora.vista().programacion_pendiente;
assert.equal(vistaCorreccionHora?.fecha, '2026-09-25',
  'un estado legacy perdió la fecha local validada al corregir solo la hora');
assert.equal(vistaCorreccionHora?.hora, 'a las once');
const cambioDeFechaInventado = await ejecutorCorreccionHora.ejecutar('programar_para', {
  fecha: '2026-09-26', hora: '11:00',
});
assert.equal(cambioDeFechaInventado.aplicado, false,
  'el modelo cambió también la fecha cuando el cliente solo corrigió la hora');
assert.match(cambioDeFechaInventado.motivo, /fecha_no_coincide_con_programacion_validada/);
let registrosHoraVieja = 0;
const gateHoraCorregida = await confirmarYEmitir({
  negocioId: 'gate-programado', telefono: '5200000000000', canal: 'whatsapp',
  estado: estadoCorreccionHora, pedido: { total: 100 },
  registrar: async () => { registrosHoraVieja += 1; return { id: 'NO' }; },
  emitir: async () => {}, guardar: async () => {},
});
assert.equal(gateHoraCorregida.ok, false);
assert.equal(registrosHoraVieja, 0,
  'se registró la hora anterior después de que el cliente la corrigió');

const estadoVuelveAhora = estadoNuevo({
  negocioId: 'gate-programado', conversacionId: 'gate-vuelve-ahora',
});
estadoVuelveAhora.programacionRequerida = true;
estadoVuelveAhora.carrito.datos.programado_para = '2026-09-25T15:00:00.000Z';
assert.equal(marcarProgramacionRequerida(estadoVuelveAhora, 'ahora'), false,
  '«ahora» no desprogramó una fecha ya guardada');
assert.equal(estadoVuelveAhora.carrito.datos.programado_para, undefined,
  '«ahora» conservó la fecha vieja');
assert.equal(estadoVuelveAhora.referenciaProgramacion, null,
  '«ahora» conservó una referencia temporal que podía revivir la fecha vieja');

const estadoSinFecha = estadoNuevo({ negocioId: 'gate-programado', conversacionId: 'gate-sin-fecha' });
estadoSinFecha.programacionRequerida = true;
let registrosSinFecha = 0;
const gateSinFecha = await confirmarYEmitir({
  negocioId: 'gate-programado', telefono: '5200000000000', canal: 'whatsapp',
  estado: estadoSinFecha, pedido: { total: 100 }, textoDelCiclo: 'sí',
  registrar: async () => { registrosSinFecha += 1; return { id: 'NO' }; },
  emitir: async () => {}, guardar: async () => {},
});
assert.equal(gateSinFecha.ok, false);
assert.equal(registrosSinFecha, 0,
  'un pedido para otro día se registró aunque nadie fijó fecha y hora');

const estadoConversionFallida = estadoNuevo({
  negocioId: 'gate-programado', conversacionId: 'gate-conversion-fallida',
});
estadoConversionFallida.programacionRequerida = true;
estadoConversionFallida.carrito.datos = {
  modalidad: 'recoger en tienda', forma_pago: 'efectivo',
  cliente: { nombre: 'Prueba', telefono: '5200000000000' },
  programado_para: '2026-09-25T15:00:00.000Z',
};
let emisionesConversionFallida = 0;
let retirosConversionFallida = 0;
const consoleErrorOriginal = console.error;
const erroresProgramacionEsperados = [];
try {
  console.error = (...args) => erroresProgramacionEsperados.push(args.join(' '));
  await assert.rejects(
    () => confirmarYEmitir({
      negocioId: 'gate-programado', telefono: '5200000000000', canal: 'whatsapp',
      estado: estadoConversionFallida, pedido: { total: 100 },
      registrar: async () => ({ id: 'XAB-GATE-FALLA', negocioId: 'gate-programado', total: 100 }),
      convertir: async () => ({ ok: false, razon: 'db_no_disponible_prueba' }),
      resolverReserva: async () => null,
      retirarProyeccionFallida: () => { retirosConversionFallida += 1; },
      emitir: async () => { emisionesConversionFallida += 1; },
      guardar: async () => {},
    }),
    (error) => error?.codigo === 'PROGRAMACION_INCIERTA',
    'una conversión incierta no falló cerrado');
} finally {
  console.error = consoleErrorOriginal;
}
assert.ok(erroresProgramacionEsperados.some((linea) => linea.includes('no se pudo conciliar')),
  'la conversión incierta dejó de producir evidencia operativa');
assert.equal(emisionesConversionFallida, 0,
  'un programado cuya reserva falló se emitió como pedido inmediato');
assert.equal(retirosConversionFallida, 1,
  'la proyección incierta quedó visible en cocina/panel');

// Módulo Asistente: sus opciones deben alimentar al agente nuevo y su
// simulador, no quedarse conectadas únicamente al prompt del bot anterior.
const reglasAsistente = {
  pedidos: { costo_envio: 60, zonas_entrega: [{ nombre: 'UTNC', costo: 150 }] },
  politicas: ['Los cambios posteriores requieren revisión.'],
  bot: {
    saludo: 'Hola desde Mapolato', tono: 'cálido', personalidad: 'servicial',
    informacion_importante: 'Información propia del negocio.',
    faqs: [{ pregunta: '¿Facturan?', respuesta: 'Sí.' }],
    respuestas_prohibidas: ['El sistema lo ajustará después'],
    transferir_a_humano: 'Si el cliente se queja.',
    palabras_criticas: ['alergia'],
  },
};
const textoReglasAsistente = reglasDelAsistenteEnTexto(reglasAsistente, { esPrimerTurno: true });
for (const dato of ['Hola desde Mapolato', 'cálido', 'servicial', 'Información propia',
  '¿Facturan?', 'El sistema lo ajustará después', 'Si el cliente se queja',
  'alergia', '$60 MXN', '$150 MXN', 'Los cambios posteriores']) {
  assert.ok(textoReglasAsistente.includes(dato), `el agente nuevo perdió la regla de Asistente: ${dato}`);
}
assert.equal(respuestaProhibidaEncontrada('El sistema lo ajustara después.', reglasAsistente),
  'El sistema lo ajustará después', 'una respuesta prohibida volvió a poder salir por cambio de acentos');
assert.ok((fuenteCanalAgente.match(/reglasDelAsistenteEnTexto\(reglas/g) || []).length >= 3,
  'productivo, sombra o simulador volvió a ignorar las reglas del módulo Asistente');
assert.match(fuenteCanalAgente, /cfg\?\.nombre \|\| cfg\?\.nombre_negocio/,
  'el agente volvió a llamar “el restaurante” a un negocio con configuracion.nombre');
const fuenteServidor = readFileSync(join(RAIZ, 'src', 'server.js'), 'utf8');
const fuenteDatabase = readFileSync(join(RAIZ, 'src', 'services', 'database.js'), 'utf8');
const fuenteFacturacionWhatsapp = readFileSync(
  join(RAIZ, 'src', 'services', 'facturacionWhatsapp.js'), 'utf8');
const bloqueEsperaFolio = fuenteFacturacionWhatsapp.slice(
  fuenteFacturacionWhatsapp.indexOf("if (!solicitud && pendiente === 'esperando_folio')"),
  fuenteFacturacionWhatsapp.indexOf('let pedido = null;'),
);
assert.match(bloqueEsperaFolio, /nuevaIntencionNoFiscal\(texto\)[\s\S]*limpiarEstado[\s\S]*manej[a-z]*:\s*false/,
  'una espera de factura volvió a secuestrar catering o pedidos programados');
assert.match(bloqueEsperaFolio, /if \(!folio\) return \{ manejado: false \}/,
  'la espera de factura volvió a consumir texto ordinario sin folio');
const bloquePedidoDerivacion = fuenteDatabase.slice(
  fuenteDatabase.indexOf('async function pedidoParaDerivacionBloqueado'),
  fuenteDatabase.indexOf('export async function asentarPagoRealVerificado'),
);
assert.ok((bloquePedidoDerivacion.match(/leerActivo\(\)/g) || []).length >= 2,
  'la derivación no relee activos tras la carrera reserva→activo del scheduler');
const bloqueMarcarProgramado = fuenteDatabase.slice(
  fuenteDatabase.indexOf('export async function marcarPedidoProgramadoActivado'),
  fuenteDatabase.indexOf('export async function obtenerPedidosProgramadosPendientes'),
);
assert.match(bloqueMarcarProgramado, /pg_advisory_xact_lock/,
  'la activación programada dejó de serializarse con la obligación de pago');
assert.match(bloqueMarcarProgramado, /negocio_id\s*=\s*\$2/,
  'la marca de activación perdió el aislamiento por negocio');
assert.match(bloqueMarcarProgramado, /cliente\?\.release\(\)/,
  'un fallo al obtener conexión vuelve a abortar el lote de programados');
assert.doesNotMatch(fuenteBrain,
  /opciones\.perfil === 'catering'\s*&&\s*capturas\.length/,
  'catering dejó de invalidar un dato negado cuando el modelo no emitió captura');
assert.match(fuenteBrain,
  /reemplazarCamposSesion\(\s*sesionComercial\.id, negocioId, marcados/,
  'la purga legacy volvió a fusionar JSON y conservar campos sin evidencia');
const bloqueRetornoAlBot = fuenteServidor.slice(
  fuenteServidor.indexOf('async function cambiarAtencionConversacion'),
  fuenteServidor.indexOf("app.post('/api/conversacion/:telefono/pausar'"),
);
assert.match(bloqueRetornoAlBot,
  /DELETE FROM conversacion_estado[\s\S]*?meta-\$\{negocioId\}-\$\{telefono\}/,
  'devolver una conversación atendida dejó vivo el estado legacy');
assert.match(bloqueRetornoAlBot,
  /estadoNuevoMesero[\s\S]*?agente:\$\{telefono\}:r\$\{revisionAtencion\.revision\}[\s\S]*?INSERT INTO conversacion_estado/,
  'devolver una conversación no abrió una identidad limpia del agente canario');
assert.doesNotMatch(bloqueRetornoAlBot,
  /DELETE FROM conversacion_estado[^;]*agente:\$\{telefono\}/,
  'devolver una conversación borraría el libro auditable del agente canario');
assert.match(fuenteServidor, /simularConAgente\(\{/,
  'el simulador del módulo Asistente volvió a usar un motor distinto al agente nuevo');
const NEGOCIO_REGLAS = '11111111-1111-4111-8111-111111111111';
const estadoZona = estadoNuevo({ negocioId: NEGOCIO_REGLAS, conversacionId: 'gate-zona-entrega' });
const entregaZona = await crearEjecutor({
  estado: estadoZona,
  reglas: reglasAsistente,
  modalidades: ['recoger en tienda', 'entrega a domicilio'],
  mensaje: 'Es entrega a domicilio en UTNC, edificio principal.',
}).ejecutar('definir_entrega', {
  modalidad: 'entrega a domicilio', direccion: 'UTNC, edificio principal', zona_entrega: 'UTNC',
});
assert.equal(entregaZona.aplicado, true, 'una zona configurada y dicha por el cliente fue rechazada');
assert.equal(estadoZona.carrito.datos.costo_envio, 150,
  'la tarifa de la zona no llegó al carrito canónico');
const estadoZonaInventada = estadoNuevo({ negocioId: NEGOCIO_REGLAS, conversacionId: 'gate-zona-inventada' });
estadoZonaInventada.carrito.datos.modalidad = 'entrega a domicilio';
const zonaInventada = await crearEjecutor({
  estado: estadoZonaInventada,
  reglas: reglasAsistente,
  modalidades: ['recoger en tienda', 'entrega a domicilio'],
  mensaje: 'Es entrega a domicilio en Zona Inventada.',
}).ejecutar('definir_entrega', { zona_entrega: 'Zona Inventada' });
assert.equal(zonaInventada.aplicado, false, 'el agente aceptó una tarifa de zona que el negocio no configuró');

// Flujos secundarios que deben seguir vivos cuando se vuelva a habilitar el
// bot: folio originado por llamada, catering y menú de imágenes.
assert.equal(esPagoPorEnlace('enlace de pago'), true,
  'la voz dejó de marcar el pedido como pago anticipado por enlace');
const fuenteVoz = readFileSync(join(RAIZ, 'src', 'channels', 'voice.js'), 'utf8');
const posicionGateVoz = fuenteVoz.indexOf('requierePagoAnticipado = true');
assert.ok(posicionGateVoz >= 0
  && fuenteVoz.indexOf('registrarPedido(resultado.orden', posicionGateVoz) > posicionGateVoz,
  'la voz registra antes de fijar el gate de pago anticipado');
assert.equal(esSolicitudCatering('Necesito mesa de postres para una boda'), true);
assert.equal(esSolicitudCatering('Desayuno para 30'), false,
  'el volumen secuestró un pedido normal como catering');
assert.equal(esSolicitudCatering('Quiero 30 desayunos para recoger'), false,
  'un pedido grande para recoger se desvió a catering sin señal de evento');
assert.equal(esSolicitudCatering('Desayuno para 30 personas para una boda'), true,
  'una señal explícita de evento no entró a la captura de catering');
assert.equal(esSolicitudCatering('No quiero catering, quiero dos chilaquiles'), false,
  'una negación de catering secuestró un pedido normal');
assert.equal(esSolicitudCatering('No es para un evento, quiero 30 desayunos para recoger'), false,
  'una negación de evento secuestró un pedido normal');
assert.equal(esSolicitudCatering('No quiero servicio para una fiesta, solo 30 waffles'), false,
  'un servicio de evento negado secuestró un pedido normal');
assert.equal(esSolicitudCatering('No es para un evento, mejor quiero catering'), true,
  'una negación borró también la segunda señal positiva de catering');
const estadoCanceladoAntesDeEvento = estadoNuevo({
  negocioId: 'gate-catering', conversacionId: 'gate-catering-cancelado',
});
estadoCanceladoAntesDeEvento.hechos.cancelado = true;
estadoCanceladoAntesDeEvento.terminadoEn = new Date().toISOString();
estadoCanceladoAntesDeEvento.carrito.items = [{ nombre: 'Waffle anterior', cantidad: 1 }];
const cicloDelEvento = cicloParaTurno(
  estadoCanceladoAntesDeEvento, 'Quiero catering para una boda',
);
assert.equal(cicloDelEvento.hechos.cancelado, false,
  'un pedido cancelado reciente dejó ilegal la captura de catering');
assert.deepEqual(cicloDelEvento.carrito.items, [],
  'la ficha de evento heredó el carrito del pedido cancelado');
assert.notEqual(cicloDelEvento.conversacionId, estadoCanceladoAntesDeEvento.conversacionId,
  'catering reutilizó el libro de operaciones del ciclo cancelado');
assert.equal(camposObligatoriosCompletos({
  nombre: 'Ana', numero_personas: '40', lugar: 'Jardín',
  fecha_evento: 'el sábado 5 a las 2 pm',
}, { perfil: 'catering' }), true);
assert.equal(camposObligatoriosCompletos({
  nombre: 'Ana', numero_personas: '40', lugar: 'Jardín',
  fecha_evento: 'el sábado a las dos de la tarde',
}, { perfil: 'catering' }), true,
'una hora escrita no completó la ficha de catering');
const asistentesEscritos = filtrarDatosEventoCatering(
  { personas: 50 },
  { mensaje: 'Seremos cincuenta personas', eventoPrevio: { nombre: 'Ana' } },
);
assert.equal(asistentesEscritos.aceptados.personas, 50,
  'los asistentes escritos no quedaron respaldados por el texto del cliente');
assert.deepEqual(filtrarDatosEventoCatering(
  { personas: 20 }, { mensaje: 'No somos veinte personas', eventoPrevio: {} },
).aceptados, {}, 'una cantidad negada completó catering');
assert.equal(camposObligatoriosCompletos({
  nombre: 'Ana', lugar: 'Jardín', fecha_evento: 'el sábado 5 a las 2 pm',
}, { perfil: 'catering' }), false,
'catering afirmó datos listos sin saber cuántas personas asistirán');
assert.equal(motivoRespuestaCateringProhibida('Quedó agendado y cuesta $500'), 'precio');
assert.deepEqual(decidirSalidaCatering({ cateringListo: true, texto: MENSAJE_CATERING_ENTREGADO }), {
  accion: 'entregar', motivo: 'datos_listos', texto: MENSAJE_CATERING_ENTREGADO,
});
const salidaCateringTruncada = {
  texto: 'Te paso con una persona del equipo para revisar esto.',
  motivoCierre: 'error', handoffPendiente: true, escalado: false,
};
const textoCateringTruncado = salidaCateringTruncada.texto;
assert.equal(aplicarSalidaSeguraDeCatering(salidaCateringTruncada, {
  eventoActivo: true, evento: {},
}).motivo, 'handoff_tecnico_pendiente');
assert.equal(salidaCateringTruncada.texto, textoCateringTruncado,
  'un handoff técnico de catering se reemplazó por una pregunta que nadie atenderá');
assert.equal(decidirSalidaCatering({
  orden: { total: 500 }, texto: 'Tu evento quedó confirmado por $500',
}).accion, 'revision', 'catering permitió convertir una ficha en pedido');

const estadoCateringGate = estadoNuevo({
  negocioId: 'gate-catering', conversacionId: 'gate-catering',
});
estadoCateringGate.carrito.items = [{
  lid: 'linea-previa', nombre: 'Waffle', cantidad: 1, modificadores: [], notas: '',
}];
const carritoAntesDeCatering = JSON.stringify(estadoCateringGate.carrito);
assert.equal(prepararEstadoCatering(
  estadoCateringGate, 'Quiero catering', { nombreConfiable: 'Ana' }), true);
let pedidosDesdeCatering = 0;
const ejecutorCateringGate = crearEjecutor({
  estado: estadoCateringGate, catalogo: [], precios: {}, mensaje: 'confirma el pedido',
  efectos: { confirmar: async () => { pedidosDesdeCatering += 1; return { ok: true }; } },
});
for (const [herramienta, argumentos] of [
  ['agregar_producto', { producto_id: '90' }],
  ['confirmar_pedido', { huella_resumen: 'inventada' }],
  ['cancelar_pedido', { motivo: 'ya no quiero catering' }],
]) {
  const bloqueada = await ejecutorCateringGate.ejecutar(herramienta, argumentos);
  assert.equal(bloqueada.aplicado, false, `${herramienta} operó dentro de catering`);
  assert.match(bloqueada.motivo, /flujo_catering_activo/);
}
assert.equal(pedidosDesdeCatering, 0, 'catering alcanzó registrarPedido');
assert.equal(JSON.stringify(estadoCateringGate.carrito), carritoAntesDeCatering,
  'una herramienta de catering alteró el carrito previo');

let fichasCatering = 0;
const registrarFicha = (mensaje, argumentos) => crearEjecutor({
  estado: estadoCateringGate, catalogo: [], precios: {}, mensaje,
  efectos: { registrarEvento: async () => { fichasCatering += 1; return { ok: true }; } },
}).ejecutar('registrar_solicitud_evento', argumentos);
await registrarFicha('Me llamo Ana', { nombre: 'Ana' });
await registrarFicha('Somos 40 personas', { personas: 40 });
await registrarFicha('Será en Jardín Mapolato', { lugar: 'Jardín Mapolato' });
const fichaSinHora = await registrarFicha('Será el sábado 5', { fecha_hora: 'el sábado 5' });
assert.equal(fichaSinHora.registrado, false, 'una fecha sin hora entregó la ficha incompleta');
const fichaCompleta = await registrarFicha('A las 2 pm', { fecha_hora: 'a las 2 pm' });
assert.equal(fichaCompleta.registrado, true,
  `la ficha completa no llegó al equipo: ${JSON.stringify(fichaCompleta.faltan)}`);
assert.equal(fichaCompleta.evento.fecha_hora, 'el sábado 5 a las 2 pm',
  'la hora de un turno posterior borró la fecha ya verificada');
assert.equal(fichasCatering, 1, 'la ficha no se entregó exactamente una vez');
assert.equal(estadoCateringGate.hechos.escalado, true,
  'la ficha completa no dejó la conversación en manos de una persona');
const salidaCateringGate = aplicarSalidaSeguraDeCatering({
  texto: 'Quedó agendado y cuesta $500',
  operaciones: [{
    herramienta: 'registrar_solicitud_evento',
    resultado: { aplicado: true, registrado: true, evento: fichaCompleta.evento },
  }],
}, { eventoActivo: true, evento: estadoCateringGate.evento });
assert.equal(salidaCateringGate.salida.texto, MENSAJE_CATERING_ENTREGADO,
  'el texto público cotizó o prometió agenda en vez de entregar la ficha');
assert.doesNotMatch(salidaCateringGate.salida.texto, /\$|precio|agendad|reservad/i);

const estadoCancelarCatering = estadoNuevo({
  negocioId: 'gate-catering', conversacionId: 'gate-catering-cancelar',
});
estadoCancelarCatering.carrito.items = [{
  lid: 'linea-que-se-conserva', nombre: 'Hotcakes', cantidad: 2,
  modificadores: [], notas: 'sin miel',
}];
prepararEstadoCatering(estadoCancelarCatering, 'Quiero catering', { nombreConfiable: 'Ana' });
const carritoAntesDeCancelarFicha = JSON.stringify(estadoCancelarCatering.carrito);
assert.equal(prepararEstadoCatering(
  estadoCancelarCatering, 'Cancela mi solicitud de catering'), false);
const cancelacionCatering = consumirCancelacionCatering(estadoCancelarCatering);
assert.equal(cancelacionCatering?.texto, TEXTO_CATERING_CANCELADO);
assert.equal(cancelacionCatering?.cateringCancelado, true);
assert.deepEqual(cancelacionCatering?.operaciones, []);
assert.equal(JSON.stringify(estadoCancelarCatering.carrito), carritoAntesDeCancelarFicha,
  'cancelar la ficha de catering borró el carrito del pedido');
assert.equal(estadoCancelarCatering.hechos.cancelado, false,
  'cancelar catering marcó como cancelado el pedido normal');

const bloqueAtenderProductivo = fuenteCanalAgente.slice(
  fuenteCanalAgente.indexOf('export async function atenderConAgente'),
  fuenteCanalAgente.indexOf('export async function observarConAgente'));
const posicionPreparaCatering = bloqueAtenderProductivo.indexOf('prepararEstadoCatering(');
const posicionConsumeCancelacion = bloqueAtenderProductivo.indexOf('consumirCancelacionCatering(');
const posicionLlamaModeloCatering = bloqueAtenderProductivo.indexOf('atenderTurnoConHerramientas({');
assert.ok(posicionPreparaCatering >= 0
  && posicionConsumeCancelacion > posicionPreparaCatering
  && posicionLlamaModeloCatering > posicionConsumeCancelacion,
  'la cancelación de catering puede llegar al modelo y ejecutar cancelar_pedido');
assert.match(construirBloqueModoComercial({}, { perfil: 'catering' }), /No uses ni menciones platillos/i);
const fuenteCanalWhatsApp = readFileSync(join(RAIZ, 'src', 'channels', 'whatsapp-meta.js'), 'utf8');
assert.match(fuenteCanalWhatsApp, /!entradaCatering[\s\S]{0,160}mensajePideMenu/,
  'el menú automático volvió a ejecutarse antes que catering');
assert.match(fuenteCanalWhatsApp, /motivo: 'CATERING_DATOS_LISTOS'/,
  'la ficha completa de catering dejó de pausar la conversación');
assert.match(fuenteCanalWhatsApp, /cerrarSesionCatering\('catering_entregado_a_humano'\)/,
  'la ficha entregada dejó la sesión activa y volvería a interceptar al reanudar');
assert.match(fuenteCanalWhatsApp,
  /esErrorRespuestaTruncada\(error\) \|\| esErrorSalidaInternaNoPublicable\(error\)[\s\S]{0,450}\? 'RESPUESTA_TRUNCADA'/,
  'WhatsApp dejó de pausar una respuesta max_tokens antes de publicar texto parcial');
assert.match(fuenteCanalWhatsApp,
  /\? 'RESPUESTA_TRUNCADA' : 'SALIDA_INTERNA_NO_PUBLICABLE'/,
  'WhatsApp no pausa una salida interna retenida por el cortafuegos');
assert.match(fuenteCanalWhatsApp,
  /error\?\.codigo === 'AGENTE_HANDOFF_NO_CONFIRMADO'\) throw error/,
  'WhatsApp afirma revisión aunque no confirmó la pausa durable');
assert.equal(mensajePideMenu('Pásame la carta', ['me mandas el menu?']), true,
  'una frase básica dejó de activar el menú por tener frases personalizadas');

// El atajo de pago por folio se prueba sin Postgres. Un error en el primer
// lookup se propaga y no puede degradarse a «no encontrado» ni alcanzar la
// búsqueda amplia/enlace; esta es la frontera que protege contra cobros sobre
// un pedido no verificado.
const errorConsultaPago = new Error('db_no_disponible_prueba');
let consultasAmpliasTrasError = 0;
await assert.rejects(
  () => resolverPedidoCobrablePorFolio({
    folio: 'XAB-9998', negocioId: 'gate-pago',
    buscarParaPago: async () => { throw errorConsultaPago; },
    buscarAmplio: async () => { consultasAmpliasTrasError += 1; return null; },
  }),
  (error) => error === errorConsultaPago,
  'una caída de DB se convirtió en folio no encontrado');
assert.equal(consultasAmpliasTrasError, 0,
  'el pago siguió buscando después de perder la fuente cobrable');
assert.equal(await resolverPedidoCobrablePorFolio({
  folio: 'XAB-9998', negocioId: 'gate-pago',
  buscarParaPago: async () => null,
  buscarAmplio: async () => ({ _origen: 'activo', folio: 'XAB-9998' }),
}), null, 'la búsqueda amplia reintrodujo un activo no cobrable');
const reservaCobrable = { _origen: 'programado', folio: 'XAB-9998' };
assert.equal(await resolverPedidoCobrablePorFolio({
  folio: 'XAB-9998', negocioId: 'gate-pago',
  buscarParaPago: async () => null,
  buscarAmplio: async () => reservaCobrable,
}), reservaCobrable, 'una reserva programada válida dejó de ser cobrable');
const bloquePagoFolio = fuenteCanalWhatsApp.slice(
  fuenteCanalWhatsApp.indexOf('// Folio para pago'),
  fuenteCanalWhatsApp.indexOf('// Pago pendiente de llamada'));
const posicionResolverPago = bloquePagoFolio.indexOf('resolverPedidoCobrablePorFolio({');
const posicionFalloPago = bloquePagoFolio.indexOf('responderFalloConsultaPago({');
const posicionCrearPago = bloquePagoFolio.indexOf('crearEnlacePago({');
assert.ok(posicionResolverPago >= 0 && posicionFalloPago > posicionResolverPago
  && posicionCrearPago > posicionFalloPago,
  'el enlace por folio puede crearse antes de resolver de forma fail-closed');
assert.match(bloquePagoFolio,
  /responderFalloConsultaPago\(\{[\s\S]{0,700}\}\);\s*return;/,
  'el canal continuó hacia el cobro después de fallar la consulta del folio');

// ── XAB-0467 / XAB-0469: confirmar una vez por ciclo ─────────────────────
const NEGOCIO = '11111111-1111-4111-8111-111111111111';
const CONVERSACION = 'agente:5218781175648';
let ejecuciones = 0;
const libro = libroDeOperaciones(almacenEnMemoria());
const confirmar = (turnoId) => libro.ejecutarUnaVez({
  negocioId: NEGOCIO,
  conversacionId: CONVERSACION,
  turnoId,
  herramienta: 'confirmar_pedido',
  argumentos: {},
}, async () => {
  ejecuciones += 1;
  return { aplicada: true, estado: 'ok', resultado: { aplicado: true, folio: 'XAB-0467' } };
});

const primera = await confirmar('wa-confirmacion-original');
assert.equal(primera.repetida, false);
assert.equal(primera.resultado.folio, 'XAB-0467');
assert.equal(ejecuciones, 1);

const estadoConfirmado = {
  negocioId: NEGOCIO,
  conversacionId: CONVERSACION,
  ciclo: 0,
  hechos: { confirmado: true, cancelado: false, escalado: false, fallido: false },
};
for (const mensaje of ['gracias', 'tiempo de envio?', 'si', 'si, todo correcto']) {
  assert.equal(cicloParaTurno(estadoConfirmado, mensaje), estadoConfirmado,
    `"${mensaje}" abrió un ciclo nuevo sin que el cliente pidiera otro pedido`);
}
for (const turno of ['wa-gracias', 'wa-tiempo-envio', 'wa-si-posterior']) {
  const repetida = await confirmar(turno);
  assert.equal(repetida.repetida, true);
  assert.equal(repetida.aplicada, true);
  assert.equal(repetida.resultado.folio, 'XAB-0467');
}
assert.equal(ejecuciones, 1, 'se ejecutó registrarPedido más de una vez en el mismo ciclo');

const cicloNuevo = cicloParaTurno(estadoConfirmado, 'quiero hacer otro pedido');
assert.notEqual(cicloNuevo, estadoConfirmado);
assert.equal(cicloNuevo.conversacionId, `${CONVERSACION}:c1`);
const segundaLegitima = await libro.ejecutarUnaVez({
  negocioId: NEGOCIO,
  conversacionId: cicloNuevo.conversacionId,
  turnoId: 'wa-otro-pedido',
  herramienta: 'confirmar_pedido',
  argumentos: {},
}, async () => ({ aplicada: true, estado: 'ok', resultado: { aplicado: true, folio: 'XAB-0500' } }));
assert.equal(segundaLegitima.repetida, false);

const runner = readFileSync(join(RAIZ, 'scripts', 'predeploy-run-032-033.mjs'), 'utf8');
const i83 = runner.indexOf("'083-restaurante-division-consumo'");
const i84 = runner.indexOf("'084-agente-operaciones'");
const i85 = runner.indexOf("'085-agente-outbox'");
const i86 = runner.indexOf("'086-estado-pedidos'");
const i89 = runner.indexOf("'089-configuracion-fechada'");
const i90 = runner.indexOf("'090-agente-terminado-en'");
assert.ok(i83 >= 0 && i84 > i83 && i85 > i84 && i86 > i85 && i89 > i86 && i90 > i89,
  'el predeploy debe aplicar 084–090, en orden, antes del binario nuevo');

// ── Panel: sesión, menú, Restaurante y replay operativo ──────────────────
const leer = (ruta) => readFileSync(join(RAIZ, ruta), 'utf8');
const panel = leer('panel/index.html');
const captura = leer('panel/captura.js');
const mesas = leer('panel/mesas.html');
const server = leer('src/server.js');
const migracion086 = leer('migrations/086_estado_pedido_autoritativo.sql');

const auth = panel.indexOf("fetch('/api/auth/me'");
const cargaMenu = panel.indexOf('renderMenuPOS().catch', auth);
const ws = panel.indexOf('conectarWS();', auth);
assert.ok(auth >= 0 && cargaMenu > auth && ws > auth,
  'el panel debe validar la sesión antes de cargar menú y conectar WebSocket');
assert.match(panel, /renderMenuPOS\(\)\.catch\([^\n]+No se pudo cargar el menú/,
  'un fallo de menú no debe rechazar la autenticación ni mandar al login');
assert.match(captura, /catch \(e\) \{[\s\S]*?se conserva el anterior:[\s\S]*?finally \{ _enVuelo = null; \}/,
  'la captura compartida debe conservar el último catálogo bueno');
assert.match(captura, /if \(_arbol && _arbol\.length && !refrescar\) \{ revalidar\(\); return _arbol; \}/,
  'las modalidades deben pintar cache bueno y revalidar en segundo plano');
assert.match(mesas, /catch \{[\s\S]*?MENU = null;[\s\S]*?\}/,
  'Restaurante debe dejar el menú reintentable después de un fallo');
assert.match(mesas, /onclick="cargarMenu\(\)"[^>]*>Reintentar/,
  'Restaurante debe ofrecer reintento visible');
assert.match(server, /res\.set\('Cache-Control', 'private, no-store'\);[\s\S]*?res\.json\(menu\)/,
  'el endpoint de menú no debe cachear una respuesta vacía transitoria');
assert.match(server, /if \(p\.estado === 'entregado' \|\| p\.estado === 'cancelado'\) return false;/,
  'el replay no debe devolver entregados ni cancelados');
assert.match(server, /fechaOperativaDe\(instante, tz\) === hoy/,
  'el replay debe limitarse al día operativo del negocio');

// XAB-0458: pago confirmado e impresión correcta, pero la fotografía JSON
// seguía pendiente_pago. Después de recuperar el proceso, el tablero debe usar
// el estado SQL nuevo y mantener el pedido visible para que se pueda entregar.
const tiendaPagadaRecuperada = pedidoActivoDesdeFila({
  estado: 'nuevo',
  negocio_id: NEGOCIO,
  entregado_at: null,
  datos: {
    folio: 'XAB-0458',
    canal: 'tienda_online',
    estado: 'pendiente_pago',
    pago_confirmado: true,
  },
});
assert.equal(tiendaPagadaRecuperada.estado, 'nuevo',
  'el estado SQL pagado debe reemplazar la fotografía pendiente_pago');
assert.equal(tiendaPagadaRecuperada.negocioId, NEGOCIO,
  'el pedido recuperado debe conservar el negocio de su columna SQL');
assert.match(migracion086, /UPDATE pedidos_activos[\s\S]*?datos->>'estado' IS DISTINCT FROM estado/,
  'la 086 debe reparar las fotografías ya desalineadas');
assert.match(migracion086, /BEFORE INSERT OR UPDATE OF estado, datos ON pedidos_activos/,
  'la 086 debe impedir nuevas desalineaciones de estado');
assert.ok(runner.indexOf("'086-estado-pedidos'") > runner.indexOf("'085-agente-outbox'"),
  'el runner productivo debe aplicar la 086 después de la 085');

// XAB-0481: el borrador omitió el extra de bistec, confundió una guarnición
// con tacos y descartó una dirección al rechazar una modalidad inferida.
const opcion = (nombre, precio_extra = 0) => ({ nombre, precio_extra, disponible: true });
const catalogo481 = [{ id: 48, nombre: 'Desayunos', productos: [
  { id: 107, nombre: 'Chilaquiles Mixtos', precio: 205, disponible: true, modificadores: [
    { nombre: 'Salsa', requerido: true, minimo: 1, maximo: 2, opciones: [opcion('Verde')] },
    { nombre: 'Proteína', requerido: true, minimo: 1, maximo: 2,
      opciones: [opcion('Huevos Estrellados'), opcion('Bistec en Salsa', 30)] },
    { nombre: 'Guarniciones', requerido: true, minimo: 1, maximo: 2,
      opciones: [opcion('Frijolitos con chorizo'), opcion('Papas a la mexicana')] },
  ] },
  { id: 501, nombre: 'Taco de papa a la mexicana', precio: 35, disponible: true, modificadores: [] },
] }];
const estado481 = estadoNuevo({ negocioId: NEGOCIO, conversacionId: 'agente:5218721242184' });
estado481.carrito.items = [
  { lid: 'linea-1', nombre: 'Chilaquiles Mixtos', cantidad: 1, notas: 'sin cebolla arriba',
    modificadores: [
      { grupo: 'Salsa', opciones: ['Verde'] },
      { grupo: 'Proteína', opciones: ['Huevos Estrellados'] },
      { grupo: 'Guarniciones', opciones: ['Frijolitos con chorizo'] },
    ] },
  { lid: 'linea-2', nombre: 'Chilaquiles Mixtos', cantidad: 1, notas: 'sin cebolla arriba',
    modificadores: [
      { grupo: 'Salsa', opciones: ['Verde'] },
      { grupo: 'Proteína', opciones: ['Huevos Estrellados', 'Bistec en Salsa'] },
      { grupo: 'Guarniciones', opciones: ['Frijolitos con chorizo'] },
    ] },
];
estado481.carrito.datos = { modalidad: 'entrega a domicilio', forma_pago: 'terminal',
  cliente: { nombre: 'Aide', direccion: 'Libramiento 1384' } };
const vista481 = vistaDelPedido({ carrito: estado481.carrito, catalogo: catalogo481,
  precios: { 'Chilaquiles Mixtos': 205, 'Taco de papa a la mexicana': 35 },
  reglas: { pedidos: { costo_envio: 60 } } });
assert.equal(vista481.subtotal, 440, 'el resumen omitió los $30 del bistec');
assert.equal(vista481.total, 500, 'el total no sumó extra y envío antes de confirmar');

const ejecutor481 = crearEjecutor({ estado: estado481, catalogo: catalogo481,
  precios: { 'Chilaquiles Mixtos': 205, 'Taco de papa a la mexicana': 35 },
  mensaje: 'Y papas a la mexicana', textoCiclo: 'Y papas a la mexicana' });
const busqueda481 = await ejecutor481.ejecutar('buscar_producto', { texto: 'papas a la mexicana' });
assert.equal(busqueda481.es_opcion_del_pedido, true,
  'Papas a la mexicana volvió a tratarse como taco en vez de guarnición');
assert.deepEqual(busqueda481.encontrados, []);
assert.equal(busqueda481.coincidencias_opcion.length, 2);

const estadoDireccion481 = estadoNuevo({ negocioId: NEGOCIO, conversacionId: 'direccion-481' });
const entrega481 = await crearEjecutor({ estado: estadoDireccion481, catalogo: catalogo481,
  precios: { 'Chilaquiles Mixtos': 205 },
  modalidades: ['recoger en tienda', 'entrega a domicilio'],
  mensaje: 'Dirección: Guardia Nacional frente al Banco Bienestar',
  textoCiclo: 'Dirección: Guardia Nacional frente al Banco Bienestar' })
  .ejecutar('definir_entrega', {
    modalidad: 'domicilio', direccion: 'Guardia Nacional frente al Banco Bienestar',
  });
assert.equal(entrega481.aplicado, true, 'la dirección se perdió junto con la modalidad inferida');
assert.equal(entrega481.codigo, 'modalidad_sin_respaldo');
assert.equal(estadoDireccion481.carrito.datos.modalidad, undefined);
assert.equal(estadoDireccion481.carrito.datos.cliente.direccion,
  'Guardia Nacional frente al Banco Bienestar');

const respuesta481 = aplicarRespuestaDeConfirmacion({ estado: estado481,
  salida: { texto: 'Confirmado por $470', operaciones: [{ herramienta: 'confirmar_pedido',
    resultado: { aplicado: true, folio: 'XAB-0481', total: 500, costo_envio: 60 } }] } });
assert.match(respuesta481.texto, /\$500 MXN/);
assert.doesNotMatch(respuesta481.texto, /\$470/);

let registros481 = 0;
const barrera481 = await confirmarYEmitir({
  negocioId: NEGOCIO, telefono: '5218721242184', canal: 'whatsapp', estado: estado481,
  pedido: { total: 470 }, emitir: async () => {}, guardar: async () => {},
  previsualizar: async () => ({ ok: true, preview: { total: 500 } }),
  registrar: async () => { registros481 += 1; return { id: 'NO-DEBE-EXISTIR' }; },
});
assert.equal(barrera481.ok, false);
assert.equal(registros481, 0, 'registró un pedido cuyo total canónico difería del confirmado');

console.log('OK: max_tokens/salida interna, programados sin emisión inmediata, catering sin pedido/precio y cancelación segura, pago por folio fail-closed, corte maestro, horario, reglas, menú, doble confirmación, sesión, Restaurante, replay, XAB-0458 y XAB-0481 protegidos.');

await import('./check-variante-turno.mjs');
await import('./check-alcance-atributos.mjs');
