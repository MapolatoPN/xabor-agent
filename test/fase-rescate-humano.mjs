// ─── RESCATE HUMANO: PRUEBAS PURAS (sin base, sin red, sin modelo) ─────────
//
// Incidente 2-oct-2026, Mapolato Obispado: dos fallos del proveedor, el mismo
// formulario dos veces, «No carga» y el cliente se fue sin que nadie del
// equipo se enterara. Aquí se fija la DECISIÓN (rescateHumano.js) y el AVISO
// (avisoRescateHumano.js) con dobles; el camino completo contra Postgres está
// en fase-rescate-humano-db.mjs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const noAtendidas = [];
process.on('unhandledRejection', (e) => { noAtendidas.push(e); });

const R = await import('../src/mesero-agente/rescateHumano.js');
const { TEXTOS_RECIBO_HANDOFF } = await import('../src/mesero-agente/reciboHandoff.js');
const { pedidoSinArmar } = await import('../src/mesero-agente/experienciaHibrida.js');
const { respuestaAfirmaCambioSinAplicar } = await import('../src/mesero-agente/seguridadConversacional.js');
const A = await import('../src/services/avisoRescateHumano.js');
const { avisarAHumano } = await import('../src/mesero-agente/canalDelAgente.js');

let pasadas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); pasadas += 1; console.log(`    OK  ${nombre}`); }
  catch (e) { fallos.push(`${nombre}: ${e.message}`); console.log(`> FALLO ${nombre}: ${e.message}`); }
}

const CON = { [R.BANDERA_RESCATE]: 'true' };
const SIN = {};
const MIN = 60 * 1000;
const T0 = Date.UTC(2026, 9, 2, 18, 0, 0);
const estadoBase = (extra = {}) => ({
  hechos: { confirmado: false, escalado: false, cancelado: false, fallido: false },
  folio: null, evento: null, confirmacionIncierta: false, pendiente: null,
  carrito: { items: [], datos: {} }, ...extra,
});
const falla = () => ({ recuperacion: 'fallo_proveedor_sin_efectos', texto: 'Disculpa la demora…' });
const TEL = '520000004321';

// ── 1 · «No carga» ─────────────────────────────────────────────────────────
const POSITIVAS = ['No carga', 'no me carga', 'No abre', 'No se abre el formulario', 'El formulario no carga',
  'No me deja elegir', 'no puedo elegir los platillos', 'Se queda cargando', 'se traba', 'El botón no funciona',
  'no funciona el link', 'No me aparece nada', 'No me abre la liga', 'me sale un error', 'ya le piqué y no abre',
  'La página no carga 😕', 'no me deja', 'no me sale el formulario', 'no jala', 'se me cierra la app',
  'Buenas tardes, no me carga el formulario',
  // La queja entera, con lo que la rodea sin cambiarla (revisión del 3-oct).
  'no carga nada', 'Oiga no me carga', 'Ya no me carga', 'no me deja hacer nada', 'ya lo intenté y no carga',
  'No carga, ayuda', 'no me abre ¿qué hago?', 'no carga no carga', 'no sirve', 'intenté pedir pero no me deja',
  'le di varias veces y no abre', 'no me carga en mi cel', 'no termina de cargar', 'sigue sin cargar',
  'hoy no me abre el formulario', 'no me aparece el menú'];
// Revisión del 3-oct: todas daban `true` y pausaban al bot por una pregunta
// que el modelo contestaba solo (horario, pedido, dinero, nota de entrega).
const NEGATIVAS_DE_LA_REVISION = ['¿todavía no abre?', '¿ya no abre?', '¿no abre en la noche?', '¿no abre en la tarde?',
  '¿no abre el fin de semana?', '¿no abre en navidad?', '¿la cocina no abre hasta las 2?',
  '¿no puedo pedir a domicilio?', '¿no puedo ordenar sin cebolla?', '¿No puedo agregar otro?', 'no puedo pedir 2?',
  'No cargo efectivo, ¿aceptan tarjeta?', '¿no me carga comisión con tarjeta?',
  'Toquen fuerte porque no funciona el timbre', 'no abre el portón, marquen al llegar'];
const NEGATIVAS = ['¿no abren los domingos?', 'no me dejes sin salsa', '¿no sale a domicilio?', '¿hoy no abre?',
  '¿no abre los lunes?', '¿a qué hora abre?', 'no quiero cebolla', 'no me cobres el envío',
  'mi mamá no me deja comer picante', '¿mañana no abren?', 'no sé si abren hoy', 'no hay problema', 'no, gracias',
  '¿el restaurante no abre?', 'quiero 2 chilaquiles sin crema, no me gusta', '¿a qué hora cierran?',
  'no puedo pedir para mañana?', 'ya cargó, gracias', 'no tengo cambio de 500',
  `Quiero unos chilaquiles verdes con pollo y un café; para recoger, pago en efectivo. ${'Gracias. '.repeat(14)}no carga`,
  ...NEGATIVAS_DE_LA_REVISION,
  // «No abre» sin pronombre tras un saludo es de horario; el menú «del día» o
  // «de la noche» es la carta, no una pantalla.
  'oiga, ¿no abre?', 'Buenas noches, ¿no abre?', '¿ahorita no abre?', '¿hoy no sale el menú del día?',
  '¿en la noche no aparece el menú de desayunos?', '¿no puedo elegir otra salsa?', '¿no funciona la terminal?',
  'no me deja pedir a domicilio', 'no carga la tarjeta', 'no sirve de nada que me digas'];

