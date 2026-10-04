// ─── RESCATE HUMANO CONTRA POSTGRES ────────────────────────────────────────
//
// Incidente 2-oct-2026, Mapolato Obispado: el proveedor falló dos veces, el
// cliente recibió el mismo formulario dos veces, escribió «No carga» y se fue
// sin que nadie del equipo se enterara. Por el ADAPTADOR REAL
// (`atenderConAgente`), con la configuración de Obispado, la continuidad real
// (pausa y revisión) y la entrega real del outbox; de mentira solo el modelo
// (un doble que lanza el mismo `Error` sin status que el SDK 0.30.1 lanza en
// un timeout) y el transporte de Meta.
//
// Base local test_botones_*, red solo local. Sin mensajes, pedidos ni pagos reales.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool, actualizarConfiguracion, setBotPausado, obtenerConfiguracion } from '../src/services/database.js';
import { prepararNegocioMixtos } from './lib-botones-local.mjs';
import { atenderConAgente, avisarAHumano, AVISO_PEDIDO_SIN_ARMAR } from '../src/mesero-agente/canalDelAgente.js';
import { leerEstadoVersionado } from '../src/mesero-agente/persistenciaDelTurno.js';
import { entregarRespuesta } from '../src/mesero-agente/entregaDeRespuestas.js';
import { crearContinuidad } from '../src/services/whatsappContinuidad.js';
import { TEXTO_RESCATE, BANDERA_RESCATE } from '../src/mesero-agente/rescateHumano.js';
import { configurarAvisoRescate, esperarAvisosEnCurso, BANDERA_AVISO_WHATSAPP } from '../src/services/avisoRescateHumano.js';
Object.assign(process.env, { MESERO_AGENTE_MODE: 'true', WHATSAPP_INTERACTIVOS: 'true', WHATSAPP_FLOW_ENDPOINT: 'true',
  WHATSAPP_FLOW_PRIVATE_KEY: 'solo-local', META_APP_SECRET: 'solo-local' });

const noAtendidas = [];
process.on('unhandledRejection', (e) => { noAtendidas.push(e); });
const sinEfectos = async () => { throw Error('NO_PEDIDOS_PAGOS_TICKETS'); };
const ADMIN_LOCAL = '520000000001'; // número de prueba: nunca sale (el envío es un doble)

let n = 0; let fallidas = 0;
const SOLO = (process.env.CASOS || '').split(',').map((s) => s.trim()).filter(Boolean);
async function caso(nombre, fn) {
  if (SOLO.length && !SOLO.includes(nombre.split(' ')[0])) return;
  try { await fn(); console.log(`OK rescate-humano ${++n}: ${nombre}`); }
  catch (e) {
    fallidas++;
    const detalle = e?.code === 'ERR_ASSERTION' && e.generatedMessage
      ? ` · obtenido=${JSON.stringify(e.actual)?.slice(0, 160)} · esperado=${JSON.stringify(e.expected)?.slice(0, 80)}` : '';
    console.log(`FALLA rescate-humano: ${nombre}\n  ${String(e?.message || e).split('\n')[0]}${detalle}`);
  }
}

// Los avisos al equipo: dobles del panel y del WhatsApp al encargado; la
// bandera y la revisión se leen de la base de verdad.
const avisosPanel = [];
const avisosWhatsapp = [];
const EFECTOS_DE_PRUEBA = {
  broadcastPanel: (negocioId, data) => avisosPanel.push({ negocioId, data }),
  enviarAvisoWhatsapp: async (numero, texto, negocioId) => { avisosWhatsapp.push({ numero, texto, negocioId }); },
  log: () => {},
};
configurarAvisoRescate(EFECTOS_DE_PRUEBA);

