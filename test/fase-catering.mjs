// Contrato de catering: recopilar cuatro datos para una persona, sin convertir
// la conversación en pedido, cotización ni agenda. Esta suite mezcla reglas
// puras, un recorrido multi-turno de marcadores y guardas de integración sobre
// los adaptadores reales; no necesita proveedor de IA ni Postgres.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MARCA_SESION_CATERING,
  MENSAJE_CATERING_ENTREGADO,
  MENSAJE_CATERING_REVISION,
  TEXTO_CATERING_CANCELADO,
  aplicarPerfilForzado,
  cancelaSolicitudCatering,
  decidirSalidaCatering,
  esSesionCatering,
  esSolicitudCatering,
  exigirCateringForzadoDisponible,
  marcarSesionCatering,
  motivoRespuestaCateringProhibida,
  preguntaSiguienteCatering,
} from '../src/agent/catering.js';
import {
  camposObligatoriosCompletos,
  camposParaPrompt,
  extraerCamposComerciales,
  fechaHoraCateringSuficiente,
  fusionarFechaHoraCatering,
  fusionarCamposCapturados,
  limpiarBloqueComercial,
  tieneCateringListo,
} from '../src/agent/comercialMarkers.js';
import {
  filtrarCapturasCatering, sellarCamposCatering,
} from '../src/agent/evidenciaCatering.js';
import { construirBloqueModoComercial } from '../src/agent/prompts.js';
import { decidirRutaCateringWhatsApp } from '../src/channels/enrutamientoCatering.js';

let pasadas = 0;
async function prueba(nombre, fn) {
  try {
    await fn();
    pasadas += 1;
    console.log(`  OK  ${nombre}`);
  } catch (error) {
    console.error(`FALLO ${nombre}: ${error.message}`);
    throw error;
  }
}

await prueba('detecta servicios de evento explícitos y variantes frecuentes', () => {
  for (const texto of [
    'Quiero contratar catering para mi boda',
    'Necesito mesa de postres para una boda',
    'Busco un coffee break corporativo',
    'Quisiera un buffet para una reunión',
    'Necesito una taquiza para mi cumpleaños',
    'Me interesa servicio de alimentos',
    '¿Manejan catering?',
    '¿Hacen eventos?',
    '¿Hacen eventos o banquetes?',
    'Quiero cotizar mi boda',
    'Quiero cotización para un evento de 40 personas',
    '¿Organizan bodas?',
    '¿Atienden fiestas?',
    '¿Pueden atender mi boda?',
    'Quiero organizar una boda',
    '¿Dan servicio para bodas?',
    '¿Tienen paquetes para bodas?',
    'Quiero festejar mi boda con ustedes',
    'Necesito que atiendan nuestra boda',
    'Busco quién celebre una posada',
    '¿Trabajan eventos?',
    'Comida para 50 personas para una boda',
    '30 desayunos para un evento',
    'No quiero catering, prefiero mesa de postres',
  ]) assert.equal(esSolicitudCatering(texto), true, texto);
});

await prueba('no secuestra pedidos normales ni servicios negados', () => {
  for (const texto of [
    'Quiero ordenar chilaquiles',
    'Desayuno para 2',
    'Desayuno para 30',
    'Desayuno para 30 personas',
    'Necesito comida para 30',
    '30 desayunos para recoger',
    'Quiero 30 desayunos para recoger mañana',
    '50 chilaquiles a domicilio',
    'Comida para cuatro personas',
    'No quiero catering, quiero dos chilaquiles',
    'Catering no, solo quiero ordenar del menú',
    'No es para un evento, quiero 30 desayunos para recoger',
    'No quiero servicio para una fiesta, solo 30 waffles',
    'No necesito desayuno para 30, gracias',
    'Tengo evento pero quiero 2 chilaquiles',
    'No quiero catering',
    '20 personas',
    '¿Qué promociones hay mañana?',
    'Una mesa para poner los postres',
    '¿Manejan servicio de comida a domicilio?',
    '¿A qué hora empieza el servicio de desayuno?',
    'El servicio de cena estuvo excelente',
    'Necesito servicio de desayuno para dos',
  ]) assert.equal(esSolicitudCatering(texto), false, texto);
  assert.equal(esSolicitudCatering('No es para un evento, mejor quiero catering'), true,
    'la segunda señal positiva se perdió junto con la cláusula negada');
});