await t('01 «no carga / no abre / no me deja» se reconoce; las preguntas de horario, pedido o dinero no', () => {
  const falsosNegativos = POSITIVAS.filter((m) => !R.formularioNoCarga(m));
  const falsosPositivos = NEGATIVAS.filter((m) => R.formularioNoCarga(m));
  assert.deepEqual(falsosNegativos, [], 'frases de «no carga» que no se reconocen');
  assert.deepEqual(falsosPositivos, [], 'frases ajenas que se toman por «no carga»');
  assert.ok(POSITIVAS.length >= 37 && NEGATIVAS.length >= 45 && NEGATIVAS_DE_LA_REVISION.length === 15);
  // Una entrada hecha para la vuelta atrás exponencial no puede trabar el turno.
  const t0 = Date.now();
  for (let i = 0; i < 50; i++) R.formularioNoCarga(`${'ya le piqué y '.repeat(10)}no abre otra`);
  assert.ok(Date.now() - t0 < 500, `la detección tardó ${Date.now() - t0} ms en 50 entradas`);
});

// ── 2 · Bandera apagada: nada cambia y nada se escribe ──────────────────────
await t('02 con la bandera apagada no decide nada ni escribe estado.rescate', async () => {
  const estado = estadoBase({ rescate: undefined });
  delete estado.rescate;
  const antes = structuredClone(estado);
  assert.equal(R.registrarFalloDelTurno({ cfg: SIN, estado, salida: falla(), ahora: T0 }), false);
  assert.equal(R.registrarFalloDelTurno({ cfg: SIN, estado, salida: falla(), ahora: T0 + MIN }), false);
  assert.deepEqual(estado, antes, 'la bandera apagada escribió en el estado');
  assert.equal(R.decidirRescate({ cfg: SIN, estado: estadoBase({ rescate: { fallos: [T0, T0 + MIN] } }),
    salida: falla(), ahora: T0 + 2 * MIN }), null);
  let consultas = 0;
  assert.equal(await R.rescateAntesDelModelo({ cfg: SIN, estado: estadoBase({ rescate: { fallos: [T0] } }),
    mensaje: 'No carga', ahora: T0 + MIN, formularioReciente: async () => { consultas += 1; return true; } }), null);
  assert.equal(consultas, 0, 'sin bandera no se consulta la base');
  assert.equal(R.rescateActivo({ [R.BANDERA_RESCATE]: 'false' }), false);
});

// ── 3 · La ventana ─────────────────────────────────────────────────────────
await t('03 dos fallos a 9 min escalan; a 11 min no', () => {
  for (const [separacion, esperado] of [[9, R.MOTIVOS_RESCATE.FALLO_REPETIDO], [11, null]]) {
    const estado = estadoBase();
    R.registrarFalloDelTurno({ cfg: CON, estado, salida: falla(), ahora: T0 });
    assert.equal(R.decidirRescate({ cfg: CON, estado, salida: falla(), ahora: T0 }), null, 'un solo fallo no escala');
    const ahora = T0 + separacion * MIN;
    R.registrarFalloDelTurno({ cfg: CON, estado, salida: falla(), ahora });
    assert.equal(R.decidirRescate({ cfg: CON, estado, salida: falla(), ahora })?.motivo ?? null, esperado,
      `separación de ${separacion} min`);
  }
});

await t('04 el corte por tiempo cuenta como fallo; un turno sano en medio no borra la marca', () => {
  const estado = estadoBase();
  R.registrarFalloDelTurno({ cfg: CON, estado, salida: falla(), ahora: T0 });
  R.registrarFalloDelTurno({ cfg: CON, estado, salida: { recuperacion: null, texto: 'ok' }, ahora: T0 + MIN });
  assert.equal(estado.rescate.fallos.length, 1);
  R.registrarFalloDelTurno({ cfg: CON, estado, salida: falla(), ahora: T0 + 2 * MIN });
  assert.equal(R.decidirRescate({ cfg: CON, estado, salida: falla(), ahora: T0 + 2 * MIN })?.motivo,
    R.MOTIVOS_RESCATE.FALLO_REPETIDO);
  // Solo en el turno que falla: con dos marcas y un turno sano no se escala.
  assert.equal(R.decidirRescate({ cfg: CON, estado, salida: { recuperacion: null }, ahora: T0 + 3 * MIN }), null);
});

