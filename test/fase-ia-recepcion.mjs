// ─── MODO FORMULARIO / RECEPCIONISTA (PARTES 1 Y 2), SIN BASE ────────────
//
// Decisión del dueño (3-oct-2026): los pedidos SOLO en el formulario; la IA,
// recepcionista para dudas. Pura: sin base de datos, red, Meta ni modelo (un
// doble que lanza). Cubre:
//
//   · modoIA y sus precondiciones (falla cerrada);
//   · el router, paso por paso (R0–R14; R13, el selector, en fase-ia-selector.mjs),
//     con y sin carrito, abierto y cerrado, y tras el pedido; la PARTE 2 suma
//     R0 (silencio tras el personal), el acuse de cerrado, el estado del pedido
//     con tiempo para los pedidos del teléfono y frases reales del análisis;
//   · clasificarIntencion y el catálogo de respuestas aprobadas;
//   · los botones y la lista (payloadInteractivoValido);
//   · formularioDePedidoPosible ⇔ construirFormulario;
//   · el turno del Mesero con `recepcion` (D1, D2, cortes B2–B9, nunca el modelo);
//   · el candado C1 del ejecutor; las variantes de texto; P3 y el pendiente que caduca.
//
// Filtrar casos para las mordidas: CASOS=R2,C1 node test/fase-ia-recepcion.mjs
import assert from 'node:assert/strict';
import * as R from '../src/mesero-agente/recepcionista.js';
import * as RF from '../src/mesero-agente/respuestasFijas.js';
import * as F from '../scripts/fixture-tienda-plomeria.mjs';
import { FRASES, TEXTOS_PERSONA, MOTIVOS_RECEPCION, NO_RECONOCIDO_SIN_BOTONES, CLAVES_IA, SALUDO_SIN_BOTONES } from '../src/mesero-agente/recepcionista.js';
import { TEXTO_RESCATE } from '../src/mesero-agente/rescateHumano.js';
import { NOTA_IMAGEN_PARA_IA } from '../src/utils/turnoImagen.js';
import { construirFormulario, formularioDePedidoPosible } from '../src/mesero-agente/formularioAgrupado.js';
import { payloadInteractivoValido } from '../src/mesero-agente/transporteInteractivo.js';
import { crearEjecutor, estadoNuevo } from '../src/mesero-agente/ejecutorDeHerramientas.js';
import { accionInteractiva } from '../src/mesero-agente/autoridadInteractiva.js';
import { atenderTurnoConHerramientas } from '../src/mesero-agente/agenteDelMesero.js';
import { preciosDelCatalogo } from '../src/mesero-agente/canalDelAgente.js';
import { fijarPendiente } from '../src/mesero-agente/estadoCanonico.js';
import { construirAvisoFueraDeHorario, respuestaAPedidoProgramado } from '../src/mesero-agente/horarioDelAgente.js';
import { respuestaDesdePedido } from '../src/mesero-agente/recuperacionDelTurno.js';
import { flujoAbiertoVencido, cicloParaTurno } from '../src/mesero-agente/cicloDelAgente.js';
import { grupoDelMotivo } from '../src/services/pausaVencePolitica.js';
import { construirInicioMapo, asociacionMapoVigente, OPCIONES_MAPO } from '../src/mesero-agente/inicioMapo.js';
import { TEXTOS_RECIBO_HANDOFF, textosDelRecibo, permiteReciboHandoff, vincularReciboHandoff } from '../src/mesero-agente/reciboHandoff.js';
import { modoDelPedido } from '../src/orders/modoDelPedido.js';

Object.assign(process.env, { WHATSAPP_INTERACTIVOS: 'true', MESERO_AGENTE_MODE: 'true', WHATSAPP_FLOW_ENDPOINT: 'true',
  WHATSAPP_FLOW_PRIVATE_KEY: 'x', META_APP_SECRET: 'x' });

let pasadas = 0, fallidas = 0;
const SOLO = (process.env.CASOS || '').split(',').map((s) => s.trim()).filter(Boolean);
async function caso(nombre, fn) {
  if (SOLO.length && !SOLO.some((p) => nombre.startsWith(p))) return;
  try { await fn(); pasadas++; console.log(`  ok  ${nombre}`); }
  catch (e) { fallidas++; console.log(`FALLA ${nombre}: ${String(e?.message || e).split('\n').slice(0, 4).join(' | ')}`); }
}

const T = F.TELEFONO;
const CARTA = F.carta();
const DIAS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'];
const REGLAS = {
  ...F.reglas, timezone: 'America/Matamoros',
  horarios: Object.fromEntries(DIAS.map((d) => [d, { abierto: true, apertura: '07:30', cierre: '15:00' }])),
  cierres_especiales: [], promociones: [], politicas: [],
  pedidos: { ...F.reglas.pedidos, tiempo_entrega_min_minutos: 45, tiempo_entrega_max_minutos: 45, tiempo_preparacion_minutos: 25,
    pedido_minimo_entrega: 0 },
  bot: { palabras_criticas: ['intoxicación'], faqs: [
    { pregunta: '¿Tienen mesas? ¿Puedo comer en el local o reservar?', respuesta: 'Sí, tenemos mesas en el local. No tomamos reservaciones.' },
    { pregunta: 'Cumpleaños', respuesta: 'El día de tu cumpleaños desayunas gratis en el local.' },
    { pregunta: 'Desayuno sorpresa', respuesta: 'Es una caja de regalo con chilaquiles, waffles y bebida.' },
  ] },
};
export const cfgModo = (extra = {}) => ({ ...F.cfgTienda('true'), whatsapp_interactivos_v1: 'true',
  whatsapp_interactivos_elecciones_v1: 'true', whatsapp_rescate_humano_v1: 'true', whatsapp_beta_hibrido_v1: 'true',
  whatsapp_eventos_formulario_v1: 'true', whatsapp_flow_evento_id: '77777777777', direccion: 'Libramiento Manuel Pérez Treviño 2416',
  ciudad: 'Piedras Negras', [CLAVES_IA.MODO]: 'formulario', [CLAVES_IA.ALCANCE]: 'todos', ...extra });
const TIENDA = { estado: 'publicada', aceptaProgramados: true, slug: 'mapolato' };
const URL_TIENDA = 'https://xabor.mx/t/mapolato';
const CAFE = { lid: 'L2', id: 3, nombre: 'Café americano', cantidad: 1, notas: '', modificadores: [] };

const vacio = () => F.estado({ pendiente: null });
const conCarrito = () => F.estado({ pendiente: null, items: 'dos' });
const confirmado = () => { const e = F.estado({ pendiente: null, items: 'dos' }); e.folio = 'XAB-1001'; e.hechos.confirmado = true; return e; };
const conPendiente = (pendiente, items = 'dos', entrega = {}) => F.estado({ pendiente, items, entrega });

async function decidir(mensaje, { estado = vacio(), cfg = cfgModo(), abierto = true, lectores = {}, configTienda = null,
  cancelacionCatering = null, ahora = Date.now() } = {}) {
  const ia = R.modoIA(cfg, T);
  assert(ia, 'el modo no está encendido en la configuración del caso');
  const estadoRestaurante = { abierto, diaActual: 'lunes', fechaHoy: '2026-10-05', preApertura: false };
  const { entradas } = RF.catalogoDeRespuestas({ reglas: REGLAS, cfg, metodosPago: F.metodosPago, modalidades: F.modalidades, estadoRestaurante });
  const llamadas = [];
  const lect = {
    ultimoSaliente: async () => { llamadas.push('ultimoSaliente'); return lectores.ultimoSaliente ?? null; },
    pedidosActivos: async () => { llamadas.push('pedidosActivos');
      if (lectores.pedidosError) throw new Error('caída'); return lectores.pedidosActivos ?? []; },
    formularioReciente: async () => { llamadas.push('formularioReciente'); return lectores.formularioReciente ?? false; },
    formularioRescate: async () => { llamadas.push('formularioRescate'); return lectores.formularioRescate ?? false; },
    estadoOperativo: async (folio) => { llamadas.push('estadoOperativo'); return lectores.estadoOperativo ? lectores.estadoOperativo(folio) : null; },
    promocionesOficiales: async () => { llamadas.push('promocionesOficiales');
      if (lectores.promocionesError) throw new Error('caída'); return lectores.promociones ?? 'Hoy: 2x1 en chilaquiles.'; },
  };
  const d = await R.decidirRecepcion({ ia, cfg, reglas: REGLAS, estado, mensaje, catalogo: CARTA, metodosPago: F.metodosPago,
    modalidades: F.modalidades, configTienda, estadoRestaurante, cancelacionCatering, negocioId: 'neg', telefono: T,
    lectores: lect, entradas, ahora });
  return { ...d, llamadas };
}

/** Compara una decisión con lo esperado (solo las claves dadas). */
function exigir(d, x, donde) {
  const msg = (k) => `${donde}: ${k} (obtenido ${JSON.stringify({ ruta: d.ruta, paso: d.recepcion?.paso, tipo: d.recepcion?.tipo,
    texto: d.respuesta?.texto?.slice(0, 60), pendiente: d.respuesta?.pendiente, formulario: d.formulario })})`;
  if (x.ruta) assert.equal(d.ruta, x.ruta, msg('ruta'));
  if (x.paso) assert.equal(d.recepcion?.paso, x.paso, msg('paso'));
  if (x.tipo) assert.equal(d.recepcion?.tipo, x.tipo, msg('tipo'));
  if (x.motivo) { assert.equal(d.persona?.motivo, x.motivo, msg('motivo')); assert.equal(d.respuesta?.tipo, 'rescate_humano', msg('rescate')); }
  if (x.texto !== undefined) assert.equal(d.respuesta?.texto, x.texto, msg('texto'));
  if (x.textoRe) assert.match(String(d.respuesta?.texto), x.textoRe, msg('texto'));
  if (x.pendiente !== undefined) assert.deepEqual(d.respuesta?.pendiente ?? null, x.pendiente, msg('pendiente'));
  if (x.formulario !== undefined) {
    if (x.formulario === null) assert.equal(d.formulario ?? null, null, msg('formulario'));
    else for (const [k, v] of Object.entries(x.formulario)) {
      if (v instanceof RegExp) assert.match(String(d.formulario?.[k]), v, msg(`formulario.${k}`));
      else assert.equal(d.formulario?.[k], v, msg(`formulario.${k}`));
    }
  }
  if (x.estadoRecepcion !== undefined) assert.equal(d.estadoRecepcion?.ultimo ?? null, x.estadoRecepcion, msg('estadoRecepcion'));
  if (x.alerta !== undefined) assert.equal(d.alerta?.motivo ?? null, x.alerta, msg('alerta'));
  if (x.ruta === 'silencio') { assert.equal(d.respuesta ?? null, null, msg('respuesta en silencio')); assert.equal(d.persona ?? null, null, msg('persona')); }
  if (x.sinLecturas) for (const l of x.sinLecturas) assert(!d.llamadas.includes(l), msg(`leyó ${l}`));
  if (x.conLecturas) for (const l of x.conLecturas) assert(d.llamadas.includes(l), msg(`no leyó ${l}`));
  // Ninguna respuesta del router lleva acciones: ningún texto cambia el pedido.
  assert.deepEqual(d.respuesta?.acciones ?? [], [], msg('acciones'));
}

const BOTONES = { tipo: 'recepcion', menu: 'botones' };
const hace = (min) => new Date(Date.now() - min * 60000).toISOString();