await prueba('cancelar distingue una salida real de una negación o cambio de servicio', () => {
  for (const texto of [
    'Cancela mi solicitud de catering',
    'Cancela el catering',
    'Quiero cancelar el servicio de catering',
  ]) assert.equal(cancelaSolicitudCatering(texto), true, texto);

  for (const texto of [
    'No quiero cancelar mi solicitud de catering',
    'No deseo cancelar el catering',
    'Cancela el catering, mejor quiero una mesa de postres',
    'Cancela el catering; necesito una taquiza',
    'No quiero catering, prefiero mesa de postres',
  ]) assert.equal(cancelaSolicitudCatering(texto), false, texto);
});

await prueba('solo continúa sesiones marcadas o con datos inequívocos de evento', () => {
  assert.equal(esSesionCatering({ campos_capturados: { [MARCA_SESION_CATERING]: true } }), true);
  for (const campo of ['numero_personas', 'lugar', 'fecha_evento', 'tipo_servicio']) {
    assert.equal(esSesionCatering({ campos_capturados: { [campo]: 'dato' } }), true, campo);
  }
  assert.equal(esSesionCatering({ campos_capturados: { observaciones: 'quiere información' } }), false);
  assert.equal(esSesionCatering({ campos_capturados: { nombre: 'Ana' } }), false);
  assert.equal(esSesionCatering({ campos_capturados: {} }), false);
  assert.equal(esSesionCatering(null), false);
});

await prueba('enruta catering antes de shortcuts: perfil, canario o revisión; nunca legacy', () => {
  assert.equal(decidirRutaCateringWhatsApp({
    solicitudExplicita: true, entradaPerfilCatering: true,
  }), 'perfil_catering');
  assert.equal(decidirRutaCateringWhatsApp({
    solicitudExplicita: true, canarioActivo: true,
  }), 'agente', 'un canario con perfil comercial estándar perdió la solicitud explícita');
  assert.equal(decidirRutaCateringWhatsApp({
    canarioActivo: true, eventoCanarioActivo: true,
  }), 'agente', 'una continuación corta perdió la ficha de evento del canario');
  assert.equal(decidirRutaCateringWhatsApp({
    eventoCanarioActivo: true, canarioActivo: false,
  }), 'revision', 'una ficha activa cayó a legacy al apagar el canario');
  assert.equal(decidirRutaCateringWhatsApp({ solicitudExplicita: true }), 'revision',
    'una solicitud explícita sin perfil ni canario cayó al bot legacy');
  assert.equal(decidirRutaCateringWhatsApp({}), 'normal');
});

await prueba('la marca interna no pisa el nombre conocido ni llega al prompt', () => {
  const nueva = marcarSesionCatering({ lugar: 'Jardín' }, { nombre: 'Ana' });
  assert.equal(nueva[MARCA_SESION_CATERING], true);
  assert.equal(nueva.nombre, 'Ana');
  assert.equal(marcarSesionCatering({ nombre: 'Luz' }, { nombre: 'Ana' }).nombre, 'Luz');
  const vista = camposParaPrompt(nueva, { perfil: 'catering' });
  assert.equal(vista[MARCA_SESION_CATERING], undefined);
});

await prueba('acepta fecha/hora natural para handoff sin usarla como autoridad DATE', () => {
  for (const fecha_evento of [
    'el sábado 5 a las 2',
    '5 de octubre a las 2 pm',
    'mañana por la tarde',
    'el próximo viernes a las 14:30',
    '2026-10-15 18:00',
  ]) assert.equal(fechaHoraCateringSuficiente({ fecha_evento }), true, fecha_evento);
  for (const fecha_evento of ['octubre', 'el sábado', '5 de octubre', 'a las 2', 'algún día']) {
    assert.equal(fechaHoraCateringSuficiente({ fecha_evento }), false, fecha_evento);
  }
});

