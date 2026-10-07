// ─── MODO FORMULARIO (PARTE 1) CONTRA POSTGRES, POR EL ADAPTADOR REAL ──────
//
// Decisión del dueño (3-oct-2026): los pedidos SOLO en el formulario; la IA,
// recepcionista para dudas. Por `atenderConAgente` (el adaptador de verdad),
// con la configuración de Obispado, la continuidad real (pausa y revisión), el
// outbox y su entrega; de mentira solo el modelo (un doble que LANZA: en modo
// formulario nunca se llama), el transporte de Meta y el registro del pedido.
//
// Cada caso comprueba lo que el cliente recibe (texto e interactivo del
// outbox), lo que NO cambió (carrito, operaciones) y, cuando pasa a una
// persona, la pausa, la revisión con su motivo, el aviso al panel y que el
// texto de persona sí sale con la pausa puesta.
//
// Base local test_botones_* con 112/113/114, red solo local. CASOS=A1,R10a… para las mordidas.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool, actualizarConfiguracion, setBotPausado } from '../src/services/database.js';
import { prepararNegocioMixtos } from './lib-botones-local.mjs';
import { atenderConAgente } from '../src/mesero-agente/canalDelAgente.js';
import { leerEstadoVersionado } from '../src/mesero-agente/persistenciaDelTurno.js';
import { entregarRespuesta } from '../src/mesero-agente/entregaDeRespuestas.js';
import { crearContinuidad } from '../src/services/whatsappContinuidad.js';
import { configurarAvisoRescate, esperarAvisosEnCurso } from '../src/services/avisoRescateHumano.js';
import { guardarPromocion } from '../src/services/tiendaPromociones.js';
import { FRASES, CLAVES_IA, MOTIVOS_RECEPCION } from '../src/mesero-agente/recepcionista.js';
import { NOTA_IMAGEN_PARA_IA } from '../src/utils/turnoImagen.js';
Object.assign(process.env, { MESERO_AGENTE_MODE: 'true', WHATSAPP_INTERACTIVOS: 'true', WHATSAPP_FLOW_ENDPOINT: 'true',
  WHATSAPP_FLOW_PRIVATE_KEY: 'solo-local', META_APP_SECRET: 'solo-local' });

const noAtendidas = [];
process.on('unhandledRejection', (e) => { noAtendidas.push(e); });
let n = 0; let fallidas = 0;
const SOLO = (process.env.CASOS || '').split(',').map((s) => s.trim()).filter(Boolean);
async function caso(nombre, fn) {
  if (SOLO.length && !SOLO.includes(nombre.split(' ')[0])) return;
  try { await fn(); console.log(`OK ia-recepcion ${++n}: ${nombre}`); }
  catch (e) {
    fallidas++;
    const detalle = e?.code === 'ERR_ASSERTION' && e.generatedMessage
      ? ` · obtenido=${JSON.stringify(e.actual)?.slice(0, 200)} · esperado=${JSON.stringify(e.expected)?.slice(0, 120)}` : '';
    console.log(`FALLA ia-recepcion: ${nombre}\n  ${String(e?.message || e).split('\n')[0].slice(0, 400)}${detalle}`);
  }
}

const avisosPanel = [];
configurarAvisoRescate({ broadcastPanel: (negocioId, data) => avisosPanel.push({ negocioId, data }),
  enviarAvisoWhatsapp: async () => {}, log: () => {} });

const DIAS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'];
const ID = { categorias: '11111111111', carrito: '22222222222', configurar: '44444444444', productos: '12121212121',
  editar: '13131313131', facturacion: '66666666666', evento: '77777777777' };

