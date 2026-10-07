// ─── MODO FORMULARIO / RECEPCIONISTA (PARTE 2) CONTRA POSTGRES ──────────────
//
// Los MENSAJES FIJOS que la verificación del análisis de 7 días encontró mal
// (no eran del modelo: eran plantillas) y el selector del modo recepcionista,
// por el adaptador real (`atenderConAgente`), con la continuidad real (pausa y
// revisión), el outbox y su entrega. De mentira: el modelo (lanza, o un
// selector guionado), el transporte de Meta y el registro del pedido.
//
//   C-1 el estado del pedido contesta el TIEMPO (c5f957c41, c1c28839e): del
//       bot, del personal por teléfono, dos pedidos, «ya hice mi pedido» sin
//       pedido → persona (nunca «no veo tu pedido»), sin pedido → tiempos;
//   C-2 nunca el carrito como respuesta a una pregunta (réplica de c6c59387b);
//   C-3 imagen → «Recibido, lo revisa el personal» + persona;
//   C-4 cerrado: acuse con hora de apertura y la tienda para agendar, sin el
//       saludo Mapo; repetido < 60 min → nada; dudas sí se contestan; «Hacer
//       pedido» cerrado → acuse;
//   C-5 tras el personal el bot calla (réplica de c33c16f63); lo que no es
//       cortesía avisa al equipo; «Devolver al bot» o pasada la ventana → normal;
//   SEL el selector por el adaptador: publicado = texto aprobado; sombra = lo
//       del modo formulario + «(sombra)» en la traza; el texto del modelo
//       nunca llega al outbox.
//
// Base local test_botones_* con 112/113/114, red solo local. CASOS=C1a,C5b… para las mordidas.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool, actualizarConfiguracion, setBotPausado } from '../src/services/database.js';
import { prepararNegocioMixtos } from './lib-botones-local.mjs';
import { atenderConAgente, simularConAgente } from '../src/mesero-agente/canalDelAgente.js';
import { leerEstadoVersionado } from '../src/mesero-agente/persistenciaDelTurno.js';
import { entregarRespuesta } from '../src/mesero-agente/entregaDeRespuestas.js';
import { crearContinuidad } from '../src/services/whatsappContinuidad.js';
import { configurarAvisoRescate, esperarAvisosEnCurso } from '../src/services/avisoRescateHumano.js';
import { FRASES, CLAVES_IA } from '../src/mesero-agente/recepcionista.js';
import { NOTA_IMAGEN_PARA_IA } from '../src/utils/turnoImagen.js';
Object.assign(process.env, { MESERO_AGENTE_MODE: 'true', WHATSAPP_INTERACTIVOS: 'true', WHATSAPP_FLOW_ENDPOINT: 'true',
  WHATSAPP_FLOW_PRIVATE_KEY: 'solo-local', META_APP_SECRET: 'solo-local' });

const noAtendidas = [];
process.on('unhandledRejection', (e) => { noAtendidas.push(e); });
let n = 0; let fallidas = 0;
const SOLO = (process.env.CASOS || '').split(',').map((s) => s.trim()).filter(Boolean);
async function caso(nombre, fn) {
  if (SOLO.length && !SOLO.includes(nombre.split(' ')[0])) return;
  try { await fn(); console.log(`OK ia-fijos ${++n}: ${nombre}`); }
  catch (e) {
    fallidas++;
    const detalle = e?.code === 'ERR_ASSERTION' && e.generatedMessage
      ? ` · obtenido=${JSON.stringify(e.actual)?.slice(0, 240)} · esperado=${JSON.stringify(e.expected)?.slice(0, 160)}` : '';
    console.log(`FALLA ia-fijos: ${nombre}\n  ${String(e?.message || e).split('\n')[0].slice(0, 400)}${detalle}`);
  }
}

const avisosPanel = [];
configurarAvisoRescate({ broadcastPanel: (negocioId, data) => avisosPanel.push({ negocioId, data }),
  enviarAvisoWhatsapp: async () => {}, log: () => {} });