await t('05 la ventana se configura entre 1 y 60 min; lo demás cae a 10', () => {
  assert.equal(R.ventanaMs({}), 10 * MIN);
  assert.equal(R.ventanaMs({ [R.CLAVE_VENTANA_MIN]: '5' }), 5 * MIN);
  for (const v of ['0', '-3', 'abc', '999', '']) assert.equal(R.ventanaMs({ [R.CLAVE_VENTANA_MIN]: v }), 10 * MIN, v);
});

// ── 4 · Exclusiones del predicado único ───────────────────────────────────
await t('06 folio, evento, confirmación incierta, cualquier hecho o un toque: no hay rescate', async () => {
  const casos = {
    folio: estadoBase({ folio: 'XAB-0001' }),
    evento: estadoBase({ evento: { tipo_servicio: 'catering' } }),
    incierta: estadoBase({ confirmacionIncierta: true }),
    ...Object.fromEntries(['confirmado', 'escalado', 'cancelado', 'fallido'].map((h) =>
      [h, estadoBase({ hechos: { confirmado: false, escalado: false, cancelado: false, fallido: false, [h]: true } })])),
  };
  for (const [nombre, estado] of Object.entries(casos)) {
    estado.rescate = { fallos: [T0, T0 + MIN] };
    assert.equal(R.decidirRescate({ cfg: CON, estado, salida: falla(), ahora: T0 + 2 * MIN }), null, nombre);
    assert.equal(await R.rescateAntesDelModelo({ cfg: CON, estado, mensaje: 'No carga', ahora: T0 + 2 * MIN,
      formularioReciente: async () => true }), null, nombre);
  }
  const estado = estadoBase({ rescate: { fallos: [T0, T0 + MIN] } });
  const toque = { mensajes: [], mixto: false };
  assert.equal(R.decidirRescate({ cfg: CON, estado, salida: falla(), interaccion: toque, ahora: T0 + 2 * MIN }), null);
  assert.equal(await R.rescateAntesDelModelo({ cfg: CON, estado, mensaje: 'No carga', interaccion: toque,
    ahora: T0 + 2 * MIN, formularioReciente: async () => true }), null);
  // Un lote mixto (texto + toque) sí trae texto del cliente.
  assert.ok(await R.rescateAntesDelModelo({ cfg: CON, estado, mensaje: 'No carga', interaccion: { mixto: true },
    ahora: T0 + 2 * MIN }));
  // Ya escalado por otro camino (el 3er fallo del bucle) o con handoff pendiente: no se duplica.
  for (const extra of [{ escalado: true }, { handoffPendiente: true }, { respuestaDeSistema: 'consulta_promociones' }]) {
    assert.equal(R.decidirRescate({ cfg: CON, estado, salida: { ...falla(), ...extra }, ahora: T0 + 2 * MIN }), null,
      JSON.stringify(extra));
  }
});

await t('07 «No carga» sin formulario reciente ni fallo: no hay rescate; con uno de los dos, sí', async () => {
  const estado = estadoBase();
  assert.equal(await R.rescateAntesDelModelo({ cfg: CON, estado, mensaje: 'No carga', ahora: T0 }), null);
  assert.equal(await R.rescateAntesDelModelo({ cfg: CON, estado, mensaje: 'No carga', ahora: T0,
    formularioReciente: async () => { throw new Error('base caída'); } }), null, 'un error de lectura no rescata');
  const conFormulario = await R.rescateAntesDelModelo({ cfg: CON, estado, mensaje: 'No carga', ahora: T0,
    formularioReciente: async () => true });
  assert.equal(conFormulario?.tipo, 'rescate_humano');
  assert.equal(conFormulario?.motivo, R.MOTIVOS_RESCATE.FORMULARIO_NO_CARGA);
  assert.equal(conFormulario?.texto, R.TEXTO_RESCATE);
  assert.equal(conFormulario?.pendiente, null);
  let consultas = 0;
  const conFallo = await R.rescateAntesDelModelo({ cfg: CON, estado: estadoBase({ rescate: { fallos: [T0] } }),
    mensaje: 'no me abre', ahora: T0 + 5 * MIN, formularioReciente: async () => { consultas += 1; return false; } });
  assert.equal(conFallo?.motivo, R.MOTIVOS_RESCATE.FORMULARIO_NO_CARGA);
  assert.equal(consultas, 0, 'con un fallo reciente no hace falta leer la base');
  assert.equal(await R.rescateAntesDelModelo({ cfg: CON, estado, mensaje: '¿hoy no abre?', ahora: T0,
    formularioReciente: async () => true }), null, 'una pregunta de horario no es un formulario roto');
});