/** La configuración de Obispado con el modo encendido (o no, con `modo: null`). */
async function fixture({ modo = 'formulario', vacio = true, extra = {}, reglasExtra = {}, legado = false } = {}) {
  const f = await prepararNegocioMixtos();
  if (vacio) {
    f.estado.carrito.items = [];
    await pool.query('UPDATE conversacion_estado SET estado=$3 WHERE negocio_id=$1 AND session_id=$2',
      [f.negocioId, `agente:${f.telefono}`, JSON.stringify(f.estado)]);
  }
  const reglas = { restaurante: 'Mapolato', timezone: 'America/Matamoros',
    horarios: Object.fromEntries(DIAS.map((d) => [d, { abierto: true, apertura: '00:00', cierre: '24:00' }])),
    pedidos: { modalidades: ['recoger en tienda', 'entrega a domicilio'], tiempo_preparacion_minutos: 25,
      tiempo_entrega_min_minutos: 45, tiempo_entrega_max_minutos: 45, pedido_minimo_entrega: 0, costo_envio: 60, pago_aceptado: ['efectivo'] },
    cierres_especiales: [], promociones: [], politicas: [],
    bot: { faqs: [{ pregunta: '¿Tienen mesas? ¿Puedo comer en el local?', respuesta: 'Sí, tenemos mesas en el local.' },
      { pregunta: 'Cumpleaños', respuesta: 'El día de tu cumpleaños desayunas gratis en el local.' }] },
    ...reglasExtra };
  const formularios = legado
    ? { whatsapp_flow_productos_id: ID.productos, whatsapp_flow_editar_id: ID.editar, whatsapp_flow_configurar_id: ID.configurar,
      whatsapp_carrito_unificado_v1: 'false' }
    : { whatsapp_flow_categorias_id: ID.categorias, whatsapp_flow_carrito_id: ID.carrito, whatsapp_flow_configurar_id: ID.configurar,
      whatsapp_carrito_unificado_v1: 'true', whatsapp_flow_carrito_duplicar_v1: 'true' };
  await actualizarConfiguracion({ nombre: 'Mapolato Obispado', whatsapp_inicio_mapo_v1: 'true',
    whatsapp_atencion_general_v1: 'true', bot_whatsapp_solo_prueba: 'false', mesero_agente_porcentaje: '100',
    mesero_agente_telefonos: '', whatsapp_flows_v1: 'true', whatsapp_flows_telefonos: '', whatsapp_beta_hibrido_v1: 'true',
    whatsapp_beta_telefonos: '', whatsapp_interactivos_elecciones_v1: 'true', ...formularios,
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
  const identidad = () => ({ id: `wamid.ia.${randomUUID()}`, from: f.telefono, timestamp: String(Math.floor(Date.now() / 1000)) });
  const turno = async (m, { entregar = true } = {}) => {
    await pool.query("INSERT INTO whatsapp_entradas(negocio_id,telefono,wamid,payload,estado) VALUES($1,$2,$3,$4,'completado')",
      [f.negocioId, f.telefono, m.id, JSON.stringify({ message: m })]);
    const r = await atenderConAgente({ negocioId: f.negocioId, telefono: f.telefono, nombre: 'Cliente local',
      mensaje: m.type === 'text' ? m.text.body : '', wamids: [m.id],
      interaccion: m.type === 'interactive' ? { mensajes: [m], mixto: false } : null,
      llamarModelo: async () => { llamadasModelo++; throw Error('EL_MODELO_NO_SE_LLAMA'); }, escalarAHumano: escalar,
      registrar, emitir: async () => {}, guardar: async () => {}, crearPago: async () => { throw Error('SIN_PAGOS'); } });
    await esperarAvisosEnCurso();
    const fila = r.outbox ? (await pool.query('SELECT * FROM agente_outbox WHERE evento_clave=$1', [r.outbox.clave])).rows[0] : null;
    let entrega = null; let enviado = null; const wamid = `wamid.ia.salida.${randomUUID()}`;
    if (entregar && fila && r.ok) {
      entrega = await entregarRespuesta({ outboxClave: fila.evento_clave,
        enviar: async (x) => { enviado = x; return { messages: [{ id: wamid }] }; }, alHumano: async () => {} });
    }
    return { r, fila, carga: fila?.carga || {}, entrega, enviado, wamid, interactivo: fila?.carga?.interactivo || null };
  };
  const texto = (body, opciones) => turno({ ...identidad(), type: 'text', text: { body } }, opciones);
  const tocar = (q, titulo, opciones) => {
    const i = q.interactivo;
    assert(i, `no hay interactivo para tocar «${titulo}»`);
    const filas = i.type === 'list' ? i.action.sections[0].rows : i.action.buttons.map((b) => b.reply);
    const fila = filas.find((r) => r.title === titulo);
    assert(fila, `no hay «${titulo}» en ${JSON.stringify(filas.map((r) => r.title))}`);
    const tipo = i.type === 'list' ? 'list_reply' : 'button_reply';
    return turno({ ...identidad(), type: 'interactive', context: { id: q.wamid },
      interactive: { type: tipo, [tipo]: { id: fila.id, title: 'no es autoridad' } } }, opciones);
  };
  const leer = () => leerEstadoVersionado(f.negocioId, f.telefono);
  const escribir = async (cambios) => {
    const e = await leer(); Object.assign(e, cambios);
    await pool.query('UPDATE conversacion_estado SET estado=$3,revision=revision+1 WHERE negocio_id=$1 AND session_id=$2',
      [f.negocioId, `agente:${f.telefono}`, JSON.stringify(e)]);
  };
  const turnos = async () => (await pool.query(`SELECT motivo_handoff, cierre, recuperacion, acciones, latencias FROM agente_turnos
    WHERE negocio_id=$1 ORDER BY id`, [f.negocioId])).rows;
  const operaciones = async () => (await pool.query(`SELECT herramienta, estado FROM agente_operaciones WHERE negocio_id=$1`, [f.negocioId])
    .catch(() => ({ rows: [] }))).rows;
  const pausado = async () => (await pool.query('SELECT bot_pausado FROM conversaciones_control WHERE negocio_id=$1 AND telefono=$2',
    [f.negocioId, f.telefono])).rows[0]?.bot_pausado === true;
  const revision = async () => (await pool.query('SELECT requiere_revision, motivo FROM whatsapp_conversaciones WHERE negocio_id=$1 AND telefono=$2',
    [f.negocioId, f.telefono])).rows[0];
  const panel = () => avisosPanel.filter((a) => a.negocioId === f.negocioId);
  return { ...f, texto, tocar, leer, escribir, turnos, operaciones, pausado, revision, panel, handoffs, registrados,
    modelo: () => llamadasModelo };
}

const flowId = (q) => q.interactivo?.action?.parameters?.flow_id;
const titulos = (q) => (q.interactivo?.type === 'list' ? q.interactivo.action.sections[0].rows : q.interactivo?.action?.buttons?.map((b) => b.reply) || [])
  .map((r) => r.title);
const CARRITO = (f) => [{ lid: 'mixtos-1', id: f.mixtosId, nombre: 'Chilaquiles Mixtos', cantidad: 1, modificadores: [], notas: '' }];

/** Pasó a una persona de verdad: pausa, revisión con su motivo, aviso al panel, traza y el texto sí sale. */
async function exigirPersona(f, q, motivo, textoEsperado) {
  assert.equal(q.r.ok, true, JSON.stringify(q.r).slice(0, 200));
  assert.equal(q.carga.texto, textoEsperado);
  assert.equal(q.carga.interactivo, undefined, 'el texto de persona llevó formulario o botones');
  assert.equal(f.handoffs.at(-1), motivo);
  assert.equal(await f.pausado(), true, 'no quedó en pausa');
  const rev = await f.revision();
  assert.equal(rev?.requiere_revision, true); assert.equal(rev?.motivo, motivo);
  assert(f.panel().some((a) => a.data?.motivo === motivo), 'sin aviso al panel');
  assert.equal((await f.turnos()).at(-1).motivo_handoff, motivo);
  assert.ok(q.carga.recibo_handoff, 'el texto no quedó ligado a la pausa');
  assert.equal(q.entrega?.estado, 'entregado', `el texto de persona no salió con la pausa puesta: ${JSON.stringify(q.entrega)}`);
}

try {
  await caso('M1 «hola» abierto: el inicio Mapo con «Información»; tocarla abre la lista; un tema contesta con botones', async () => {
    const f = await fixture();
    const hola = await f.texto('hola');
    assert.match(hola.carga.texto, /Mapo Bot/);
    assert.deepEqual(titulos(hola), ['Ordenar', 'Información', 'Facturación', 'Servicio para eventos', 'Otra duda']);
    const info = await f.tocar(hola, 'Información');
    assert.equal(info.carga.texto, FRASES.INFORMACION_MENU);
    assert.equal(info.interactivo?.type, 'list');
    assert.deepEqual(titulos(info).slice(0, 4), ['Horario', 'Ubicación', 'Tiempo de entrega', 'Envío a domicilio']);
    assert(titulos(info).includes('Cumpleaños') && titulos(info).includes('Mesas y reservaciones'));
    const horario = await f.tocar(info, 'Horario');
    assert.match(horario.carga.texto, /^\*Horario\*\nLunes a domingo: abierto las 24 horas$/);
    assert.deepEqual(titulos(horario), ['Hacer pedido', 'Más información', 'Hablar con alguien']);
    const ubicacion = await f.tocar(await f.tocar(horario, 'Más información'), 'Ubicación');
    assert.match(ubicacion.carga.texto, /Libramiento Manuel Pérez Treviño 2416, Piedras Negras\./);
    const pedido = await f.tocar(ubicacion, 'Hacer pedido');
    assert.equal(pedido.interactivo?.type, 'flow'); assert.equal(flowId(pedido), ID.categorias);
    assert.equal(f.modelo(), 0); assert.equal((await f.leer()).carrito.items.length, 0);
    assert((await f.turnos()).some((t) => /^recepcion:toque:info:horario/.test(t.recuperacion || '')), 'la traza no dice qué decidió');
  });
  await caso('M2 «Hablar con alguien» pasa a una persona (camino de hoy del menú)', async () => {
    const f = await fixture();
    const q = await f.tocar(await f.texto('¿y eso qué?'), 'Hablar con alguien');
    assert.equal(f.handoffs.at(-1), 'AGENTE_PIDE_HUMANO'); assert.equal(await f.pausado(), true);
    assert.match(q.carga.texto, /persona/i);
  });

  await caso('R10 pedido escrito → el formulario con su frase; ni el carrito ni el libro cambian; nunca el modelo', async () => {
    const f = await fixture();
    const q = await f.texto('Quiero 2 chilaquiles mixtos con pollo y salsa roja');
    assert.equal(q.interactivo?.type, 'flow'); assert.equal(flowId(q), ID.categorias);
    assert(q.carga.texto.startsWith(FRASES.PEDIDO_ESCRITO), q.carga.texto.slice(0, 120));
    assert.equal(q.entrega?.estado, 'entregado');
    const e = await f.leer();
    assert.equal(e.carrito.items.length, 0); assert.equal(e.pendiente?.tipo, 'agregar_otro');
    assert.equal((await f.operaciones()).length, 0, 'se escribió en el libro de operaciones');
    assert.equal(f.modelo(), 0);
    assert.match((await f.turnos()).at(-1).recuperacion, /^recepcion:R10:pedido_escrito/);
    assert.equal((await f.turnos()).at(-1).latencias?.recepcion?.paso, 'R10');
  });
  await caso('R10a el segundo pedido escrito < 30 min tras el formulario → persona (pausa, revisión, panel, el texto sale)', async () => {
    const f = await fixture();
    await f.texto('Quiero 2 chilaquiles mixtos con pollo');
    const q = await f.texto('2 chilaquiles mixtos con pollo y salsa roja, a domicilio');
    await exigirPersona(f, q, 'RECEPCION_PEDIDO_ESCRITO', FRASES.PERSONA_PEDIDO);
    assert.equal((await f.leer()).carrito.items.length, 0);
  });
  await caso('R10b un formulario de FACTURA reciente no cuenta: el pedido escrito recibe el formulario', async () => {
    const f = await fixture();
    const factura = await f.tocar(await f.texto('hola'), 'Facturación');
    assert.equal(flowId(factura), ID.facturacion);
    await f.escribir({ pendiente: null });
    const q = await f.texto('Quiero 2 chilaquiles mixtos con pollo');
    assert.equal(flowId(q), ID.categorias, `${q.carga.texto?.slice(0, 80)} ${f.handoffs}`);
    assert.deepEqual(f.handoffs, []);
  });
  await caso('R10c sin formulario posible (sin el Flow de pedido) → persona, nunca «escríbeme tu pedido»', async () => {
    const f = await fixture({ extra: { whatsapp_flow_categorias_id: '', whatsapp_flow_carrito_id: '' } });
    const q = await f.texto('quiero hacer un pedido');
    await exigirPersona(f, q, 'RECEPCION_FORMULARIO_NO_DISPONIBLE', FRASES.PERSONA_PEDIDO);
  });
  await caso('R1 sin Flows (precondición) → persona, el modo no vuelve al modelo', async () => {
    const f = await fixture({ extra: { whatsapp_flows_v1: 'false' } });
    const q = await f.texto('quiero 2 chilaquiles mixtos');
    await exigirPersona(f, q, 'RECEPCION_SIN_PRECONDICIONES', FRASES.PERSONA);
    assert.equal(f.modelo(), 0);
  });
  await caso('R2 una imagen la revisa el personal', async () => {
    const f = await fixture();
    const q = await f.texto(`Este es mi comprobante ${NOTA_IMAGEN_PARA_IA}`);
    await exigirPersona(f, q, 'RECEPCION_IMAGEN', FRASES.PERSONA_IMAGEN);
  });
  await caso('R14 dos mensajes no reconocidos → persona (la segunda vez)', async () => {
    const f = await fixture();
    const q1 = await f.texto('asdf qwer zxcv');
    assert.equal(q1.carga.texto, FRASES.NO_RECONOCIDO);
    assert.deepEqual(titulos(q1), ['Hacer pedido', 'Más información', 'Hablar con alguien']);
    assert.equal((await f.leer()).recepcion?.ultimo, 'no_reconocido');
    const q2 = await f.texto('ñlkj poiu');
    await exigirPersona(f, q2, 'RECEPCION_INSISTE', FRASES.PERSONA);
  });
  await caso('R11 dudas con respuesta aprobada: horario y mesas; con carrito, «Continuar pedido» lleva la respuesta', async () => {
    const f = await fixture();
    const h = await f.texto('¿A qué hora abren?');
    assert.match(h.carga.texto, /^\*Horario\*/); assert.deepEqual(titulos(h), ['Hacer pedido', 'Más información', 'Hablar con alguien']);
    const m = await f.texto('¿tienen mesas?');
    assert.equal(m.carga.texto, 'Sí, tenemos mesas en el local.');
    await f.escribir({ carrito: { items: CARRITO(f), datos: { cliente: { nombre: 'Cliente local', telefono: f.telefono } } }, pendiente: null });
    const c = await f.texto('¿cuánto tardan?');
    assert.equal(c.interactivo?.type, 'flow'); assert.equal(c.interactivo.action.parameters.flow_cta, 'Continuar pedido');
    assert.match(c.carga.texto, /^\*Tiempo estimado\*[\s\S]*Tu pedido guardado sigue aquí/);
    assert.equal((await f.leer()).carrito.items.length, 1);
  });
  await caso('A1 promociones: el texto oficial sin ofrecer_promocion; un «sí» después no agrega nada', async () => {
    const f = await fixture();
    await guardarPromocion(f.negocioId, { nombre: 'Café 2x1', tipo: '2x1', automatica: true, cantidadRequerida: 2,
      cantidadBeneficiada: 1, canales: ['whatsapp'], productos: [f.productoId] });
    const q = await f.texto('¿Qué promociones tienen?');
    const t = (await f.turnos()).at(-1);
    assert(!JSON.stringify(t.acciones).includes('ofrecer_promocion'), JSON.stringify(t.acciones));
    assert.notEqual((await f.leer()).pendiente?.tipo, 'aceptar_promocion');
    assert.match(t.recuperacion, /^recepcion:R11:fija:promociones/);
    await f.texto('sí');
    assert.equal((await f.leer()).carrito.items.length, 0); assert.equal(f.modelo(), 0);
    assert(q.carga.texto.length > 0);
  });
  await caso('A2 «quiero ordenar a domicilio» con carrito: el formulario, sin definir la modalidad por texto', async () => {
    const f = await fixture();
    await f.escribir({ carrito: { items: CARRITO(f), datos: { cliente: { nombre: 'Cliente local', telefono: f.telefono } } }, pendiente: null });
    const q = await f.texto('quiero ordenar a domicilio');
    assert.equal(q.interactivo?.type, 'flow');
    const e = await f.leer();
    assert.equal(e.carrito.datos.modalidad, undefined, 'la modalidad se tomó del texto');
    assert(!JSON.stringify((await f.turnos()).at(-1).acciones).includes('definir_entrega'));
  });
  await caso('A4 «quiero pedir a domicilio» sin carrito: el formulario, sin definir la modalidad', async () => {
    const f = await fixture();
    const q = await f.texto('quiero pedir a domicilio');
    assert.equal(flowId(q), ID.categorias);
    assert.equal((await f.leer()).carrito.datos.modalidad, undefined);
    assert(!JSON.stringify((await f.turnos()).at(-1).acciones).includes('definir_entrega'));
  });
  await caso('A3 dirección escrita (con lectura de dirección por texto encendida): no se define la entrega', async () => {
    const f = await fixture({ extra: { whatsapp_direccion_texto_v1: 'true' } });
    await f.escribir({ carrito: { items: CARRITO(f), datos: { modalidad: 'entrega a domicilio', forma_pago: 'efectivo',
      cliente: { nombre: 'Cliente local', telefono: f.telefono } } }, pendiente: { tipo: 'direccion' } });
    await f.texto('Calle Hidalgo 405, colonia Centro');
    const e = await f.leer();
    assert.equal(e.carrito.datos.cliente?.direccion, undefined, 'la dirección se tomó del texto');
    assert(!JSON.stringify((await f.turnos()).at(-1).acciones).includes('definir_entrega'));
  });
  await caso('A5 una salsa escrita con la lista abierta no modifica el renglón', async () => {
    const f = await fixture();
    await f.escribir({ carrito: { items: CARRITO(f), datos: { cliente: { nombre: 'Cliente local', telefono: f.telefono } } },
      pendiente: { tipo: 'elegir_opcion', linea_id: 'mixtos-1', grupo: 'Salsa', producto: 'Chilaquiles Mixtos', candidatos: ['Roja', 'Verde'] },
      eleccionInteractiva: { ciclo: (await f.leer()).conversacionId, linea_id: 'mixtos-1', producto_id: String(f.mixtosId), grupo: 'Salsa', id: randomUUID() } });
    await f.texto('roja');
    assert.deepEqual((await f.leer()).carrito.items[0].modificadores, [], 'el texto modificó el renglón');
    assert(!JSON.stringify((await f.turnos()).at(-1).acciones).includes('modificar_linea'));
  });
  await caso('R10m modalidad escrita: la misma pregunta otra vez, con el aviso de usar las opciones', async () => {
    const f = await fixture({ extra: { whatsapp_flow_configurar_id: '' } });
    await f.escribir({ carrito: { items: [{ lid: 'cafe-1', id: f.productoId, nombre: 'Café americano', cantidad: 1, modificadores: [], notas: '' }],
      datos: { cliente: { nombre: 'Cliente local', telefono: f.telefono } } }, pendiente: { tipo: 'modalidad', opciones: ['recoger en tienda', 'entrega a domicilio'] } });
    const q = await f.texto('a domicilio');
    assert((await f.leer()).carrito.datos.modalidad === undefined);
    assert(['button', 'list', 'flow'].includes(q.interactivo?.type), JSON.stringify(q.carga).slice(0, 200));
    if (q.interactivo.type !== 'flow') assert(q.carga.texto.startsWith(FRASES.USA_OPCIONES), q.carga.texto);
    assert.equal((await f.leer()).recepcion?.ultimo, 'usa_opciones');
  });
  await caso('D2 «sí» al resumen registra el pedido ligado a su huella; otra huella vuelve a mostrar el resumen con botones', async () => {
    const f = await fixture();
    const conversacionId = (await f.leer()).conversacionId;
    await f.escribir({ carrito: { items: [{ lid: 'cafe-1', id: f.productoId, nombre: 'Café americano', cantidad: 1, modificadores: [], notas: '' }],
      datos: { modalidad: 'recoger en tienda', forma_pago: 'efectivo', cliente: { nombre: 'Cliente local', telefono: f.telefono } } },
    pendiente: { tipo: 'confirmar_resumen', huella: 'vieja', dialogo_id: 'd-viejo' },
    dialogo: { id: 'd-viejo', ciclo: conversacionId, tipo: 'resumen', huella: 'vieja', texto: 'Resumen viejo ¿Confirmas este pedido?', enviado: true } });
    const r1 = await f.texto('sí');
    assert.equal(f.registrados.length, 0, 'registró con una huella vieja');
    assert.match(r1.carga.texto, /¿Confirmas este pedido\?$/);
    assert.deepEqual(titulos(r1), ['Confirmar', 'Cambiar algo', 'Agregar otro']);
    const r2 = await f.texto('sí');
    assert.equal(f.registrados.length, 1, `no registró: ${r2.carga.texto}`);
    assert.equal((await f.leer()).folio, 'XAB-T1'); assert.equal(f.modelo(), 0);
  });
  await caso('A6 «Cambiar algo» sin formulario de edición → persona (no «escribe qué deseas cambiar»)', async () => {
    const f = await fixture();
    const conversacionId = (await f.leer()).conversacionId;
    await f.escribir({ carrito: { items: [{ lid: 'cafe-1', id: f.productoId, nombre: 'Café americano', cantidad: 1, modificadores: [], notas: '' }],
      datos: { modalidad: 'recoger en tienda', forma_pago: 'efectivo', cliente: { nombre: 'Cliente local', telefono: f.telefono } } },
    pendiente: { tipo: 'confirmar_resumen', huella: 'vieja', dialogo_id: 'd-viejo' },
    dialogo: { id: 'd-viejo', ciclo: conversacionId, tipo: 'resumen', huella: 'vieja', texto: 'Resumen ¿Confirmas este pedido?', enviado: true } });
    const resumen = await f.texto('sí');
    await actualizarConfiguracion({ whatsapp_flow_carrito_id: '', whatsapp_flow_configurar_id: '', whatsapp_flow_editar_id: '' }, f.negocioId);
    const q = await f.tocar(resumen, 'Cambiar algo');
    await exigirPersona(f, q, 'RECEPCION_FORMULARIO_NO_DISPONIBLE', FRASES.PERSONA_PEDIDO);
  });
  await caso('A7 «Agregar otro» sin formulario → persona', async () => {
    const f = await fixture();
    const conversacionId = (await f.leer()).conversacionId;
    await f.escribir({ carrito: { items: [{ lid: 'cafe-1', id: f.productoId, nombre: 'Café americano', cantidad: 1, modificadores: [], notas: '' }],
      datos: { modalidad: 'recoger en tienda', forma_pago: 'efectivo', cliente: { nombre: 'Cliente local', telefono: f.telefono } } },
    pendiente: { tipo: 'confirmar_resumen', huella: 'vieja', dialogo_id: 'd-viejo' },
    dialogo: { id: 'd-viejo', ciclo: conversacionId, tipo: 'resumen', huella: 'vieja', texto: 'Resumen ¿Confirmas este pedido?', enviado: true } });
    const resumen = await f.texto('sí');
    await actualizarConfiguracion({ whatsapp_flow_carrito_id: '', whatsapp_flow_categorias_id: '', whatsapp_flow_configurar_id: '' }, f.negocioId);
    const q = await f.tocar(resumen, 'Agregar otro');
    await exigirPersona(f, q, 'RECEPCION_FORMULARIO_NO_DISPONIBLE', FRASES.PERSONA_PEDIDO);
  });
  await caso('D1 «cancela mi pedido» cancela el borrador (sin modelo)', async () => {
    const f = await fixture();
    await f.escribir({ carrito: { items: CARRITO(f), datos: { cliente: { nombre: 'Cliente local', telefono: f.telefono } } }, pendiente: null });
    const q = await f.texto('cancela mi pedido');
    assert.match(q.carga.texto, /borrador fue cancelado/);
    const e = await f.leer(); assert.equal(e.hechos.cancelado, true); assert.equal(e.carrito.items.length, 0);
  });
  await caso('F1 el formulario aplicado sigue llegando a la siguiente pregunta o al resumen (formularios de siempre)', async () => {
    const f = await fixture({ legado: true });
    const q = await f.texto('quiero hacer un pedido');
    assert.equal(flowId(q), ID.productos);
    const foto = (await pool.query(`SELECT b.datos FROM agente_botones b JOIN agente_preguntas_interactivas p ON p.id=b.pregunta_id
      WHERE p.negocio_id=$1 ORDER BY p.created_at DESC LIMIT 1`, [f.negocioId])).rows[0].datos;
    const i = foto.productos.findIndex((p) => p.nombre === 'Café americano');
    assert(i >= 0);
    const m = { id: `wamid.ia.${randomUUID()}`, from: f.telefono, timestamp: String(Math.floor(Date.now() / 1000)), type: 'interactive',
      context: { id: q.wamid }, interactive: { type: 'nfm_reply', nfm_reply: { name: 'flow', body: 'Sent',
        response_json: JSON.stringify({ flow_token: q.interactivo.action.parameters.flow_token, producto0: `p${i}` }) } } };
    await pool.query("INSERT INTO whatsapp_entradas(negocio_id,telefono,wamid,payload,estado) VALUES($1,$2,$3,$4,'completado')",
      [f.negocioId, f.telefono, m.id, JSON.stringify({ message: m })]);
    const r = await atenderConAgente({ negocioId: f.negocioId, telefono: f.telefono, mensaje: '', wamids: [m.id],
      interaccion: { mensajes: [m], mixto: false }, llamarModelo: async () => { throw Error('NO'); },
      escalarAHumano: async () => true, registrar: async () => { throw Error('NO'); } });
    assert.equal(r.ok, true, JSON.stringify(r).slice(0, 200));
    const e = await f.leer();
    assert.equal(e.carrito.items.length, 1, `el formulario no se aplicó: ${r.texto}`);
    assert.equal(e.carrito.items[0].nombre, 'Café americano');
  });
  await caso('R9 otro día con tienda: la liga y «Pedir para hoy» abre el formulario (la programación no bloquea)', async () => {
    const f = await fixture();
    await pool.query(`INSERT INTO tienda_config (negocio_id, estado, modalidades, acepta_programados, anticipacion_minutos, publicada_at, slug_publico)
      VALUES ($1,'publicada','["recoger"]'::jsonb,TRUE,40,NOW(),$2)`, [f.negocioId, `ia-${f.marca.slice(0, 8)}`]);
    const q = await f.texto('quiero unos chilaquiles para mañana a las 10');
    assert.match(q.carga.texto, /^Para un pedido de otro día, agéndalo en nuestra tienda en línea: https?:\/\/\S+\/t\/ia-/);
    assert.deepEqual(titulos(q), ['Pedir para hoy', 'Más información', 'Hablar con alguien']);
    assert.notEqual((await f.leer()).programacionRequerida, true, 'se marcó la programación');
    const hoy = await f.tocar(q, 'Pedir para hoy');
    assert.equal(hoy.interactivo?.type, 'flow', `«Pedir para hoy» no abrió el formulario: ${hoy.carga.texto}`);
  });
  await caso('S1 servicios intactos: «hacen eventos?» abre «Datos del evento»', async () => {
    const f = await fixture();
    const q = await f.texto('¿hacen eventos? es para un cumpleaños de 50 personas');
    assert.equal(flowId(q), ID.evento, q.carga.texto);
    assert.equal(f.modelo(), 0);
  });
  await caso('C7 cerrado: el acuse de cerrado (PARTE 2, C-4); una duda con respuesta sí se contesta sin botones', async () => {
    const cerrado = Object.fromEntries(DIAS.map((d) => [d, { abierto: false }]));
    const f = await fixture({ reglasExtra: { horarios: cerrado } });
    const q = await f.texto('quiero 2 chilaquiles mixtos');
    assert.equal(q.carga.texto, FRASES.PEDIDO_ESCRITO_CERRADO + 'Recibimos tu mensaje. 🙂 Ahora estamos cerrados; el personal te contesta por aquí en cuanto abramos.');
    assert.equal(q.carga.interactivo, undefined);
    assert.equal((await f.leer()).recepcion?.ultimo, 'cerrado');
    const h = await f.texto('¿A qué hora abren?');
    assert.equal(h.carga.texto, '*Horario*\nLunes a domingo: cerrado');
    assert.equal(h.carga.interactivo, undefined, 'cerrado: la respuesta salió con botones o formulario');
    assert.equal(f.modelo(), 0);
  });
  await caso('CP1 orden completa escrita: formulario con acuse, mensaje original persistido y ningún pedido registrado', async () => {
    const f = await fixture();
    const mensaje = 'Voy a pedir:\n2 chilaquiles mixtos con pollo y salsa roja\n1 café americano\nPara recoger, pago en efectivo';
    const q = await f.texto(mensaje);
    assert.equal(flowId(q), ID.categorias);
    assert(q.carga.texto.startsWith(FRASES.PEDIDO_ESCRITO));
    assert.equal(q.entrega?.estado, 'entregado');
    assert.equal(f.modelo(), 0);
    assert.equal((await f.leer()).carrito.items.length, 0);
    assert.equal(f.registrados.length, 0);
    const entradas = (await pool.query('SELECT payload FROM whatsapp_entradas WHERE negocio_id=$1', [f.negocioId])).rows;
    assert(entradas.some(e => e.payload?.message?.text?.body === mensaje));
    const otra = await f.texto(mensaje);
    await exigirPersona(f, otra, MOTIVOS_RECEPCION.PEDIDO_ESCRITO, FRASES.PERSONA_PEDIDO);
    assert.equal(f.registrados.length, 0);
  });
  await caso('CP2 aviso de cerrado seguido de orden escrita: hay nueva respuesta sin formulario, modelo ni registro', async () => {
    const f = await fixture({ reglasExtra: { horarios: Object.fromEntries(DIAS.map(d => [d, { abierto: false }])) } });
    const primero = await f.texto('hola');
    assert.match(primero.carga.texto, /cerrados/);
    const q = await f.texto('Voy a pedir:\n2 chilaquiles mixtos con pollo\n1 café americano');
    assert(q.carga.texto.startsWith(FRASES.PEDIDO_ESCRITO_CERRADO));
    assert.equal(q.carga.interactivo, undefined);
    assert.equal(q.entrega?.estado, 'entregado');
    assert.equal((await f.leer()).carrito.items.length, 0);
    assert.equal(f.modelo(), 0);
    assert.equal(f.registrados.length, 0);
    const duda = await f.texto('¿Me orientan sobre una entrega especial?');
    assert.equal(duda.entrega?.estado, 'entregado');
    assert.match(duda.carga.texto, /cerrados/);
  });
  await caso('CP3 cerrado conserva el seguimiento de un pedido del teléfono después del aviso', async () => {
    const f = await fixture({ reglasExtra: { horarios: Object.fromEntries(DIAS.map(d => [d, { abierto: false }])) } });
    const folio = `LOCAL-${f.marca.slice(0, 8)}`;
    await pool.query(`INSERT INTO pedidos_activos(folio,negocio_id,estado,datos)
      VALUES($1,$2,'en_preparacion',$3)`, [folio, f.negocioId,
      JSON.stringify({ cliente: { telefono: f.telefono }, modalidad: 'recoger en tienda' })]);
    await f.texto('hola');
    const q = await f.texto('¿Cómo va mi pedido?');
    assert.match(q.carga.texto, /en preparación/i);
    assert(q.carga.texto.includes(folio));
    assert.doesNotMatch(q.carga.texto, /ya va en camino|Ahora estamos cerrados/);
    assert.equal(q.entrega?.estado, 'entregado');
    assert.equal(q.carga.interactivo, undefined);
    assert.equal(f.modelo(), 0);
    assert.equal(f.registrados.length, 0);
  });
  await caso('CP4 orden larga con nombres ajenos al menú llega al formulario y conserva íntegro el texto', async () => {
    const f = await fixture();
    const mensaje = `2 bagels de salmón con ${'ingredientes adicionales '.repeat(30)}\n1 limonada de pepino`;
    const q = await f.texto(mensaje);
    assert.equal(flowId(q), ID.categorias);
    assert(q.carga.texto.startsWith(FRASES.PEDIDO_ESCRITO));
    assert.equal(q.entrega?.estado, 'entregado');
    const e = (await pool.query('SELECT payload FROM whatsapp_entradas WHERE negocio_id=$1', [f.negocioId])).rows;
    assert(e.some(r => r.payload?.message?.text?.body === mensaje));
    assert.equal((await f.leer()).carrito.items.length, 0);
    assert.equal(f.modelo(), 0);
    assert.equal(f.registrados.length, 0);
  });
  await caso('CP5 orden escrita con pregunta de pago conserva la respuesta aprobada en el Flow', async () => {
    const f = await fixture();
    const q = await f.texto('2 chilaquiles mixtos\n1 café americano\n¿Aceptan efectivo?');
    assert.equal(q.interactivo?.type, 'flow');
    assert.match(q.interactivo.body.text, /Formas de pago/);
    assert.match(q.interactivo.body.text, /Efectivo/);
    assert.match(q.interactivo.body.text, /no está registrado/);
    assert(q.interactivo.body.text.length <= 1024);
    assert.equal(q.entrega?.estado, 'entregado');
    assert.equal((await f.leer()).carrito.items.length, 0);
    assert.equal(f.modelo(), 0);
    assert.equal(f.registrados.length, 0);
  });
  await caso('CP6 cerrado recibe orden y pregunta de pago sin tapar ninguna parte', async () => {
    const f = await fixture({ reglasExtra: { horarios: Object.fromEntries(DIAS.map(d => [d, { abierto: false }])) } });
    await f.texto('hola');
    const q = await f.texto('2 bagels de salmón\n1 limonada de pepino\n¿Aceptan efectivo?');
    assert.match(q.carga.texto, /no confirma/);
    assert.match(q.carga.texto, /cerrados/);
    assert.match(q.carga.texto, /Formas de pago/);
    assert.equal(q.carga.interactivo, undefined);
    assert.equal(q.entrega?.estado, 'entregado');
    assert.equal((await f.leer()).carrito.items.length, 0);
    assert.equal(f.modelo(), 0);
    assert.equal(f.registrados.length, 0);
  });
  await caso('CP7 información larga completa: texto sin formulario imposible y vía humana operable', async () => {
    const informacion = 'Opciones aprobadas para esta solicitud. '.repeat(24).trim();
    const f = await fixture({ reglasExtra: { bot: { faqs: [{ pregunta: 'Pedido especial', respuesta: informacion }] } } });
    const q = await f.texto('2 chilaquiles mixtos\n1 café americano\n¿Me ayudan con el pedido especial?');
    assert(q.carga.texto.includes(informacion));
    assert.match(q.carga.texto, /todavía no está registrado/);
    assert.match(q.carga.texto, /hablar con alguien/);
    assert.doesNotMatch(q.carga.texto, /este formulario|elige tus platillos/i);
    assert.equal(q.carga.interactivo, undefined);
    assert.equal(q.entrega?.estado, 'entregado');
    await exigirPersona(f, await f.texto('hablar con alguien'), MOTIVOS_RECEPCION.PIDE_PERSONA, FRASES.PERSONA);
    assert.equal(f.registrados.length, 0);
  });
  await caso('SIM el simulador del Asistente muestra lo que vería un cliente del alcance, sin llamar al modelo', async () => {
    const { simularConAgente } = await import('../src/mesero-agente/canalDelAgente.js');
    const f = await fixture({ extra: { [CLAVES_IA.ALCANCE]: 'prueba', [CLAVES_IA.TELEFONOS]: '5218780000000' } });
    let llamadas = 0;
    const sim = (mensaje) => simularConAgente({ sessionId: `sim-${randomUUID()}`, negocioId: f.negocioId, mensaje,
      llamarModelo: async () => { llamadas++; throw Error('EL_MODELO_NO_SE_LLAMA'); } });
    const pedido = await sim('Quiero 2 chilaquiles mixtos con pollo');
    assert(pedido.texto.startsWith(FRASES.PEDIDO_ESCRITO.trim()), pedido.texto);
    assert.match(pedido.texto, /\n\[Formulario: .+\]$/, pedido.texto);
    const horario = await sim('¿A qué hora abren?');
    assert.match(horario.texto, /^\*Horario\*[\s\S]*\n\[Botones: Hacer pedido · Más información · Hablar con alguien\]$/);
    const persona = await sim('quiero hablar con una persona');
    assert.equal(persona.texto, `${FRASES.PERSONA}\n[Pasa a una persona: RECEPCION_PIDE_PERSONA]`); assert.equal(persona.escalar, true);
    const info = await sim('info');
    assert.match(info.texto, /\n\[Lista: Horario · Ubicación · /);
    assert.equal(llamadas, 0);
  });
  // ── Revisión 3 ─────────────────────────────────────────────────────────
  await caso('RC un «gracias» u «ok» no cuenta como «no te entendí»: ni dos ni tres pasan a una persona; la segunda cortesía no recibe nada', async () => {
    const f = await fixture();
    const q1 = await f.texto('asdf qwer zxcv');
    assert.equal(q1.carga.texto, FRASES.NO_RECONOCIDO);
    const q2 = await f.texto('gracias');
    assert.equal(q2.carga.texto, FRASES.CORTESIA);
    assert.deepEqual(titulos(q2), ['Hacer pedido', 'Más información', 'Hablar con alguien']);
    assert.equal((await f.leer()).recepcion?.ultimo, 'cortesia');
    const q3 = await f.texto('ok gracias 👍');
    assert.equal(q3.r.sinRespuesta, true, 'la segunda cortesía contestó'); assert.equal(q3.fila, null);
    const q4 = await f.texto('ñlkj poiu');
    assert.equal(q4.carga.texto, FRASES.NO_RECONOCIDO, 'tras una cortesía, otro «no te entendí» no es insistir');
    assert.deepEqual(f.handoffs, []); assert.equal(await f.pausado(), false);
    assert.equal(f.modelo(), 0);
  });
  await caso('RCF con el formulario de pedido en curso, un «ok» vuelve a mandar el mismo formulario (el anterior vence con el texto)', async () => {
    const f = await fixture();
    const q1 = await f.texto('quiero hacer un pedido');
    assert.equal(flowId(q1), ID.categorias);
    const q2 = await f.texto('ok');
    assert.equal(q2.interactivo?.type, 'flow'); assert.equal(flowId(q2), ID.categorias);
    assert(q2.carga.texto.startsWith(FRASES.CORTESIA_FORMULARIO), q2.carga.texto.slice(0, 80));
    assert.equal((await f.leer()).pendiente?.tipo, 'agregar_otro');
    assert.deepEqual(f.handoffs, []);
  });
  await caso('FB un formulario que salió como TEXTO de respaldo cuenta: volver a escribir el pedido pasa a una persona', async () => {
    const f = await fixture();
    const q1 = await f.texto('quiero hacer un pedido');
    assert.equal(flowId(q1), ID.categorias);
    // Lo que deja entregaRespuestas.js cuando el teléfono no recibe el Flow.
    await pool.query(`UPDATE agente_outbox SET carga=jsonb_set(carga,'{texto_enviado}',to_jsonb(carga->>'texto_fallback')) WHERE evento_clave=$1`,
      [q1.fila.evento_clave]);
    const q2 = await f.texto('2 chilaquiles mixtos con pollo y salsa roja');
    await exigirPersona(f, q2, 'RECEPCION_PEDIDO_ESCRITO', FRASES.PERSONA_PEDIDO);
  });
  await caso('NF un formulario que el cliente YA ENVIÓ no cuenta: «quiero hacer otro pedido» recibe el formulario, no una persona', async () => {
    const f = await fixture();
    const q1 = await f.texto('quiero hacer un pedido');
    assert.equal(flowId(q1), ID.categorias);
    // La respuesta del Flow (nfm_reply) después de entregarlo.
    await pool.query("INSERT INTO whatsapp_entradas(negocio_id,telefono,wamid,payload,estado) VALUES($1,$2,$3,$4,'completado')",
      [f.negocioId, f.telefono, `wamid.ia.flow.${randomUUID()}`, JSON.stringify({ message: { type: 'interactive',
        interactive: { type: 'nfm_reply', nfm_reply: { name: 'flow', body: 'Sent', response_json: '{}' } } } })]);
    const q2 = await f.texto('quiero hacer otro pedido');
    assert.equal(flowId(q2), ID.categorias, `${q2.carga.texto?.slice(0, 80)} ${f.handoffs}`);
    assert.deepEqual(f.handoffs, []);
  });
  await caso('MO «Hacer pedido» sin formulario que mandar → persona (nunca «Elige tus platillos» sin nada debajo)', async () => {
    const f = await fixture();
    const q1 = await f.texto('asdf qwer zxcv');
    assert.deepEqual(titulos(q1), ['Hacer pedido', 'Más información', 'Hablar con alguien']);
    await actualizarConfiguracion({ whatsapp_flow_categorias_id: '', whatsapp_flow_carrito_id: '' }, f.negocioId);
    const q2 = await f.tocar(q1, 'Hacer pedido');
    await exigirPersona(f, q2, 'RECEPCION_FORMULARIO_NO_DISPONIBLE', FRASES.PERSONA_PEDIDO);
  });
  await caso('TP la cortesía tras el pedido (ruta «turno») no se reescribe con «¿Cuál prefieres?» por una modalidad descartada', async () => {
    const f = await fixture();
    await f.escribir({ folio: 'XAB-T9', hechos: { ...(await f.leer()).hechos, confirmado: true }, pendiente: null,
      carrito: { items: CARRITO(f), datos: { modalidad: 'consumo en sitio', forma_pago: 'efectivo', cliente: { nombre: 'Cliente local', telefono: f.telefono } } } });
    const q = await f.texto('muchas gracias');
    assert(!/¿Cuál prefieres\?/.test(q.carga.texto || ''), q.carga.texto);
    assert.equal(q.carga.texto, '¡Gracias a ti! Si necesitas algo más, aquí estamos para ayudarte.');
    assert.equal(f.modelo(), 0);
  });
  await caso('RF las preguntas de envío y promociones como las escriben reciben su respuesta fija por el adaptador', async () => {
    const f = await fixture();
    const e = await f.texto('Tiene servicio a domicilio?');
    assert.match(e.carga.texto, /^\*Envío a domicilio\*/);
    const p = await f.texto('Hola buen día, disculpa hoy tienes alguna promoción');
    assert.match((await f.turnos()).at(-1).recuperacion, /^recepcion:R11:fija:promociones/); assert(p.carga.texto.length > 0);
    assert.deepEqual(f.handoffs, []);
  });

  await caso('P0 sin la bandera: el mismo pedido escrito llega al modelo como hoy (la prueba distingue)', async () => {
    const f = await fixture({ modo: null });
    await f.texto('Quiero 2 chilaquiles mixtos con pollo');
    assert(f.modelo() > 0, 'sin la bandera el turno no llegó al modelo');
  });
} finally {
  await new Promise((r) => setTimeout(r, 200));
  console.log(`\nmodo formulario contra Postgres: ${n} pasadas, ${fallidas} fallidas${noAtendidas.length ? ` · rechazos sin atender: ${noAtendidas.length}` : ''}`);
  await pool.end().catch(() => {});
  if (fallidas || noAtendidas.length) process.exitCode = 1;
}