const DIAS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'];
const ID = { categorias: '11111111111', carrito: '22222222222', configurar: '44444444444', facturacion: '66666666666', evento: '77777777777' };
const ABIERTO = Object.fromEntries(DIAS.map((d) => [d, { abierto: true, apertura: '00:00', cierre: '24:00' }]));
// Cerrado casi todo el día, con apertura conocida: «abrimos mañana a las 12:00 a. m.».
const CERRADO_CON_HORA = Object.fromEntries(DIAS.map((d) => [d, { abierto: true, apertura: '00:00', cierre: '00:01' }]));
const CERRADO_SIEMPRE = Object.fromEntries(DIAS.map((d) => [d, { abierto: false }]));
const PIE = 'Si necesitas otro detalle, escribe «hablar con alguien».';

/** Obispado con el modo encendido. `modelo`: el llamarModelo del turno (por omisión, uno que LANZA). */
async function fixture({ modo = 'formulario', extra = {}, horarios = ABIERTO, modelo = null } = {}) {
  const f = await prepararNegocioMixtos();
  f.estado.carrito.items = [];
  await pool.query('UPDATE conversacion_estado SET estado=$3 WHERE negocio_id=$1 AND session_id=$2',
    [f.negocioId, `agente:${f.telefono}`, JSON.stringify(f.estado)]);
  await pool.query("INSERT INTO metodos_pago(negocio_id,tipo,habilitado,disponible_para_bot,disponible_para_operador,orden) VALUES($1,'terminal',true,true,true,1)",
    [f.negocioId]);
  const reglas = { restaurante: 'Mapolato', timezone: 'America/Matamoros', horarios,
    pedidos: { modalidades: ['recoger en tienda', 'entrega a domicilio'], tiempo_preparacion_minutos: 25,
      tiempo_entrega_min_minutos: 45, tiempo_entrega_max_minutos: 45, pedido_minimo_entrega: 0, costo_envio: 60, pago_aceptado: ['efectivo'] },
    cierres_especiales: [], promociones: [], politicas: [],
    bot: { faqs: [{ pregunta: '¿Tienen mesas? ¿Puedo comer en el local?', respuesta: 'Sí, tenemos mesas en el local.' },
      { pregunta: 'Cumpleaños', respuesta: 'El día de tu cumpleaños desayunas gratis en el local.' }] } };
  await actualizarConfiguracion({ nombre: 'Mapolato Obispado', whatsapp_inicio_mapo_v1: 'true',
    whatsapp_atencion_general_v1: 'true', bot_whatsapp_solo_prueba: 'false', mesero_agente_porcentaje: '100',
    mesero_agente_telefonos: '', whatsapp_flows_v1: 'true', whatsapp_flows_telefonos: '', whatsapp_beta_hibrido_v1: 'true',
    whatsapp_beta_telefonos: '', whatsapp_interactivos_elecciones_v1: 'true',
    whatsapp_flow_categorias_id: ID.categorias, whatsapp_flow_carrito_id: ID.carrito, whatsapp_flow_configurar_id: ID.configurar,
    whatsapp_carrito_unificado_v1: 'true', whatsapp_flow_carrito_duplicar_v1: 'true',
    whatsapp_flow_facturacion_id: ID.facturacion, whatsapp_flow_evento_id: ID.evento, whatsapp_eventos_formulario_v1: 'true',
    whatsapp_rescate_humano_v1: 'true', whatsapp_flujos_caducan_v1: 'true', direccion: 'Libramiento Manuel Pérez Treviño 2416',
    ciudad: 'Piedras Negras', reglas_atencion: JSON.stringify(reglas),
    ...(modo ? { [CLAVES_IA.MODO]: modo, [CLAVES_IA.ALCANCE]: 'todos' } : {}), ...extra }, f.negocioId);
  const continuidad = crearContinuidad({ pool, locks: pool, procesar: async () => { throw Error('X'); }, cargarSesion: async () => {},
    leerSesion: async () => ({}), alRevision: (neg, tel) => setBotPausado(tel, true, neg) });
  const handoffs = [];
  const escalar = async (neg, tel, motivo) => {
    handoffs.push(motivo);
    return (await continuidad.enviarARevision(neg, tel, motivo)) || continuidad.revisionActiva(neg, tel);
  };
  const registrados = [];
  const registrar = async (orden) => { registrados.push(orden); return { ok: true, folio: `XAB-T${registrados.length}`, total: 45, pedido: { id: `XAB-T${registrados.length}` } }; };
  let llamadasModelo = 0;
  const llamarModelo = async (p) => { llamadasModelo++; if (!modelo) throw Error('EL_MODELO_NO_SE_LLAMA'); return modelo(p); };
  const identidad = () => ({ id: `wamid.iaf.${randomUUID()}`, from: f.telefono, timestamp: String(Math.floor(Date.now() / 1000)) });
  const turno = async (m) => {
    await pool.query("INSERT INTO whatsapp_entradas(negocio_id,telefono,wamid,payload,estado) VALUES($1,$2,$3,$4,'completado')",
      [f.negocioId, f.telefono, m.id, JSON.stringify({ message: m })]);
    const r = await atenderConAgente({ negocioId: f.negocioId, telefono: f.telefono, nombre: 'Cliente local',
      mensaje: m.type === 'text' ? m.text.body : '', wamids: [m.id],
      interaccion: m.type === 'interactive' ? { mensajes: [m], mixto: false } : null,
      llamarModelo, escalarAHumano: escalar,
      registrar, emitir: async () => {}, guardar: async () => {}, crearPago: async () => { throw Error('SIN_PAGOS'); } });
    await esperarAvisosEnCurso();
    const fila = r.outbox ? (await pool.query('SELECT * FROM agente_outbox WHERE evento_clave=$1', [r.outbox.clave])).rows[0] : null;
    let entrega = null; const wamid = `wamid.iaf.salida.${randomUUID()}`;
    if (fila && r.ok) {
      entrega = await entregarRespuesta({ outboxClave: fila.evento_clave,
        enviar: async () => ({ messages: [{ id: wamid }] }), alHumano: async () => {} });
      // El historial del chat, como whatsapp-meta.js: R0 mira el último saliente.
      if (entrega?.estado === 'entregado') {
        await pool.query("INSERT INTO mensajes(telefono,nombre,direccion,texto,negocio_id,origen) VALUES($1,'Cliente local','saliente',$2,$3,'bot')",
          [f.telefono, fila.carga.texto || '', f.negocioId]);
      }
    }
    return { r, fila, carga: fila?.carga || {}, entrega, wamid, interactivo: fila?.carga?.interactivo || null };
  };
  const texto = (body) => turno({ ...identidad(), type: 'text', text: { body } });
  const tocar = (q, titulo) => {
    const i = q.interactivo;
    assert(i, `no hay interactivo para tocar «${titulo}»`);
    const filas = i.type === 'list' ? i.action.sections[0].rows : i.action.buttons.map((b) => b.reply);
    const fila = filas.find((r) => r.title === titulo);
    assert(fila, `no hay «${titulo}» en ${JSON.stringify(filas.map((r) => r.title))}`);
    const tipo = i.type === 'list' ? 'list_reply' : 'button_reply';
    return turno({ ...identidad(), type: 'interactive', context: { id: q.wamid },
      interactive: { type: tipo, [tipo]: { id: fila.id, title: 'no es autoridad' } } });
  };
  const leer = () => leerEstadoVersionado(f.negocioId, f.telefono);
  const escribir = async (cambios) => {
    const e = await leer(); Object.assign(e, cambios);
    await pool.query('UPDATE conversacion_estado SET estado=$3,revision=revision+1 WHERE negocio_id=$1 AND session_id=$2',
      [f.negocioId, `agente:${f.telefono}`, JSON.stringify(e)]);
  };
  const turnos = async () => (await pool.query(`SELECT motivo_handoff, recuperacion, acciones, latencias FROM agente_turnos
    WHERE negocio_id=$1 ORDER BY id`, [f.negocioId])).rows;
  const salidas = async () => Number((await pool.query("SELECT count(*) FROM agente_outbox WHERE negocio_id=$1 AND tipo='respuesta_cliente'",
    [f.negocioId])).rows[0].count);
  const pausado = async () => (await pool.query('SELECT bot_pausado FROM conversaciones_control WHERE negocio_id=$1 AND telefono=$2',
    [f.negocioId, f.telefono])).rows[0]?.bot_pausado === true;
  const revision = async () => (await pool.query('SELECT requiere_revision, motivo FROM whatsapp_conversaciones WHERE negocio_id=$1 AND telefono=$2',
    [f.negocioId, f.telefono])).rows[0];
  const panel = () => avisosPanel.filter((a) => a.negocioId === f.negocioId);
  /** Un mensaje del PERSONAL (panel o Business App) hace `minutos`. */
  const personal = (minutos, textoP = 'Me confirma si le llegó 😊') => pool.query(`INSERT INTO mensajes(telefono,nombre,direccion,texto,negocio_id,origen,"timestamp")
    VALUES($1,'','saliente',$2,$3,'humano', now() - make_interval(mins => $4::int))`, [f.telefono, textoP, f.negocioId, minutos]);
  /** Un pedido en pedidos_activos con el teléfono del cliente (del personal, de la tienda o del bot). */
  const pedido = async ({ estado: est = 'nuevo', modalidad = 'entrega a domicilio', telefono = f.telefono, horas = 0 } = {}) => {
    const folio = `IA${randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`;
    await pool.query(`INSERT INTO pedidos_activos (folio, estado, datos, negocio_id, created_at)
      VALUES ($1, $2, $3, $4, now() - make_interval(hours => $5::int))`,
    [folio, est, JSON.stringify({ modalidad, cliente: { nombre: 'Cliente local', telefono }, items: [] }), f.negocioId, horas]);
    return folio;
  };
  return { ...f, texto, tocar, leer, escribir, turnos, salidas, pausado, revision, panel, handoffs, registrados, personal, pedido,
    modelo: () => llamadasModelo };
}

