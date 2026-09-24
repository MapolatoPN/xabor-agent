import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  diagnosticarRespuestaTruncada,
  esRespuestaTruncada,
  exigirRespuestaCompleta,
  consumirStreamCompleto,
  RespuestaModeloTruncadaError,
  textoCompletoDeRespuesta,
} from '../src/agent/respuestaTruncada.js';
import { quitarBloquesCerrados } from '../src/agent/marcadoresTruncados.js';
import { atenderTurnoConHerramientas, CIERRE } from '../src/mesero-agente/agenteDelMesero.js';
import { crearEjecutor, estadoNuevo } from '../src/mesero-agente/ejecutorDeHerramientas.js';
import {
  aplicarSalidaSeguraDeCatering, desenlaceDelTurno, resultadoDelCanalAgente,
} from '../src/mesero-agente/canalDelAgente.js';
import {
  detectarSalidaInterna, exigirSalidaPublicable, SalidaInternaNoPublicableError,
} from '../src/mesero-agente/salidaPublicable.js';

let pasadas = 0;
const probar = (nombre, fn) => {
  try {
    fn();
    pasadas += 1;
    console.log(`    OK  ${nombre}`);
  } catch (error) {
    console.error(`> FALLO ${nombre}: ${error.message}`);
    process.exitCode = 1;
  }
};

const probarAsync = async (nombre, fn) => {
  try {
    await fn();
    pasadas += 1;
    console.log(`    OK  ${nombre}`);
  } catch (error) {
    console.error(`> FALLO ${nombre}: ${error.message}`);
    process.exitCode = 1;
  }
};

console.log('\n-- Respuestas truncadas del modelo --');

probar('stop_reason=max_tokens basta aunque no haya marcador', () => {
  assert.deepEqual(
    diagnosticarRespuestaTruncada({ stop_reason: 'max_tokens' }, 'Una respuesta cortada a la mi'),
    { truncada: true, motivo: 'max_tokens', marcador: null },
  );
});

probar('model_context_window_exceeded también es truncamiento autoritativo', () => {
  assert.deepEqual(
    diagnosticarRespuestaTruncada(
      { stop_reason: 'model_context_window_exceeded' },
      'Una respuesta incompleta aunque parezca prosa normal',
    ),
    { truncada: true, motivo: 'model_context_window_exceeded', marcador: null },
  );
});

probar('un marcador abierto protege aunque falte metadata del proveedor', () => {
  assert.deepEqual(
    diagnosticarRespuestaTruncada({}, 'Texto\n<ORDEN_PREVIEW>{"total":'),
    { truncada: true, motivo: 'marcador_sin_cerrar', marcador: 'ORDEN_PREVIEW' },
  );
});

probar('los JSON internos del asistente comercial también fallan cerrados', () => {
  for (const tag of ['CAMPO_COMERCIAL_CAPTURADO', 'OBJECION_DETECTADA']) {
    const texto = `Respuesta visible.\n<${tag}>{"privado":`;
    const diagnostico = diagnosticarRespuestaTruncada({ stop_reason: 'end_turn' }, texto);
    assert.equal(diagnostico.truncada, true, `${tag} no se detectó`);
    assert.equal(diagnostico.marcador, tag);
  }
});

probar('max_tokens conserva el marcador diagnostico si tambien existe', () => {
  assert.deepEqual(
    diagnosticarRespuestaTruncada(
      { stop_reason: 'max_tokens' },
      '<ORDEN_CONFIRMADA>{"cliente":',
    ),
    { truncada: true, motivo: 'max_tokens', marcador: 'ORDEN_CONFIRMADA' },
  );
});

probar('end_turn con bloque cerrado no es truncamiento', () => {
  assert.equal(
    esRespuestaTruncada(
      { stop_reason: 'end_turn' },
      '<ORDEN_PREVIEW>{"total":100}</ORDEN_PREVIEW>',
    ),
    false,
  );
});

probar('el extractor interno recibe un error tipado y no parsea lo parcial', () => {
  assert.throws(
    () => exigirRespuestaCompleta({ stop_reason: 'max_tokens' }, '{"items":['),
    (error) => error instanceof RespuestaModeloTruncadaError
      && error.codigo === 'RESPUESTA_MODELO_TRUNCADA'
      && error.diagnostico.motivo === 'max_tokens',
  );
});

