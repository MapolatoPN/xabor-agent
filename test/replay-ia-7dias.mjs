// ─── MODO FORMULARIO / RECEPCIONISTA SOBRE 7 DÍAS DE CONVERSACIONES REALES ──
//
// Corre el router de recepción (recepcionista.js) sobre cada mensaje de
// cliente del volcado de 7 días de Mapolato Obispado (el del análisis del
// 3-oct), en modo «formulario» y en modo «recepcionista» (selector guionado
// que además «escribe» texto, para comprobar que nunca sale), y escribe la
// tabla de rutas por caso. Pura y OFFLINE: el volcado NO vive en el repo (son
// conversaciones de clientes); se pasa por CONVERSACIONES_7D. Sin él, la suite
// se omite y lo dice.
//
// Aserciones:
//   · ningún turno produce texto del modelo ni acciones (nada muta el pedido);
//   · todo texto que saldría es uno aprobado (frases fijas, respuestas de la
//     configuración, datos de la carta, estado del pedido, acuse de cerrado);
//   · los casos que nombra el análisis caen en la ruta esperada (tabla abajo).
//
// El estado de cada conversación se reconstruye de lo que se ve en el volcado:
// carrito tras un formulario de carrito, resumen pendiente tras «Revisa tu
// pedido», folio tras «quedó registrado», último saliente (bot o personal)
// para R0, formulario de pedido reciente (y ya enviado: «Formulario recibido»)
// para la regla de 30 minutos y la hora local para el cerrado. El pendiente
// que deja cada decisión del router se conserva para el turno siguiente.
//
// Lo que corre ANTES del modo también se simula (revisión 3), para que la tabla
// se parezca a producción:
//   · el inicio Mapo contesta los saludos con el estado libre y sin carrito;
//   · una FOTO SIN TEXTO la contesta whatsapp-meta.js con TEXTO_FALLBACK_IMAGEN
//     (archivo protegido) y nunca llega al modo: paso «P-1». Con VISION=1 se
//     simula vision_imagenes=true (la foto llega con su descripción: R2).
// El atajo de estado de whatsapp-meta.js («mi pedido», «cuánto falta») NO se
// simula: ese texto llega aquí al router.
//
// La carta: la de prueba de Obispado (3 categorías), o la publicada en WhatsApp
// si se pasa CARTA_7D (carta-obispado.json, sin datos de clientes): con ella
// los pedidos escritos de tacos o hot cakes se reconocen como en producción.
//
//   CONVERSACIONES_7D=…/conversaciones-7d.json [CARTA_7D=…/carta-obispado.json] [VISION=1] [SALIDA=tabla.tsv]
//     node test/replay-ia-7dias.mjs
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as R from '../src/mesero-agente/recepcionista.js';
import * as RF from '../src/mesero-agente/respuestasFijas.js';
import * as S from '../src/mesero-agente/selectorRecepcionista.js';
import { NEGOCIOS } from './replay/cartas.mjs';
import { estadoNuevo } from '../src/mesero-agente/ejecutorDeHerramientas.js';
import { cicloParaTurno } from '../src/mesero-agente/cicloDelAgente.js';
import { textosDelRecibo } from '../src/mesero-agente/reciboHandoff.js';
import { entradaMapo } from '../src/mesero-agente/inicioMapo.js';
import { NOTA_IMAGEN_PARA_IA } from '../src/utils/turnoImagen.js';
import * as F from '../scripts/fixture-tienda-plomeria.mjs';

Object.assign(process.env, { WHATSAPP_INTERACTIVOS: 'true', MESERO_AGENTE_MODE: 'true', WHATSAPP_FLOW_ENDPOINT: 'true',
  WHATSAPP_FLOW_PRIVATE_KEY: 'x', META_APP_SECRET: 'x' });

const ARCHIVO = process.env.CONVERSACIONES_7D;
if (!ARCHIVO || !existsSync(ARCHIVO)) {
  console.log('OMITIDA replay-ia-7dias: falta CONVERSACIONES_7D (el volcado de conversaciones no vive en el repositorio)');
  process.exit(0);
}

let pasadas = 0, fallidas = 0;
const t = async (nombre, fn) => {
  try { await fn(); pasadas++; console.log(`  ok  ${nombre}`); }
  catch (e) { fallidas++; console.log(`FALLA ${nombre}: ${String(e.message).split('\n').slice(0, 6).join(' | ')}`); }
};