await prueba('los cuatro mínimos entregan; sin asistentes o sin hora no', () => {
  const completos = {
    nombre: 'Ana', numero_personas: '40', lugar: 'Jardín',
    fecha_evento: 'el sábado 5 a las 2 pm',
  };
  assert.equal(camposObligatoriosCompletos(completos, { perfil: 'catering' }), true);
  assert.equal(camposObligatoriosCompletos({ ...completos, numero_personas: '' }, { perfil: 'catering' }), false);
  assert.equal(camposObligatoriosCompletos({ ...completos, fecha_evento: '5 de octubre' }, { perfil: 'catering' }), false);
  assert.equal(camposObligatoriosCompletos({ ...completos, lugar: '' }, { perfil: 'catering' }), false);
  assert.equal(camposObligatoriosCompletos({ ...completos, nombre: '' }, { perfil: 'catering' }), false);
});

await prueba('la fecha natural capturada se conserva y no se repregunta por fallar el parser', () => {
  const respuesta = 'Perfecto. <CAMPO_COMERCIAL_CAPTURADO>{"campo":"fecha_evento","valor":"el sábado 5 a las 2"}</CAMPO_COMERCIAL_CAPTURADO>';
  const fusionados = fusionarCamposCapturados({}, extraerCamposComerciales(respuesta));
  assert.equal(fusionados.fecha_evento, 'el sábado 5 a las 2');
  assert.equal(camposParaPrompt(fusionados, { perfil: 'catering' }).fecha_evento,
    'el sábado 5 a las 2');
  assert.equal(camposParaPrompt(fusionados).fecha_evento, undefined,
    'el perfil estándar sí conserva su validación DATE');
});

await prueba('fecha y hora en turnos separados se fusionan sin confiar en texto inventado', () => {
  const previos = sellarCamposCatering({ fecha_evento: '5 de octubre' }, ['fecha_evento']);
  const parcial = filtrarCapturasCatering([
    { campo: 'fecha_evento', valor: 'a las 2 pm' },
  ], { mensaje: 'Sería a las 2 pm', camposPrevios: previos });
  assert.equal(parcial.aceptadas.length, 1);
  const fusionados = fusionarCamposCapturados(
    previos, parcial.aceptadas, { perfil: 'catering' },
  );
  assert.equal(fusionados.fecha_evento, '5 de octubre a las 2 pm');
  assert.equal(fechaHoraCateringSuficiente(fusionados), true);

  const combinadaPorModelo = filtrarCapturasCatering([
    { campo: 'fecha_evento', valor: '5 de octubre a las 2 pm' },
  ], { mensaje: 'Sería a las 2 pm', camposPrevios: previos });
  assert.equal(combinadaPorModelo.aceptadas.length, 1,
    'rechazó una combinación formada solo con dos piezas literales verificadas');
  const inventada = filtrarCapturasCatering([
    { campo: 'fecha_evento', valor: '5 de octubre a las 3 pm' },
  ], { mensaje: 'Sería a las 2 pm', camposPrevios: previos });
  assert.equal(inventada.aceptadas.length, 0, 'el modelo cambió la hora que dijo el cliente');
  assert.equal(fusionarFechaHoraCatering('a las 2 pm', '5 de octubre'),
    '5 de octubre a las 2 pm');
  assert.equal(fechaHoraCateringSuficiente({ fecha_evento: 'por la mañana' }), false,
    'una franja sola se contó también como fecha por contener «mañana»');
  assert.equal(fechaHoraCateringSuficiente({
    fecha_evento: 'el sábado a las dos de la tarde',
  }), true, 'la hora escrita en español no completó fecha y hora');
  assert.equal(fechaHoraCateringSuficiente({ fecha_evento: 'a las dos de la mañana' }), false,
    'una hora escrita sola volvió a contar «mañana» como fecha');
});

await prueba('recorrido multi-turno solo queda listo al cuarto dato', () => {
  let campos = marcarSesionCatering({});
  const turnos = [
    '<CAMPO_COMERCIAL_CAPTURADO>{"campo":"nombre","valor":"Ana"}</CAMPO_COMERCIAL_CAPTURADO>',
    '<CAMPO_COMERCIAL_CAPTURADO>{"campo":"fecha_evento","valor":"el sábado 5 a las 2"}</CAMPO_COMERCIAL_CAPTURADO>',
    '<CAMPO_COMERCIAL_CAPTURADO>{"campo":"lugar","valor":"Jardín Aurora"}</CAMPO_COMERCIAL_CAPTURADO>',
    '<CAMPO_COMERCIAL_CAPTURADO>{"campo":"numero_personas","valor":"40"}</CAMPO_COMERCIAL_CAPTURADO>',
  ];
  turnos.forEach((turno, indice) => {
    campos = fusionarCamposCapturados(campos, extraerCamposComerciales(turno));
    assert.equal(camposObligatoriosCompletos(campos, { perfil: 'catering' }), indice === 3);
  });
  assert.deepEqual(decidirSalidaCatering({
    cateringListo: true, texto: 'El modelo intentó redactar otra cosa',
  }), { accion: 'entregar', motivo: 'datos_listos', texto: MENSAJE_CATERING_ENTREGADO });
});