// ── 5 · Un solo predicado para los dos pasos ──────────────────────────────
await t('08 si el paso previo contestó, el posterior escala SIEMPRE con su motivo', () => {
  const previo = R.respuestaDeRescate(R.MOTIVOS_RESCATE.FORMULARIO_NO_CARGA);
  // Ni la bandera ni el estado se vuelven a evaluar: el texto ya promete una persona.
  for (const cfg of [CON, SIN]) {
    const r = R.decidirRescate({ cfg, estado: estadoBase({ folio: 'XAB-9' }),
      salida: { respuestaDeSistema: 'rescate_humano', texto: R.TEXTO_RESCATE }, previo });
    assert.equal(r?.motivo, R.MOTIVOS_RESCATE.FORMULARIO_NO_CARGA);
  }
});

await t('09 la salida del rescate: texto honesto, sin pregunta, y la marca que bloquea el formulario', () => {
  const estado = estadoBase({ rescate: { fallos: [T0, T0 + MIN] }, pendiente: { tipo: 'agregar_otro' } });
  const ok = R.aplicarSalidaDeRescate({ ...falla(), pendienteFinal: { tipo: 'modalidad' } },
    { motivo: R.MOTIVOS_RESCATE.FALLO_REPETIDO, entregado: true, estado, cierre: 'escalado' });
  assert.equal(ok.texto, R.TEXTO_RESCATE);
  assert.equal(ok.pendienteFinal, null);
  assert.equal(ok.escalado, true); assert.equal(ok.handoffPendiente, false);
  assert.equal(ok.motivoHandoff, R.MOTIVOS_RESCATE.FALLO_REPETIDO); assert.equal(ok.motivoCierre, 'escalado');
  assert.equal(estado.hechos.escalado, true); assert.equal(estado.motivoEscalado, R.MOTIVOS_RESCATE.FALLO_REPETIDO);
  assert.deepEqual(estado.rescate.fallos, [], 'las marcas viejas dispararían otro rescate al volver al bot');
  const estado2 = estadoBase();
  const roto = R.aplicarSalidaDeRescate(falla(), { motivo: R.MOTIVOS_RESCATE.FALLO_REPETIDO, entregado: false,
    estado: estado2 });
  assert.equal(roto.handoffPendiente, true); assert.equal(estado2.hechos.escalado, false);
  assert.equal(roto.texto, R.TEXTO_RESCATE); assert.ok(roto.rescate);
});

await t('10 tras un rescate cuyo handoff falló no se reabre «No pude armar tu pedido»', () => {
  const base = { interaccion: null, protegerConsulta: false, preguntaVieja: false, estado: estadoBase(),
    formulariosActivos: true };
  assert.equal(pedidoSinArmar({ ...base, salida: falla() }), true, 'control: sin rescate el formulario sí sale');
  assert.equal(pedidoSinArmar({ ...base, salida: { ...falla(), rescate: { motivo: 'AGENTE_FALLO_REPETIDO' },
    handoffPendiente: true } }), false);
});

await t('11 el texto del rescate está en la lista de acuses y no se lee como «cambio sin guardar»', () => {
  assert.ok(TEXTOS_RECIBO_HANDOFF.includes(R.TEXTO_RESCATE), 'sin esto la beta híbrida descarta el acuse');
  assert.equal(respuestaAfirmaCambioSinAplicar({ texto: R.TEXTO_RESCATE, operaciones: [] }), false);
  assert.ok(!/\?/.test(R.TEXTO_RESCATE), 'no deja una pregunta a un bot en pausa');
});

// ── 6 · El aviso al equipo ────────────────────────────────────────────────
// Con el WhatsApp al encargado encendido (su bandera aparte, apagada por omisión).
const CON_WA = { ...CON, [A.BANDERA_AVISO_WHATSAPP]: 'true', wa_admin_numero: '520000000001' };
const REV = (extra = {}) => ({ requiere_revision: true, revision: 7, motivo: 'FORMULARIO_NO_CARGA',
  actualizado_at: new Date(T0), ...extra });
function dobles({ cfg = CON_WA, revision = REV(), ...extra } = {}) {
  const panel = []; const whatsapp = []; let lecturasCfg = 0; let lecturasRev = 0; let reloj = T0;
  const actual = { revision };
  A.reiniciarAvisoRescate();
  A.configurarAvisoRescate({
    broadcastPanel: (n, d) => panel.push({ n, d }),
    enviarAvisoWhatsapp: async (numero, texto, n) => { whatsapp.push({ numero, texto, n }); },
    leerConfiguracion: async () => { lecturasCfg += 1; return { wa_admin_numero: '520000000001', ...cfg }; },
    leerRevision: async () => { lecturasRev += 1; return actual.revision; },
    log: () => {}, reloj: () => reloj, ...extra,
  });
  return { panel, whatsapp, lecturas: () => lecturasCfg, lecturasRev: () => lecturasRev, actual,
    avanzar: (ms) => { reloj += ms; } };
}
const NEG = 'aaaaaaaa-0000-4000-8000-000000000001';
const LARGO = `Quiero unos chilaquiles verdes con pollo, ${'muy '.repeat(40)}ricos`;