// La configuración de Mapolato Obispado en producción (atención general,
// beta híbrida, formularios), como fase-carrito-respuestas-db. `avisoWhatsapp`
// enciende el WhatsApp al encargado, que va aparte y nace apagado.
async function fixture({ rescate = false, vacio = true, handoffFalla = false, avisoWhatsapp = false } = {}) {
  const f = await prepararNegocioMixtos();
  if (vacio) {
    f.estado.carrito.items = [];
    await pool.query('UPDATE conversacion_estado SET estado=$3 WHERE negocio_id=$1 AND session_id=$2',
      [f.negocioId, `agente:${f.telefono}`, JSON.stringify(f.estado)]);
  }
  await actualizarConfiguracion({ nombre: 'Mapolato Obispado', whatsapp_inicio_mapo_v1: 'true',
    whatsapp_atencion_general_v1: 'true', bot_whatsapp_solo_prueba: 'false', mesero_agente_porcentaje: '100',
    mesero_agente_telefonos: '', whatsapp_flows_v1: 'true', whatsapp_flows_telefonos: '', whatsapp_beta_hibrido_v1: 'true',
    whatsapp_beta_telefonos: '', whatsapp_carrito_unificado_v1: 'true', whatsapp_interactivos_elecciones_v1: 'true',
    whatsapp_flow_categorias_id: '11111111111', whatsapp_flow_carrito_id: '22222222222',
    whatsapp_flow_configurar_id: '44444444444', whatsapp_flow_carrito_duplicar_v1: 'true',
    whatsapp_flow_facturacion_id: '66666666666', whatsapp_flow_evento_id: '77777777777',
    wa_admin_numero: ADMIN_LOCAL, ...(rescate ? { [BANDERA_RESCATE]: 'true' } : {}),
    ...(avisoWhatsapp ? { [BANDERA_AVISO_WHATSAPP]: 'true' } : {}) }, f.negocioId);
  const continuidad = crearContinuidad({ pool, locks: pool, procesar: sinEfectos, cargarSesion: sinEfectos,
    leerSesion: sinEfectos, alRevision: (neg, tel) => setBotPausado(tel, true, neg) });
  const handoffs = [];
  // El escalarAHumano de whatsapp-meta.js para el agente, con la continuidad real.
  const escalar = async (neg, tel, motivo) => {
    handoffs.push(motivo);
    if (handoffFalla) return false;
    return (await continuidad.enviarARevision(neg, tel, motivo)) || continuidad.revisionActiva(neg, tel);
  };
  const procesar = async (texto, { modelo = null, entregar = true } = {}) => {
    let llamadas = 0;
    const llamar = async (payload) => {
      llamadas++;
      if (!modelo) throw Error('NO_DEBE_LLAMAR_MODELO');
      return modelo(payload, llamadas);
    };
    const m = { id: 'wamid.rescate.' + randomUUID(), from: f.telefono, timestamp: String(Math.floor(Date.now() / 1000)),
      type: 'text', text: { body: texto } };
    await pool.query("INSERT INTO whatsapp_entradas(negocio_id,telefono,wamid,payload,estado) VALUES($1,$2,$3,$4,'completado')",
      [f.negocioId, f.telefono, m.id, JSON.stringify({ message: m })]);
    const r = await atenderConAgente({ negocioId: f.negocioId, telefono: f.telefono, nombre: 'Cliente local',
      mensaje: texto, wamids: [m.id], llamarModelo: llamar, escalarAHumano: escalar,
      registrar: sinEfectos, emitir: sinEfectos, guardar: sinEfectos, crearPago: sinEfectos });
    await esperarAvisosEnCurso();
    const fila = r.outbox ? (await pool.query('SELECT * FROM agente_outbox WHERE evento_clave=$1', [r.outbox.clave])).rows[0] : null;
    let entrega = null;
    if (entregar && fila && r.ok) {
      entrega = await entregarRespuesta({ outboxClave: fila.evento_clave,
        enviar: async () => ({ messages: [{ id: 'wamid.salida.' + randomUUID() }] }), alHumano: sinEfectos });
    }
    return { r, fila, carga: fila?.carga || {}, entrega, llamadas };
  };
  const leer = () => leerEstadoVersionado(f.negocioId, f.telefono);
  const turnos = async () => (await pool.query(`SELECT motivo_handoff, cierre, recuperacion FROM agente_turnos
    WHERE negocio_id=$1 AND conversacion_id LIKE $2 ORDER BY id`, [f.negocioId, `agente:${f.telefono}%`])).rows;
  const eventosHandoff = async () => (await pool.query(`SELECT carga FROM agente_outbox
    WHERE negocio_id=$1 AND tipo='handoff' ORDER BY created_at`, [f.negocioId])).rows.map((x) => x.carga);
  const pausado = async () => (await pool.query('SELECT bot_pausado FROM conversaciones_control WHERE negocio_id=$1 AND telefono=$2',
    [f.negocioId, f.telefono])).rows[0]?.bot_pausado === true;
  const avisos = () => ({ panel: avisosPanel.filter((a) => a.negocioId === f.negocioId),
    whatsapp: avisosWhatsapp.filter((a) => a.negocioId === f.negocioId) });
  return { ...f, procesar, leer, turnos, eventosHandoff, pausado, avisos, handoffs, escalar, continuidad };
}

