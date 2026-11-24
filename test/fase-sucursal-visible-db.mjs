// ─── LA SUCURSAL EN EL CANAL REAL (XAB-3915), CONTRA POSTGRES ────────────
//
// Lo mismo que fase-sucursal-visible.mjs, pero por atenderConAgente y la
// salida (agente_outbox → entregarRespuesta), con las banderas puestas en la
// configuración del negocio como en producción:
//
//   · el saludo nombra la sucursal y, a quien solo pidió en la hermana, le
//     avisa con su WhatsApp (la lectura del historial va a Postgres);
//   · «Revisa tu pedido» lleva «Sucursal:» y la confirmación dice dónde se
//     recoge;
//   · «el pedido es en acuña» tras confirmar recibe las ligas SIN pausar la
//     conversación, y el texto sí sale (una pausa lo habría descartado);
//   · sin las banderas, el saludo es el de hoy.
//
// Base local test_botones_* y red solo local:
//   NODE_OPTIONS=--import=./test/red-solo-local.mjs node test/fase-sucursal-visible-db.mjs
// CASOS=E1,E3 para las mordidas.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool, actualizarConfiguracion, setBotPausado } from '../src/services/database.js';
import { prepararNegocioMixtos } from './lib-botones-local.mjs';
import { atenderConAgente } from '../src/mesero-agente/canalDelAgente.js';
import { leerEstadoVersionado } from '../src/mesero-agente/persistenciaDelTurno.js';
import { entregarRespuesta } from '../src/mesero-agente/entregaDeRespuestas.js';
import { crearContinuidad } from '../src/services/whatsappContinuidad.js';
import { configurarAvisoRescate, esperarAvisosEnCurso } from '../src/services/avisoRescateHumano.js';
import { CLAVES_IA } from '../src/mesero-agente/recepcionista.js';
import { CLAVE_SUCURSAL_VISIBLE, CLAVE_HERMANAS } from '../src/mesero-agente/sucursalVisible.js';

Object.assign(process.env, { MESERO_AGENTE_MODE: 'true', WHATSAPP_INTERACTIVOS: 'true', WHATSAPP_FLOW_ENDPOINT: 'true',
  WHATSAPP_FLOW_PRIVATE_KEY: 'solo-local', META_APP_SECRET: 'solo-local' });
assert.match(new URL(process.env.DATABASE_URL || 'postgres://x/x').pathname, /^\/test_botones_/, 'solo contra una base local test_botones_*');
assert.match(process.env.NODE_OPTIONS || '', /red-solo-local/, 'corre con NODE_OPTIONS=--import=./test/red-solo-local.mjs');

let n = 0; let fallidas = 0;
const SOLO = (process.env.CASOS || '').split(',').map((s) => s.trim()).filter(Boolean);
async function caso(nombre, fn) {
  if (SOLO.length && !SOLO.includes(nombre.split(' ')[0])) return;
  try { await fn(); console.log(`OK sucursal-db ${++n}: ${nombre}`); }
  catch (e) { fallidas++; console.log(`FALLA sucursal-db: ${nombre}\n  ${String(e?.message || e).split('\n').slice(0, 6).join('\n  ')}`); }
}
configurarAvisoRescate({ broadcastPanel: () => {}, enviarAvisoWhatsapp: async () => {}, log: () => {} });

const DIAS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'];
const ID = { categorias: '11111111111', carrito: '22222222222', configurar: '44444444444',
  facturacion: '66666666666', evento: '77777777777' };