// La configuración de Obispado del 3-oct (después del ajuste de horario, tiempos y mesas).
const DIAS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'];
const REGLAS = { restaurante: 'Mapolato Obispado', timezone: 'America/Matamoros',
  horarios: Object.fromEntries(DIAS.map((d) => [d, { abierto: true, apertura: '07:30', cierre: '15:00' }])),
  pedidos: { modalidades: ['recoger en tienda', 'entrega a domicilio'], costo_envio: 60, pedido_minimo_entrega: 0,
    tiempo_entrega_min_minutos: 45, tiempo_entrega_max_minutos: 45, tiempo_preparacion_minutos: 25, pago_instrucciones: '',
    zonas_entrega: [{ nombre: 'UTNC', costo: 150 }, { nombre: 'Cervecera', costo: 150 }, { nombre: 'Coca Cola', costo: 120 },
      { nombre: 'Cartonera', costo: 120 }, { nombre: 'COMISION FEDERAL / CARBON 2', costo: 200 }, { nombre: 'Escuela Ciencias de la Salud', costo: 70 }] },
  cierres_especiales: [], promociones: [], politicas: [],
  bot: { faqs: [{ pregunta: '¿Tienen mesas? ¿Puedo comer en el local o reservar?',
    respuesta: 'Para información más rápida y confiable, por favor márcanos al 8781042714' }], palabras_criticas: [] } };
const METODOS = [{ tipo: 'efectivo' }, { tipo: 'terminal' }, { tipo: 'enlace_pago' }];
const TIENDA = { estado: 'publicada', aceptaProgramados: true, slug: 'mapolato-obispado' };
// La carta publicada (CARTA_7D: [{ nombre, platillos: [{ nombre, precio, descripcion }] }]) o la de prueba.
const CARTA_REAL = process.env.CARTA_7D && existsSync(process.env.CARTA_7D);
const CARTA = CARTA_REAL
  ? (() => { let id = 1000; return JSON.parse(readFileSync(process.env.CARTA_7D, 'utf8')).map((c, i) => ({ id: i + 1, nombre: c.nombre,
    productos: (c.platillos || []).map((p, j) => ({ id: id++, nombre: p.nombre, precio: p.precio, descripcion: p.descripcion || '',
      disponible: true, orden: j, modificadores: [] })) })); })()
  : NEGOCIOS.obispado.catalogo;
const VISION = process.env.VISION === '1';
const cfgDe = (modo) => ({ ...F.cfgTienda('true'), whatsapp_interactivos_v1: 'true', whatsapp_interactivos_elecciones_v1: 'true',
  whatsapp_rescate_humano_v1: 'true', whatsapp_beta_hibrido_v1: 'true', whatsapp_eventos_formulario_v1: 'true',
  whatsapp_flow_evento_id: '77777777777', direccion: 'Libramiento Manuel Pérez Treviño 2416, Colonia Tecnológico', ciudad: 'Piedras Negras',
  whatsapp_ia_modo_v1: modo, whatsapp_ia_modo_alcance: 'todos', whatsapp_ia_selector_publicar: 'true' });
const ENTRADAS = RF.catalogoDeRespuestas({ reglas: REGLAS, cfg: cfgDe('formulario'), metodosPago: METODOS,
  modalidades: REGLAS.pedidos.modalidades, estadoRestaurante: { abierto: true } }).entradas;

// La hora local de Obispado (America/Matamoros sigue el horario de verano de EE. UU.).
const local = (iso) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Matamoros', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'long' }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  const dia = { monday: 'lunes', tuesday: 'martes', wednesday: 'miercoles', thursday: 'jueves', friday: 'viernes', saturday: 'sabado', sunday: 'domingo' }[p.weekday.toLowerCase()];
  const min = Number(p.hour) * 60 + Number(p.minute);
  return { dia, fecha: `${p.year}-${p.month}-${p.day}`, min };
};
const estadoRestaurante = (iso) => {
  const { dia, fecha, min } = local(iso);
  const abierto = min >= 7 * 60 + 30 && min < 15 * 60;
  return { abierto, diaActual: dia, fechaHoy: fecha, preApertura: min < 7 * 60 + 30 };
};