await prueba('el marcador de cierre nunca queda visible', () => {
  const crudo = 'texto<CATERING_DATOS_LISTOS>';
  assert.equal(tieneCateringListo(crudo), true);
  assert.equal(limpiarBloqueComercial(crudo), 'texto');
});

await prueba('la barrera bloquea precio, cotización, disponibilidad y agenda', () => {
  const prohibidas = new Map([
    ['El paquete cuesta $500 MXN', 'precio'],
    ['Te preparo una cotización', 'precio'],
    ['La tarifa sería de 300 pesos', 'precio'],
    ['Tu evento quedó agendado', 'agenda'],
    ['Ya está programado para el sábado', 'agenda'],
    ['Tenemos disponibilidad ese día', 'promesa_comercial'],
    ['<ORDEN_CONFIRMADA>{}</ORDEN_CONFIRMADA>', 'marcador_transaccional'],
    ['', 'respuesta_vacia'],
  ]);
  for (const [texto, motivo] of prohibidas) {
    assert.equal(motivoRespuestaCateringProhibida(texto), motivo, texto);
  }
  for (const texto of [
    '¿A nombre de quién registro los datos?',
    '¿Cuántas personas asistirán?',
    '¿En qué lugar será el evento?',
    '¿Qué fecha y hora tienen contempladas?',
    MENSAJE_CATERING_ENTREGADO,
    MENSAJE_CATERING_REVISION,
  ]) assert.equal(motivoRespuestaCateringProhibida(texto), null, texto);
});

await prueba('la decisión final falla cerrada y usa texto de código', () => {
  assert.deepEqual(decidirSalidaCatering({ texto: '  ¿Cuántas personas?  ' }),
    { accion: 'responder', motivo: null, texto: '¿Cuántas personas?' });
  for (const resultado of [
    { texto: 'Cuesta $500' },
    { texto: 'Listo', cateringCierrePrematuro: true },
    { texto: 'Listo', marcadorTruncado: true },
    { texto: 'Listo', orden: { id: 'NO' } },
    { texto: '' },
  ]) {
    const decision = decidirSalidaCatering(resultado);
    assert.equal(decision.accion, 'revision');
    assert.equal(decision.texto, MENSAJE_CATERING_REVISION);
  }
});

await prueba('las preguntas de captura también son deterministas', () => {
  assert.match(preguntaSiguienteCatering({}), /nombre/i);
  assert.match(preguntaSiguienteCatering({ nombre: 'Ana' }), /cuántas personas/i);
  assert.match(preguntaSiguienteCatering({ nombre: 'Ana', numero_personas: 40 }), /qué lugar/i);
  assert.match(preguntaSiguienteCatering({
    nombre: 'Ana', numero_personas: 40, lugar: 'Jardín', fecha_evento: '5 de octubre',
  }), /qué hora|qué franja/i);
  assert.equal(preguntaSiguienteCatering({
    nombre: 'Ana', numero_personas: 40, lugar: 'Jardín',
    fecha_evento: '5 de octubre a las 2 pm',
  }), null);
  assert.deepEqual(decidirSalidaCatering({
    texto: 'Claro, tenemos muchos platillos',
    cateringCampos: { nombre: 'Ana' },
  }), { accion: 'responder', motivo: null, texto: '¿Para cuántas personas sería el evento?' });
});