probar('el texto solo se entrega al consumidor después de validar stop_reason', () => {
  assert.equal(textoCompletoDeRespuesta({
    stop_reason: 'end_turn', content: [{ type: 'text', text: '{"ok":true}' }],
  }), '{"ok":true}');

  let parseos = 0;
  assert.throws(() => {
    const texto = textoCompletoDeRespuesta({
      stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"items":[' }],
    });
    parseos += 1;
    JSON.parse(texto);
  }, RespuestaModeloTruncadaError);
  assert.equal(parseos, 0);
});

probar('los bloques cerrados se limpian con la misma gramática tolerante', () => {
  assert.equal(
    quitarBloquesCerrados('Antes < orden_preview >{"total":1}< / orden_preview > Después'),
    'Antes  Después',
  );
  assert.equal(
    quitarBloquesCerrados('Antes <pedido_borrador>{}< /PEDIDO_BORRADOR   > Después'),
    'Antes  Después',
  );
});

probar('el cortafuegos del CANARIO detecta protocolo interno aun bien cerrado', () => {
  const casos = [
    ['<ORDEN_PREVIEW>{"total":500}</ORDEN_PREVIEW>', 'marcador'],
    ['< / orden_preview >', 'marcador'],
    ['&lt;CATERING_DATOS_LISTOS&gt;', 'marcador'],
    ['{"type":"tool_use","name":"confirmar_pedido"}', 'protocolo'],
    ['Usaré confirmar_pedido para resolverlo', 'herramienta'],
    ['tool_result: ok', 'protocolo'],
    ['ORDEN_PREVIEW {"total":500}', 'marcador'],
    ['CATERING_DATOS_LISTOS', 'marcador'],
    ['Resultado: {"aplicado":true,"estado":"ok"}', 'resultado_herramienta'],
    ['```json\n{"huella":"abc"}\n```', 'resultado_herramienta'],
    ['{"producto_id":"42","cantidad":2,"opciones":[]}', 'entrada_herramienta'],
    ['```json\n{"fecha":"2026-09-25","hora":"11:00"}\n```', 'entrada_herramienta'],
    ['Entrada: {"linea_id":"l1","cantidad":2}', 'entrada_herramienta'],
    ['{}', 'entrada_herramienta'],
    ['{"texto":"waffle"}', 'entrada_herramienta'],
    ['```json\n{"tipo_servicio":"catering","personas":50}\n```', 'entrada_herramienta'],
    ['Aquí va:\n```json\n{"texto":"waffle"}\n```', 'entrada_herramienta'],
    ['Primero {"texto":"normal"}; luego {"linea_id":"l1"}', 'entrada_herramienta'],
    ['Claro. {"producto_id":"secret-123"', 'entrada_herramienta'],
    ['Claro. {"texto":"waffle"', 'entrada_herramienta'],
    ['Claro. producto_id: "secret-123"', 'entrada_herramienta'],
    ['Claro. {campo_generico:"valor"', 'entrada_herramienta'],
    ['Aquí va:\n```json\n{"texto":"waffle"', 'entrada_herramienta'],
  ];
  for (const [texto, clase] of casos) {
    assert.equal(detectarSalidaInterna(texto)?.clase, clase, texto);
  }
  assert.equal(detectarSalidaInterna('Dos es menor que tres: 2 < 3.'), null);
  assert.equal(detectarSalidaInterna('Claro, ¿para qué día lo necesitas?'), null);
  assert.equal(detectarSalidaInterna('Aplicado con cariño: todo quedó listo.'), null);
  assert.equal(detectarSalidaInterna('Tu descuento aplicado: $50'), null);
  assert.equal(detectarSalidaInterna('Usa {sin cebolla}'), null);
  assert.equal(detectarSalidaInterna('El costo usa {subtotal} como referencia.'), null);
  assert.equal(detectarSalidaInterna('Nombre: Mario'), null);
});

probar('la puerta compartida también bloquea JSON residual del bot legacy', () => {
  for (const texto of [
    'Claro. {"producto_id":"secret-123"',
    'Claro. {"producto_id":"secret-123"}',
    'Voy a llamar confirmar_pedido para ayudarte.',
  ]) {
    assert.throws(
      () => exigirSalidaPublicable(texto),
      (error) => error instanceof SalidaInternaNoPublicableError
        && error.codigo === 'SALIDA_INTERNA_NO_PUBLICABLE',
      texto,
    );
  }
  assert.equal(exigirSalidaPublicable('Claro, ¿para qué día lo necesitas?'),
    'Claro, ¿para qué día lo necesitas?');
});

probar('un handoff pendiente nunca se declara como turno atendido', () => {
  const pendiente = resultadoDelCanalAgente({
    texto: 'Permíteme un momento, te paso con alguien del equipo.',
    handoffPendiente: true,
  });
  assert.equal(pendiente.ok, false);
  assert.equal(resultadoDelCanalAgente({ handoffPendiente: false }).ok, true);

  const canal = readFileSync(new URL('../src/channels/whatsapp-meta.js', import.meta.url), 'utf8');
  assert.match(canal, /if\s*\(r\.ok\s*&&\s*r\.handoffPendiente\s*!==\s*true\)/,
    'WhatsApp puede publicar antes de confirmar el handoff');
  assert.match(canal, /AGENTE_HANDOFF_NO_CONFIRMADO/,
    'WhatsApp no propaga un fallo durable de pausa a continuidad');
});

probar('brain valida todas las respuestas antes de guardar, parsear o ejecutar', () => {
  const brain = readFileSync(new URL('../src/agent/brain.js', import.meta.url), 'utf8');

  const forzado = brain.slice(
    brain.indexOf('async function extraerBorradorForzado'),
    brain.indexOf('async function extraerMencionesComerciales'),
  );
  assert.ok(forzado.indexOf('textoCompletoDeRespuesta(r)') >= 0);
  assert.ok(forzado.indexOf('textoCompletoDeRespuesta(r)') < forzado.indexOf('txt.match'));

  const menciones = brain.slice(
    brain.indexOf('async function extraerMencionesComerciales'),
    brain.indexOf('// Snapshot canónico'),
  );
  assert.ok(menciones.indexOf('textoCompletoDeRespuesta(r)') >= 0);
  assert.ok(menciones.indexOf('textoCompletoDeRespuesta(r)') < menciones.indexOf('bruto.match'));

  const principal = brain.slice(
    brain.indexOf('async function procesarMensajeInterno'),
    brain.indexOf('// ─── Simulador'),
  );
  const validaPrincipal = principal.indexOf('textoCompletoDeRespuesta(respuesta)');
  assert.ok(validaPrincipal >= 0);
  assert.ok(validaPrincipal < principal.indexOf("agregarMensaje(sessionId, 'assistant'", validaPrincipal));
  assert.ok(validaPrincipal < principal.indexOf('extraerOrden(textoRespuesta)', validaPrincipal));
  assert.match(principal, /instanceof RespuestaModeloTruncadaError\) throw e/);
  const validaSalidaInterna = principal.indexOf('exigirSalidaPublicable(limpiarBloqueComercial(limpiarTexto(textoRespuesta)))');
  assert.ok(validaSalidaInterna >= 0);
  assert.ok(validaSalidaInterna < principal.indexOf("agregarMensaje(sessionId, 'assistant'"),
    'el JSON residual llegó al historial antes del cortafuegos');
  assert.ok(validaSalidaInterna < principal.indexOf('extraerOrden(textoRespuesta)'),
    'el bot interpretó efectos antes del cortafuegos');
  assert.match(principal, /textoFinal\s*=\s*exigirSalidaPublicable\(textoFinal\)/,
    'el texto final del bot legacy no pasa por el cortafuegos compartido');

  const simulador = brain.slice(brain.indexOf('export async function simularMensaje'), brain.indexOf('// ─── Versión streaming'));
  const validaSimulador = simulador.indexOf('textoCompletoDeRespuesta(respuesta)');
  assert.ok(validaSimulador >= 0);
  assert.ok(validaSimulador < simulador.indexOf("agregarMensaje(sessionId, 'assistant'", validaSimulador));
  assert.ok(validaSimulador < simulador.indexOf('extraerOrden(textoRespuesta)', validaSimulador));
  assert.match(simulador, /exigirSalidaPublicable\(limpiarTexto\(textoRespuesta\)\)/);

  const streaming = brain.slice(brain.indexOf('export async function procesarMensajeStream'), brain.indexOf('// ─── Detección de intents'));
  const consumeSeguro = streaming.indexOf('await consumirStreamCompleto(stream');
  assert.ok(consumeSeguro >= 0);
  assert.ok(consumeSeguro < streaming.indexOf("agregarMensaje(sessionId, 'assistant'"));
  assert.ok(consumeSeguro < streaming.indexOf('extraerOrden(textoCompleto)'));
  assert.match(streaming, /exigirSalidaPublicable\(limpiarTexto\(crudo\)\)/);

  const whatsapp = readFileSync(new URL('../src/channels/whatsapp-meta.js', import.meta.url), 'utf8');
  assert.match(whatsapp, /esErrorRespuestaTruncada\(error\)\s*\|\|\s*esErrorSalidaInternaNoPublicable\(error\)/,
    'WhatsApp no convierte la salida interna en revisión humana');
  assert.match(whatsapp, /error\?\.codigo\s*===\s*'AGENTE_HANDOFF_NO_CONFIRMADO'\)\s*throw error/,
    'WhatsApp todavía promete revisión después de fallar la pausa durable');

  const helper = readFileSync(new URL('../src/agent/respuestaTruncada.js', import.meta.url), 'utf8');
  const bloqueStream = helper.slice(helper.indexOf('export async function consumirStreamCompleto'));
  const final = bloqueStream.indexOf('await stream.finalMessage()');
  const validaStream = bloqueStream.indexOf('exigirRespuestaCompleta(respuesta, texto)');
  const publica = bloqueStream.indexOf('onTextoSeguro(texto)');
  assert.ok(final >= 0 && validaStream > final && publica > validaStream);
});