// El selector guionado del modo recepcionista: elige con reglas tontas y además
// «escribe» texto, que nunca debe salir.
const TEXTO_DEL_MODELO = 'TEXTO_DEL_MODELO_no_debe_salir';
const modeloGuionado = async (p) => {
  const m = p.messages[0].content.toLowerCase();
  const decision = /factura|queja|cobr/.test(m) ? 'persona' : /promo/.test(m) ? 'promociones' : /abren|cierran|horario/.test(m) ? 'horario'
    : /direcci|ubicaci|donde/.test(m) ? 'ubicacion' : /pedido|orden|quiero/.test(m) ? 'pedido' : 'ninguna';
  return { stop_reason: 'tool_use', content: [{ type: 'text', text: TEXTO_DEL_MODELO },
    { type: 'tool_use', id: 't', name: 'elegir', input: { decision, confianza: 'alta' } }] };
};

const FORM_DE_PEDIDO = /^\*(?:Tu carrito|Arma tu pedido|Elige tus platillos)\*|Arma tu pedido\*/;
const esToque = (x) => /^▸ |^Formulario recibido · pendiente de validación$/.test(String(x).trim());
const minutos = (a, b) => (Date.parse(b) - Date.parse(a)) / 60000;
const PAUSA_MIN = 90;

/** Los turnos de una conversación: mensajes de cliente seguidos (≤ 10 s) en uno, como la cola de 6 s. */
function turnosDe(conversacion) {
  const salida = [];
  let lote = null;
  for (const m of conversacion.mensajes) {
    if (m.d !== 'entrante') { lote = null; salida.push({ saliente: m }); continue; }
    if (m.t === 'documento' || (m.t === 'texto' && esToque(m.x))) { lote = null; salida.push({ toque: m }); continue; }
    const pie = m.t === 'imagen' ? m.x.replace(/^📷\s*(Imagen(?: recibida)?)?\s*/, '').trim() : null;
    const texto = m.t === 'imagen' ? `${pie} ${NOTA_IMAGEN_PARA_IA}`.trim() : m.x;
    // Una foto sin texto (sola en su lote) es la «foto muda» de whatsapp-meta.js.
    const muda = m.t === 'imagen' && !pie;
    if (lote && minutos(lote.ts, m.ts) <= 10 / 60) { lote.texto += `\n${texto}`; lote.ts = m.ts; lote.muda = lote.muda && muda; continue; }
    lote = { texto, ts: m.ts, primero: m.ts, muda };
    salida.push({ cliente: lote });
  }
  return salida;
}