// El SDK 0.30.1 lanza APIConnectionTimeoutError con name 'Error' y sin status:
// es el «motivo: Error» de agente_turnos.errores_proveedor del 2-oct.
const timeout = async () => { throw new Error('Request timed out.'); };
// buscar → agregar → timeout: el modelo aplica un artículo y luego falla. El
// turno cierra igual como 'fallo_proveedor_sin_efectos' (con carrito).
const parcialYTimeout = (productoId) => async (_p, i) => {
  if (i === 1) return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu-' + randomUUID(),
    name: 'buscar_producto', input: { texto: 'café americano' } }] };
  if (i === 2) return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu-' + randomUUID(),
    name: 'agregar_producto', input: { producto_id: String(productoId), cantidad: 1 } }] };
  throw new Error('Request timed out.');
};

try {
  await caso('01 sin bandera: dos timeouts con el carrito vacío repiten «No pude armar tu pedido» y el formulario', async () => {
    const f = await fixture();
    for (const texto of ['Quiero unos chilaquiles', 'Quiero unos chilaquiles']) {
      const q = await f.procesar(texto, { modelo: timeout });
      assert.ok(q.llamadas >= 1, 'el turno no llegó al modelo');
      assert.equal(q.r.ok, true, JSON.stringify(q.r).slice(0, 200));
      assert.equal(q.r.recuperacion, 'fallo_proveedor_sin_efectos');
      assert.ok(q.carga.texto.startsWith(AVISO_PEDIDO_SIN_ARMAR.trim()), q.carga.texto.slice(0, 80));
      assert.equal(q.carga.interactivo?.type, 'flow');
      assert.equal(q.entrega?.estado, 'entregado');
    }
    assert.deepEqual(f.handoffs, []);
    assert.equal((await f.leer()).rescate, undefined, 'sin bandera se escribió estado.rescate');
    assert.deepEqual((await f.turnos()).map((t) => t.motivo_handoff), [null, null]);
    assert.equal(f.avisos().panel.length + f.avisos().whatsapp.length, 0);
  });

  await caso('02 con bandera: el 1er timeout sigue igual y el 2º pasa a una persona con un acuse que sí sale', async () => {
    const f = await fixture({ rescate: true, avisoWhatsapp: true });
    const q1 = await f.procesar('Quiero unos chilaquiles verdes con pollo', { modelo: timeout });
    assert.ok(q1.carga.texto.startsWith(AVISO_PEDIDO_SIN_ARMAR.trim()), 'el primer fallo cambió de respuesta');
    assert.equal(q1.carga.interactivo?.type, 'flow');
    assert.equal((await f.leer()).rescate?.fallos?.length, 1);
    assert.deepEqual(f.handoffs, []);
    const q2 = await f.procesar('Quiero unos chilaquiles verdes con pollo', { modelo: timeout });
    assert.equal(q2.r.ok, true, JSON.stringify(q2.r).slice(0, 200));
    assert.equal(q2.carga.texto, TEXTO_RESCATE);
    assert.equal(q2.carga.interactivo, undefined, 'el rescate llevó formulario o botones');
    assert.deepEqual(f.handoffs, ['AGENTE_FALLO_REPETIDO']);
    assert.ok(q2.carga.recibo_handoff, 'el acuse no quedó ligado a la pausa');
    assert.equal(q2.entrega?.estado, 'entregado', `el cliente no recibió el aviso: ${JSON.stringify(q2.entrega)}`);
    const [handoff] = await f.eventosHandoff();
    assert.equal(handoff?.motivo, 'AGENTE_FALLO_REPETIDO');
    const e = await f.leer();
    assert.equal(e.hechos.escalado, true); assert.equal(e.pendiente, null); assert.deepEqual(e.rescate.fallos, []);
    assert.ok(await f.pausado(), 'la conversación no quedó en pausa');
    const t = (await f.turnos()).at(-1);
    assert.equal(t.motivo_handoff, 'AGENTE_FALLO_REPETIDO'); assert.equal(t.cierre, 'escalado');
    assert.equal(t.recuperacion, 'fallo_proveedor_sin_efectos', 'la traza perdió que el proveedor falló');
    const { panel, whatsapp } = f.avisos();
    assert.equal(panel.length, 1); assert.equal(panel[0].data.tipo, 'rescate_humano');
    assert.equal(panel[0].data.motivo, 'AGENTE_FALLO_REPETIDO');
    assert.ok(!JSON.stringify(panel[0].data).includes('chilaquiles'), 'el panel recibió el texto del cliente');
    assert.equal(whatsapp.length, 1); assert.equal(whatsapp[0].numero, ADMIN_LOCAL);
    assert.match(whatsapp[0].texto, /Escribió: «Quiero unos chilaquiles verdes con pollo»/);
    assert.match(whatsapp[0].texto, /falló dos veces seguidas/);
  });

  await caso('03 con bandera y carrito parcial (buscar → agregar → timeout): escala con las líneas en la transferencia', async () => {
    const f = await fixture({ rescate: true });
    const q1 = await f.procesar('Quiero un café americano', { modelo: parcialYTimeout(f.productoId) });
    assert.equal(q1.r.recuperacion, 'fallo_proveedor_sin_efectos');
    assert.equal((await f.leer()).carrito.items.length, 1, 'el agregar del primer turno no quedó');
    assert.deepEqual(f.handoffs, []);
    const q2 = await f.procesar('Y otro café americano', { modelo: parcialYTimeout(f.productoId) });
    assert.equal(q2.r.recuperacion, 'fallo_proveedor_sin_efectos');
    assert.equal(q2.carga.texto, TEXTO_RESCATE);
    assert.deepEqual(f.handoffs, ['AGENTE_FALLO_REPETIDO']);
    const [handoff] = await f.eventosHandoff();
    assert.ok(handoff?.pedido?.lineas?.length >= 1, `la transferencia no lleva el pedido: ${JSON.stringify(handoff)}`);
    assert.match(JSON.stringify(handoff.pedido.lineas), /Café americano/);
    assert.equal(q2.entrega?.estado, 'entregado');
  });

  await caso('04 «No carga» tras el formulario: con bandera no llama al modelo y escala; horario, pedido o dinero sí van al modelo', async () => {
    const f = await fixture({ rescate: true, avisoWhatsapp: true });
    const abierto = await f.procesar('quiero ordenar');
    assert.equal(abierto.carga.interactivo?.type, 'flow', 'el formulario no salió');
    assert.equal(abierto.entrega?.estado, 'entregado');
    // Con el formulario recién entregado (la condición del rescate), preguntas
    // que se tomaban por «no carga» hasta la revisión del 3-oct.
    for (const pregunta of ['¿hoy no abre?', '¿todavía no abre?', '¿no puedo pedir a domicilio?',
      'No cargo efectivo, ¿aceptan tarjeta?', 'Toquen fuerte porque no funciona el timbre']) {
      const q = await f.procesar(pregunta, { modelo: async () => ({ stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Con gusto te ayudo.' }] }) });
      assert.notEqual(q.carga.texto, TEXTO_RESCATE, `«${pregunta}» se tomó por un formulario roto`);
      assert.deepEqual(f.handoffs, [], `«${pregunta}» pausó al bot`);
      if (pregunta === '¿hoy no abre?') assert.equal(q.llamadas, 1, 'una pregunta de horario no llegó al modelo');
    }
    const q = await f.procesar('No carga', { modelo: timeout });
    assert.equal(q.llamadas, 0, '«No carga» esperó al modelo');
    assert.equal(q.r.llamadasAlModelo, 0);
    assert.equal(q.carga.texto, TEXTO_RESCATE);
    assert.equal(q.carga.interactivo, undefined);
    assert.deepEqual(f.handoffs, ['FORMULARIO_NO_CARGA']);
    assert.equal(q.entrega?.estado, 'entregado');
    assert.equal((await f.turnos()).at(-1).motivo_handoff, 'FORMULARIO_NO_CARGA');
    assert.match(f.avisos().whatsapp[0]?.texto || '', /Escribió: «No carga»/);
  });

  await caso('05 «No carga» sin bandera, o sin formulario ni fallo previo, sigue el camino de siempre', async () => {
    const f = await fixture();
    await f.procesar('quiero ordenar');
    const q = await f.procesar('No carga', { modelo: async () => ({ stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Con gusto te ayudo con tu pedido.' }] }) });
    assert.equal(q.llamadas, 1, 'sin bandera el turno debe ir al modelo como hoy');
    assert.deepEqual(f.handoffs, []);
    const g = await fixture({ rescate: true });
    const sinContexto = await g.procesar('No carga', { modelo: async () => ({ stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Con gusto te ayudo con tu pedido.' }] }) });
    assert.equal(sinContexto.llamadas, 1, 'sin formulario ni fallo previo no hay a qué atribuir el «no carga»');
    assert.deepEqual(g.handoffs, []);
  });

  await caso('06 si el handoff falla, no se rearma el formulario ni se pisa el texto, y el motivo se conserva', async () => {
    const f = await fixture({ rescate: true, handoffFalla: true });
    await f.procesar('Quiero unos chilaquiles', { modelo: timeout });
    const q = await f.procesar('Quiero unos chilaquiles', { modelo: timeout, entregar: false });
    assert.equal(q.r.ok, false, 'un handoff no confirmado se declaró atendido');
    assert.equal(q.r.handoffPendiente, true);
    assert.equal(q.carga.texto, TEXTO_RESCATE, `el commit pisó el texto: ${String(q.carga.texto).slice(0, 80)}`);
    assert.equal(q.carga.interactivo, undefined, 'se rearmó el formulario');
    const e = await f.leer();
    assert.equal(e.pendiente, null, 'quedó una pregunta de pedido abierta');
    assert.equal(e.hechos.escalado, false);
    // El rescate y el reintento del desenlace: dos intentos, el mismo motivo.
    assert.deepEqual(f.handoffs, ['AGENTE_FALLO_REPETIDO', 'AGENTE_FALLO_REPETIDO']);
    assert.equal((await f.turnos()).at(-1).motivo_handoff, 'AGENTE_FALLO_REPETIDO');
    assert.equal(f.avisos().panel.length + f.avisos().whatsapp.length, 0, 'avisó de una pausa que no ocurrió');
  });

  await caso('07 el aviso cubre cualquier escalado del agente y sale una vez por revisión', async () => {
    const pideHumano = async () => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu-' + randomUUID(),
      name: 'pedir_humano', input: { motivo: 'necesita una persona' } }] });
    const f = await fixture({ rescate: true, avisoWhatsapp: true });
    await f.procesar('Tengo una consulta especial', { modelo: pideHumano });
    assert.deepEqual(f.handoffs, ['AGENTE_PIDE_HUMANO']);
    assert.equal(f.avisos().panel.length, 1); assert.equal(f.avisos().panel[0].data.motivo, 'AGENTE_PIDE_HUMANO');
    assert.match(f.avisos().panel[0].data.ref || '', /^[a-f0-9]{16}$/, 'el evento no trae la referencia del tag');
    // Otro escalado mientras sigue la misma revisión: sin aviso nuevo.
    assert.equal(await avisarAHumano(f.escalar, f.negocioId, f.telefono, 'AGENTE_RESPUESTA_PROHIBIDA'), true);
    await esperarAvisosEnCurso();
    assert.equal(f.avisos().panel.length, 1, 'el mismo episodio avisó dos veces');
    assert.equal(f.avisos().whatsapp.length, 1);
    // La atendieron como lo hace «Revisé y atendí» (revision+1) y el mismo
    // cliente vuelve a atascarse POR LO MISMO: episodio nuevo, aviso nuevo.
    await pool.query(`UPDATE whatsapp_conversaciones SET requiere_revision=false, motivo=NULL, revision=revision+1,
      actualizado_at=now() WHERE negocio_id=$1 AND telefono=$2`, [f.negocioId, f.telefono]);
    assert.equal(await avisarAHumano(f.escalar, f.negocioId, f.telefono, 'AGENTE_PIDE_HUMANO'), true);
    await esperarAvisosEnCurso();
    assert.equal(f.avisos().panel.length, 2, 'una revisión nueva no avisó');
    // Sin bandera, el mismo escalado no avisa (el camino de hoy).
    const g = await fixture();
    await g.procesar('Tengo una consulta especial', { modelo: pideHumano });
    assert.deepEqual(g.handoffs, ['AGENTE_PIDE_HUMANO']);
    assert.equal(g.avisos().panel.length + g.avisos().whatsapp.length, 0);
  });

  await caso('09 handoff fallido con un platillo a medio elegir: no sale el formulario de opciones encima', async () => {
    // El carrito trae Chilaquiles Mixtos sin sus opciones obligatorias: sin la
    // marca `rescate`, el commit armaría «Personaliza tu pedido» y taparía el texto.
    const f = await fixture({ rescate: true, vacio: false, handoffFalla: true });
    const q1 = await f.procesar('Me ayudas con mi pedido por favor', { modelo: timeout, entregar: false });
    assert.equal(q1.r.recuperacion, 'fallo_proveedor_sin_efectos', 'el primer turno no fue un fallo del proveedor');
    const q = await f.procesar('Me ayudas con mi pedido por favor', { modelo: timeout, entregar: false });
    assert.equal(q.r.handoffPendiente, true);
    assert.equal(q.carga.texto, TEXTO_RESCATE, `el formulario pisó el texto: ${String(q.carga.texto).slice(0, 80)}`);
    assert.equal(q.carga.interactivo, undefined, 'salió un formulario o botones');
    assert.equal((await f.leer()).carrito.items.length, 1, 'el rescate tocó el carrito');
  });

  await caso('10 handoff fallido tras ofrecer el enlace de pago: no queda esa pregunta pendiente ni sus botones', async () => {
    // El modelo intentó «transferencia», Xabor la rechazó y aplicarRespuestaDePago
    // dejó la oferta del enlace como pregunta pendiente; luego el proveedor falló.
    // Un «sí» posterior no puede aceptar una oferta que el cliente nunca leyó.
    const f = await fixture({ rescate: true, vacio: false, handoffFalla: true });
    const { rows: [integ] } = await pool.query(`INSERT INTO integraciones_canal (negocio_id, canal, identificador,
      nombre, activo, proveedor, estado, principal, ambiente) VALUES ($1,'pagos',$2,'Proveedor local',TRUE,'clip','activo',TRUE,'sandbox')
      RETURNING id`, [f.negocioId, 'pagos-' + randomUUID()]);
    await pool.query(`INSERT INTO metodos_pago (negocio_id, tipo, habilitado, integracion_id, disponible_para_bot,
      disponible_para_operador, orden) VALUES ($1,'enlace_pago',TRUE,$2,TRUE,TRUE,50)`, [f.negocioId, integ.id]);
    const e0 = await f.leer();
    e0.carrito.items = [{ lid: 'cafe-1', id: f.productoId, nombre: 'Café americano', cantidad: 1, modificadores: [], notas: '' }];
    e0.carrito.datos = { modalidad: 'recoger en tienda', cliente: { nombre: 'Cliente local', telefono: f.telefono } };
    await pool.query('UPDATE conversacion_estado SET estado=$3 WHERE negocio_id=$1 AND session_id=$2',
      [f.negocioId, `agente:${f.telefono}`, JSON.stringify(e0)]);
    const q1 = await f.procesar('Me ayudas con mi pedido por favor', { modelo: timeout, entregar: false });
    assert.equal(q1.r.recuperacion, 'fallo_proveedor_sin_efectos', 'el primer turno no fue un fallo del proveedor');
    const transferenciaYTimeout = async (_p, i) => {
      if (i === 1) return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu-' + randomUUID(),
        name: 'definir_pago', input: { forma_pago: 'transferencia' } }] };
      throw new Error('Request timed out.');
    };
    const q = await f.procesar('Pago con transferencia', { modelo: transferenciaYTimeout, entregar: false });
    assert.equal(q.r.recuperacion, 'fallo_proveedor_sin_efectos');
    assert.ok((q.r.operaciones || []).some((o) => o.herramienta === 'definir_pago' && o.resultado?.alternativa_tipo === 'enlace_pago'),
      'el escenario no llegó a ofrecer el enlace');
    assert.equal(q.carga.texto, TEXTO_RESCATE);
    assert.equal(q.carga.interactivo, undefined, 'salieron botones de la oferta debajo del rescate');
    assert.equal((await f.leer()).pendiente, null, 'quedó pendiente una oferta de pago que el cliente no leyó');
  });

  await caso('11 por omisión el aviso se queda en el sistema: evento al panel, sin WhatsApp al encargado', async () => {
    const f = await fixture({ rescate: true });
    await f.procesar('Quiero unos chilaquiles', { modelo: timeout });
    const q = await f.procesar('Quiero unos chilaquiles', { modelo: timeout });
    assert.equal(q.carga.texto, TEXTO_RESCATE);
    assert.equal(f.avisos().panel.length, 1, 'el panel no se enteró');
    assert.equal(f.avisos().whatsapp.length, 0, 'salió WhatsApp sin whatsapp_rescate_aviso_whatsapp_v1');
  });

  await caso('12 dos handoffs del MISMO turno por la continuidad real: un aviso, aunque el lote cierre con revision+1', async () => {
    // Revisión del 3-oct: `ejecutar` (whatsappContinuidad.js) suma uno a
    // `revision` al cerrar el lote, también el que acaba de escalar. Si la
    // decisión del aviso no se esperara dentro del turno, una lectura lenta
    // caería después de ese cierre, con otra clave, y saldrían dos avisos.
    const f = await fixture({ rescate: true });
    const cfg = await obtenerConfiguracion(f.negocioId);
    const leerFila = async (n, t) => (await pool.query(`SELECT requiere_revision, revision, motivo
      FROM whatsapp_conversaciones WHERE negocio_id=$1 AND telefono=$2`, [n, t])).rows[0] || null;
    let lecturas = 0;
    // La PRIMERA lectura es lenta: espera (hasta 300 ms) a que el lote cierre.
    const leerRevisionLenta = async (n, t) => {
      lecturas += 1;
      if (lecturas === 1) {
        const r0 = await leerFila(n, t); const t0 = Date.now();
        while (Date.now() - t0 < 300 && (await leerFila(n, t))?.revision === r0?.revision) {
          await new Promise((r) => setTimeout(r, 10));
        }
      }
      return leerFila(n, t);
    };
    const resultados = [];
    configurarAvisoRescate({ ...EFECTOS_DE_PRUEBA, leerRevision: leerRevisionLenta });
    try {
      await pool.query(`INSERT INTO whatsapp_conversaciones(negocio_id,telefono) VALUES($1,$2) ON CONFLICT DO NOTHING`,
        [f.negocioId, f.telefono]);
      await pool.query(`UPDATE whatsapp_conversaciones SET requiere_revision=false, motivo=NULL
        WHERE negocio_id=$1 AND telefono=$2`, [f.negocioId, f.telefono]);
      await pool.query(`UPDATE whatsapp_entradas SET estado='completado' WHERE negocio_id=$1 AND telefono=$2
        AND estado IN ('pendiente','procesando')`, [f.negocioId, f.telefono]);
      const wamid = 'wamid.rescate.lote.' + randomUUID();
      await pool.query(`INSERT INTO whatsapp_entradas(negocio_id,telefono,wamid,payload) VALUES($1,$2,$3,$4)`,
        [f.negocioId, f.telefono, wamid, JSON.stringify({ message: { id: wamid, from: f.telefono, type: 'text',
          text: { body: 'Tengo una consulta especial' } } })]);
      const antes = Number((await leerFila(f.negocioId, f.telefono)).revision);
      const lote = crearContinuidad({ pool, locks: pool, ventanaMs: 0,
        cargarSesion: async () => {}, leerSesion: async () => ({}),
        // El turno: pide a una persona y, en el mismo turno, otro escalado.
        procesar: async (_payloads, n, t) => {
          resultados.push(await avisarAHumano(f.escalar, n, t, 'AGENTE_PIDE_HUMANO', { cfg }));
          resultados.push(await avisarAHumano(f.escalar, n, t, 'AGENTE_RESPUESTA_PROHIBIDA', { cfg }));
          return {};
        } });
      await lote.ejecutar(f.negocioId, f.telefono);
      await esperarAvisosEnCurso();
      const despues = await leerFila(f.negocioId, f.telefono);
      assert.deepEqual(resultados, [true, true], 'los handoffs del turno no quedaron confirmados');
      assert.equal(despues.requiere_revision, true);
      assert.equal(Number(despues.revision), antes + 1, 'el lote no cerró: el escenario no se reprodujo');
      assert.equal(lecturas, 2);
      assert.equal(f.avisos().panel.length, 1, 'el mismo turno avisó dos veces (una lectura de cada lado del cierre)');
    } finally {
      configurarAvisoRescate(EFECTOS_DE_PRUEBA);
    }
  });

  await caso('08 ninguna promesa quedó sin atender', async () => {
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(noAtendidas.map((e) => String(e?.message || e)), []);
  });

  console.log(`Rescate humano DB: ${n} pasadas, ${fallidas} fallidas. Sin red externa, mensajes, pedidos o pagos reales.`);
  if (fallidas) process.exitCode = 1;
} finally {
  await pool.end();
}