probar('WhatsApp convierte el error tipado en revisión sin enviar prosa parcial', () => {
  const canal = readFileSync(new URL('../src/channels/whatsapp-meta.js', import.meta.url), 'utf8');
  assert.match(canal, /import \{ RespuestaModeloTruncadaError \}/);
  assert.match(canal, /codigo === 'RESPUESTA_MODELO_TRUNCADA'/);

  const catchPrincipal = canal.slice(
    canal.indexOf("console.error('[Meta WA] Error en procesarConClaude:'"),
    canal.indexOf('// ─── Enrutamiento repartidor/cliente'),
  );
  const ramaTruncada = catchPrincipal.indexOf(
    'if (esErrorRespuestaTruncada(error) || esErrorSalidaInternaNoPublicable(error))',
  );
  const mensajeGenerico = catchPrincipal.indexOf('const msgFallo');
  assert.ok(ramaTruncada >= 0 && mensajeGenerico > ramaTruncada);
  assert.match(catchPrincipal.slice(ramaTruncada, mensajeGenerico), /\? 'RESPUESTA_TRUNCADA'\s*: 'SALIDA_INTERNA_NO_PUBLICABLE'/);
  assert.match(catchPrincipal.slice(ramaTruncada, mensajeGenerico), /avisarCliente: false/);

  const catering = canal.slice(canal.indexOf('if (entradaCatering)'), canal.indexOf('// ── EL AGENTE DE HERRAMIENTAS'));
  assert.match(catering, /esErrorRespuestaTruncada\(e\)[\s\S]*'RESPUESTA_TRUNCADA'/);
  assert.match(catering, /publicarCatering\(MENSAJE_CATERING_REVISION\)/);
});