async function correr(conversacion, modo) {
  const cfg = cfgDe(modo);
  const filas = [];
  let estado = estadoNuevo({ negocioId: 'obispado', conversacionId: `agente:${conversacion.cliente}` });
  let ultimoSaliente = null, ultimoFormulario = null, pausaDesde = null, ultimoHumano = null;
  let i = 0;
  for (const paso of turnosDe(conversacion)) {
    if (paso.saliente) {
      ultimoSaliente = paso.saliente;
      if (paso.saliente.o === 'humano') ultimoHumano = paso.saliente.ts;
      const x = String(paso.saliente.x);
      if (paso.saliente.o === 'bot' && FORM_DE_PEDIDO.test(x)) {
        ultimoFormulario = paso.saliente.ts;
        estado.pendiente = { tipo: estado.carrito.items.length ? 'editar_pedido' : 'agregar_otro' };
      }
      if (paso.saliente.o === 'bot' && /^\*Tu carrito\*|^\*Revisa tu pedido\*/m.test(x) && !estado.carrito.items.length) {
        estado.carrito.items = [{ lid: 'L1', id: 1, nombre: 'Chilaquiles Sencillos', cantidad: 1, modificadores: [], notas: '' }];
      }
      if (paso.saliente.o === 'bot' && /^\*Revisa tu pedido\*/m.test(x)) estado.pendiente = { tipo: 'confirmar_resumen', huella: 'h' };
      const folio = /Tu pedido (XAB-\d+) quedó registrado/.exec(x)?.[1];
      if (folio) { estado.folio = folio; estado.hechos = { ...estado.hechos, confirmado: true }; estado.terminadoEn = paso.saliente.ts; estado.pendiente = null; }
      continue;
    }
    if (paso.toque) {
      // Un formulario ENVIADO ya no cuenta para la regla de los 30 minutos (revisión 3).
      if (/^Formulario recibido/.test(String(paso.toque.x).trim())) ultimoFormulario = null;
      continue;
    }
    const { texto, ts, muda } = paso.cliente;
    i++;
    // Tras pasar a una persona la conversación queda en pausa: el bot no la ve.
    // La pausa vence sola (P3) tras un rato sin el personal; aquí, 90 minutos
    // desde lo último del personal (c33c16f63: el bot volvió a contestar 107
    // minutos después del mensaje del personal).
    if (pausaDesde && minutos(new Date(Math.max(Date.parse(pausaDesde), Date.parse(ultimoHumano || pausaDesde))).toISOString(), ts) < PAUSA_MIN) {
      filas.push({ caso: conversacion.cliente, turno: i, modo, ts, paso: '-', tipo: 'pausado', ruta: 'pausado', motivo: '', texto: '',
        acciones: [], selector: null, entrada: texto });
      continue;
    }
    // Lo que corre antes del modo (revisión 3): la foto muda la contesta
    // whatsapp-meta.js (archivo protegido) sin visión; nunca llega al modo.
    if (muda && !VISION) {
      filas.push({ caso: conversacion.cliente, turno: i, modo, ts, paso: 'P-1', tipo: 'foto_sin_texto', ruta: 'whatsapp-meta', motivo: '',
        texto: '', acciones: [], selector: null, entrada: texto });
      ultimoSaliente = { o: 'bot', ts, x: 'TEXTO_FALLBACK_IMAGEN' };
      continue;
    }
    // El ciclo de la conversación, como el canal: un pedido confirmado se cierra
    // por tiempo o porque el cliente pide otro.
    const recepcion = estado.recepcion;
    estado = cicloParaTurno({ ...estado, _actualizadoAt: estado._actualizadoAt || ts }, texto, { ahora: new Date(ts), zona: 'America/Matamoros' });
    if (recepcion && !estado.recepcion && estado.conversacionId === `agente:${conversacion.cliente}`) estado.recepcion = recepcion;
    const ia = R.modoIA(cfg, F.TELEFONO);
    const er = estadoRestaurante(ts);
    // El inicio Mapo (canalDelAgente.js): tras R0 y con el local abierto, un
    // saludo con el estado libre y sin carrito recibe el menú de inicio.
    const silencio = await R.decidirSilencio({ ia, mensaje: texto, lectores: { ultimoSaliente: async () => (ultimoSaliente
      ? { origen: ultimoSaliente.o === 'humano' ? 'humano' : 'bot', minutos: minutos(ultimoSaliente.ts, ts), liberadaDespues: false } : null) } });
    const mapo = !silencio && er.abierto ? entradaMapo({ cfg, estado, mensaje: texto, zona: 'America/Matamoros', ahora: new Date(ts),
      nombreNegocio: REGLAS.restaurante }) : null;
    if (mapo) {
      filas.push({ caso: conversacion.cliente, turno: i, modo, ts, paso: 'Mapo', tipo: 'inicio_mapo', ruta: 'respuesta', motivo: '',
        texto: mapo.texto, acciones: mapo.acciones || [], selector: null, entrada: texto });
      estado.pendiente = { tipo: 'inicio_mapo' };
      ultimoSaliente = { o: 'bot', ts, x: mapo.texto };
      estado._actualizadoAt = ts;
      continue;
    }
    const d = await R.decidirRecepcion({ ia, cfg, reglas: REGLAS, estado, mensaje: texto, catalogo: CARTA, metodosPago: METODOS,
      modalidades: REGLAS.pedidos.modalidades, configTienda: TIENDA, estadoRestaurante: er, negocioId: 'obispado',
      telefono: F.TELEFONO, entradas: ENTRADAS, ahora: Date.parse(ts),
      elegir: modo === 'recepcionista' ? (m, e) => S.elegirRespuesta({ mensaje: m, entradas: e, nombreNegocio: 'Mapolato', llamarModelo: modeloGuionado }) : null,
      lectores: {
        ultimoSaliente: async () => (ultimoSaliente ? { origen: ultimoSaliente.o === 'humano' ? 'humano' : 'bot',
          minutos: minutos(ultimoSaliente.ts, ts), liberadaDespues: false } : null),
        pedidosActivos: async () => (estado.folio ? [{ folio: estado.folio, estado: 'nuevo', modalidad: 'entrega a domicilio' }] : []),
        formularioReciente: async () => !!ultimoFormulario && minutos(ultimoFormulario, ts) < 30,
        formularioRescate: async () => !!ultimoFormulario && minutos(ultimoFormulario, ts) < 30,
        estadoOperativo: async (folio) => ({ folio, estado: 'nuevo', modalidad: 'entrega a domicilio' }),
        promocionesOficiales: async () => 'Hoy: promoción del día (texto oficial).',
      } });
    filas.push({ caso: conversacion.cliente, turno: i, modo, ts, paso: d.recepcion.paso, tipo: d.recepcion.tipo, ruta: d.ruta,
      motivo: d.persona?.motivo || d.alerta?.motivo || '', texto: d.respuesta?.texto || '', acciones: d.respuesta?.acciones || [],
      selector: d.recepcion.selector, entrada: texto });
    // Lo que el canal guarda del turno (la cuenta de «no te entendí», el cerrado
    // y el pendiente que deja la respuesta).
    if (d.ruta !== 'silencio') {
      if (d.estadoRecepcion) estado.recepcion = d.estadoRecepcion; else delete estado.recepcion;
      if (d.ruta !== 'turno' && d.ruta !== 'existente') estado.pendiente = d.respuesta?.pendiente ?? null;
    }
    if (d.ruta === 'persona' || d.alerta) pausaDesde = ts;
    // Lo que el bot mandó cuenta como su último saliente (R0) y, si fue un
    // formulario de pedido, para la regla de los 30 minutos (R10).
    if (d.ruta !== 'silencio') ultimoSaliente = { o: 'bot', ts, x: d.respuesta?.texto || '' };
    if (d.ruta === 'formulario' || ['agregar_otro', 'editar_pedido'].includes(d.respuesta?.pendiente?.tipo)) ultimoFormulario = ts;
    estado._actualizadoAt = ts;
  }
  return filas;
}