/** Obispado en modo formulario; `sucursal` enciende las dos banderas, con la hermana dada. */
async function fixture({ sucursal = true, hermanaId = null } = {}) {
  const f = await prepararNegocioMixtos();
  f.estado.carrito.items = [];
  await pool.query('UPDATE conversacion_estado SET estado=$3 WHERE negocio_id=$1 AND session_id=$2',
    [f.negocioId, `agente:${f.telefono}`, JSON.stringify(f.estado)]);
  const reglas = { restaurante: 'Mapolato', timezone: 'America/Matamoros',
    horarios: Object.fromEntries(DIAS.map((d) => [d, { abierto: true, apertura: '00:00', cierre: '24:00' }])),
    pedidos: { modalidades: ['recoger en tienda', 'entrega a domicilio'], tiempo_preparacion_minutos: 25,
      tiempo_entrega_min_minutos: 45, tiempo_entrega_max_minutos: 45, pedido_minimo_entrega: 0, costo_envio: 60, pago_aceptado: ['efectivo'] },
    cierres_especiales: [], promociones: [], politicas: [], bot: { faqs: [] } };
  const hermanas = JSON.stringify([{ nombre: 'Mapolato Acuña', ciudad: 'Acuña', whatsapp: '520000000001',
    tienda: 'https://xabor.mx/t/prueba-acuna', ...(hermanaId ? { negocio_id: hermanaId } : {}) }]);
  await actualizarConfiguracion({ nombre: 'Mapolato Obispado', whatsapp_inicio_mapo_v1: 'true',
    whatsapp_atencion_general_v1: 'true', bot_whatsapp_solo_prueba: 'false', mesero_agente_porcentaje: '100',
    mesero_agente_telefonos: '', whatsapp_flows_v1: 'true', whatsapp_flows_telefonos: '', whatsapp_beta_hibrido_v1: 'true',
    whatsapp_beta_telefonos: '', whatsapp_interactivos_elecciones_v1: 'true',
    whatsapp_flow_categorias_id: ID.categorias, whatsapp_flow_carrito_id: ID.carrito, whatsapp_flow_configurar_id: ID.configurar,
    whatsapp_carrito_unificado_v1: 'true', whatsapp_flow_carrito_duplicar_v1: 'true',
    whatsapp_flow_facturacion_id: ID.facturacion, whatsapp_flow_evento_id: ID.evento, whatsapp_eventos_formulario_v1: 'true',
    whatsapp_rescate_humano_v1: 'true', whatsapp_flujos_caducan_v1: 'true',
    direccion: 'Libramiento Manuel Pérez Treviño 2416, Colonia Tecnológico', ciudad: 'Piedras Negras',
    reglas_atencion: JSON.stringify(reglas), [CLAVES_IA.MODO]: 'formulario', [CLAVES_IA.ALCANCE]: 'todos',
    [CLAVE_SUCURSAL_VISIBLE]: sucursal ? 'true' : '', [CLAVE_HERMANAS]: sucursal ? hermanas : '' }, f.negocioId);
  const continuidad = crearContinuidad({ pool, locks: pool, procesar: async () => { throw Error('X'); }, cargarSesion: async () => {},
    leerSesion: async () => ({}), alRevision: (neg, tel) => setBotPausado(tel, true, neg) });
  const handoffs = [];
  const escalar = async (neg, tel, motivo) => {
    handoffs.push(motivo);
    return (await continuidad.enviarARevision(neg, tel, motivo)) || continuidad.revisionActiva(neg, tel);
  };
  const registrados = [];
  const registrar = async (orden) => { registrados.push(orden); return { ok: true, folio: `XAB-T${registrados.length}`, total: 45, pedido: { id: `XAB-T${registrados.length}` } }; };
  const identidad = () => ({ id: `wamid.suc.${randomUUID()}`, from: f.telefono, timestamp: String(Math.floor(Date.now() / 1000)) });
  const turno = async (m) => {
    await pool.query("INSERT INTO whatsapp_entradas(negocio_id,telefono,wamid,payload,estado) VALUES($1,$2,$3,$4,'completado')",
      [f.negocioId, f.telefono, m.id, JSON.stringify({ message: m })]);
    const r = await atenderConAgente({ negocioId: f.negocioId, telefono: f.telefono, nombre: 'Cliente local',
      mensaje: m.type === 'text' ? m.text.body : '', wamids: [m.id],
      interaccion: m.type === 'interactive' ? { mensajes: [m], mixto: false } : null,
      llamarModelo: async () => { throw Error('EL_MODELO_NO_SE_LLAMA'); }, escalarAHumano: escalar,
      registrar, emitir: async () => {}, guardar: async () => {}, crearPago: async () => { throw Error('SIN_PAGOS'); } });
    await esperarAvisosEnCurso();
    assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
    const fila = r.outbox ? (await pool.query('SELECT * FROM agente_outbox WHERE evento_clave=$1', [r.outbox.clave])).rows[0] : null;
    let entrega = null; const wamid = `wamid.suc.salida.${randomUUID()}`;
    if (fila) entrega = await entregarRespuesta({ outboxClave: fila.evento_clave,
      enviar: async () => ({ messages: [{ id: wamid }] }), alHumano: async () => {} });
    return { r, carga: fila?.carga || {}, entrega, wamid, interactivo: fila?.carga?.interactivo || null };
  };
  const texto = (body) => turno({ ...identidad(), type: 'text', text: { body } });
  const leer = () => leerEstadoVersionado(f.negocioId, f.telefono);
  const escribir = async (cambios) => {
    const e = await leer(); Object.assign(e, cambios);
    await pool.query('UPDATE conversacion_estado SET estado=$3,revision=revision+1 WHERE negocio_id=$1 AND session_id=$2',
      [f.negocioId, `agente:${f.telefono}`, JSON.stringify(e)]);
  };
  const pausado = async () => (await pool.query('SELECT bot_pausado FROM conversaciones_control WHERE negocio_id=$1 AND telefono=$2',
    [f.negocioId, f.telefono])).rows[0]?.bot_pausado === true;
  return { ...f, texto, leer, escribir, pausado, handoffs, registrados };
}
const cuerpo = (q) => q.interactivo?.body?.text || q.carga.texto || '';
const titulos = (q) => (q.interactivo?.type === 'list' ? q.interactivo.action.sections[0].rows : q.interactivo?.action?.buttons?.map((b) => b.reply) || [])
  .map((r) => r.title);