const titulos = (q) => (q.interactivo?.type === 'list' ? q.interactivo.action.sections[0].rows : q.interactivo?.action?.buttons?.map((b) => b.reply) || [])
  .map((r) => r.title);
const BOTONES = ['Hacer pedido', 'Más información', 'Hablar con alguien'];
const CARRITO = (f) => [{ lid: 'mixtos-1', id: f.mixtosId, nombre: 'Chilaquiles Mixtos', cantidad: 1, modificadores: [], notas: '' }];

async function exigirPersona(f, q, motivo, textoEsperado) {
  assert.equal(q.r.ok, true, JSON.stringify(q.r).slice(0, 200));
  assert.equal(q.carga.texto, textoEsperado);
  assert.equal(q.carga.interactivo, undefined, 'el texto de persona llevó formulario o botones');
  assert.equal(f.handoffs.at(-1), motivo);
  assert.equal(await f.pausado(), true, 'no quedó en pausa');
  const rev = await f.revision();
  assert.equal(rev?.requiere_revision, true); assert.equal(rev?.motivo, motivo);
  assert(f.panel().some((a) => a.data?.motivo === motivo), 'sin aviso al panel');
  assert.equal(q.entrega?.estado, 'entregado', `el texto de persona no salió: ${JSON.stringify(q.entrega)}`);
}
/** Nada al cliente: sin outbox ni turno comprometido. */
async function exigirSilencio(f, q, { salidasAntes, turnosAntes }) {
  assert.equal(q.r.ok, true, JSON.stringify(q.r).slice(0, 200)); assert.equal(q.r.sinRespuesta, true, 'contestó');
  assert.equal(q.fila, null); assert.equal(await f.salidas(), salidasAntes, 'quedó una respuesta en el outbox');
  assert.equal((await f.turnos()).length, turnosAntes, 'se comprometió un turno');
}