// Lo que puede salir: las frases fijas, las respuestas de la configuración, los
// datos de la carta, el estado del pedido, el acuse de cerrado y los textos de persona.
const aprobado = (texto) => {
  if (!texto) return true;
  const fijas = Object.values(R.FRASES).map((v) => (typeof v === 'function' ? null : v.trim())).filter(Boolean);
  return fijas.includes(texto.trim()) || textosDelRecibo(true).includes(texto) || texto === R.NO_RECONOCIDO_SIN_BOTONES
    || texto === R.SALUDO_SIN_BOTONES || /^¡Hola, (?:buenos días|buenas tardes|buenas noches)! Soy \*Mapo Bot\*\./.test(texto)
    || ENTRADAS.some((e) => e.texto === texto) || texto === 'Hoy: promoción del día (texto oficial).'
    || texto === R.FRASES.PROGRAMADO_TIENDA('https://xabor.mx/t/mapolato-obispado')
    || /^Sí, en el menú tenemos: |^[^:\n]+: (?:precio base \$\d|[^\n]+\. Precio base: \$\d)/.test(texto)
    || /^Tu pedido XAB-\d+ /.test(texto) || /^Recibimos tu mensaje\. 🙂 Ahora estamos cerrados/.test(texto);
};

// Los casos que nombra el análisis (sus VERIFICACIONES), con la ruta que el
// modo debe darles: [caso, turno de cliente, modo ('*' = los dos), esperado,
// por qué, cuándo]. `cuándo`: 'carta' (solo con CARTA_7D), 'prueba' (solo con
// la carta de prueba), 'vision' / 'sin_vision'; sin él, siempre.
const ESPERADOS = [
  ['c33c16f63', 3, '*', { paso: 'R0', ruta: 'silencio', motivo: '' }, 'C-5: «Si muchas gracias / Ya la recibí» 107 min tras el personal: nada'],
  ['c090529eb', 1, '*', { paso: 'R10', ruta: 'formulario', tipo: 'pedir' }, '«¿podría levantarme un pedido?» → el formulario'],
  ['c090529eb', 2, '*', { paso: 'R0', ruta: 'silencio', motivo: 'RECEPCION_TRAS_PERSONAL' }, 'C-5: «Si porfavor» tras el personal: nada + aviso'],
  ['c3911ff1c', 3, '*', { paso: 'R0', motivo: 'RECEPCION_TRAS_PERSONAL' }, 'C-5: pregunta tras el saludo del personal'],
  // Con la carta publicada, «link de los almuerzos» ya es un pedido (formulario) y
  // «Chilaquiles mixtos» después pasa a una persona: el turno 4 queda en pausa.
  ['c5f957c41', 4, '*', { paso: 'R8', texto: /XAB-1135 .*Tiempo estimado de entrega: unos 45 minutos/ }, 'C-1: «Tiempo de entrega?» con su pedido', 'prueba'],
  ['c1c28839e', 2, '*', { paso: 'R10', motivo: 'RECEPCION_PEDIDO_ESCRITO' }, 'el pedido escrito 2 min después del formulario → persona'],
  ['c6c59387b', 3, '*', { paso: 'R10', motivo: 'RECEPCION_PEDIDO_ESCRITO' }, 'C-2: vuelve a pedir por escrito 15 min después del formulario → persona (no siete carritos)'],
  // C-3 con una foto SIN texto: hoy la contesta whatsapp-meta.js (TEXTO_FALLBACK_IMAGEN) y nunca llega al
  // modo. Requiere P-1 (archivo protegido) o vision_imagenes=true; con VISION=1 se ve R2.
  ['cc4cc9086', 3, '*', { paso: 'P-1', ruta: 'whatsapp-meta' }, 'C-3: foto sin texto → REQUIERE P-1 (sin visión no llega al modo)', 'sin_vision'],
  ['cc4cc9086', 3, '*', { paso: 'R2', motivo: 'RECEPCION_IMAGEN', texto: R.FRASES.PERSONA_IMAGEN }, 'C-3: con visión, imagen tras pagar → persona', 'vision'],
  ['ca5f9d2be', 2, '*', { paso: 'R8', motivo: 'RECEPCION_PEDIDO_EXTERNO' }, '«Acabo de realizar un pedido» → persona, nunca «no veo tu pedido»'],
  ['c64517ec9', 3, '*', { paso: 'R8', motivo: 'RECEPCION_PEDIDO_EXTERNO' }, '«Hice un pedido» → persona, nunca «no veo tu pedido»'],
  ['c30be5dc3', 1, '*', { paso: 'R7', ruta: 'cerrado', texto: /^Recibimos tu mensaje\. 🙂 Ahora estamos cerrados; abrimos / }, 'C-4: saludo de noche → acuse, sin menú Mapo'],
  ['c30be5dc3', 2, '*', { paso: 'R5', motivo: 'RECEPCION_OTRO', texto: R.FRASES.PERSONA_OTRO }, 'vacantes de noche → personal, sin prometer hora'],
  ['ccca77514', 1, '*', { paso: 'R7', ruta: 'cerrado', texto: /tienda en línea: https:\/\/xabor\.mx\/t\/mapolato-obispado\./ }, 'C-4: desayuno para mañana, de noche → acuse con la tienda'],
  ['ccca77514', 2, '*', { paso: 'R7', ruta: 'silencio' }, 'C-4: lo que sigue de noche < 60 min → nada (ninguna promesa)'],
  ['ccca77514', 3, '*', { paso: 'R2', texto: R.FRASES.PERSONA_CERRADO }, 'C-3/C-4: imagen de noche → persona sin «en un momento»'],
  ['c81777008', 4, '*', { paso: 'R7', ruta: 'silencio' }, 'C-4: «Hi» repetido de noche < 60 min → nada'],
  ['c1710927e', 7, '*', { paso: 'R11', tipo: 'fija:mesas' }, '«Quería comer ahí :(» → la respuesta configurada, nunca «no tenemos»'],
  ['ceb00a79f', 3, '*', { paso: 'R6', motivo: 'RECEPCION_NO_PUEDE' }, '«No carga» tras el formulario → persona'],
  ['cd8758f5a', 1, '*', { paso: 'R10', tipo: 'pedir' }, '«…quisiera hacer un pedido a domicilio» → el formulario'],
  ['cd8758f5a', 2, '*', { paso: 'R10', motivo: 'RECEPCION_PEDIDO_ESCRITO' }, 'el pedido escrito al minuto del formulario → persona'],
  ['c08d1c935', 1, '*', { paso: 'R5', motivo: 'RECEPCION_OTRO' }, 'proveedor de noche → personal'],
  // ── Revisión 3 ───────────────────────────────────────────────────────────
  // Bloqueante 1: un acuse no es «no te entendí» ni pasa a una persona.
  ['c69889eec', 2, '*', { paso: 'R-cortesia', tipo: 'cortesia', motivo: '' }, '«A Okis gracias» tras las promociones → cortesía'],
  ['c69889eec', 3, '*', { paso: 'R10', tipo: 'pedir', motivo: '' }, '«Voy a pedir en la página…» → el formulario, no «no te entendí»'],
  ['cda850980', 4, '*', { paso: 'R-cortesia', tipo: 'cortesia', motivo: '' }, '«Listo» tras el pedido → cortesía, nunca RECEPCION_INSISTE'],
  // Bloqueante 2: las preguntas más comunes, como las escribieron, reciben su respuesta fija.
  ['cda850980', 1, '*', { paso: 'R11', tipo: 'fija:envio' }, '«Tiene servicio a domicilio?» → envío'],
  ['cda850980', 2, '*', { paso: 'R11', tipo: 'fija:pagos' }, '«Y tiene pago por transferencia?» → formas de pago'],
  ['ca61f05af', 2, '*', { paso: 'R11', tipo: 'fija:envio' }, '«Disculpe tiene servicio a domicilio? Para almuerzos» → envío'],
  ['c2e259046', 1, '*', { paso: 'R11', tipo: 'fija:envio' }, '«tiene servicio a domicilio disponible?» → envío'],
  ['c3351cd2c', 1, '*', { paso: 'R11', tipo: 'fija:envio' }, '«tienen servicio a domicilio?» → envío'],
  ['c3f7254a9', 1, '*', { paso: 'R7', tipo: 'fija:envio' }, '«cuentan con servicio a domicilio?» de noche → envío, sin botones'],
  ['c98cd8d95', 1, '*', { paso: 'R11', tipo: 'fija:promociones' }, '«hoy tienes alguna promoción» (sin «?») → promociones'],
  ['cba7740ef', 2, '*', { paso: 'R10', tipo: 'pedir' }, '«pudiera hacer un pedido» → el formulario'],
  ['ce7a8a18c', 1, '*', { paso: 'R10', tipo: 'pedir' }, '«quisiera order algo a dom.» → el formulario'],
  ['c89ba2c32', 2, '*', { paso: 'R8', motivo: 'RECEPCION_PEDIDO_EXTERNO' }, '«el estado de mi pedido» sin pedido encontrado → persona'],
  ['c78b696b9', 1, '*', { paso: 'R8', motivo: 'RECEPCION_PEDIDO_EXTERNO' }, '«Disculpa hicimos un pedido» → persona'],
  ['ced4cc7b4', 3, '*', { paso: 'R4', motivo: 'RECEPCION_QUEJA_PAGO' }, '«No me acepta la tarjeta» → persona (dinero)'],
  ['cbc7c109e', 3, '*', { paso: 'R5', motivo: 'RECEPCION_PIDE_PERSONA', texto: R.FRASES.PERSONA_CERRADO }, '«Con una persona real xfis» de noche → persona'],
  // Menor: los pedidos escritos en varias líneas y sin verbo, con la carta publicada.
  ['cda850980', 3, '*', { paso: 'R10', tipo: 'pedido_escrito' }, 'tres renglones de tacos y hot cakes → el formulario', 'carta'],
  ['cab7bcd0a', 1, '*', { paso: 'R10', tipo: 'pedido_escrito' }, '«un pedido d 3 tacos d papas con chorizo» → el formulario', 'carta'],
];
const CONDICION = { carta: CARTA_REAL, prueba: !CARTA_REAL, vision: VISION, sin_vision: !VISION };