// ── El router, paso por paso ─────────────────────────────────────────────
const HUMANO = (minutos, extra = {}) => ({ origen: 'humano', minutos, liberadaDespues: false, ...extra });
const PEDIDO = (folio, estado, modalidad = 'entrega a domicilio') => ({ folio, estado, modalidad });
const PIE = 'Si necesitas otro detalle, escribe «hablar con alguien».';
const CASOS_ROUTER = [
  // R0 — tras el personal, el bot no habla (C-5).
  ['R0 cortesía tras el personal (c33c16f63) → nada y sin aviso', 'Si muchas gracias\nYa la recibí', { lectores: { ultimoSaliente: HUMANO(107) } },
    { ruta: 'silencio', paso: 'R0', tipo: 'cortesia_tras_personal', alerta: null }],
  ['R0 «Si porfavor» tras el personal (c090529eb) → nada, con aviso al equipo', 'Si porfavor', { lectores: { ultimoSaliente: HUMANO(1) } },
    { ruta: 'silencio', paso: 'R0', tipo: 'tras_personal', alerta: 'RECEPCION_TRAS_PERSONAL' }],
  ['R0 un pedido escrito tras el personal tampoco lo contesta el bot', 'quiero 2 chilaquiles', { lectores: { ultimoSaliente: HUMANO(30) } },
    { ruta: 'silencio', paso: 'R0', alerta: 'RECEPCION_TRAS_PERSONAL', sinLecturas: ['formularioReciente'] }],
  ['R0 cerrado: también calla (antes que el acuse)', 'hola', { abierto: false, lectores: { ultimoSaliente: HUMANO(10) } },
    { ruta: 'silencio', paso: 'R0' }],
  ['R0 pasada la ventana (180 min) → ruta normal', 'Si porfavor', { lectores: { ultimoSaliente: HUMANO(181) } }, { ruta: 'respuesta', paso: 'R14' }],
  ['R0 ventana configurada (90 min)', 'Si porfavor', { cfg: cfgModo({ [CLAVES_IA.SILENCIO]: '90' }), lectores: { ultimoSaliente: HUMANO(100) } },
    { paso: 'R14' }],
  ['R0 devuelta al bot por una persona → ruta normal', 'Si porfavor', { lectores: { ultimoSaliente: HUMANO(5, { liberadaDespues: true }) } },
    { ruta: 'respuesta', paso: 'R14' }],
  ['R0 el último saliente es del bot → ruta normal', 'Si porfavor', { lectores: { ultimoSaliente: { origen: 'bot', minutos: 1, liberadaDespues: false } } },
    { paso: 'R14' }],
  ['R0 sin lectura → ruta normal (texto fijo, que es seguro)', 'Si porfavor', { lectores: { ultimoSaliente: null } }, { paso: 'R14', conLecturas: ['ultimoSaliente'] }],
  // R1 — precondiciones: falla cerrada hacia una persona (nunca el modelo).
  ['R1 sin rescate → persona', 'quiero chilaquiles', { cfg: cfgModo({ whatsapp_rescate_humano_v1: 'false' }) },
    { ruta: 'persona', paso: 'R1', motivo: 'RECEPCION_SIN_PRECONDICIONES', texto: FRASES.PERSONA }],
  ['R1 sin formularios → persona', 'hola', { cfg: cfgModo({ whatsapp_flows_v1: 'false' }) }, { ruta: 'persona', paso: 'R1' }],
  ['R1 sin eventos por formulario → persona', 'hola', { cfg: cfgModo({ whatsapp_eventos_formulario_v1: '' }) }, { ruta: 'persona', paso: 'R1' }],
  ['R1 cerrado → texto de cerrado', 'hola', { cfg: cfgModo({ whatsapp_beta_hibrido_v1: 'false' }), abierto: false },
    { ruta: 'persona', paso: 'R1', texto: FRASES.PERSONA_CERRADO }],
  // R2 — imagen.
  ['R2 imagen (nota de whatsapp-meta) → persona', `Mira ${NOTA_IMAGEN_PARA_IA}`, {},
    { ruta: 'persona', paso: 'R2', motivo: 'RECEPCION_IMAGEN', texto: FRASES.PERSONA_IMAGEN }],
  ['R2 imagen con visión → persona', '[CONTEXTO VISUAL] Se ve un comprobante de transferencia por $350', {},
    { ruta: 'persona', paso: 'R2', motivo: 'RECEPCION_IMAGEN' }],
  // PARTE 2: PERSONA_IMAGEN dice «en un momento»; de noche sería una promesa sin dueño (ccca77514).
  ['R2 imagen cerrado → el texto de cerrado (no «en un momento»)', `${NOTA_IMAGEN_PARA_IA}`, { abierto: false }, { paso: 'R2', texto: FRASES.PERSONA_CERRADO }],
  // PARTE 2: frases reales del análisis que el router no reconocía.
  ['R10 «¿podría levantarme un pedido?» (c090529eb) → formulario', 'Buenos dias quisiera saber si podria levantarme un pedido', {},
    { ruta: 'formulario', paso: 'R10', tipo: 'pedir' }],
  ['R10 «Disculpa quisiera hacer un pedido a domicilio» (cd8758f5a) → formulario', 'Hola buen día\nDisculpa quisiera hacer un pedido a domicilio', {},
    { ruta: 'formulario', tipo: 'pedir' }],
  ['R8 «Acabo de realizar un pedido» (ca5f9d2be) → persona', 'Acabo de realizar un pedido', {}, { ruta: 'persona', paso: 'R8', motivo: 'RECEPCION_PEDIDO_EXTERNO' }],
  ['R5 «quiero ofrecerle mi producto» (c08d1c935) → personal', 'Hola, quiero ofrecerle mi producto, manzanas cubiertas', {},
    { ruta: 'persona', paso: 'R5', motivo: 'RECEPCION_OTRO' }],
  ['R11 «¿cuál es la dirección en Acuña?» (c1876f06b) no la contesta la de este local', 'Disculpe ,cual es la direccion en acuña?', {},
    { paso: 'R14' }],
  ['R11 «¿Dónde están ubicados?» sí es la ubicación', '¿Dónde están ubicados?', {}, { paso: 'R11', tipo: 'fija:ubicacion' }],
  ['R11 «me podrían ayudar con la factura» no es «cómo pedir»', 'Buen dia\nMe podrían ayudar conla factura', {}, { paso: 'R14' }],
  ['R11 «Mm me podrían explicar por favor?» sí es «cómo pedir»', 'Mm me podrían explicar por favor?', {}, { paso: 'R11', tipo: 'fija:como_pedir' }],
  // R3 — evento por chat heredado.
  ['R3 captura de evento heredada → persona', 'somos 40', { estado: Object.assign(vacio(), { evento: { personas: 40 } }) },
    { ruta: 'persona', paso: 'R3', motivo: 'SOLICITUD_EVENTO', texto: FRASES.PERSONA_EVENTO }],
  ['R3 cancelación de la ficha → camino de hoy', 'ya no quiero el catering', { cancelacionCatering: { texto: 'x' } },
    { ruta: 'existente', paso: 'R3' }],
  // R4 — queja y retraso.
  ['R4 queja → persona', 'El pedido llegó frío y mal', {}, { ruta: 'persona', paso: 'R4', motivo: 'RECEPCION_QUEJA', texto: FRASES.PERSONA_QUEJA }],
  ['R4 queja de dinero → nunca vence', 'Me cobraron de más en el pedido', {}, { paso: 'R4', motivo: 'RECEPCION_QUEJA_PAGO' }],
  ['R4 palabra crítica del negocio → persona', 'creo que fue una intoxicación', {}, { paso: 'R4', motivo: 'RECEPCION_QUEJA' }],
  ['R4 retraso con pedido → persona', 'no ha llegado mi pedido y ya es mucho', { estado: confirmado() },
    { paso: 'R4', motivo: 'RECEPCION_RETRASO', texto: FRASES.PERSONA_RETRASO }],
  ['R4 «no llega» sin pedido no es retraso', 'no llega el formulario', {}, { ruta: 'respuesta', paso: 'R14' }],
  // R5 — persona, vacantes.
  ['R5 pide una persona', 'quiero hablar con una persona', {}, { ruta: 'persona', paso: 'R5', motivo: 'RECEPCION_PIDE_PERSONA', texto: FRASES.PERSONA }],
  ['R5 «persona» a secas', 'Persona', {}, { paso: 'R5', motivo: 'RECEPCION_PIDE_PERSONA' }],
  ['R5 cerrado → texto de cerrado', 'quiero hablar con alguien', { abierto: false }, { paso: 'R5', texto: FRASES.PERSONA_CERRADO }],
  ['R5 vacantes → personal', '¿Tienen vacantes? busco trabajo', {}, { paso: 'R5', motivo: 'RECEPCION_OTRO', texto: FRASES.PERSONA_OTRO }],
  ['R5 proveedor cerrado → no promete hora', 'Soy proveedor de desechables', { abierto: false }, { paso: 'R5', texto: FRASES.PERSONA_OTRO }],
  // R6 — no puede usar el formulario.
  ['R6 «no carga» tras un formulario → rescate de hoy', 'no carga', { lectores: { formularioRescate: true } },
    { ruta: 'persona', paso: 'R6', motivo: 'FORMULARIO_NO_CARGA', texto: TEXTO_RESCATE }],
  ['R6 «prefiero escribir» tras un formulario de pedido → persona', 'prefiero escribir por aquí', { lectores: { formularioReciente: true } },
    { paso: 'R6', motivo: 'RECEPCION_NO_PUEDE', texto: FRASES.PERSONA_PEDIDO }],
  ['R6 «no carga» sin formulario reciente no pasa a persona', 'no carga', {}, { ruta: 'respuesta', paso: 'R14' }],
  // R-turno — D1, D2, cortesía.
  ['R-turno D1 cancelar el borrador', 'cancela mi pedido', { estado: conCarrito() }, { ruta: 'turno', tipo: 'D1', sinLecturas: ['formularioReciente'] }],
  ['R-turno D2 «sí» al resumen', 'sí', { estado: conPendiente({ tipo: 'confirmar_resumen', huella: 'h' }) }, { ruta: 'turno', tipo: 'D2' }],
  ['R-turno D2 «sí pero sin cebolla» no confirma', 'sí pero sin cebolla', { estado: conPendiente({ tipo: 'confirmar_resumen', huella: 'h' }) },
    { ruta: 'formulario', paso: 'R10', tipo: 'cambiar' }],
  ['R-turno D2 cerrado no confirma', 'sí', { estado: conPendiente({ tipo: 'confirmar_resumen', huella: 'h' }), abierto: false },
    { ruta: 'cerrado', paso: 'R7' }],
  ['R-turno cortesía tras el pedido', 'muchas gracias', { estado: confirmado() }, { ruta: 'turno', tipo: 'cortesia' }],
  // R7 — cerrado.
  ['R7 cerrado → acuse con la hora de apertura (C-4)', 'hola', { abierto: false },
    { ruta: 'cerrado', paso: 'R7', texto: 'Recibimos tu mensaje. 🙂 Ahora estamos cerrados; abrimos mañana a las 7:30 a. m. '
      + 'En cuanto abramos, el personal te contesta por aquí.', estadoRecepcion: 'cerrado' }],
  ['R7 cerrado con tienda → la liga para agendar', 'quiero desayuno para mañana temprano', { abierto: false, configTienda: TIENDA },
    { ruta: 'cerrado', paso: 'R7', texto: FRASES.PEDIDO_ESCRITO_CERRADO + 'Recibimos tu mensaje. 🙂 Ahora estamos cerrados; abrimos mañana a las 7:30 a. m. '
      + `Si quieres dejar tu pedido agendado, hazlo en nuestra tienda en línea: ${URL_TIENDA}. En cuanto abramos, el personal te contesta por aquí.` }],
  ['R7 cerrado repetido < 60 min → nada', 'hola', { abierto: false, estado: Object.assign(vacio(), { recepcion: { ultimo: 'cerrado', en: hace(20) } }) },
    { ruta: 'silencio', paso: 'R7', tipo: 'cerrado_repetido', estadoRecepcion: null }],
  ['R7 cerrado pasada la hora → el acuse otra vez', 'hola', { abierto: false, estado: Object.assign(vacio(), { recepcion: { ultimo: 'cerrado', en: hace(70) } }) },
    { ruta: 'cerrado', paso: 'R7', estadoRecepcion: 'cerrado' }],
  ['R7 cerrado repetido, una duda se contesta y no rompe la ventana', '¿Dónde están?', { abierto: false,
    estado: Object.assign(vacio(), { recepcion: { ultimo: 'cerrado', en: hace(20) } }) },
  { ruta: 'respuesta', paso: 'R7', tipo: 'fija:ubicacion', estadoRecepcion: 'cerrado' }],
  ['R7 cerrado, pedido escrito → aviso', 'quiero 2 chilaquiles', { abierto: false }, { ruta: 'cerrado' }],
  ['R7 cerrado, duda con respuesta → la contesta sin botones', '¿A qué hora abren?', { abierto: false },
    { ruta: 'respuesta', paso: 'R7', tipo: 'fija:horario', pendiente: null, formulario: null, textoRe: /7:30 a\. m\./ }],
  // R8 — estado del pedido de esta conversación.
  ['R8 ¿cuánto falta? con folio → estado con tiempo', '¿cuánto falta?', { estado: confirmado(), lectores: {
    estadoOperativo: (folio) => ({ folio, estado: 'en_preparacion', modalidad: 'entrega a domicilio' }) } },
  { ruta: 'respuesta', paso: 'R8', textoRe: /XAB-1001 está en preparación\. Tiempo estimado de entrega: unos 45 minutos/, pendiente: null }],
  // Revisión 3: un pedido que no encontramos lo confirma una persona (antes: «no te entendí»).
  ['R8 sin folio no lee el estado; sin pedidos del teléfono → persona', '¿cuánto falta?', {},
    { ruta: 'persona', paso: 'R8', motivo: 'RECEPCION_PEDIDO_EXTERNO', sinLecturas: ['estadoOperativo'], conLecturas: ['pedidosActivos'] }],
  ['R8 «solo para preguntar el estado de mi pedido» sin pedidos (c89ba2c32) → persona, nunca «no te entendí»',
    'solo para preguntar el estado de mi pedido', {}, { ruta: 'persona', paso: 'R8', motivo: 'RECEPCION_PEDIDO_EXTERNO', texto: FRASES.PERSONA_PEDIDO_EXTERNO }],
  ['R8 «Realicé un pedido en línea» (c9ef5c451) → persona', 'Realice un pedido en línea\nPero cerré la página', {},
    { ruta: 'persona', paso: 'R8', motivo: 'RECEPCION_PEDIDO_EXTERNO' }],
  ['R8 «Disculpa hicimos un pedido» (c78b696b9) → persona', 'Hola buen dia\nDisculpa hicimos un pedido', {},
    { ruta: 'persona', paso: 'R8', motivo: 'RECEPCION_PEDIDO_EXTERNO' }],
  ['R8 «En cuánto tiempo llega?» con folio (c1c28839e) → estado con tiempo', 'En cuánto tiempo llega?', { estado: confirmado(), lectores: {
    estadoOperativo: (folio) => ({ folio, estado: 'nuevo', modalidad: 'entrega a domicilio' }) } },
  { paso: 'R8', texto: `Tu pedido XAB-1001 está recibido, en espera de preparación. Tiempo estimado de entrega: unos 45 minutos, contando desde tu pedido. ${PIE}` }],
  ['R8 sin folio: el pedido del teléfono (del personal) → su estado con tiempo (C-1)', '¿Tiempo de entrega?', {
    lectores: { pedidosActivos: [PEDIDO('XAB-1135', 'nuevo')] } },
  { ruta: 'respuesta', paso: 'R8', tipo: 'estado_telefono', pendiente: null, conLecturas: ['pedidosActivos'],
    texto: `Tu pedido XAB-1135 está recibido, en espera de preparación. Tiempo estimado de entrega: unos 45 minutos, contando desde tu pedido. ${PIE}` }],
  ['R8 dos pedidos → una línea por folio, el pie una vez', '¿ya viene mi pedido?', {
    lectores: { pedidosActivos: [PEDIDO('XAB-2', 'en_preparacion', 'recoger en tienda'), PEDIDO('XAB-1', 'listo', 'recoger en tienda')] } },
  { paso: 'R8', tipo: 'estado_telefono_varios', texto: 'Tu pedido XAB-2 está en preparación. Estará listo para recoger en unos 25 minutos, contando desde tu pedido.\n'
    + `Tu pedido XAB-1 está listo. Puedes pasar a recogerlo.\n${PIE}` }],
  ['R8 listo a domicilio: no inventa un tiempo', '¿cuánto falta?', { lectores: { pedidosActivos: [PEDIDO('XAB-3', 'listo')] } },
    { paso: 'R8', texto: `Tu pedido XAB-3 está listo. ${PIE}` }],
  ['R8 más de 3 pedidos → persona', '¿cuánto falta?', { lectores: { pedidosActivos: ['1', '2', '3', '4'].map((n) => PEDIDO(`XAB-${n}`, 'nuevo')) } },
    { ruta: 'persona', paso: 'R8', motivo: 'RECEPCION_RETRASO', texto: FRASES.PERSONA_RETRASO }],
  ['R8 un estado sin etiqueta (pendiente de pago) no se adivina → persona', '¿cuánto falta?', {
    lectores: { pedidosActivos: [PEDIDO('XAB-4', 'pendiente_pago')] } },
  { ruta: 'persona', paso: 'R8', motivo: 'RECEPCION_PEDIDO_EXTERNO', texto: FRASES.PERSONA_PEDIDO_EXTERNO }],
  ['R8 «ya hice mi pedido en línea» sin pedidos → persona, nunca «no veo tu pedido»', 'Ya hice mi pedido en línea', {},
    { ruta: 'persona', paso: 'R8', motivo: 'RECEPCION_PEDIDO_EXTERNO', texto: FRASES.PERSONA_PEDIDO_EXTERNO }],
  ['R8 «ya hice mi pedido» con la lectura caída → persona', 'ya hice mi pedido', { lectores: { pedidosError: true } },
    { ruta: 'persona', motivo: 'RECEPCION_PEDIDO_EXTERNO' }],
  ['R8 «ya hice mi pedido» con un pedido del teléfono → su estado', 'ya hice mi pedido por la página', {
    lectores: { pedidosActivos: [PEDIDO('XAB-5', 'en_preparacion')] } }, { paso: 'R8', tipo: 'estado_telefono', textoRe: /^Tu pedido XAB-5 está en preparación\./ }],
  ['R8 «¿tiempo de entrega?» sin pedidos → la respuesta de tiempos', '¿Cuál es el tiempo de entrega?', {},
    { ruta: 'respuesta', paso: 'R11', tipo: 'fija:tiempos', conLecturas: ['pedidosActivos'] }],
  // R9 — otro día.
  ['R9 otro día con tienda → liga y «Pedir para hoy»', 'quiero unos chilaquiles para mañana a las 10', { configTienda: TIENDA },
    { ruta: 'respuesta', paso: 'R9', texto: FRASES.PROGRAMADO_TIENDA(URL_TIENDA), pendiente: { tipo: 'recepcion', menu: 'botones_hoy' } }],
  ['R9 otro día sin tienda → persona', 'quiero unos chilaquiles para mañana a las 10', {},
    { ruta: 'persona', paso: 'R9', motivo: 'RECEPCION_PROGRAMADO', texto: FRASES.PERSONA_PROGRAMADO }],
  // R10 — pedir, cambiar, carta.
  ['R10 «quiero hacer un pedido» → formulario', 'quiero hacer un pedido', {},
    { ruta: 'formulario', paso: 'R10', tipo: 'pedir', pendiente: { tipo: 'agregar_otro' }, formulario: { aviso: FRASES.PEDIR },
      conLecturas: ['formularioReciente'] }],
  ['R10 pedido escrito → formulario con su frase', 'unos chilaquiles verdes con pollo y un café', {},
    { ruta: 'formulario', tipo: 'pedido_escrito', formulario: { aviso: FRASES.PEDIDO_ESCRITO } }],
  ['R10 «quiero 2 chilaquiles» → pedido escrito', 'quiero 2 chilaquiles', {}, { tipo: 'pedido_escrito' }],
  ['R10 la carta → formulario', 'me pasas el menú', {}, { ruta: 'formulario', tipo: 'carta', formulario: { aviso: FRASES.CARTA } }],
  ['R10 la carta tras un formulario reciente sigue en formulario', 'me pasas el menú', { lectores: { formularioReciente: true } },
    { ruta: 'formulario', tipo: 'carta', sinLecturas: ['formularioReciente'] }],
  ['R10 retomar → formulario', 'seguir mi pedido', { estado: conCarrito() },
    { ruta: 'formulario', tipo: 'retomar', pendiente: { tipo: 'editar_pedido' }, formulario: { aviso: FRASES.RETOMAR } }],
  ['R10 saludo con carrito → formulario', 'hola', { estado: conCarrito() }, { tipo: 'saludo', formulario: { aviso: FRASES.SALUDO_CON_CARRITO } }],
  ['R10 «no» al resumen → editar', 'no', { estado: conPendiente({ tipo: 'confirmar_resumen', huella: 'h' }) },
    { ruta: 'formulario', tipo: 'no_al_resumen', pendiente: { tipo: 'editar_pedido' }, formulario: { aviso: FRASES.CAMBIAR } }],
  ['R10 cambio con carrito → editar', 'mejor quita el café', { estado: conCarrito() },
    { ruta: 'formulario', tipo: 'cambiar', pendiente: { tipo: 'editar_pedido' } }],
  ['R10 «agrega otro» con carrito → formulario', 'agrega otro', { estado: conCarrito() }, { tipo: 'pedir' }],
  ['R10 segundo pedido escrito < 30 min → persona', 'quiero 2 chilaquiles', { lectores: { formularioReciente: true } },
    { ruta: 'persona', paso: 'R10', motivo: 'RECEPCION_PEDIDO_ESCRITO', texto: FRASES.PERSONA_PEDIDO }],
  ['R10 «quiero ordenar» tras un formulario reciente → persona', 'quiero ordenar', { lectores: { formularioReciente: true } },
    { motivo: 'RECEPCION_PEDIDO_ESCRITO' }],
  ['R10 sin formulario posible → persona', 'quiero hacer un pedido', { cfg: cfgModo({ whatsapp_flow_tienda_v1: '',
    whatsapp_flow_categorias_id: '', whatsapp_flow_repetible_id: '', whatsapp_flow_categorias_dir_id: '', whatsapp_flow_categorias_nota_id: '' }) },
  { ruta: 'persona', paso: 'R10', motivo: 'RECEPCION_FORMULARIO_NO_DISPONIBLE', texto: FRASES.PERSONA_PEDIDO }],
  ['R10 cambio tras confirmar → persona (ya registrado)', 'quita el café', { estado: confirmado() },
    { ruta: 'persona', motivo: 'RECEPCION_FORMULARIO_NO_DISPONIBLE', texto: FRASES.PERSONA_CONFIRMADO }],
  ['R10 «quiero reservar una mesa» no es pedido', 'quiero reservar una mesa', {}, { ruta: 'respuesta', paso: 'R11', tipo: 'fija:mesas' }],
  // R10b — la pregunta con opciones contestada por texto.
  ['R10b modalidad escrita → la misma pregunta', 'a domicilio', { estado: conPendiente({ tipo: 'modalidad', opciones: F.modalidades }) },
    { ruta: 'respuesta', paso: 'R10b', pendiente: { tipo: 'modalidad', opciones: F.modalidades }, estadoRecepcion: 'usa_opciones' }],
  ['R10b dirección escrita → el formulario en la dirección', 'Hidalgo 405, centro', {
    estado: conPendiente({ tipo: 'direccion' }, 'dos', { modalidad: 'entrega a domicilio', forma_pago: 'efectivo' }) },
  { paso: 'R10b', tipo: 'usa_opciones:direccion', formulario: { aviso: FRASES.DIRECCION_EN_FORMULARIO } }],
  ['R10b la segunda vez < 30 min → persona', 'a domicilio', { estado: Object.assign(conPendiente({ tipo: 'modalidad', opciones: F.modalidades }),
    { recepcion: { ultimo: 'usa_opciones', en: hace(5) } }) }, { ruta: 'persona', paso: 'R10b', motivo: 'RECEPCION_INSISTE' }],
  // R11 — dudas con respuesta aprobada.
  ['R11 horario → texto y botones', '¿Qué horario tienen?', {},
    { ruta: 'respuesta', paso: 'R11', tipo: 'fija:horario', pendiente: BOTONES, textoRe: /^\*Horario\*\nLunes a domingo: 7:30 a\. m\. a 3:00 p\. m\.$/ }],
  ['R11 ubicación', '¿Dónde están?', {}, { tipo: 'fija:ubicacion', textoRe: /Libramiento Manuel Pérez Treviño 2416, Piedras Negras\./ }],
  ['R11 «mi dirección» no es la del local', 'ya les pasé mi dirección', {}, { paso: 'R14' }],
  ['R11 tiempos', '¿Cuánto tardan?', {}, { tipo: 'fija:tiempos', textoRe: /A domicilio: unos 45 minutos\.\nPara recoger: unos 25 minutos\./ }],
  ['R11 envío con zonas', '¿Cuánto cuesta el envío?', {}, { tipo: 'fija:envio', textoRe: /Costo base: \$60\.\nZonas con otro costo: UTNC \$150 · Cervecera \$150/ }],
  ['R11 pagos reales', '¿Aceptan tarjeta?', {}, { tipo: 'fija:pagos', textoRe: /Efectivo[\s\S]*Tarjeta con terminal[\s\S]*No manejamos transferencia/ }],
  ['R11 ¿qué es el enlace de pago?', '¿Qué es el enlace de pago?', {}, { tipo: 'fija:pagos' }],
  ['R11 mesas (la pregunta frecuente)', '¿Tienen mesas?', {}, { tipo: 'fija:mesas', texto: 'Sí, tenemos mesas en el local. No tomamos reservaciones.' }],
  ['R11 promociones: el texto oficial, sin oferta', '¿Qué promociones tienen hoy?', {},
    { tipo: 'fija:promociones', texto: 'Hoy: 2x1 en chilaquiles.', conLecturas: ['promocionesOficiales'] }],
  ['R11 promociones sin lectura → texto fijo', '¿hay promociones?', { lectores: { promocionesError: true } },
    { tipo: 'fija:promociones', texto: FRASES.PROMOS_NO_DISPONIBLES }],
  ['R11 cómo pedir', '¿Cómo hago mi pedido?', {}, { tipo: 'fija:como_pedir', texto: FRASES.COMO_PEDIR }],
  ['R11 pregunta frecuente por sus palabras', '¿Qué hacen por mi cumpleaños?', {},
    { tipo: `fija:${RF.idDeFaq('Cumpleaños')}`, texto: 'El día de tu cumpleaños desayunas gratis en el local.' }],
  ['R11 «info» → la lista', 'info', {}, { ruta: 'respuesta', tipo: 'informacion', texto: FRASES.INFORMACION_MENU,
    pendiente: { tipo: 'recepcion', menu: 'informacion' } }],
  ['R11 con carrito → el formulario «Continuar pedido» lleva la respuesta', '¿A qué hora cierran?', { estado: conCarrito() },
    { tipo: 'fija:horario', pendiente: { tipo: 'editar_pedido' }, formulario: { cta: 'Continuar pedido', cuerpo: /^\*Horario\*[\s\S]*Tu pedido guardado sigue aquí/ } }],
  ['R11 tras el pedido → solo texto', '¿Dónde están?', { estado: confirmado() }, { tipo: 'fija:ubicacion', pendiente: null, formulario: null }],
  // R12 — preguntas de platillos.
  ['R12 ¿tienen…? → la carta y el menú debajo', '¿Tienen chilaquiles?', {},
    { ruta: 'respuesta', paso: 'R12', tipo: 'producto', texto: `Sí, en el menú tenemos: Chilaquiles ($145).\n\n${FRASES.PRODUCTO_PIE}`,
      pendiente: { tipo: 'agregar_otro' }, formulario: { cuerpo: /^Sí, en el menú tenemos/ } }],
  ['R12 con carrito → «Continuar pedido»', '¿Cuánto cuesta el jugo de naranja?', { estado: conCarrito() },
    { paso: 'R12', pendiente: { tipo: 'editar_pedido' }, formulario: { cta: 'Continuar pedido' } }],
  ['R12 ¿qué trae…? sin descripción', '¿Qué trae el café americano?', {}, { paso: 'R12', textoRe: /^Café americano: precio base \$45\./ }],
  ['R12 no encontrado → nunca «no tenemos»', '¿Tienen pizza?', {}, { paso: 'R12', tipo: 'producto_no_encontrado',
    texto: FRASES.PRODUCTO_NO_ENCONTRADO, pendiente: BOTONES }],
  // R14 — no reconocido.
  ['R14 no reconocido → botones', 'asdf qwer', {}, { ruta: 'respuesta', paso: 'R14', tipo: 'no_reconocido', texto: FRASES.NO_RECONOCIDO,
    pendiente: BOTONES, estadoRecepcion: 'no_reconocido' }],
  ['R14 la segunda vez < 30 min → persona', 'asdf qwer', { estado: Object.assign(vacio(), { recepcion: { ultimo: 'no_reconocido', en: hace(10) } }) },
    { ruta: 'persona', paso: 'R14', motivo: 'RECEPCION_INSISTE', texto: FRASES.PERSONA }],
  ['R14 pasados 30 min vuelve a contar', 'asdf qwer', { estado: Object.assign(vacio(), { recepcion: { ultimo: 'no_reconocido', en: hace(45) } }) },
    { ruta: 'respuesta', paso: 'R14' }],
  ['R14 saludo que no tomó el inicio Mapo → saludo y botones', 'hola', { estado: Object.assign(vacio(), { programacionRequerida: true }) },
    { paso: 'R14', tipo: 'saludo', texto: FRASES.SALUDO }],
  ['R14 tras el pedido → sin botones', 'asdf qwer', { estado: confirmado() }, { paso: 'R14', texto: NO_RECONOCIDO_SIN_BOTONES, pendiente: null }],
  ['R14 con carrito → botones (el primero «Continuar pedido»)', '¿y eso qué?', { estado: conCarrito() }, { paso: 'R14', pendiente: BOTONES }],
  // REVISIÓN 3 — un saludo nunca es «no te entendí» ni insistir.
  ['R14 «Hola buenos días 😃» tras un «no te entendí» → saludo, nunca persona', 'Hola buenos días 😃',
    { estado: Object.assign(vacio(), { recepcion: { ultimo: 'no_reconocido', en: hace(2) } }) },
    { ruta: 'respuesta', paso: 'R14', tipo: 'saludo', texto: FRASES.SALUDO, pendiente: BOTONES, estadoRecepcion: null }],
  ['R14 saludo tras el pedido → sin botones', 'Buenos días', { estado: confirmado() },
    { paso: 'R14', tipo: 'saludo_sin_botones', texto: SALUDO_SIN_BOTONES, pendiente: null, estadoRecepcion: null }],
  ['R10 «Hola buen día» con carrito → el carrito (saludo)', 'Hola buen día', { estado: conCarrito() }, { ruta: 'formulario', tipo: 'saludo' }],
  // REVISIÓN 3 (bloqueante 1) — R-cortesía: un agradecimiento o un acuse no cuenta ni pasa a una persona.
  ['RC «gracias» sin pedido → cortesía con botones; no cuenta como «no te entendí»', 'gracias', {},
    { ruta: 'respuesta', paso: 'R-cortesia', tipo: 'cortesia', texto: FRASES.CORTESIA, pendiente: BOTONES, estadoRecepcion: 'cortesia' }],
  ['RC «ok gracias» tras un «no te entendí» < 30 min → cortesía, nunca RECEPCION_INSISTE', 'ok gracias',
    { estado: Object.assign(vacio(), { recepcion: { ultimo: 'no_reconocido', en: hace(5) } }) },
    { ruta: 'respuesta', paso: 'R-cortesia', estadoRecepcion: 'cortesia' }],
  ['RC «👍» tras un «no te entendí» → cortesía', '👍', { estado: Object.assign(vacio(), { recepcion: { ultimo: 'no_reconocido', en: hace(5) } }) },
    { ruta: 'respuesta', paso: 'R-cortesia' }],
  ['RC «A Okis gracias» (c69889eec) → cortesía', 'A Okis gracias', {}, { paso: 'R-cortesia', tipo: 'cortesia' }],
  ['RC «okis, muy bien» (cde7d3a3e) → cortesía', 'okis, muy bien', {}, { paso: 'R-cortesia' }],
  ['RC «Listo» tras el pedido (cda850980) → cortesía sin botones', 'Listo', { estado: confirmado() },
    { ruta: 'respuesta', paso: 'R-cortesia', texto: FRASES.CORTESIA, pendiente: null }],
  ['RC «Ya llegó, muchas gracias» con el pedido en camino → cortesía, nunca «está en camino»', 'Ya llegó, muchas gracias', { estado: confirmado(),
    lectores: { estadoOperativo: (folio) => ({ folio, estado: 'en_camino', modalidad: 'entrega a domicilio' }) } },
  { paso: 'R-cortesia', texto: FRASES.CORTESIA, sinLecturas: ['estadoOperativo'] }],
  ['RC «ya llegó gracias!» con un pedido del teléfono → cortesía, no su estado', 'ya llegó gracias!',
    { lectores: { pedidosActivos: [PEDIDO('XAB-9', 'en_camino')] } }, { paso: 'R-cortesia', sinLecturas: ['pedidosActivos'] }],
  ['RC la segunda cortesía < 30 min → nada, sin aviso', 'gracias', { estado: Object.assign(vacio(), { recepcion: { ultimo: 'cortesia', en: hace(3) } }) },
    { ruta: 'silencio', paso: 'R-cortesia', tipo: 'cortesia_repetida', alerta: null }],
  ['RC con el formulario de pedido en curso → el mismo formulario otra vez, su pendiente', 'ok', { estado: conPendiente({ tipo: 'agregar_otro' }, 'vacio') },
    { ruta: 'formulario', paso: 'R-cortesia', tipo: 'cortesia_formulario', pendiente: { tipo: 'agregar_otro' },
      formulario: { aviso: FRASES.CORTESIA_FORMULARIO }, estadoRecepcion: null }],
  ['RC con el carrito en su formulario → el carrito otra vez (aunque ya haya otra cortesía)', 'gracias',
    { estado: Object.assign(conPendiente({ tipo: 'editar_pedido' }), { recepcion: { ultimo: 'cortesia', en: hace(3) } }) },
    { ruta: 'formulario', paso: 'R-cortesia', pendiente: { tipo: 'editar_pedido' } }],
  ['RC cerrado → cortesía sin botones ni formulario', 'gracias', { abierto: false, estado: conPendiente({ tipo: 'agregar_otro' }, 'vacio') },
    { ruta: 'respuesta', paso: 'R-cortesia', pendiente: null, formulario: null }],
  ['RC cerrado tras el acuse < 60 min → nada (la ventana del cerrado sigue)', 'gracias',
    { abierto: false, estado: Object.assign(vacio(), { recepcion: { ultimo: 'cerrado', en: hace(10) } }) },
    { ruta: 'silencio', paso: 'R-cortesia', tipo: 'cortesia_cerrado' }],
  ['RC «gracias» con una opción pendiente → la misma pregunta (R10b)', 'gracias', { estado: conPendiente({ tipo: 'modalidad', opciones: F.modalidades }) },
    { paso: 'R10b' }],
  ['RC «gracias, ¿a qué hora cierran?» es una duda', 'gracias, ¿a qué hora cierran?', {}, { paso: 'R11', tipo: 'fija:horario' }],
  ['RC «Si porfavor» no es un acuse (sin el personal: «no te entendí»)', 'Si porfavor', {}, { paso: 'R14', tipo: 'no_reconocido' }],
  // REVISIÓN 3 (bloqueante 2) — las preguntas más comunes de los 7 días, como las escribieron.
  ...[['cda850980', 'Tiene servicio a domicilio?'], ['ca61f05af', 'Disculpe tiene servicio a domicilio? Para almuerzos'],
    ['c2e259046', 'Buen día, tiene servicio a domicilio disponible?'], ['c3f7254a9', 'Hola buen día, cuentan con servicio a domicilio?'],
    ['c98cd8d95', 'Muy bien, disculpa cuentas con envío ?'], ['cde7d3a3e', 'el envio es de cuanto?'],
    ['cbc7c109e', 'Disculpe a una guardería junto las salón Versalles cuánto cobra el servicio a domicilio?'],
    ['cf3f29860', 'Buenos dias , tiene el dia de hoy para entregar a domicilio ?']]
    .map(([c, m]) => [`RF envío (${c}): «${m.slice(0, 40)}»`, m, {}, { ruta: 'respuesta', paso: 'R11', tipo: 'fija:envio' }]),
  ...[['c98cd8d95', 'Hola buen día, disculpa hoy tienes alguna promoción'], ['-', 'hoy hay promo'], ['-', 'tienen promociones']]
    .map(([c, m]) => [`RF promociones (${c}): «${m}»`, m, {}, { paso: 'R11', tipo: 'fija:promociones' }]),
  // Como esConsultaDePromociones: una promoción ligada al pedido es aplicarla, no preguntar por ella.
  ['RF «tienen promo para mi pedido» no es la pregunta de promociones', 'tienen promo para mi pedido', {}, { paso: 'R12' }],
  ['RF pagos «puedo transferir» (cde7d3a3e)', 'puedo transferir', {}, { paso: 'R11', tipo: 'fija:pagos' }],
  ['RF pedir «Disculpe pudiera hacer un pedido para pasar por el» (cba7740ef)', 'Disculpe pudiera hacer un pedido para pasar por el', {},
    { ruta: 'formulario', paso: 'R10', tipo: 'pedir' }],
  ['RF pedir «Buenos días, quisiera order algo a dom.» (ce7a8a18c)', 'Buenos días, quisiera order algo a dom.', {},
    { ruta: 'formulario', paso: 'R10', tipo: 'pedir' }],
  // REVISIÓN 3 — con carrito, una DUDA con «sin» o «mejor» no es un cambio (C-2).
  ['RF con carrito «O si tiene para hacer trasferencia mejor» (ced4cc7b4) → formas de pago con «Continuar pedido»',
    'O si tiene  para hacer trasferencia mejor', { estado: conCarrito() },
    { paso: 'R11', tipo: 'fija:pagos', formulario: { cta: 'Continuar pedido' } }],
  ['RF con carrito «¿Tienen opciones sin gluten?» → la consulta, no «Haz el cambio aquí»', '¿Tienen opciones sin gluten?', { estado: conCarrito() },
    { ruta: 'respuesta', paso: 'R12' }],
  ['RF con carrito «¿me quitas el café?» sí es un cambio', '¿me quitas el café?', { estado: conCarrito() }, { ruta: 'formulario', tipo: 'cambiar' }],
  // REVISIÓN 3 — lo que el replay de 7 días (con la carta publicada) todavía mandaba a «no te entendí».
  ['RF pago: «No me / Acepta la tarjeta» (ced4cc7b4) → persona, dinero', 'No me\nAcepta la tarjeta pagaré en efectivo', { estado: confirmado() },
    { ruta: 'persona', paso: 'R4', motivo: 'RECEPCION_QUEJA_PAGO', texto: FRASES.PERSONA_QUEJA }],
  ['RF pago: «Estoy teniendo problemas con el pago» (c7d56ed24) → persona, dinero',
    'No tiene otra forma de pago? Que no sea por clip? Estoy teniendo problemas con el pago', { estado: confirmado() },
    { ruta: 'persona', paso: 'R4', motivo: 'RECEPCION_QUEJA_PAGO' }],
  ['RF «Con una persona real xfis» (cbc7c109e) → persona', 'Con una persona real xfis', {}, { ruta: 'persona', paso: 'R5', motivo: 'RECEPCION_PIDE_PERSONA' }],
  ['RF «Creo que si pediré por aquí» (c69889eec) → el formulario', 'Creo que si pediré por aquí', {}, { ruta: 'formulario', paso: 'R10', tipo: 'pedir' }],
  ['RF «Hola Buendía» (cadd98934) es un saludo', 'Hola Buendía', {}, { paso: 'R14', tipo: 'saludo', estadoRecepcion: null }],
  ['RF nota con carrito («poner una nota de feliz cumpleaños») → el formulario (lleva la nota)', 'Le pueden poner una nota de feliz cumpleaños',
    { estado: conCarrito() }, { ruta: 'formulario', tipo: 'cambiar' }],
  ['RF nota tras el pedido (cadd98934) → persona (ya registrado)', 'Creen poderle poner una nota de feliz cumpleaños', { estado: confirmado() },
    { ruta: 'persona', paso: 'R10', texto: FRASES.PERSONA_CONFIRMADO }],
];