await t('12 el aviso: evento al panel sin el texto del cliente y WhatsApp al encargado con extracto y motivo', async () => {
  const d = dobles();
  const r = await A.avisarEquipoDeHandoff({ negocioId: NEG, telefono: TEL, motivo: 'AGENTE_FALLO_REPETIDO', mensaje: LARGO });
  await A.esperarAvisosEnCurso();
  assert.equal(r.avisado, true);
  assert.equal(d.panel.length, 1);
  assert.deepEqual(Object.keys(d.panel[0].d).sort(), ['motivo', 'razon', 'ref', 'telefono', 'tipo']);
  assert.equal(d.panel[0].d.tipo, 'rescate_humano');
  assert.equal(d.panel[0].d.telefono, '***4321');
  assert.ok(!JSON.stringify(d.panel[0].d).includes('chilaquiles'), 'el evento del panel llevó el texto del cliente');
  assert.ok(!JSON.stringify(d.panel[0].d).includes(TEL), 'el evento del panel llevó el teléfono completo');
  assert.equal(d.whatsapp.length, 1);
  assert.equal(d.whatsapp[0].numero, '520000000001');
  const extracto = d.whatsapp[0].texto.match(/Escribió: «([^»]*)»/)?.[1];
  assert.equal(extracto, LARGO.replace(/\s+/g, ' ').slice(0, 120));
  assert.match(d.whatsapp[0].texto, /falló dos veces seguidas/);
  assert.match(d.whatsapp[0].texto, /\*\*\*4321/);
  assert.ok(!d.whatsapp[0].texto.includes(TEL), 'el WhatsApp llevó el teléfono completo');
});

await t('13 un aviso por episodio (revisión + motivo de la fila): el mismo no repite; otro episodio, otro motivo o el TTL sí', async () => {
  const d = dobles();
  const avisar = async (motivo) => { const r = await A.avisarEquipoDeHandoff({ negocioId: NEG, telefono: TEL, motivo });
    await A.esperarAvisosEnCurso(); return r; };
  await avisar('FORMULARIO_NO_CARGA');
  const r2 = await avisar('AGENTE_PIDE_HUMANO');
  assert.equal(r2.motivo, 'ya_avisado'); assert.equal(d.panel.length, 1); assert.equal(d.whatsapp.length, 1);
  // `actualizado_at` cambia con cada lote (whatsappContinuidad.js): no es parte de la clave.
  d.actual.revision = REV({ actualizado_at: new Date(T0 + 5 * MIN) });
  assert.equal((await avisar('AGENTE_PIDE_HUMANO')).motivo, 'ya_avisado', 'el cierre del lote parecía otro episodio');
  // La misma revisión cambia de causa a propósito (enviarARevision deja reescribir AGENTE_ESTADO_INCIERTO).
  d.actual.revision = REV({ motivo: 'AGENTE_ESTADO_INCIERTO' });
  await avisar('AGENTE_ESTADO_INCIERTO');
  assert.equal(d.panel.length, 2, 'el cambio de causa de la revisión no avisó');
  // La atendieron (toda liberación suma uno a `revision`) y se volvió a atascar con el MISMO motivo.
  d.actual.revision = REV({ revision: 9 });
  await avisar('FORMULARIO_NO_CARGA');
  assert.equal(d.panel.length, 3, 'otro episodio del mismo cliente no avisó');
  d.avanzar(A.TTL_AVISO_MS + MIN);
  await avisar('FORMULARIO_NO_CARGA');
  assert.equal(d.panel.length, 4, 'la clave no venció a las 6 h');
  assert.equal(A.claveDeAvisoHandoff({ negocioId: NEG, telefono: TEL, revision: 7, motivoRevision: 'X' }),
    `${NEG}:${TEL}:7:X`);
});

await t('14 sin bandera, sin configurar, sin negocio o ya atendida: no avisa', async () => {
  let d = dobles({ cfg: SIN });
  assert.equal((await A.avisarEquipoDeHandoff({ negocioId: NEG, telefono: TEL, motivo: 'X' })).motivo, 'bandera_apagada');
  assert.equal(d.panel.length + d.whatsapp.length, 0);
  A.reiniciarAvisoRescate();
  assert.equal((await A.avisarEquipoDeHandoff({ negocioId: NEG, telefono: TEL, motivo: 'X' })).motivo, 'sin_configurar');
  d = dobles();
  assert.equal((await A.avisarEquipoDeHandoff({ negocioId: '', telefono: TEL, motivo: 'X' })).motivo, 'sin_negocio');
  assert.equal(d.lecturas(), 0, 'sin negocio leyó configuración (caería al negocio por omisión)');
  d = dobles({ revision: REV({ requiere_revision: false }) });
  assert.equal((await A.avisarEquipoDeHandoff({ negocioId: NEG, telefono: TEL, motivo: 'X' })).motivo, 'sin_revision');
  await A.esperarAvisosEnCurso();
  assert.equal(d.panel.length + d.whatsapp.length, 0);
});