await prueba('el prompt limita la tarea a captura y handoff', () => {
  const prompt = construirBloqueModoComercial({
    fecha_evento: 'el sábado 5 a las 2', [MARCA_SESION_CATERING]: true,
  }, { perfil: 'catering' });
  assert.match(prompt, /tu única tarea es recopilar los datos y entregarlos/i);
  assert.match(prompt, /fecha y hora aproximada/i);
  assert.match(prompt, /no agendes, reserves, apartes ni confirmes/i);
  assert.match(prompt, /<CATERING_DATOS_LISTOS>/);
  assert.match(prompt, /NO\s+crea una cotización, un pedido, una reserva ni un evento agendado/i);
  assert.match(prompt, /el sábado 5 a las 2/);
  assert.doesNotMatch(prompt, /__perfil_catering/);
});

await prueba('el canal da precedencia, pausa, alinea historial y finaliza', () => {
  const canal = readFileSync(new URL('../src/channels/whatsapp-meta.js', import.meta.url), 'utf8');
  const entrada = canal.indexOf('let entradaCatering = false');
  const menu = canal.indexOf('mensajePideMenu(texto', entrada);
  const flujo = canal.indexOf('if (entradaCatering)', menu);
  const agente = canal.indexOf('// ── EL AGENTE DE HERRAMIENTAS', flujo);
  const bloque = canal.slice(flujo, agente);
  assert.ok(entrada >= 0 && menu > entrada && flujo > menu && agente > flujo);
  assert.match(canal.slice(entrada, flujo), /!entradaCatering[\s\S]*mensajePideMenu/);
  assert.match(canal.slice(entrada, flujo), /modoAgente = await modoDelPedido[\s\S]*rutaCatering === 'normal'/,
    'el modo canario debe resolverse antes de cualquier shortcut');
  assert.match(canal.slice(entrada, flujo), /session_id = \$2[\s\S]*`agente:\$\{telefono\}`/,
    'las continuaciones no consultan la ficha durable del canario');
  assert.match(bloque, /decidirSalidaCatering\(\{/);
  assert.match(bloque, /motivo: 'CATERING_DATOS_LISTOS'/);
  assert.match(bloque, /avisarCliente: false/);
  assert.match(bloque, /alinearHistorialCatering\(mensaje\)/);
  assert.match(bloque, /cerrarSesionCatering\('catering_entregado_a_humano'\)/);
  assert.match(bloque, /if \(!handoffConfirmado\) throw e/);
});

await prueba('runtime: una sesión catering con preview previo no alcanza pedido, pago ni menú', async () => {
  const canal = readFileSync(new URL('../src/channels/whatsapp-meta.js', import.meta.url), 'utf8');
  const inicio = canal.indexOf('let modoAgente = null');
  const fin = canal.indexOf('// ── EL AGENTE DE HERRAMIENTAS', inicio);
  assert.ok(inicio >= 0 && fin > inicio);

  // Ejecuta la rama REAL del adaptador con dependencias inyectadas. El código
  // añadido al final representa la entrada al pipeline genérico: el `return`
  // de catering debe hacerlo inalcanzable tanto en éxito como en fail-close.
  const nombres = [
    'pool', 'negocioId', 'obtenerSesionActiva', 'telefono', 'esSesionCatering',
    'esSolicitudCatering', 'cancelaSolicitudCatering', 'texto', 'pasarAgenteARevision', 'continuidadWA',
    'modoDelPedido', 'decidirRutaCateringWhatsApp',
    'nombreMeta', 'credenciales', 'obtenerMenuParaEnvio', 'mensajePideMenu',
    'enviarMenuAutomatico', 'enviarMensaje', 'enviarImagenBuffer', 'guardarMensaje',
    'obtenerCliente', 'obtenerUltimosPedidos', 'upsertCliente', 'getSession',
    'reemplazarUltimoMensajeAsistente', 'agregarMensaje', 'procesarMensaje',
    'decidirSalidaCatering', 'esErrorRespuestaTruncada', 'wsBroadcast', 'finalizarSesion',
    'MENSAJE_CATERING_REVISION', 'TEXTO_CATERING_CANCELADO', 'console', 'efectos',
    'registrarPedido', 'crearEnlacePago',
  ];
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const ejecutarRama = new AsyncFunction(...nombres,
    `${canal.slice(inicio, fin)}\nawait registrarPedido(); await crearEnlacePago(); efectos.pipelinePedido += 1;`);

  const crearEscenario = ({ fallaConfigInterna = false, sinSesion = false,
    texto = 'sí' } = {}) => {
    const efectos = {
      preview: { total: 450 }, captura: 0, handoff: 0, menu: 0, registro: 0, enlace: 0,
      respuestas: [], cierre: 0, pipelinePedido: 0,
    };
    const sesionComercial = {
      id: 'sc-1', campos_capturados: marcarSesionCatering({
        nombre: 'Ana', numero_personas: 30, lugar: 'Jardín',
        fecha_evento: 'el sábado 5 a las 2 pm',
      }),
    };
    const memoria = { mensajes: [] };
    const procesarMensaje = async (...args) => {
      const control = args.at(-1);
      const forzado = aplicarPerfilForzado(control, () => { efectos.preview = null; });
      exigirCateringForzadoDisponible(forzado, {
        moduloHabilitado: !fallaConfigInterna,
        perfilComercial: fallaConfigInterna ? 'estandar' : 'catering',
      });
      efectos.captura += 1;
      memoria.mensajes.push({ role: 'assistant', content: 'texto interno' });
      return {
        texto: MENSAJE_CATERING_ENTREGADO, cateringListo: true,
        cateringCampos: sesionComercial.campos_capturados,
        sesionComercialId: sesionComercial.id,
      };
    };
    return {
      efectos,
      args: [
        { query: async () => ({ rows: [{ perfil: 'catering', estado_modulo: 'activo' }] }) },
        'neg-1', async () => (sinSesion ? null : sesionComercial), '528100000000', esSesionCatering,
        esSolicitudCatering, cancelaSolicitudCatering, texto, async () => { efectos.handoff += 1; return true; },
        {}, async () => ({ agente: false }), decidirRutaCateringWhatsApp,
        null, {}, async () => ({ activo: true, imagenes: ['menu.jpg'] }),
        () => true, async () => { efectos.menu += 1; },
        async (_tel, mensaje) => { efectos.respuestas.push(mensaje); }, async () => {},
        async () => null, async () => null, async () => [], async () => {},
        () => memoria,
        (_id, mensaje) => { memoria.mensajes.at(-1).content = mensaje; },
        (_id, role, content) => { memoria.mensajes.push({ role, content }); },
        procesarMensaje, decidirSalidaCatering, () => false, null,
        async () => { efectos.cierre += 1; }, MENSAJE_CATERING_REVISION,
        TEXTO_CATERING_CANCELADO, { log() {}, warn() {}, error() {} }, efectos,
        async () => { efectos.registro += 1; }, async () => { efectos.enlace += 1; },
      ],
    };
  };

  const feliz = crearEscenario();
  await ejecutarRama(...feliz.args);
  assert.equal(feliz.efectos.preview, null, 'el preview anterior debe invalidarse primero');
  assert.deepEqual({
    captura: feliz.efectos.captura,
    handoff: feliz.efectos.handoff,
    menu: feliz.efectos.menu,
    registro: feliz.efectos.registro,
    enlace: feliz.efectos.enlace,
    pipelinePedido: feliz.efectos.pipelinePedido,
  }, { captura: 1, handoff: 1, menu: 0, registro: 0, enlace: 0, pipelinePedido: 0 });
  assert.deepEqual(feliz.efectos.respuestas, [MENSAJE_CATERING_ENTREGADO]);
  assert.equal(feliz.efectos.cierre, 1);

  const configRota = crearEscenario({ fallaConfigInterna: true });
  await ejecutarRama(...configRota.args);
  assert.equal(configRota.efectos.preview, null);
  assert.deepEqual({
    captura: configRota.efectos.captura,
    handoff: configRota.efectos.handoff,
    menu: configRota.efectos.menu,
    registro: configRota.efectos.registro,
    enlace: configRota.efectos.enlace,
    pipelinePedido: configRota.efectos.pipelinePedido,
  }, { captura: 0, handoff: 1, menu: 0, registro: 0, enlace: 0, pipelinePedido: 0 });
  assert.deepEqual(configRota.efectos.respuestas, [MENSAJE_CATERING_REVISION]);

  const mixta = crearEscenario({
    sinSesion: true,
    texto: 'Quiero catering para una boda y pagar con enlace; ¿cómo va mi pedido?',
  });
  await ejecutarRama(...mixta.args);
  assert.deepEqual({
    captura: mixta.efectos.captura,
    handoff: mixta.efectos.handoff,
    menu: mixta.efectos.menu,
    registro: mixta.efectos.registro,
    enlace: mixta.efectos.enlace,
    pipelinePedido: mixta.efectos.pipelinePedido,
  }, { captura: 1, handoff: 1, menu: 0, registro: 0, enlace: 0, pipelinePedido: 0 },
  'un atajo de pago/estado secuestró la entrada explícita de catering');

  const cancelada = crearEscenario({ texto: 'Cancela el catering' });
  await ejecutarRama(...cancelada.args);
  assert.deepEqual({
    captura: cancelada.efectos.captura,
    handoff: cancelada.efectos.handoff,
    menu: cancelada.efectos.menu,
    registro: cancelada.efectos.registro,
    enlace: cancelada.efectos.enlace,
    pipelinePedido: cancelada.efectos.pipelinePedido,
  }, { captura: 0, handoff: 0, menu: 0, registro: 0, enlace: 0, pipelinePedido: 0 });
  assert.equal(cancelada.efectos.cierre, 1, 'la sesión cancelada siguió activa');
  assert.deepEqual(cancelada.efectos.respuestas, [TEXTO_CATERING_CANCELADO]);
});

await prueba('el módulo es corte maestro y una observación no reactiva sesiones', () => {
  const brain = readFileSync(new URL('../src/agent/brain.js', import.meta.url), 'utf8');
  assert.match(brain, /const entradaCatering = moduloHabilitado && perfilComercial === 'catering'/);
  assert.match(brain, /cateringForzado \|\| esSesionCatering\(sesionExistente\) \|\| esSolicitudCatering\(mensajeUsuario\)/);
  assert.ok(brain.indexOf('aplicarPerfilForzado(') < brain.indexOf('verPreviewPedido(sessionId)'),
    'el perfil forzado debe invalidar antes del atajo determinista del preview');
  assert.match(brain, /if \(!cateringForzado && verPreviewPedido\(sessionId\)/);
  assert.match(brain, /if \(!turnoCatering && typeof negocioId/);
  assert.match(brain, /enviarMenu: !turnoCatering/);
  assert.match(brain, /perfilComercial === 'catering'[\s\S]{0,120}\? \(entradaCatering \? 'solicitud_comercial' : 'ambiguo'\)/);
  assert.match(brain, /perfilComercial === 'catering'[\s\S]{0,500}invalidarPreviewPedido\(sessionId\)[\s\S]{0,100}ordenParaRegistrar = null/,
    'un marcador de pedido del modelo dejó un preview confirmable tras el handoff');
});

await prueba('la rama catering retorna antes de DraftBuilder/PDF', () => {
  const brain = readFileSync(new URL('../src/agent/brain.js', import.meta.url), 'utf8');
  const inicio = brain.indexOf('async function procesarCapturaComercial');
  const captura = brain.slice(inicio);
  const ramaCatering = captura.indexOf("if (opciones.perfil === 'catering')");
  const draft = captura.indexOf('await generarBorradorDesdeSesion');
  const notificacion = captura.indexOf('await notificarBorradorAlAdmin');
  assert.ok(inicio >= 0 && ramaCatering >= 0 && draft > ramaCatering && notificacion > draft);
  assert.match(captura.slice(ramaCatering, draft), /return completos/);
  assert.doesNotMatch(captura.slice(ramaCatering, draft), /cotizacion|PDF|precioUnitario/i);
});

await prueba('truncación general y motivos de catering son visibles para el equipo', () => {
  const canal = readFileSync(new URL('../src/channels/whatsapp-meta.js', import.meta.url), 'utf8');
  const panel = readFileSync(new URL('../panel/index.html', import.meta.url), 'utf8');
  assert.match(canal, /motivo: 'RESPUESTA_TRUNCADA'[\s\S]{0,100}marcadorTruncado/);
  for (const motivo of [
    'RESPUESTA_TRUNCADA', 'CATERING_DATOS_LISTOS',
    'CATERING_REVISION_HUMANA', 'CATERING_CONFIGURACION_FALLIDA',
  ]) {
    assert.ok(canal.includes(motivo), `canal sin ${motivo}`);
    assert.ok(panel.includes(`${motivo}:`), `panel sin ${motivo}`);
  }
});

console.log(`\nCatering: ${pasadas} grupos de invariantes pasados, 0 fallidos.`);