await probarAsync('el agente no ejecuta confirmar_pedido si el tool_use llegó truncado', async () => {
  const catalogo = [{ id: 1, nombre: 'Desayunos', productos: [{
    id: 90, nombre: 'Hotcakes', precio: 95, disponible: true, modificadores: [],
  }] }];
  const estado = estadoNuevo({ negocioId: 'n1', conversacionId: 'truncada-tool' });
  estado.carrito = {
    items: [{ lid: 'l1', nombre: 'Hotcakes', cantidad: 1, modificadores: [], notas: '' }],
    datos: { modalidad: 'recoger en tienda', forma_pago: 'efectivo' },
  };
  const vista = crearEjecutor({
    estado, catalogo, precios: { Hotcakes: 95 }, mensaje: 'sí',
  }).vista();

  let registros = 0;
  let menus = 0;
  let eventos = 0;
  let handoffs = 0;
  const salida = await atenderTurnoConHerramientas({
    negocioId: 'n1', conversacionId: 'truncada-tool', turnoId: 't1',
    mensaje: 'sí', estado, catalogo, precios: { Hotcakes: 95 },
    llamarModelo: async () => ({
      stop_reason: 'max_tokens',
      content: [{
        type: 'tool_use', id: 'confirmacion-parcial', name: 'confirmar_pedido',
        input: { huella_resumen: vista.huella },
      }],
    }),
    efectos: {
      confirmar: async () => { registros += 1; return { ok: true, folio: 'NO-DEBE-EXISTIR' }; },
      enviarMenu: async () => { menus += 1; return { ok: true }; },
      registrarEvento: async () => { eventos += 1; return { ok: true }; },
      escalar: async () => { handoffs += 1; return { ok: true }; },
    },
  });

  assert.deepEqual({ registros, menus, eventos, handoffs },
    { registros: 0, menus: 0, eventos: 0, handoffs: 1 });
  assert.equal(salida.motivoCierre, CIERRE.ERROR);
  assert.equal(salida.escalado, true);
  assert.equal(salida.handoffPendiente, false);
  assert.equal(salida.confirmado, false);
  assert.match(salida.error, /RESPUESTA_MODELO_TRUNCADA/);
  assert.deepEqual(salida.operaciones.map((o) => o.herramienta), ['pedir_humano']);
});