try {
  const datos = JSON.parse(readFileSync(ARCHIVO, 'utf8'));
  const conversaciones = (datos.conversaciones || []).filter((c) => Array.isArray(c?.mensajes));
  const filas = [];
  for (const modo of ['formulario', 'recepcionista']) for (const c of conversaciones) filas.push(...await correr(c, modo));

  await t(`T9a ${filas.length} turnos (${conversaciones.length} conversaciones × 2 modos): ninguno lleva acciones ni texto del modelo`, () => {
    assert(conversaciones.length >= 100, `${conversaciones.length} conversaciones`);
    const malas = filas.filter((f) => f.acciones.length || f.texto.includes(TEXTO_DEL_MODELO) || JSON.stringify(f.selector || {}).includes(TEXTO_DEL_MODELO));
    assert.deepEqual(malas.map((f) => `${f.caso}#${f.turno}`), []);
  });
  await t('T9b todo texto que saldría es uno aprobado', () => {
    const malas = filas.filter((f) => !aprobado(f.texto));
    assert.deepEqual(malas.slice(0, 5).map((f) => `${f.caso}#${f.turno} ${f.paso}: ${f.texto.slice(0, 60)}`), []);
  });
  await t('T9c los casos del análisis caen en su ruta', () => {
    const fallas = [];
    let revisados = 0;
    for (const [caso, turno, modo, x, por, cuando] of ESPERADOS) {
      if (cuando && !CONDICION[cuando]) continue;
      revisados++;
      for (const m of modo === '*' ? ['formulario', 'recepcionista'] : [modo]) {
        const f = filas.find((r) => r.caso === caso && r.turno === turno && r.modo === m);
        if (!f) { fallas.push(`${caso}#${turno} ${m}: no existe`); continue; }
        for (const [k, v] of Object.entries(x)) {
          const ok = v instanceof RegExp ? v.test(f[k]) : f[k] === v;
          if (!ok) fallas.push(`${caso}#${turno} ${m} (${por}): ${k}=${JSON.stringify(f[k]).slice(0, 80)} · entrada «${f.entrada.slice(0, 50)}»`);
        }
      }
    }
    for (const f of fallas) console.log(`    · ${f}`);
    console.log(`    (${revisados} casos revisados; carta ${CARTA_REAL ? 'publicada (CARTA_7D)' : 'de prueba'}${VISION ? ', con visión' : ''})`);
    assert.deepEqual(fallas, []);
  });
  await t('T9d en modo recepcionista el selector solo corre en R13 y su elección siempre es una opción del turno', () => {
    const opciones = new Set(S.opcionesDelSelector(ENTRADAS));
    for (const f of filas) {
      if (f.modo === 'formulario') assert.equal(f.selector, null, `${f.caso}#${f.turno}`);
      if (f.selector) assert(opciones.has(f.selector.decision), `${f.caso}#${f.turno}: ${f.selector.decision}`);
    }
  });

  // La tabla de rutas por caso (para la revisión con Mario; sin el texto del cliente).
  const conteo = (modo) => Object.entries(filas.filter((f) => f.modo === modo).reduce((a, f) => {
    const k = `${f.paso}${f.ruta === 'persona' ? `:${f.motivo}` : f.ruta === 'silencio' ? ':silencio' : ''}`; a[k] = (a[k] || 0) + 1; return a; }, {}))
    .sort((a, b) => b[1] - a[1]);
  for (const modo of ['formulario', 'recepcionista']) console.log(`  rutas (${modo}): ${conteo(modo).map(([k, v]) => `${k}=${v}`).join(' · ')}`);
  if (process.env.SALIDA) {
    writeFileSync(process.env.SALIDA, ['caso\tturno\tmodo\thora\tpaso\ttipo\truta\tmotivo\tselector',
      ...filas.map((f) => [f.caso, f.turno, f.modo, f.ts, f.paso, f.tipo, f.ruta, f.motivo, f.selector ? `${f.selector.decision}${f.selector.error ? `/${f.selector.error}` : ''}` : '',
        // ENTRADA=1 añade el texto del cliente (solo para revisar en local; nunca al repositorio).
        ...(process.env.ENTRADA === '1' ? [JSON.stringify(f.entrada)] : [])].join('\t'))].join('\n'));
    console.log(`  tabla: ${process.env.SALIDA}`);
  }
} finally {
  console.log(`\nrecepción sobre 7 días reales: ${pasadas} pasadas, ${fallidas} fallidas`);
  if (fallidas) process.exitCode = 1;
}