try {
  // ── C-1 el estado con el tiempo ──────────────────────────────────────────
  await caso('C1a pedido del bot (folio de la conversación): «¿Tiempo de entrega?» contesta el estado con el tiempo', async () => {
    const f = await fixture();
    const folio = await f.pedido({ estado: 'nuevo' });
    await f.escribir({ folio, hechos: { ...(await f.leer()).hechos, confirmado: true }, carrito: { items: CARRITO(f), datos: {} } });
    const q = await f.texto('Tiempo de entrega?');
    assert.equal(q.carga.texto, `Tu pedido ${folio} está recibido, en espera de preparación. Tiempo estimado de entrega: unos 45 minutos, contando desde tu pedido. ${PIE}`);
    assert.match((await f.turnos()).at(-1).recuperacion, /^recepcion:R8:estado/);
  });
  await caso('C1b pedido del PERSONAL por teléfono (sin folio en la conversación): «¿En cuánto tiempo llega?» con el tiempo', async () => {
    const f = await fixture();
    const folio = await f.pedido({ estado: 'en_preparacion', modalidad: 'recoger en tienda' });
    const q = await f.texto('En cuánto tiempo llega?');
    assert.equal(q.carga.texto, `Tu pedido ${folio} está en preparación. Estará listo para recoger en unos 25 minutos, contando desde tu pedido. ${PIE}`);
    assert.equal(f.modelo(), 0); assert.deepEqual(f.handoffs, []);
  });
  await caso('C1c dos pedidos del teléfono: una línea por folio; uno viejo (> 24 h) o de otro teléfono no cuenta', async () => {
    const f = await fixture();
    const a = await f.pedido({ estado: 'nuevo' });
    const b = await f.pedido({ estado: 'listo', modalidad: 'recoger en tienda' });
    await f.pedido({ estado: 'nuevo', horas: 30 });
    await f.pedido({ estado: 'nuevo', telefono: '5218780000001' });
    const q = await f.texto('¿ya viene mi pedido?');
    const lineas = q.carga.texto.split('\n');
    assert.equal(lineas.length, 3, q.carga.texto);
    assert(lineas.includes(`Tu pedido ${a} está recibido, en espera de preparación. Tiempo estimado de entrega: unos 45 minutos, contando desde tu pedido.`));
    assert(lineas.includes(`Tu pedido ${b} está listo. Puedes pasar a recogerlo.`)); assert.equal(lineas[2], PIE);
  });
  await caso('C1d sin pedido, «ya hice mi pedido en línea» → persona (nunca «no veo tu pedido»)', async () => {
    const f = await fixture();
    const q = await f.texto('Ya hice mi pedido en línea');
    await exigirPersona(f, q, 'RECEPCION_PEDIDO_EXTERNO', FRASES.PERSONA_PEDIDO_EXTERNO);
  });
  await caso('C1e sin pedido, «¿cuál es el tiempo de entrega?» → la respuesta de tiempos con sus botones', async () => {
    const f = await fixture();
    const q = await f.texto('¿Cuál es el tiempo de entrega?');
    assert.equal(q.carga.texto, '*Tiempo estimado*\nA domicilio: unos 45 minutos.\nPara recoger: unos 25 minutos.\nEs un estimado, no una hora garantizada.');
    assert.deepEqual(titulos(q), BOTONES);
  });

  // ── C-2 nunca el carrito como respuesta ──────────────────────────────────
  await caso('C2 réplica de c6c59387b: con carrito, cada pregunta recibe su respuesta en el formulario; nunca el carrito solo', async () => {
    const f = await fixture();
    await f.escribir({ carrito: { items: CARRITO(f), datos: { cliente: { nombre: 'Cliente local', telefono: f.telefono } } }, pendiente: null });
    const preguntas = ['En las opciones no vi de transferencia', 'Que tipo de pago es?', 'Que es el enlace de pago?', '¿Cómo puedo pagar?',
      'Mm me podrían explicar por favor?', 'Me podrían apoyar con la info?'];
    for (const p of preguntas) {
      const q = await f.texto(p);
      assert.equal(q.interactivo?.type, 'flow', `${p}: ${JSON.stringify(q.carga).slice(0, 160)}`);
      assert.equal(q.interactivo.action.parameters.flow_cta, 'Continuar pedido', p);
      const cuerpo = q.interactivo.body.text;
      assert(!/^\*Tu carrito\*/.test(cuerpo), `${p}: salió el carrito solo`);
      assert(/^\*(Formas de pago|Cómo pedir por aquí)\*/.test(cuerpo), `${p}: ${cuerpo.slice(0, 80)}`);
      assert(/Tu pedido guardado sigue aquí/.test(cuerpo), p);
    }
    const pagos = (await f.turnos()).slice(-6).map((t) => t.recuperacion.split(':').slice(1, 3).join(':'));
    assert.deepEqual(pagos, ['R11:fija', 'R11:fija', 'R11:fija', 'R11:fija', 'R11:fija', 'R11:fija']);
    assert.equal((await f.leer()).carrito.items.length, 1); assert.equal(f.modelo(), 0);
  });

  // ── C-3 imagen ───────────────────────────────────────────────────────────
  await caso('C3 imagen con texto o con visión → «Recibido, lo revisa el personal» y pasa a una persona', async () => {
    const f = await fixture();
    await exigirPersona(f, await f.texto(`Ya pagué ${NOTA_IMAGEN_PARA_IA}`), 'RECEPCION_IMAGEN', FRASES.PERSONA_IMAGEN);
    const g = await fixture();
    await exigirPersona(g, await g.texto('[CONTEXTO VISUAL] Captura de una transferencia por $350'), 'RECEPCION_IMAGEN', FRASES.PERSONA_IMAGEN);
  });

  // ── C-4 cerrado ──────────────────────────────────────────────────────────
  await caso('C4a cerrado con tienda: acuse con la hora de apertura y la liga; sin saludo Mapo; repetido < 60 min → nada', async () => {
    const f = await fixture({ horarios: CERRADO_CON_HORA });
    await pool.query(`INSERT INTO tienda_config (negocio_id, estado, modalidades, acepta_programados, anticipacion_minutos, publicada_at, slug_publico)
      VALUES ($1,'publicada','["recoger"]'::jsonb,TRUE,40,NOW(),$2)`, [f.negocioId, `iaf-${f.marca.slice(0, 8)}`]);
    const q = await f.texto('Hola buen día');
    assert.match(q.carga.texto, /^Recibimos tu mensaje\. 🙂 Ahora estamos cerrados; abrimos (?:mañana|hoy) a las 12:00 a\. m\. Si quieres dejar tu pedido agendado, hazlo en nuestra tienda en línea: https?:\/\/\S+\/t\/iaf-[^ ]+\. En cuanto abramos, el personal te contesta por aquí\.$/, q.carga.texto);
    assert(!/Mapo Bot|estoy aquí/.test(q.carga.texto)); assert.equal(q.carga.interactivo, undefined);
    assert.equal((await f.leer()).recepcion?.ultimo, 'cerrado');
    const antes = { salidasAntes: await f.salidas(), turnosAntes: (await f.turnos()).length };
    await exigirSilencio(f, await f.texto('hola?? hay alguien'), antes);
    // Una duda con respuesta aprobada sí se contesta de noche, sin botones.
    const h = await f.texto('¿Dónde están?');
    assert.match(h.carga.texto, /^\*Ubicación\*\nLibramiento Manuel Pérez Treviño 2416/); assert.equal(h.carga.interactivo, undefined);
    assert.equal((await f.leer()).recepcion?.ultimo, 'cerrado', 'la duda rompió la ventana del acuse');
    assert.equal(f.modelo(), 0);
  });
  await caso('C4b cerrado sin próxima apertura ni tienda: el acuse sin hora', async () => {
    const f = await fixture({ horarios: CERRADO_SIEMPRE });
    const q = await f.texto('Quería enviar un desayuno mañana a primera hora');
    assert.equal(q.carga.texto, 'Recibimos tu mensaje. 🙂 Ahora estamos cerrados; el personal te contesta por aquí en cuanto abramos.');
    assert.deepEqual(f.handoffs, []);
  });
  await caso('C4c «Hacer pedido» tocado ya cerrado → el acuse, no el formulario', async () => {
    const f = await fixture();
    const q = await f.texto('asdf qwer zxcv');
    assert.deepEqual(titulos(q), BOTONES);
    await actualizarConfiguracion({ reglas_atencion: JSON.stringify({ ...JSON.parse((await pool.query(
      "SELECT valor FROM configuracion WHERE negocio_id=$1 AND clave='reglas_atencion'", [f.negocioId])).rows[0].valor), horarios: CERRADO_CON_HORA }) }, f.negocioId);
    const t = await f.tocar(q, 'Hacer pedido');
    assert.match(t.carga.texto, /^Recibimos tu mensaje\. 🙂 Ahora estamos cerrados; abrimos /, t.carga.texto);
    assert.notEqual(t.interactivo?.type, 'flow', 'salió el formulario con el local cerrado');
  });

  // ── C-5 tras el personal ─────────────────────────────────────────────────
  await caso('C5a réplica de c33c16f63: «Si muchas gracias / Ya la recibí» 107 min después del personal → nada, sin revisión', async () => {
    const f = await fixture();
    await f.personal(107);
    const antes = { salidasAntes: await f.salidas(), turnosAntes: (await f.turnos()).length };
    await exigirSilencio(f, await f.texto('Si muchas gracias\nYa la recibí'), antes);
    assert.deepEqual(f.handoffs, []); assert.equal(await f.pausado(), false); assert.equal(f.modelo(), 0);
  });
  await caso('C5b «Si porfavor» 1 min después del personal (c090529eb) → nada al cliente, revisión y aviso al panel', async () => {
    const f = await fixture();
    await f.personal(1, 'Hola buenos días');
    const antes = { salidasAntes: await f.salidas(), turnosAntes: (await f.turnos()).length };
    await exigirSilencio(f, await f.texto('Si porfavor'), antes);
    assert.deepEqual(f.handoffs, ['RECEPCION_TRAS_PERSONAL']); assert.equal(await f.pausado(), true);
    assert.equal((await f.revision())?.motivo, 'RECEPCION_TRAS_PERSONAL');
    assert(f.panel().some((a) => a.data?.motivo === 'RECEPCION_TRAS_PERSONAL'), 'sin aviso al panel');
  });
  await caso('C5c un «hola» tras el personal tampoco recibe el saludo Mapo', async () => {
    const f = await fixture();
    await f.personal(20);
    const antes = { salidasAntes: await f.salidas(), turnosAntes: (await f.turnos()).length };
    await exigirSilencio(f, await f.texto('hola'), antes);
  });
  await caso('C5d tras «Devolver al bot» (una persona, después del mensaje) → ruta normal', async () => {
    const f = await fixture();
    await f.personal(10);
    const { rows: [u] } = await pool.query("INSERT INTO usuarios (negocio_id, nombre, email, password_hash) VALUES ($1,'Encargada',$2,'x') RETURNING id",
      [f.negocioId, `enc-${randomUUID()}@local.test`]);
    await pool.query(`INSERT INTO conversaciones_control (negocio_id, telefono, bot_pausado, updated_by, updated_at) VALUES ($1,$2,false,$3,now())
      ON CONFLICT (negocio_id, telefono) DO UPDATE SET bot_pausado=false, updated_by=EXCLUDED.updated_by, updated_at=now()`, [f.negocioId, f.telefono, u.id]);
    const q = await f.texto('¿A qué hora abren?');
    assert.match(q.carga.texto, /^\*Horario\*/); assert.deepEqual(f.handoffs, []);
  });
  await caso('C5e pasada la ventana (181 min) → ruta normal; la ventana se configura (90)', async () => {
    const f = await fixture();
    await f.personal(181);
    assert.match((await f.texto('¿A qué hora abren?')).carga.texto, /^\*Horario\*/);
    const g = await fixture({ extra: { [CLAVES_IA.SILENCIO]: '90' } });
    await g.personal(100);
    assert.match((await g.texto('¿A qué hora abren?')).carga.texto, /^\*Horario\*/);
    const h = await fixture({ extra: { [CLAVES_IA.SILENCIO]: '90' } });
    await h.personal(80);
    assert.equal((await h.texto('¿A qué hora abren?')).r.sinRespuesta, true);
  });
  await caso('C5f el último saliente es del bot (el personal escribió antes) → ruta normal', async () => {
    const f = await fixture();
    await f.personal(30);
    // Después del personal escribió el bot (p. ej. un aviso de estado del pedido):
    await pool.query("INSERT INTO mensajes(telefono,nombre,direccion,texto,negocio_id,origen) VALUES($1,'','saliente','Aviso del bot',$2,'bot')",
      [f.telefono, f.negocioId]);
    assert.match((await f.texto('¿A qué hora abren?')).carga.texto, /^\*Horario\*/);
  });

  // ── El selector por el adaptador ─────────────────────────────────────────
  const MSG = 'oigan una pregunta, ¿cuándo puedo ir?';
  const selector = (decision, texto = 'TEXTO_DEL_MODELO_que_no_sale') => async (p) => {
    assert.deepEqual(p.tool_choice, { type: 'tool', name: 'elegir' });
    return { stop_reason: 'tool_use', content: [{ type: 'text', text: texto }, { type: 'tool_use', id: 't', name: 'elegir', input: { decision, confianza: 'alta' } }] };
  };
  await caso('SEL1 recepcionista publicado: el texto aprobado, literal; el del modelo nunca llega al outbox', async () => {
    const f = await fixture({ modo: 'recepcionista', extra: { [CLAVES_IA.PUBLICAR_SELECTOR]: 'true' }, modelo: selector('ubicacion') });
    const q = await f.texto(MSG);
    assert.match(q.carga.texto, /^\*Ubicación\*\nLibramiento Manuel Pérez Treviño 2416, Piedras Negras\./);
    assert(!JSON.stringify(q.carga).includes('TEXTO_DEL_MODELO')); assert.deepEqual(titulos(q), BOTONES);
    const t = (await f.turnos()).at(-1);
    assert.equal(t.recuperacion, 'recepcion:R13:fija:ubicacion:sel=ubicacion');
    assert.equal(t.latencias?.recepcion?.selector?.decision, 'ubicacion'); assert.equal(f.modelo(), 1);
    assert(!JSON.stringify(t).includes('TEXTO_DEL_MODELO'), 'la traza guardó texto del modelo');
  });
  await caso('SEL2 recepcionista en sombra: el cliente recibe lo del modo formulario; la traza dice qué habría elegido', async () => {
    const f = await fixture({ modo: 'recepcionista', modelo: selector('ubicacion') });
    const q = await f.texto(MSG);
    assert.equal(q.carga.texto, FRASES.NO_RECONOCIDO); assert.deepEqual(titulos(q), BOTONES);
    assert.equal((await f.turnos()).at(-1).recuperacion, 'recepcion:R14:no_reconocido:sel=ubicacion(sombra)');
    // Un mensaje que reconoce una regla no llama al selector.
    await f.texto('¿A qué hora abren?'); assert.equal(f.modelo(), 1);
  });
  await caso('SEL3 recepcionista publicado, «persona» → traspaso; un proveedor caído → los botones de siempre', async () => {
    const f = await fixture({ modo: 'recepcionista', extra: { [CLAVES_IA.PUBLICAR_SELECTOR]: 'true' }, modelo: selector('persona') });
    await exigirPersona(f, await f.texto(MSG), 'RECEPCION_PIDE_PERSONA', FRASES.PERSONA);
    const g = await fixture({ modo: 'recepcionista', extra: { [CLAVES_IA.PUBLICAR_SELECTOR]: 'true' } });
    const q = await g.texto(MSG);
    assert.equal(q.carga.texto, FRASES.NO_RECONOCIDO); assert.equal(g.modelo(), 1);
    assert.equal((await g.turnos()).at(-1).recuperacion, 'recepcion:R14:no_reconocido:sel=ninguna');
  });
  await caso('SIM el simulador en modo recepcionista muestra lo que eligió el selector (en sombra)', async () => {
    const f = await fixture({ modo: 'recepcionista' });
    const sim = await simularConAgente({ sessionId: `sim-${randomUUID()}`, negocioId: f.negocioId, mensaje: MSG, llamarModelo: selector('horario') });
    assert.equal(sim.texto, `${FRASES.NO_RECONOCIDO}\n[Botones: Hacer pedido · Más información · Hablar con alguien]\n[Selector (sombra): horario]`);
  });
} finally {
  await new Promise((r) => setTimeout(r, 200));
  console.log(`\nmensajes fijos y selector contra Postgres: ${n} pasadas, ${fallidas} fallidas${noAtendidas.length ? ` · rechazos sin atender: ${noAtendidas.length}` : ''}`);
  await pool.end().catch(() => {});
  if (fallidas || noAtendidas.length) process.exitCode = 1;
}