await probarAsync('max_tokens no pregunta por catering después de dejar un handoff pendiente', async () => {
  const estado = estadoNuevo({ negocioId: 'n1', conversacionId: 'truncada-catering' });
  estado.evento = {};
  let handoffs = 0;
  const salida = await atenderTurnoConHerramientas({
    negocioId: 'n1', conversacionId: estado.conversacionId, turnoId: 't-catering',
    mensaje: 'somos 40', estado, catalogo: [],
    llamarModelo: async () => ({
      stop_reason: 'max_tokens', content: [{ type: 'text', text: 'respuesta parcial' }],
    }),
    efectos: {
      escalar: async () => { handoffs += 1; return { ok: true }; },
    },
  });

  assert.equal(handoffs, 0,
    'la guarda de captura debe dejar el handoff técnico al adaptador');
  assert.equal(salida.motivoCierre, CIERRE.ERROR);
  assert.equal(salida.handoffPendiente, true);
  assert.match(salida.error, /RESPUESTA_MODELO_TRUNCADA/);
  const textoContingencia = salida.texto;

  const catering = aplicarSalidaSeguraDeCatering(salida, {
    eventoActivo: true, evento: estado.evento,
  });
  assert.equal(catering.motivo, 'handoff_tecnico_pendiente');
  assert.equal(catering.requiereHandoff, false,
    'el desenlace ya es responsable del handoff pendiente');
  assert.equal(salida.texto, textoContingencia,
    'el postprocesador reemplazó la contingencia por una pregunta de captura');
  assert.equal(salida.motivoCierre, CIERRE.ERROR,
    'el postprocesador ocultó el cierre técnico como una respuesta normal');

  const desenlace = desenlaceDelTurno({ salida, confirmacionIntentada: false });
  assert.equal(desenlace.handoffPendiente, true);
  assert.equal(desenlace.motivoHandoff, 'AGENTE_HANDOFF_PENDIENTE');
});

await probarAsync('context_window no ejecuta una herramienta aunque el bloque venga completo', async () => {
  const estado = estadoNuevo({ negocioId: 'n1', conversacionId: 'contexto-tool' });
  estado.carrito = {
    items: [{ lid: 'l1', nombre: 'Hotcakes', cantidad: 1, modificadores: [], notas: '' }],
    datos: { modalidad: 'recoger en tienda', forma_pago: 'efectivo' },
  };
  const vista = crearEjecutor({
    estado,
    catalogo: [{ id: 1, nombre: 'Desayunos', productos: [{
      id: 90, nombre: 'Hotcakes', precio: 95, disponible: true, modificadores: [],
    }] }],
    precios: { Hotcakes: 95 }, mensaje: 'sí',
  }).vista();
  let registros = 0;
  let handoffs = 0;
  const salida = await atenderTurnoConHerramientas({
    negocioId: 'n1', conversacionId: estado.conversacionId, turnoId: 't-contexto',
    mensaje: 'sí', estado,
    catalogo: [{ id: 1, nombre: 'Desayunos', productos: [{
      id: 90, nombre: 'Hotcakes', precio: 95, disponible: true, modificadores: [],
    }] }],
    precios: { Hotcakes: 95 },
    llamarModelo: async () => ({
      stop_reason: 'model_context_window_exceeded',
      content: [{
        type: 'tool_use', id: 'contexto-parcial', name: 'confirmar_pedido',
        input: { huella_resumen: vista.huella },
      }],
    }),
    efectos: {
      confirmar: async () => { registros += 1; return { ok: true }; },
      escalar: async () => { handoffs += 1; return { ok: true }; },
    },
  });
  assert.equal(registros, 0);
  assert.equal(handoffs, 1);
  assert.equal(salida.motivoCierre, CIERRE.ERROR);
  assert.match(salida.error, /RESPUESTA_MODELO_TRUNCADA/);
});