await t('15 el aviso nunca rechaza, aunque fallen la base, el panel y WhatsApp', async () => {
  for (const extra of [
    { leerConfiguracion: async () => { throw new Error('base caída'); } },
    { leerRevision: async () => { throw new Error('base caída'); } },
    { broadcastPanel: () => { throw new Error('ws roto'); },
      enviarAvisoWhatsapp: async () => { throw new Error('meta 500'); } },
  ]) {
    dobles(extra);
    const r = await A.avisarEquipoDeHandoff({ negocioId: NEG, telefono: TEL, motivo: 'X' });
    assert.equal(typeof r?.avisado, 'boolean');
  }
});

await t('16 avisarAHumano avisa solo con la pausa confirmada, y el aviso nunca cambia su resultado', async () => {
  let d = dobles();
  assert.equal(await avisarAHumano(async () => true, NEG, TEL, 'AGENTE_PIDE_HUMANO', { mensaje: 'No carga' }), true);
  await A.esperarAvisosEnCurso();
  assert.equal(d.panel.length, 1); assert.equal(d.panel[0].d.motivo, 'AGENTE_PIDE_HUMANO');
  assert.match(d.whatsapp[0].texto, /Escribió: «No carga»/);
  assert.match(d.whatsapp[0].texto, /el asistente pasó la conversación a una persona/);
  for (const escalar of [async () => false, async () => { throw new Error('db'); }, null]) {
    d = dobles();
    assert.equal(await avisarAHumano(escalar, NEG, TEL, 'AGENTE_PIDE_HUMANO'), false);
    await A.esperarAvisosEnCurso();
    assert.equal(d.panel.length, 0, 'avisó de un handoff que no ocurrió');
  }
  dobles({ leerConfiguracion: async () => { throw new Error('base caída'); } });
  assert.equal(await avisarAHumano(async () => true, NEG, TEL, 'AGENTE_PIDE_HUMANO'), true);
  await A.esperarAvisosEnCurso();
  A.reiniciarAvisoRescate();
  assert.equal(await avisarAHumano(async () => true, NEG, TEL, 'AGENTE_PIDE_HUMANO'), true, 'sin configurar sigue igual');
});

// ── 7 · El cableado (lectura del código) ──────────────────────────────────
const SERVER = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const CANAL = readFileSync(new URL('../src/mesero-agente/canalDelAgente.js', import.meta.url), 'utf8');
const SW = readFileSync(new URL('../panel/sw.js', import.meta.url), 'utf8');