/** Un pedido viejo del mismo teléfono en la sucursal hermana. */
async function pedidoEnHermana(hermanaId, telefono) {
  await pool.query(`INSERT INTO pedidos_activos (folio, estado, datos, negocio_id, created_at)
    VALUES ($1, 'entregado', $2::jsonb, $3, now() - interval '10 days')`,
  [`SUC-${randomUUID().slice(0, 8)}`, JSON.stringify({ canal: 'whatsapp', cliente: { nombre: 'Cliente local', telefono } }), hermanaId]);
}

const SALUDO_HOY = /^¡Hola, buen(os días|as tardes|as noches)! Soy \*Mapo Bot\*\. Nuestro personal se encuentra algo ocupado, pero estoy aquí para servirte\.\n\n¿Cómo puedo ayudarte\?$/;

try {
  await caso('E1 saludo: nombra la sucursal y avisa a quien solo pidió en Acuña, con los botones de siempre', async () => {
    const acuna = await prepararNegocioMixtos();
    const f = await fixture({ hermanaId: acuna.negocioId });
    await pedidoEnHermana(acuna.negocioId, f.telefono);
    const q = await f.texto('Buen dia');
    const t = cuerpo(q);
    assert.match(t, /^¡Hola, buen[^!]+! Soy \*Mapo Bot\* de \*Mapolato Obispado\* \(Piedras Negras\)\. Nuestro personal/);
    assert.match(t, /\n\n📍 Tus pedidos anteriores fueron en \*Mapolato Acuña\*\. Este WhatsApp es de Piedras Negras; si tu pedido es para Acuña, escríbeles aquí:\nhttps:\/\/wa\.me\/520000000001\n\n¿Cómo puedo ayudarte\?$/);
    assert.ok(titulos(q).includes('Ordenar ahora'), `sin el menú de siempre: ${JSON.stringify(titulos(q))}`);
    assert.equal(q.entrega?.estado, 'entregado');
  });
  await caso('E2 saludo sin pedidos en la hermana (o con pedidos aquí también): sin aviso', async () => {
    const acuna = await prepararNegocioMixtos();
    const f = await fixture({ hermanaId: acuna.negocioId });
    const q = await f.texto('hola');
    assert.match(cuerpo(q), /Soy \*Mapo Bot\* de \*Mapolato Obispado\* \(Piedras Negras\)\./);
    assert.doesNotMatch(cuerpo(q), /📍/);
    const g = await fixture({ hermanaId: acuna.negocioId });
    await pedidoEnHermana(acuna.negocioId, g.telefono);
    await pedidoEnHermana(g.negocioId, g.telefono);
    assert.doesNotMatch(cuerpo(await g.texto('hola')), /📍/, 'ya pidió aquí: no se le avisa');
  });
  await caso('E3 «Revisa tu pedido» lleva la sucursal y la confirmación dice dónde se recoge', async () => {
    const f = await fixture();
    const conversacionId = (await f.leer()).conversacionId;
    await f.escribir({ carrito: { items: [{ lid: 'cafe-1', id: f.productoId, nombre: 'Café americano', cantidad: 1, modificadores: [], notas: '' }],
      datos: { modalidad: 'recoger en tienda', forma_pago: 'efectivo', cliente: { nombre: 'Cliente local', telefono: f.telefono } } },
    pendiente: { tipo: 'confirmar_resumen', huella: 'vieja', dialogo_id: 'd-viejo' },
    dialogo: { id: 'd-viejo', ciclo: conversacionId, tipo: 'resumen', huella: 'vieja', texto: 'Resumen viejo ¿Confirmas este pedido?', enviado: true } });
    const r1 = await f.texto('sí');
    assert.match(cuerpo(r1), /\nModalidad: Recoger en tienda\nSucursal: \*Mapolato Obispado · Piedras Negras\*\n[\s\S]*¿Confirmas este pedido\?$/);
    assert.deepEqual(titulos(r1), ['Confirmar', 'Cambiar algo', 'Agregar otro']);
    const r2 = await f.texto('sí');
    assert.equal(f.registrados.length, 1, `no registró: ${cuerpo(r2)}`);
    assert.match(cuerpo(r2), /^Tu pedido XAB-T1 quedó registrado por \$45 MXN\. .*Recoges en Mapolato Obispado: Libramiento Manuel Pérez Treviño 2416, Colonia Tecnológico, Piedras Negras\.$/);
  });
  await caso('E4 «el pedido es en acuña» tras confirmar: ligas de Acuña, sin pausa, y el texto SÍ sale', async () => {
    const f = await fixture();
    await f.escribir({ folio: 'XAB-T9', hechos: { ...(await f.leer()).hechos, confirmado: true },
      carrito: { items: [{ lid: 'cafe-1', id: f.productoId, nombre: 'Café americano', cantidad: 1, modificadores: [], notas: '' }],
        datos: { modalidad: 'recoger en tienda', forma_pago: 'efectivo', cliente: { nombre: 'Cliente local', telefono: f.telefono } } },
      pendiente: null });
    const q = await f.texto('Disculpe el pedido es en acuña');
    assert.match(cuerpo(q), /^Este WhatsApp es de \*Mapolato Obispado\*, en Piedras Negras\.\n\nPara \*Mapolato Acuña\* escríbeles a su WhatsApp:\nhttps:\/\/wa\.me\/520000000001\nO pide en línea:\nhttps:\/\/xabor\.mx\/t\/prueba-acuna\n\nTu pedido XAB-T9 quedó registrado aquí, en Piedras Negras\./);
    assert.deepEqual(f.handoffs, []); assert.equal(await f.pausado(), false);
    assert.equal(q.entrega?.estado, 'entregado', `el texto no salió: ${JSON.stringify(q.entrega)}`);
    const p = await f.texto('Hablar con alguien');
    assert.equal(f.handoffs.length, 1, 'cancelar sigue pasando al equipo');
    assert.equal(p.entrega?.estado, 'entregado');
  });
  await caso('E5 sin las banderas: el saludo de hoy y «en acuña» no recibe ligas', async () => {
    const f = await fixture({ sucursal: false });
    assert.match(cuerpo(await f.texto('Buen dia')), SALUDO_HOY);
    assert.doesNotMatch(cuerpo(await f.texto('Es en Acuña verdad?')), /wa\.me/);
  });
} finally {
  console.log(`\nsucursal en el canal (Postgres): ${n} pasadas, ${fallidas} fallidas`);
  await pool.end().catch(() => {});
  if (fallidas) process.exitCode = 1;
}