await probarAsync('el agente nunca publica marcadores o nombres de herramientas como prosa', async () => {
  for (const textoInterno of [
    '<ORDEN_PREVIEW>{"total":500}</ORDEN_PREVIEW>',
    '<CATERING_DATOS_LISTOS>',
    '{"type":"tool_use","name":"confirmar_pedido","input":{}}',
    '{"producto_id":"42","cantidad":2,"opciones":[]}',
    '{}',
    '{"texto":"waffle"}',
    '{"tipo_servicio":"catering","personas":50}',
    'Voy a usar confirmar_pedido.',
  ]) {
    const estado = estadoNuevo({ negocioId: 'n1', conversacionId: `fuga-${textoInterno.length}` });
    let handoffs = 0;
    const salida = await atenderTurnoConHerramientas({
      negocioId: 'n1', conversacionId: estado.conversacionId, turnoId: 't1',
      mensaje: 'hola', estado, catalogo: [],
      llamarModelo: async () => ({
        stop_reason: 'end_turn', content: [{ type: 'text', text: textoInterno }],
      }),
      efectos: { escalar: async () => { handoffs += 1; return { ok: true }; } },
    });
    assert.equal(salida.motivoCierre, CIERRE.ERROR, textoInterno);
    assert.equal(salida.escalado, true, textoInterno);
    assert.equal(handoffs, 1, textoInterno);
    assert.doesNotMatch(salida.texto, /ORDEN_PREVIEW|CATERING_DATOS|tool_use|confirmar_pedido/i);
  }
});

await probarAsync('end_turn tampoco publica un argumento JSON cortado', async () => {
  const textoInterno = 'Claro. {"producto_id":"secret-123"';
  const estado = estadoNuevo({ negocioId: 'n1', conversacionId: 'fuga-json-parcial' });
  let handoffs = 0;
  const salida = await atenderTurnoConHerramientas({
    negocioId: 'n1', conversacionId: estado.conversacionId, turnoId: 't-json-parcial',
    mensaje: 'quiero pedir', estado, catalogo: [],
    llamarModelo: async () => ({
      stop_reason: 'end_turn', content: [{ type: 'text', text: textoInterno }],
    }),
    efectos: { escalar: async () => { handoffs += 1; return { ok: true }; } },
  });

  assert.equal(salida.motivoCierre, CIERRE.ERROR);
  assert.equal(salida.escalado, true);
  assert.equal(handoffs, 1);
  assert.doesNotMatch(salida.texto, /secret-123|producto_id/i);
});

await probarAsync('voz no publica ningún token antes de validar finalMessage', async () => {
  const eventos = [
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Tu pedido está ' } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'confirmado y ' } },
  ];
  let finales = 0;
  const streamTruncado = {
    async *[Symbol.asyncIterator]() { for (const evento of eventos) yield evento; },
    async finalMessage() {
      finales += 1;
      return { stop_reason: 'max_tokens', content: [{ type: 'text', text: 'Tu pedido está confirmado y ' }] };
    },
  };
  const pronunciado = [];
  await assert.rejects(
    () => consumirStreamCompleto(streamTruncado, {
      onTextoSeguro: (texto) => { pronunciado.push(texto); },
    }),
    RespuestaModeloTruncadaError,
  );
  assert.equal(finales, 1);
  assert.deepEqual(pronunciado, [], 'TTS recibió prosa parcial antes del stop_reason');

  const streamCompleto = {
    async *[Symbol.asyncIterator]() { yield eventos[0]; },
    async finalMessage() { return { stop_reason: 'end_turn', content: [] }; },
  };
  await consumirStreamCompleto(streamCompleto, {
    onTextoSeguro: (texto) => { pronunciado.push(texto); },
  });
  assert.deepEqual(pronunciado, ['Tu pedido está ']);
});

if (!process.exitCode) console.log(`\n  TODO VERDE -- ${pasadas} pasadas, 0 fallidas`);