await t('17 server.js: push con un tag POR CONVERSACIÓN, aviso inyectado y el evento sí llega al operador', () => {
  const push = SERVER.slice(SERVER.indexOf('function dispararPushParaEvento'), SERVER.indexOf('const EVENTOS_WS_SOLO_ADMIN'));
  const bloque = push.slice(push.indexOf("data.tipo === 'rescate_humano'"));
  assert.match(bloque, /const ref = typeof data\.ref === 'string' && \/\^\[a-f0-9\]\{8,32\}\$\/\.test\(data\.ref\) \? data\.ref : '';/);
  assert.match(bloque, /\{ tag: ref \? `xabor-rescate-\$\{ref\}` : 'xabor-rescate' \}\s*\)\.catch\(/);
  // El operador también recibe el push y no abre Chats (/api/conversaciones es de administrador).
  assert.match(bloque, /'Un administrador lo atiende desde Chats de Xabor'/);
  assert.match(SERVER, /app\.get\('\/api\/conversaciones', requireAdminSeguro,/);
  assert.match(SERVER, /const payload = JSON\.stringify\(\{ titulo, cuerpo, data, \.\.\.\(tag \? \{ tag: String\(tag\) \} : \{\}\) \}\);/);
  assert.match(SERVER, /configurarAvisoRescate\(\{\s*broadcastPanel: \(negocioId, data\) => broadcastNegocio\(negocioId, data\),/);
  const soloAdmin = SERVER.match(/const EVENTOS_WS_SOLO_ADMIN = new Set\(\[([^\]]*)\]\)/)[1];
  assert.ok(!soloAdmin.includes('rescate_humano'), 'el operador también tiene que enterarse');
  assert.match(SW, /tag:\s+typeof datos\.tag === 'string' && datos\.tag \? datos\.tag : 'xabor-pedido'/);
});

await t('18 canal: el paso previo va primero, el posterior recibe su resultado y el aviso espera solo su decisión', () => {
  assert.match(CANAL, /: rescatePrevio\s*\n\s*\|\| entradaRetomarPedido\(/);
  assert.match(CANAL, /decidirRescate\(\{ cfg, estado, salida, interaccion, previo: rescatePrevio \}\)/);
  assert.match(CANAL, /await avisarEquipoDeHandoff\(\{ negocioId, telefono, motivo, mensaje: detalle\?\.mensaje \|\| '',\s*origen: detalle\?\.origen \|\| null, cfg: detalle\?\.cfg \?\? null \}\);/);
});

// ── 8 · Revisión del 3-oct ─────────────────────────────────────────────────
await t('20 el horario se reconoce (todavía/ya no abre, noche, tarde, fin de semana, feriados, «hasta las», la cocina)', () => {
  const horario = ['¿todavía no abre?', '¿ya no abre?', '¿no abre en la noche?', '¿no abre en la tarde?',
    '¿no abre el fin de semana?', '¿no abre en navidad?', '¿la cocina no abre hasta las 2?', '¿ahorita no abre?',
    '¿abren los feriados?', '¿abren a las 9?'];
  const quejas = ['no me carga', 'Buenas tardes, no me carga el formulario', 'ya no me abre el formulario',
    'buenas noches, no me carga', 'No carga'];
  assert.deepEqual(horario.filter((m) => !R.hablaDeHorario(m)), [], 'preguntas de horario que no se reconocen');
  assert.deepEqual(quejas.filter((m) => R.hablaDeHorario(m)), [], 'quejas que se toman por horario');
});

await t('21 avisarAHumano espera la DECISIÓN del aviso (lee la revisión dentro del turno), nunca el envío', async () => {
  let leida = false; let soltarEnvio = null;
  const d = dobles({
    leerRevision: async () => { await new Promise((r) => setTimeout(r, 30)); leida = true; return REV(); },
    enviarAvisoWhatsapp: () => new Promise((r) => { soltarEnvio = r; }),
  });
  try {
    assert.equal(await avisarAHumano(async () => true, NEG, TEL, 'AGENTE_PIDE_HUMANO', { cfg: CON_WA }), true);
    assert.equal(leida, true, 'avisarAHumano volvió antes de leer la revisión: la lectura caería después del cierre del lote');
    assert.equal(typeof soltarEnvio, 'function', 'el envío no arrancó');
    // Otro handoff del MISMO turno: misma revisión, un solo aviso.
    assert.equal(await avisarAHumano(async () => true, NEG, TEL, 'AGENTE_RESPUESTA_PROHIBIDA', { cfg: CON_WA }), true);
    assert.equal(d.panel.length, 1, 'el mismo turno avisó dos veces');
  } finally {
    // Aun si falla, el envío pendiente se suelta: si no, la suite no termina.
    await new Promise((r) => setTimeout(r, 50));
    soltarEnvio?.();
    await A.esperarAvisosEnCurso();
  }
});

await t('22 una decisión lenta no detiene al cliente más que el tope, y el aviso sale igual', async () => {
  const d = dobles({ esperaMaxMs: 40,
    leerRevision: async () => { await new Promise((r) => setTimeout(r, 400)); return REV(); } });
  const t0 = Date.now();
  assert.equal(await avisarAHumano(async () => true, NEG, TEL, 'AGENTE_PIDE_HUMANO', { cfg: CON_WA }), true);
  const ms = Date.now() - t0;
  assert.ok(ms < 300, `el turno esperó ${ms} ms al aviso`);
  assert.equal(d.panel.length, 0);
  await A.esperarAvisosEnCurso();
  assert.equal(d.panel.length, 1, 'la decisión lenta no terminó de avisar');
  assert.equal(A.ESPERA_MAX_DECISION_MS, 2000);
});

// El texto de cada llamada a avisarAHumano dentro del canal (paréntesis balanceados).
function llamadasEnElCanal(nombre) {
  const out = [];
  for (let i = CANAL.indexOf(`${nombre}(`); i >= 0; i = CANAL.indexOf(`${nombre}(`, i + 1)) {
    if (CANAL.slice(Math.max(0, i - 16), i).includes('function ')) continue;
    let j = i + nombre.length; let nivel = 0;
    do { if (CANAL[j] === '(') nivel += 1; else if (CANAL[j] === ')') nivel -= 1; j += 1; } while (nivel > 0 && j < CANAL.length);
    out.push(CANAL.slice(i, j));
  }
  return out;
}

await t('23 con la configuración del turno no se vuelve a leer nada; el canal la pasa en TODOS sus handoffs', async () => {
  let d = dobles();
  assert.equal((await A.avisarEquipoDeHandoff({ negocioId: NEG, telefono: TEL, motivo: 'X', cfg: SIN })).motivo,
    'bandera_apagada');
  assert.equal(d.lecturas() + d.lecturasRev(), 0, 'con la bandera apagada hubo lecturas');
  d = dobles();
  assert.equal((await A.avisarEquipoDeHandoff({ negocioId: NEG, telefono: TEL, motivo: 'X', cfg: CON_WA })).avisado, true);
  await A.esperarAvisosEnCurso();
  assert.equal(d.lecturas(), 0, 'releyó la configuración que el turno ya traía');
  assert.equal(d.lecturasRev(), 1);
  // Sin `cfg` (otro llamador) sí la lee: cae del lado seguro, no del mudo.
  d = dobles();
  await A.avisarEquipoDeHandoff({ negocioId: NEG, telefono: TEL, motivo: 'X' });
  assert.equal(d.lecturas(), 1);
  // avisarAHumano la hace llegar: un handoff con la bandera apagada no lee nada.
  d = dobles();
  assert.equal(await avisarAHumano(async () => true, NEG, TEL, 'AGENTE_PIDE_HUMANO', { cfg: SIN }), true);
  await A.esperarAvisosEnCurso();
  assert.equal(d.lecturas() + d.lecturasRev(), 0, 'avisarAHumano no pasó la configuración del turno');
  const llamadas = llamadasEnElCanal('avisarAHumano');
  assert.ok(llamadas.length >= 12, `solo ${llamadas.length} llamadas encontradas`);
  const sinCfg = llamadas.filter((c) => !/cfg: cfgDelTurno/.test(c));
  assert.deepEqual(sinCfg, [], 'handoffs del canal que no pasan la configuración del turno');
  assert.match(CANAL, /\]\);\s*\n\s*cfgDelTurno = cfg;/);
});

await t('24 el evento lleva una referencia opaca POR CONVERSACIÓN (el tag del push), nunca el teléfono', async () => {
  const d = dobles();
  const OTRO = '520000009876';
  await A.avisarEquipoDeHandoff({ negocioId: NEG, telefono: TEL, motivo: 'X', cfg: CON });
  d.actual.revision = REV({ revision: 8 });
  await A.avisarEquipoDeHandoff({ negocioId: NEG, telefono: TEL, motivo: 'X', cfg: CON });
  await A.avisarEquipoDeHandoff({ negocioId: NEG, telefono: OTRO, motivo: 'X', cfg: CON });
  await A.esperarAvisosEnCurso();
  const [a, b, c] = d.panel.map((p) => p.d.ref);
  assert.match(a, /^[a-f0-9]{16}$/);
  assert.equal(a, b, 'el mismo cliente cambió de referencia');
  assert.notEqual(a, c, 'dos clientes comparten referencia: el segundo aviso taparía al primero');
  assert.notEqual(A.referenciaDeConversacion(NEG, TEL), A.referenciaDeConversacion('otro-negocio', TEL));
  assert.ok(!JSON.stringify(d.panel).includes(TEL) && !JSON.stringify(d.panel).includes(OTRO));
});

await t('25 si lo pidió el cliente (menú de inicio), el aviso no dice que fue el asistente', async () => {
  assert.equal(A.etiquetaDeMotivo('AGENTE_PIDE_HUMANO', 'cliente'), 'el cliente pidió hablar con una persona');
  assert.equal(A.etiquetaDeMotivo('AGENTE_PIDE_HUMANO'), 'el asistente pasó la conversación a una persona');
  assert.equal(A.etiquetaDeMotivo('FACTURACION_REVISION_HUMANA', 'cliente'), 'el cliente pidió factura');
  const d = dobles();
  assert.equal(await avisarAHumano(async () => true, NEG, TEL, 'AGENTE_PIDE_HUMANO', { cfg: CON_WA, origen: 'cliente' }), true);
  await A.esperarAvisosEnCurso();
  assert.equal(d.panel[0].d.razon, 'el cliente pidió hablar con una persona');
  assert.match(d.whatsapp[0].texto, /Motivo: el cliente pidió hablar con una persona/);
  const servicio = llamadasEnElCanal('avisarAHumano').filter((c) => c.includes('motivoServicio('));
  assert.equal(servicio.length, 1);
  assert.match(servicio[0], /origen: 'cliente'/);
});

await t('26 el WhatsApp al encargado solo sale con su propia bandera (el dueño revisa al entrar al sistema)', async () => {
  let d = dobles({ cfg: { ...CON, wa_admin_numero: '520000000001' } });
  assert.equal((await A.avisarEquipoDeHandoff({ negocioId: NEG, telefono: TEL, motivo: 'X' })).avisado, true);
  await A.esperarAvisosEnCurso();
  assert.equal(d.panel.length, 1, 'sin la bandera del WhatsApp el panel igual debe enterarse');
  assert.equal(d.whatsapp.length, 0, 'salió WhatsApp sin whatsapp_rescate_aviso_whatsapp_v1');
  d = dobles({ cfg: { ...CON_WA, wa_admin_numero: '' } });
  await A.avisarEquipoDeHandoff({ negocioId: NEG, telefono: TEL, motivo: 'X' });
  await A.esperarAvisosEnCurso();
  assert.equal(d.whatsapp.length, 0, 'sin número del encargado no hay a quién mandarlo');
  assert.equal(A.BANDERA_AVISO_WHATSAPP, 'whatsapp_rescate_aviso_whatsapp_v1');
});

await A.esperarAvisosEnCurso();
await new Promise((r) => setImmediate(r));
await t('99 ninguna promesa quedó sin atender', () => {
  assert.deepEqual(noAtendidas.map((e) => String(e?.message || e)), []);
});

console.log(`Rescate humano (puro): ${pasadas} pasadas, ${fallos.length} fallidas. Sin base, red ni modelo.`);
if (fallos.length) process.exitCode = 1;