try {
  // ── modoIA ─────────────────────────────────────────────────────────────
  await caso('M1 modoIA: valores exactos, alcance y prueba por teléfono', () => {
    for (const v of [undefined, '', 'true', 'false', 'FORMULARIO', ' formulario', 'Recepcionista']) {
      assert.equal(R.modoIA(cfgModo({ [CLAVES_IA.MODO]: v }), T), null, `modo ${JSON.stringify(v)}`);
    }
    for (const a of [undefined, '', 'Todos', 'true', 'TODOS']) assert.equal(R.modoIA(cfgModo({ [CLAVES_IA.ALCANCE]: a }), T), null, `alcance ${a}`);
    assert.equal(R.modoIA(cfgModo({ [CLAVES_IA.ALCANCE]: 'prueba' }), T), null, 'prueba sin lista');
    assert.equal(R.modoIA(cfgModo({ [CLAVES_IA.ALCANCE]: 'prueba', [CLAVES_IA.TELEFONOS]: F.OTRO_TELEFONO }), T), null);
    assert.equal(R.modoIA(cfgModo({ [CLAVES_IA.ALCANCE]: 'prueba', [CLAVES_IA.TELEFONOS]: `${F.OTRO_TELEFONO}, ${T}` }), T)?.completo, true);
    const m = R.modoIA(cfgModo({ [CLAVES_IA.MODO]: 'recepcionista', [CLAVES_IA.PUBLICAR_SELECTOR]: 'true', [CLAVES_IA.SILENCIO]: '90' }), T);
    assert.deepEqual({ modo: m.modo, completo: m.completo, publicarSelector: m.publicarSelector, silencioMin: m.silencioMin },
      { modo: 'recepcionista', completo: true, publicarSelector: true, silencioMin: 90 });
    assert.equal(R.modoIA(cfgModo({ [CLAVES_IA.PUBLICAR_SELECTOR]: 'true' }), T).publicarSelector, false, 'en formulario no hay selector');
    for (const s of ['0', '721', 'x', '', '12.5']) assert.equal(R.modoIA(cfgModo({ [CLAVES_IA.SILENCIO]: s }), T).silencioMin, 180, s);
  });
  await caso('M2 precondiciones: cada una cae con su id (falla cerrada, no vuelve a hoy)', () => {
    const caidas = { formularios: { whatsapp_flows_v1: 'false' }, interactivos: { whatsapp_interactivos_v1: 'false' },
      elecciones: { whatsapp_interactivos_elecciones_v1: '' }, rescate: { whatsapp_rescate_humano_v1: 'TRUE' },
      inicio_mapo: { whatsapp_inicio_mapo_v1: 'false' }, beta_hibrida: { whatsapp_beta_hibrido_v1: 'false' },
      eventos_formulario: { whatsapp_flow_evento_id: 'x' } };
    for (const [id, extra] of Object.entries(caidas)) {
      const m = R.modoIA(cfgModo(extra), T);
      assert(m && m.completo === false && m.faltan.includes(id), `${id}: ${JSON.stringify(m)}`);
    }
    const sinProceso = process.env.WHATSAPP_INTERACTIVOS;
    process.env.WHATSAPP_INTERACTIVOS = 'false';
    try { assert.deepEqual(R.modoIA(cfgModo(), T).faltan, ['interactivos']); } finally { process.env.WHATSAPP_INTERACTIVOS = sinProceso; }
  });

  // ── El router ──────────────────────────────────────────────────────────
  for (const [nombre, mensaje, opciones, esperado] of CASOS_ROUTER) {
    await caso(nombre, async () => exigir(await decidir(mensaje, { ...opciones, estado: opciones.estado ?? vacio() }), esperado, nombre));
  }
  await caso('R* cada persona del router usa un texto de la lista cerrada del recibo (la del modo)', async () => {
    for (const [nombre, mensaje, opciones] of CASOS_ROUTER) {
      const d = await decidir(mensaje, { ...opciones, estado: opciones.estado ?? vacio() });
      if (d.ruta === 'persona') assert(textosDelRecibo(true).includes(d.persona.texto), `${nombre}: ${d.persona.texto}`);
    }
    assert(CASOS_ROUTER.length >= 70, `${CASOS_ROUTER.length} casos`);
  });

  // ── REVISIÓN 3: acuses, la lista del recibo y la alerta fuera del Mesero ──
  await caso('AC esAcuse: agradecimientos y acuses sí; preguntas, saludos solos, pedidos y «sí, quiero…» no', () => {
    for (const m of ['gracias', 'Gracias 🙏', 'ok gracias', 'A Okis gracias', 'Listo', 'ok', 'Okisss', 'sí', 'De acuerdo', 'okis, muy bien',
      '👍', '🙏🙏', 'Perfecto gracias', 'Ya llegó, muchas gracias', 'ya llegó gracias!', 'Si muchas gracias\nYa la recibí', 'Muy amable gracias',
      'Graciasss', 'Mil gracias por todo, buen día', 'Va, gracias joven']) assert.equal(R.esAcuse(m), true, m);
    for (const m of ['', 'hola', 'Buenos días', 'Buenas noches', 'gracias, ¿a qué hora cierran?', '¿ok?', 'Si porfavor', 'sí, quiero 2 chilaquiles',
      'ok, a domicilio', 'Listo, ya pagué con tarjeta', `gracias ${NOTA_IMAGEN_PARA_IA}`, 'no', 'Oki entonces sería 2 verdes por favor',
      'ok '.repeat(14)]) assert.equal(R.esAcuse(m), false, m);
  });
  await caso('RH recibo: la lista de siempre no cambia; un texto del modo pasa la pausa SOLO con el modo vigente; vincular usa la del modo solo con recepcion', async () => {
    assert.equal(TEXTOS_RECIBO_HANDOFF.length, 3);
    assert(TEXTOS_PERSONA.every((t) => !TEXTOS_RECIBO_HANDOFF.includes(t) && textosDelRecibo(true).includes(t)));
    const fila = (texto) => ({ id: 1, negocio_id: 'neg', carga: { telefono: T, texto, recibo_handoff: { motivo: 'X' } } });
    const db = (cfg) => ({ query: async () => ({ rows: [{ bot_whatsapp_activo: true, canal: true, modulo: true, tomado: false, humano: false,
      ventana: true, cfg: { ...cfg, mesero_agente_v1: 'true', mesero_agente_porcentaje: '100', whatsapp_beta_telefonos: '' } }] }) });
    const sinModo = cfgModo({ [CLAVES_IA.MODO]: '' });
    assert.equal(await permiteReciboHandoff({ db: db(cfgModo()), fila: fila(FRASES.PERSONA_PEDIDO) }), true, 'con el modo, el texto de persona sale');
    assert.equal(await permiteReciboHandoff({ db: db(sinModo), fila: fila(FRASES.PERSONA_PEDIDO) }), false, 'sin el modo, un texto del modo no salta la pausa');
    assert.equal(await permiteReciboHandoff({ db: db(sinModo), fila: fila(TEXTO_RESCATE) }), true, 'el texto de siempre sale sin el modo');
    const llamadas = [];
    const espia = { query: async (_sql, params) => { llamadas.push(params[3]); return { rows: [] }; } };
    await vincularReciboHandoff(espia, { clave: 'c', negocioId: 'n', telefono: T });
    await vincularReciboHandoff(espia, { clave: 'c', negocioId: 'n', telefono: T, recepcion: true });
    assert.deepEqual(llamadas[0], TEXTOS_RECIBO_HANDOFF, 'sin recepcion, la lista de siempre');
    assert(TEXTOS_PERSONA.every((t) => llamadas[1].includes(t)), 'con recepcion, también los textos del modo');
  });
  await caso('AL modoDelPedido avisa si un cliente del alcance del modo cae fuera del Mesero (una vez por negocio); la decisión no cambia', async () => {
    const errores = [];
    const original = console.error;
    console.error = (...a) => { errores.push(a.join(' ')); };
    try {
      const leer = (cfg) => async () => cfg;
      const fuera = await modoDelPedido('neg-al-1', { telefono: T, leerConfiguracion: leer(cfgModo({ mesero_agente_v1: 'false' })) });
      assert.equal(fuera.agente, false);
      await modoDelPedido('neg-al-1', { telefono: T, leerConfiguracion: leer(cfgModo({ mesero_agente_v1: 'false' })) });
      assert.equal(errores.filter((e) => /ALERTA modo_fuera_del_mesero negocio=neg-al-1/.test(e)).length, 1, errores.join(' | '));
      const dentro = await modoDelPedido('neg-al-2', { telefono: T, leerConfiguracion: leer(cfgModo({ mesero_agente_v1: 'true', mesero_agente_porcentaje: '100' })) });
      assert.equal(dentro.agente, true);
      await modoDelPedido('neg-al-3', { telefono: T, leerConfiguracion: leer(cfgModo({ [CLAVES_IA.MODO]: '', mesero_agente_v1: 'false' })) });
      await modoDelPedido('neg-al-4', { telefono: F.OTRO_TELEFONO, leerConfiguracion: leer(cfgModo({ [CLAVES_IA.ALCANCE]: 'prueba',
        [CLAVES_IA.TELEFONOS]: T, mesero_agente_v1: 'false' })) });
      assert(!errores.some((e) => /neg-al-[234]/.test(e)), errores.join(' | '));
    } finally { console.error = original; }
  });

  // ── clasificarIntencion ────────────────────────────────────────────────
  await caso('CI clasificarIntencion: clases y orden', () => {
    const c = (m, estado = vacio()) => R.clasificarIntencion({ mensaje: m, estado, catalogo: CARTA });
    assert.equal(c('no', conPendiente({ tipo: 'confirmar_resumen', huella: 'h' })), 'no_al_resumen');
    assert.equal(c('ver mi carrito'), 'retomar');
    assert.equal(c('hola', conCarrito()), 'saludo');
    assert.equal(c('hola'), null);
    assert.equal(c('me pasas la carta'), 'carta');
    assert.equal(c('quiero ordenar a domicilio'), 'pedir');
    assert.equal(c('quita el café', conCarrito()), 'cambiar');
    assert.equal(c('quita el café'), 'pedido_escrito');
    assert.equal(c('dos chilaquiles rojos'), 'pedido_escrito');
    assert.equal(c('¿chilaquiles?'), null, 'una pregunta sin decisión no es pedido');
    assert.equal(c('¿tienen chilaquiles?'), null);
    assert.equal(R.clasificarIntencion({ mensaje: 'quiero reservar', estado: vacio(), catalogo: CARTA, respuestaFija: () => 'mesas' }), null);
    assert.equal(R.clasificarIntencion({ mensaje: 'quiero chilaquiles', estado: vacio(), catalogo: CARTA, respuestaFija: () => 'mesas' }), 'pedido_escrito');
  });

  // ── El catálogo de respuestas aprobadas ────────────────────────────────
  const catalogo = (reglas = REGLAS, cfg = cfgModo(), metodosPago = F.metodosPago, modalidades = F.modalidades, estadoRestaurante = { abierto: true }) =>
    RF.catalogoDeRespuestas({ reglas, cfg, metodosPago, modalidades, estadoRestaurante });
  await caso('CA1 horario en 12 h, días cerrados agrupados y cierre especial; horario incompleto se omite', () => {
    const horarios = { ...REGLAS.horarios, martes: { abierto: false }, sabado: { abierto: true, apertura: '08:00', cierre: '24:00' },
      domingo: { abierto: true, apertura: '08:00', cierre: '24:00' } };
    const h = catalogo({ ...REGLAS, horarios }, cfgModo(), F.metodosPago, F.modalidades,
      { abierto: true, cierreEspecial: { hora_cierre: '13:30' } }).entradas.find((e) => e.id === 'horario');
    assert.equal(h.texto, '*Horario*\nLunes: 7:30 a. m. a 3:00 p. m.\nMartes: cerrado\nMiércoles a viernes: 7:30 a. m. a 3:00 p. m.\n'
      + 'Sábado y domingo: 8:00 a. m. a 12:00 a. m.\nHoy cerramos a las 1:30 p. m.');
    const r = catalogo({ ...REGLAS, horarios: { ...REGLAS.horarios, lunes: { abierto: true, apertura: '7', cierre: '15:00' } } });
    assert(!r.entradas.some((e) => e.id === 'horario') && r.omitidas.some((o) => o.id === 'horario'));
  });
  await caso('CA2 envío, pagos reales y mesas solo con su pregunta frecuente', () => {
    const conTransfer = catalogo(REGLAS, cfgModo(), [...F.metodosPago, { tipo: 'transferencia' }, { tipo: 'enlace_pago' }]).entradas.find((e) => e.id === 'pagos');
    assert(!/No manejamos transferencia/.test(conTransfer.texto) && /Enlace de pago: te enviamos un link/.test(conTransfer.texto));
    assert.match(conTransfer.descripcion, /Efectivo, Tarjeta con terminal, Transferencia, Enlace de pago/);
    const soloRecoger = catalogo(REGLAS, cfgModo(), F.metodosPago, ['recoger en tienda']).entradas;
    assert.equal(soloRecoger.find((e) => e.id === 'envio').texto, '*Envío*\nPor ahora solo tenemos pedidos para recoger en tienda.');
    assert.equal(soloRecoger.find((e) => e.id === 'tiempos').texto, '*Tiempo estimado*\nPara recoger: unos 25 minutos.\nEs un estimado, no una hora garantizada.');
    const sinMesas = catalogo({ ...REGLAS, bot: { faqs: [] } });
    assert(!sinMesas.entradas.some((e) => e.id === 'mesas') && sinMesas.omitidas.some((o) => o.id === 'mesas'));
    assert(!catalogo(REGLAS, cfgModo({ direccion: '' })).entradas.some((e) => e.id === 'ubicacion'));
    assert(!catalogo(REGLAS, cfgModo(), []).entradas.some((e) => e.id === 'pagos'));
  });
  await caso('CA3 preguntas frecuentes: la de tarifa de envío, la prohibida y la larga se omiten; información importante nunca entra', () => {
    const reglas = { ...REGLAS, bot: { informacion_importante: 'Después del cierre está prohibido tomar pedidos; responde…',
      respuestas_prohibidas: ['no tenemos'], faqs: [
        { pregunta: 'Envío a la UTNC', respuesta: 'A la UTNC el envío cuesta $150.' },
        { pregunta: 'Pizza', respuesta: 'No tenemos pizza.' },
        { pregunta: 'Larga', respuesta: 'x'.repeat(1025) },
        { pregunta: 'Cumpleaños', respuesta: 'Desayunas gratis.' }] } };
    const { entradas, omitidas } = catalogo(reglas);
    assert.deepEqual(entradas.filter((e) => e.origen === 'faq').map((e) => e.titulo), ['Cumpleaños']);
    const motivos = omitidas.filter((o) => o.id.startsWith('faq:')).map((o) => o.motivo);
    assert.equal(motivos.length, 3, JSON.stringify(motivos));
    ['menciona una tarifa', 'contiene una frase prohibida', 'respuesta de más de 1024'].forEach((m, i) => assert(motivos[i].startsWith(m), motivos[i]));
    assert(!entradas.some((e) => /prohibido tomar pedidos/.test(e.texto || '')));
    // PARTE 2: sin zonas de entrega (Acuña) una respuesta de varias frases no es «tarifa».
    const sinZonas = { ...REGLAS, pedidos: { ...REGLAS.pedidos, zonas_entrega: [] }, bot: { faqs: [
      { pregunta: 'Cumpleaños', respuesta: 'Desayunas gratis en el local. Ven acompañado. Te ponemos velita.' }] } };
    assert.deepEqual(catalogo(sinZonas).entradas.filter((e) => e.origen === 'faq').map((e) => e.titulo), ['Cumpleaños']);
    assert.equal(RF.faqConTarifaDeEnvio({ pregunta: 'Envío', respuesta: 'Hola. A la UTNC el envío cuesta $150.' }, REGLAS), true);
  });
  await caso('CA4 lista: ≤ 10 filas (9 + «Más preguntas»), títulos ≤ 24 y únicos, segunda lista solo preguntas frecuentes', () => {
    const faqs = Array.from({ length: 6 }, (_, i) => ({ pregunta: `¿Pregunta frecuente número ${i} con un texto largo para cortar?`, respuesta: `R${i}` }));
    faqs.push({ pregunta: '¿Pregunta frecuente número 0 con un texto largo para cortar? (otra)', respuesta: 'Z' });
    const { entradas } = catalogo({ ...REGLAS, bot: { faqs: [...REGLAS.bot.faqs, ...faqs] } });
    assert(entradas.length > 10);
    assert(entradas.every((e) => e.titulo.length <= 24 && (e.descripcion || '').length <= 72), 'título o descripción largos');
    assert.equal(new Set(entradas.map((e) => e.titulo)).size, entradas.length, 'títulos repetidos');
    const primera = R.filasDeInformacion(entradas, 'informacion'), segunda = R.filasDeInformacion(entradas, 'informacion_2');
    assert.equal(primera.length, 10); assert.equal(primera[9].valor, 'mas_preguntas');
    assert(segunda.length >= 1 && segunda.every((f) => f.valor.startsWith('info:faq:')));
    assert.deepEqual(RF.tituloDeFaq('¿Desayuno sorpresa?'), { titulo: 'Desayuno sorpresa', descripcion: '' });
    assert.equal(RF.tituloDeFaq('Supercalifragilisticoespialidoso del día').titulo.length <= 24, true);
  });
  await caso('CA5 buscarRespuestaFija: un tema reconocido sin su dato no cae a otro; faq solo si coincide una', () => {
    const { entradas } = catalogo();
    const sinHorario = entradas.filter((e) => e.id !== 'horario');
    assert.equal(RF.buscarRespuestaFija('¿a qué hora abren y dónde están?', sinHorario), null);
    assert.equal(RF.buscarRespuestaFija('¿a qué hora abren y dónde están?', entradas), 'horario');
    assert.equal(RF.buscarRespuestaFija('desayuno sorpresa', entradas), RF.idDeFaq('Desayuno sorpresa'));
    assert.equal(RF.buscarRespuestaFija('¿abren el 16 de septiembre?', entradas), null, 'una fecha no la contesta el horario semanal');
    const dos = [...entradas, { id: 'faq:otra', origen: 'faq', titulo: 'Sorpresa desayuno', pregunta: 'Sorpresa desayuno', texto: 'x' }];
    assert.equal(RF.buscarRespuestaFija('desayuno sorpresa', dos), null, 'dos faqs coinciden: no se adivina');
  });

  // ── Botones y lista ────────────────────────────────────────────────────
  await caso('BL construirRecepcion: válido para Meta; null sin modo, tras el pedido o con otro texto', () => {
    const { entradas } = catalogo();
    const preparar = (menu, estado = F.estado({ pendiente: { tipo: 'recepcion', menu } }), cfg = cfgModo(), texto = FRASES.NO_RECONOCIDO) => {
      estado.dialogo.texto = FRASES.NO_RECONOCIDO;
      return R.construirRecepcion({ estado, pedido: { huella: 'h', total: 0 }, texto, cfg, telefono: T, entradas });
    };
    for (const menu of ['botones', 'botones_hoy', 'informacion']) {
      const p = preparar(menu);
      assert(p && payloadInteractivoValido(p.carga, FRASES.NO_RECONOCIDO), `${menu}: ${JSON.stringify(p?.carga).slice(0, 200)}`);
      assert(p.botones.every((b) => b.accion === 'menu_mapo' && R.esValorDeRecepcion(b.datos.valor) || ['ordenar', 'humano'].includes(b.datos.valor)));
      assert.match(p.textoFallback, /hablar con alguien/);
    }
    assert.deepEqual(preparar('botones').botones.map((b) => [b.title, b.datos.valor]),
      [['Hacer pedido', 'ordenar'], ['Más información', 'informacion'], ['Hablar con alguien', 'humano']]);
    assert.equal(preparar('botones_hoy').botones[0].title, 'Pedir para hoy');
    assert.equal(preparar('botones', F.estado({ pendiente: { tipo: 'recepcion', menu: 'botones' }, items: 'dos' })).botones[0].title, 'Continuar pedido');
    assert.equal(preparar('botones', undefined, cfgModo({ [CLAVES_IA.MODO]: '' })), null, 'sin modo');
    const conFolio = F.estado({ pendiente: { tipo: 'recepcion', menu: 'botones' } }); conFolio.folio = 'X'; conFolio.hechos.confirmado = true;
    assert.equal(preparar('botones', conFolio), null, 'tras el pedido');
    assert.equal(preparar('botones', undefined, cfgModo(), 'otro texto'), null, 'texto distinto del diálogo');
    assert.equal(preparar('botones', F.estado({ pendiente: { tipo: 'agregar_otro' } })), null, 'otro pendiente');
  });
  await caso('BL2 inicio Mapo: tres opciones en modo formulario y compatibilidad con los menús anteriores', () => {
    const e = F.estado({ pendiente: { tipo: 'inicio_mapo' } });
    const filas = (cfg) => construirInicioMapo({ estado: e, pedido: { huella: 'h', total: 0 }, texto: 'Elige', cfg, telefono: T })
      .carga.action.sections[0].rows.map((r) => r.title);
    assert.deepEqual(filas(cfgModo()), ['Ordenar ahora', 'Eventos y catering', 'Hablar con una persona']);
    assert.deepEqual(filas(cfgModo({ [CLAVES_IA.MODO]: '' })), OPCIONES_MAPO.map((o) => o.title));
    const q = (valor) => ({ accion: 'menu_mapo', datos: { valor } });
    for (const valor of ['ordenar', 'evento', 'humano', 'facturacion']) {
      assert.equal(asociacionMapoVigente(q(valor), { estado: vacio(), cfg: cfgModo(), telefono: T }), true);
    }
    assert.equal(asociacionMapoVigente(q('informacion'), { estado: vacio(), cfg: cfgModo(), telefono: T }), true);
    assert.equal(asociacionMapoVigente(q('info:horario'), { estado: vacio(), cfg: cfgModo(), telefono: T }), true);
    assert.equal(asociacionMapoVigente(q('informacion'), { estado: vacio(), cfg: cfgModo({ [CLAVES_IA.MODO]: '' }), telefono: T }), false);
    assert.equal(asociacionMapoVigente(q('info:../x'), { estado: vacio(), cfg: cfgModo(), telefono: T }), false);
  });
  await caso('BL3 toques: «Información», un tema (con y sin carrito), tema que ya no existe y botón vencido', async () => {
    const { entradas } = catalogo();
    const toque = (valor, estado = vacio(), extra = {}) => R.respuestaDeToqueRecepcion({ valor, estado, entradas,
      lectores: { promocionesOficiales: async () => 'Hoy: 2x1.' }, ...extra });
    assert.deepEqual((await toque('informacion')).respuesta.pendiente, { tipo: 'recepcion', menu: 'informacion' });
    assert.deepEqual((await toque('mas_preguntas')).respuesta.pendiente, { tipo: 'recepcion', menu: 'informacion_2' });
    const h = await toque('info:horario');
    assert.match(h.respuesta.texto, /^\*Horario\*/); assert.deepEqual(h.respuesta.pendiente, BOTONES); assert.equal(h.formulario, null);
    const hc = await toque('info:horario', conCarrito());
    assert.deepEqual(hc.respuesta.pendiente, { tipo: 'editar_pedido' }); assert.equal(hc.formulario.cta, 'Continuar pedido');
    assert.equal((await toque('info:promociones')).respuesta.texto, 'Hoy: 2x1.');
    const viejo = await toque('info:faq:00000000');
    assert.equal(viejo.respuesta.texto, FRASES.INFO_CAMBIO); assert.deepEqual(viejo.respuesta.pendiente, { tipo: 'recepcion', menu: 'informacion' });
    assert.equal((await toque('info:horario', vacio(), { cerrado: true })).respuesta.pendiente, null, 'cerrado: sin botones');
    const vencido = await toque('ordenar', vacio(), { vencido: true });
    assert.equal(vencido.respuesta.texto, FRASES.MENU_CAMBIO); assert.deepEqual(vencido.respuesta.pendiente, BOTONES);
  });

  // ── formularioDePedidoPosible ⇔ construirFormulario ────────────────────
  await caso('FP formularioDePedidoPosible equivale a construirFormulario real (escenarios de la plomería)', async () => {
    let n = 0;
    for (const cfg of [F.cfgHoy, F.cfgTienda('true'), F.cfgTienda('prueba'), { ...F.cfgHoy, whatsapp_carrito_unificado_v1: 'false' },
      { ...F.cfgHoy, whatsapp_flows_v1: 'false' }]) {
      for (const [escenario, , mk] of F.ESCENARIOS) {
        for (const tel of [T, F.OTRO_TELEFONO]) {
          const e = mk();
          const ctx = { catalogo: CARTA, modalidades: F.modalidades, metodosPago: F.metodosPago, reglas: F.reglas, cfg, telefono: tel };
          const pendiente = e.carrito.items.length ? { tipo: 'editar_pedido' } : { tipo: 'agregar_otro' };
          const real = { ...structuredClone(e), pendiente, dialogo: { ...e.dialogo, ciclo: e.conversacionId, texto: 'T' } };
          const esperado = !!construirFormulario({ ...ctx, estado: real, pedido: { huella: 'h', total: 1 }, texto: 'T' });
          assert.equal(formularioDePedidoPosible({ ...ctx, estado: e }), esperado, `${escenario} ${tel}`);
          n++;
        }
      }
    }
    assert(n >= 100);
  });

  // ── El turno del Mesero con `recepcion` ────────────────────────────────
  const PRECIOS = preciosDelCatalogo(CARTA);
  async function turno(mensaje, estado, { recepcion = true, efectos = null } = {}) {
    let llamadas = 0;
    const s = await atenderTurnoConHerramientas({ negocioId: 'n', conversacionId: estado.conversacionId, turnoId: `t-${Math.random()}`,
      mensaje, catalogo: CARTA, precios: PRECIOS, modalidades: F.modalidades, metodosPago: F.metodosPago, reglas: F.reglas, estado,
      recepcion, efectos, llamarModelo: async () => { llamadas++; throw new Error('EL_MODELO_NO_SE_LLAMA'); } });
    return { s, llamadas };
  }
  const conResumen = () => {
    const e = F.estado({ pendiente: null, items: [structuredClone(CAFE)], entrega: { modalidad: 'recoger en tienda', forma_pago: 'efectivo' } });
    const v = crearEjecutor({ estado: e, catalogo: CARTA, precios: PRECIOS, modalidades: F.modalidades, metodosPago: F.metodosPago, mensaje: '' }).vista();
    e.dialogo = { id: 'd1', ciclo: e.conversacionId, tipo: 'resumen', huella: v.huella, texto: 'Resumen\n¿Confirmas este pedido?', enviado: true };
    fijarPendiente(e, { tipo: 'confirmar_resumen', huella: v.huella }, { dialogoId: 'd1' });
    return e;
  };
  await caso('TM1 D1: cancelar el borrador por texto sigue funcionando (sin modelo)', async () => {
    const { s, llamadas } = await turno('cancela mi pedido', conCarrito());
    assert.equal(llamadas, 0); assert.equal(s.estado.hechos.cancelado, true); assert.equal(s.estado.carrito.items.length, 0);
    assert(s.operaciones.some((o) => o.herramienta === 'cancelar_pedido' && o.resultado?.aplicado));
  });
  await caso('TM2 D2: «sí» confirma el resumen ligado a su huella (sin modelo)', async () => {
    const registrados = [];
    const { s, llamadas } = await turno('sí', conResumen(), { efectos: { confirmar: async ({ pedido }) => { registrados.push(pedido.total); return { ok: true, folio: 'XAB-9' }; } } });
    assert.equal(llamadas, 0); assert.deepEqual(registrados, [45]); assert.equal(s.estado.folio, 'XAB-9');
    const otro = conResumen(); otro.pendiente.huella = 'otra';
    const r = await turno('sí', otro, { efectos: { confirmar: async () => { throw new Error('no debe registrar'); } } });
    assert.equal(r.s.estado.hechos.confirmado, false, 'otra huella confirmó');
  });
  await caso('TM3 B6: «no» al resumen → formulario de edición (sin «¿qué te gustaría cambiar?»)', async () => {
    const { s, llamadas } = await turno('no', conResumen());
    assert.equal(llamadas, 0); assert.equal(s.texto, FRASES.CAMBIAR.trim());
    assert.deepEqual(s.recepcionFormulario, { aviso: FRASES.CAMBIAR }); assert.equal(s.estado.pendiente?.tipo, 'editar_pedido');
  });
  // Ni siquiera se INTENTA una herramienta: el corte del turno va antes que el
  // candado C1 (si el corte faltara, C1 rechazaría el intento y el carrito
  // seguiría igual: por eso se mira el intento, no solo el resultado).
  const sinMutar = (s, n) => {
    assert.deepEqual(s.operaciones.map((o) => o.herramienta), [], 'se intentó una herramienta');
    assert.equal(s.estado.carrito.items.length, n, 'el carrito cambió');
  };
  await caso('TM4 B2: «agrega otro» no deja «¿qué te gustaría agregar?»', async () => {
    const { s, llamadas } = await turno('agrega otro', conCarrito());
    assert.equal(llamadas, 0); assert.equal(s.texto, FRASES.NO_RECONOCIDO); assert.deepEqual(s.estado.pendiente?.tipo, 'recepcion'); sinMutar(s, 2);
  });
  await caso('TM5 B3: elegir producto pendiente + texto no agrega', async () => {
    const e = conPendiente({ tipo: 'elegir_producto', ciclo: 'c', solicitud: 'un taco', nombre: 'taco', cantidad: 1,
      candidatos: [{ id: '5', nombre: 'Taco de Barbacoa' }, { id: '6', nombre: 'Taco de Pastor' }] }, 'vacio');
    // «pastor con harina» SÍ lo resolvería resolverSeleccion (sin recepcion se agrega).
    const { s, llamadas } = await turno('pastor con harina', e);
    assert.equal(llamadas, 0); sinMutar(s, 0); assert.equal(s.texto, FRASES.NO_RECONOCIDO);
  });
  await caso('TM6 B4: un platillo ambiguo no abre la selección', async () => {
    const { s } = await turno('un taco', vacio());
    assert.notEqual(s.estado.pendiente?.tipo, 'elegir_producto'); sinMutar(s, 0);
  });
  await caso('TM7 B5: «sí» a una oferta de producto o de pago no agrega; la modalidad escrita no se define', async () => {
    const oferta = conPendiente({ tipo: 'aceptar_producto', producto_id: '3', producto: 'Café americano' }, 'vacio');
    sinMutar((await turno('sí', oferta)).s, 0);
    const pago = conPendiente({ tipo: 'aceptar_pago_ofrecido', forma_pago: 'efectivo' });
    const r = await turno('sí', pago); sinMutar(r.s, 2); assert(!r.s.estado.carrito.datos.forma_pago);
    const mod = await turno('a domicilio', conPendiente({ tipo: 'modalidad', opciones: F.modalidades }));
    sinMutar(mod.s, 2); assert(!mod.s.estado.carrito.datos.modalidad);
  });
  await caso('TM8 B7/B8: opciones por texto no modifican renglones', async () => {
    const e = conPendiente({ tipo: 'elegir_opcion', linea_id: 'L1', grupo: 'Salsa', producto: 'Chilaquiles', candidatos: ['Roja', 'Verde', 'Chipotle'] });
    const antes = JSON.stringify(e.carrito.items);
    const { s, llamadas } = await turno('chipotle', e);
    assert.equal(llamadas, 0); assert.equal(JSON.stringify(s.estado.carrito.items), antes);
  });
  await caso('TM9 B9: nada llega al modelo; sin recepcion sí llega (la prueba distingue)', async () => {
    for (const m of ['quiero dos chilaquiles verdes con pollo', 'mejor quita el café', 'pago en efectivo', 'para mañana a las 10', 'asdf']) {
      const { s, llamadas } = await turno(m, conCarrito());
      assert.equal(llamadas, 0, m); sinMutar(s, 2);
    }
    assert((await turno('quiero dos chilaquiles verdes con pollo', conCarrito(), { recepcion: false })).llamadas > 0);
  });
  await caso('TM10 B10: con recepcion la prosa del modelo nunca deja «aceptar producto»', async () => {
    // Inalcanzable mientras B9 corte el bucle (el modelo no se llama): un modelo
    // guionado que busca un producto y lo ofrece en prosa no cambia nada.
    let llamadas = 0;
    const e = vacio();
    const s = await atenderTurnoConHerramientas({ negocioId: 'n', conversacionId: e.conversacionId, turnoId: 't-b10', mensaje: '¿tienen café?',
      catalogo: CARTA, precios: PRECIOS, modalidades: F.modalidades, metodosPago: F.metodosPago, reglas: F.reglas, estado: e, recepcion: true,
      llamarModelo: async () => { llamadas++;
        return llamadas === 1 ? { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'b1', name: 'buscar_producto', input: { texto: 'café americano' } }] }
          : { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Tenemos Café americano a $45. ¿Te lo agrego?' }] }; } });
    assert.notEqual(s.estado.pendiente?.tipo, 'aceptar_producto');
  });
  await caso('TM11 respuesta de sistema desdePedido: sin pregunta, el texto apunta al formulario y deja su pendiente', async () => {
    const r = await atenderTurnoConHerramientas({ negocioId: 'n', conversacionId: 'c', turnoId: 't-dp', mensaje: '', catalogo: CARTA, precios: PRECIOS,
      modalidades: F.modalidades, metodosPago: F.metodosPago, reglas: F.reglas, estado: vacio(), recepcion: true,
      respuestaDeSistema: { tipo: 'boton_desactualizado', desdePedido: true, sinSaludo: true, texto: 'Aviso.\n', acciones: [] },
      llamarModelo: async () => { throw new Error('no'); } });
    assert.equal(r.texto, `Aviso.\n${FRASES.ELIGE_EN_MENU}`); assert.equal(r.estado.pendiente?.tipo, 'agregar_otro');
  });
  await caso('TM12 B12: «sí» a un resumen que ya no vale (carrito vacío) → «Elige tus platillos» con su formulario, nunca «¿Qué te gustaría pedir?»', async () => {
    const e = conResumen();
    e.carrito.items = [];
    const { s, llamadas } = await turno('sí', e, { efectos: { confirmar: async () => { throw new Error('no debe registrar'); } } });
    assert.equal(llamadas, 0); assert.equal(s.estado.hechos.confirmado, false);
    assert.match(s.texto, /Elige tus platillos en el menú\. 👇$/); assert(!/¿Qué te gustaría pedir\?/.test(s.texto), s.texto);
    assert.equal(s.estado.pendiente?.tipo, 'agregar_otro');
    // Sin recepcion, el texto de hoy (la prueba distingue).
    const hoy = conResumen(); hoy.carrito.items = [];
    assert.match((await turno('sí', hoy, { recepcion: false, efectos: { confirmar: async () => { throw new Error('no'); } } })).s.texto,
      /¿Qué te gustaría pedir\?$/);
  });

  // ── C1 ─────────────────────────────────────────────────────────────────
  await caso('C1 el ejecutor con recepcion rechaza mutaciones sin elección validada; con accionInteractiva aplica', async () => {
    const e = vacio();
    const ej = crearEjecutor({ estado: e, catalogo: CARTA, precios: PRECIOS, mensaje: 'un café americano', recepcion: true,
      modalidades: F.modalidades, metodosPago: F.metodosPago });
    const r = await ej.ejecutar('agregar_producto', { producto_id: '3', cantidad: 1 });
    assert.equal(r.aplicado, false); assert.match(r.motivo, /recepcion_solo_formulario/); assert.equal(e.carrito.items.length, 0);
    const a = accionInteractiva('agregar_producto', { producto_id: '3', cantidad: 1 }, e);
    assert.equal((await ej.ejecutar(a.herramienta, a.argumentos, { autorizacion: a.autorizacion })).aplicado, true);
    const c = crearEjecutor({ estado: conCarrito(), catalogo: CARTA, precios: PRECIOS, mensaje: 'cancela mi pedido', recepcion: true });
    assert.match((await c.ejecutar('cancelar_pedido', { motivo: 'x' })).motivo, /recepcion_solo_formulario/, 'cancelar sin D1');
    const d = crearEjecutor({ estado: conCarrito(), catalogo: CARTA, precios: PRECIOS, mensaje: 'cancela mi pedido', recepcion: true });
    assert.equal((await d.ejecutar('cancelar_pedido', { motivo: 'x' }, { autorizacion: { tipo: 'cancelacion_explicita' } })).aplicado, true, 'D1');
  });
  await caso('C1b cancelar el borrador por texto en modo formulario (el turno lleva la autorización de D1)', async () => {
    const { s } = await turno('cancela mi pedido', conCarrito());
    assert(s.operaciones.some((o) => o.herramienta === 'cancelar_pedido' && o.resultado?.aplicado), JSON.stringify(s.operaciones.map((o) => o.resultado?.motivo)));
  });

  // ── Variantes de texto y frases ────────────────────────────────────────
  await caso('V1 variantes: programado con tienda/sin tienda y respuestaDesdePedido con recepcion; sin recepcion, los de hoy', () => {
    assert.deepEqual(respuestaAPedidoProgramado({ configTienda: TIENDA, recepcion: true }), { escalar: false, texto: FRASES.PROGRAMADO_TIENDA(URL_TIENDA) });
    assert.deepEqual(respuestaAPedidoProgramado({ configTienda: null, recepcion: true }), { escalar: true, texto: FRASES.PERSONA_PROGRAMADO });
    assert.match(respuestaAPedidoProgramado({ configTienda: TIENDA }).texto, /te lo anoto/);
    const vista = { lineas: [], falta: [], aclaraciones: [], total: 0 };
    assert.equal(respuestaDesdePedido({ estado: vacio(), pedido: vista, recepcion: true }), FRASES.ELIGE_EN_MENU);
    assert.equal(respuestaDesdePedido({ estado: vacio(), pedido: vista }), '¿Qué te gustaría pedir?');
  });
  await caso('V2 ninguna frase invita a escribir el pedido ni afirma un cambio; todas caben', async () => {
    const { respuestaAfirmaCambioSinAplicar } = await import('../src/mesero-agente/seguridadConversacional.js');
    const INVITA = /\b((?<!\bte )(?<!\ble )escr[ií]be(me|nos)?|d[ií]me|cu[eé]ntame|me dices|qu[eé] (te gustar[ií]a|se te antoja|deseas) (pedir|ordenar|agregar)|te lo anoto|anoto)\b/i;
    for (const [k, v] of Object.entries(FRASES)) {
      const t = typeof v === 'function' ? v(URL_TIENDA) : v;
      assert(!INVITA.test(k === 'PEDIDO_ESCRITO' ? t.replace('«no abre»', '') : t), k);
      assert(!respuestaAfirmaCambioSinAplicar({ texto: t, operaciones: [] }), k);
      assert(t.length <= 1024, k);
    }
    assert.equal(TEXTOS_PERSONA.length, 11);
  });

  // ── P3 y el pendiente que caduca ───────────────────────────────────────
  await caso('P3 los motivos del modo vencen como petición, salvo la queja de dinero', () => {
    for (const m of Object.values(MOTIVOS_RECEPCION)) {
      assert.equal(grupoDelMotivo(m), m === 'RECEPCION_QUEJA_PAGO' ? null : 'peticion', m);
    }
  });
  await caso('PC el pendiente «recepcion» vence a los 30 minutos (flujos que caducan) y no altera pendientes de hoy', () => {
    const e = vacio(); fijarPendiente(e, { tipo: 'recepcion', menu: 'botones' });
    e._actualizadoAt = new Date(Date.now() - 40 * 60000).toISOString(); e._inactividadMs = 40 * 60000;
    assert.equal(flujoAbiertoVencido(e), true);
    assert.equal(cicloParaTurno(e, 'hola', { flujosCaducan: true }).pendiente, null);
    const reciente = vacio(); fijarPendiente(reciente, { tipo: 'recepcion', menu: 'informacion' });
    reciente._actualizadoAt = new Date().toISOString(); reciente._inactividadMs = 60000;
    assert.equal(flujoAbiertoVencido(reciente), false);
    assert.throws(() => fijarPendiente(vacio(), { tipo: 'recepcion', menu: 'otro' }), /pendiente_invalido/);
  });
} finally {
  console.log(`\nmodo formulario (pura): ${pasadas} pasadas, ${fallidas} fallidas`);
  if (fallidas) process.exitCode = 1;
}
