// ─── MODO FORMULARIO / RECEPCIONISTA ───────────────────────────────────────
//
// Decisión del dueño (3-oct-2026, noche): «los pedidos SOLO en el formulario;
// la IA queda como recepcionista para dudas». El análisis de 7 días mostró que
// el modelo inventó datos (mesas, «no veo tu pedido», «ya va en camino») y que
// casi ningún pedido necesitaba que el modelo lo interpretara.
//
// Este módulo decide, por cada TEXTO del cliente, qué contesta Xabor con el
// modo encendido. Nunca llama al modelo para redactar: o contesta con un texto
// aprobado (frasesRecepcion.js, respuestasFijas.js), o manda el formulario de
// pedido, o pasa la conversación a una persona por el circuito del rescate
// (rescateHumano.js). Ningún texto arma ni cambia el pedido.
//
// Bandera por negocio (tabla configuracion), leída SOLO aquí y en
// activacionModoIA.js (check-modo-ia.mjs lo exige):
//
//   whatsapp_ia_modo_v1       'formulario' | 'recepcionista' (otro valor = hoy)
//   whatsapp_ia_modo_alcance  'prueba' (solo whatsapp_ia_modo_telefonos) | 'todos'
//
// Sin valor, ningún camino de hoy cambia: todo corte es condicional a modoIA().
//
// ¡Ojo con los ciclos de importación! inicioMapo.js e interactivos.js importan
// este módulo y este los importa a ellos. Ninguna constante de nivel superior
// de aquí usa un valor importado (salvo de frasesRecepcion.js, que es hoja, y
// la llamada a observarDecisionDelModo, una DECLARACIÓN de función de
// modoDelPedido.js que existe antes de evaluar cualquier módulo del ciclo).
// check-modo-ia.mjs (sección 9) importa cada punto de entrada en un proceso
// limpio y falla si alguno lanza.
import { randomBytes, randomUUID } from 'node:crypto';
import { enElCanario, observarDecisionDelModo } from '../orders/modoDelPedido.js';
import { flowsActivos, formularioDePedidoPosible, construirFormulario } from './formularioAgrupado.js';
import { interactivosActivos } from './interactivos.js';
import { eleccionesActivas, opcionesInteractivas } from './eleccionesInteractivas.js';
import { rescateActivo, respuestaDeRescate, rescateAntesDelModelo } from './rescateHumano.js';
import { inicioMapoActivo } from './inicioMapo.js';
import { betaHibridaActiva, RETOMAR_PEDIDO, textoConsultaConCarrito } from './experienciaHibrida.js';
import { normalizarEleccion, contieneDecisionDePedido, politicaDelTurno, preguntaDeContenido } from './politicaDelTurno.js';
import { esSaludoSolo, puedeRecuperarSinEfectos } from './recuperacionDelTurno.js';
import { esNegativaCorta } from './respuestaCorta.js';
import { autorizaCancelacion } from './contratoConversacional.js';
import { esConfirmacionVerbal } from '../agent/confirmacionVerbal.js';
import { cortesiaPostPedido } from './cortesiaPostPedido.js';
import { esSolicitudDePedidoProgramado } from './seguridadConversacional.js';
import { construirAvisoFueraDeHorario, respuestaAPedidoProgramado } from './horarioDelAgente.js';
import { respuestaOperativaVerificada, textoEstadoDePedido, PIE_ESTADO_DE_PEDIDO } from './estadoOperativoDelPedido.js';
import { solicitudDeEntrada, intencionDeEntrada } from './intencionDeEntrada.js';
import { pideAgregarOtro } from './seleccionDeProducto.js';
import { buscarProductos } from '../mesero-whatsapp/consultasDelMenu.js';
import { esListaDeOrdenEscrita } from './listaDeOrdenEscrita.js';
import { solicitaAtencionHumana } from '../utils/solicitudPersona.js';
import { CLAVES_FLOW_PEDIDO } from './disponibilidadTienda.js';
import { FLOW_TIENDA_ID } from './contratoTienda.js';
import { catalogoDeRespuestas, buscarRespuestaFija } from './respuestasFijas.js';
import { NOTA_IMAGEN_PARA_IA, RE_MARCA_IMAGEN } from '../utils/turnoImagen.js';
import { motivoDeDineroOIncierto } from '../services/pausaVencePolitica.js';
import { FRASES, TEXTOS_PERSONA, PERSONA_SIN_HORA, MOTIVOS_RECEPCION, PIE_SIN_BOTONES, SALUDO_SIN_BOTONES } from './frasesRecepcion.js';

export { FRASES, TEXTOS_PERSONA, MOTIVOS_RECEPCION, PIE_SIN_BOTONES, SALUDO_SIN_BOTONES };

// ── 1. BANDERA, ALCANCE Y PRECONDICIONES ─────────────────────────────────

export const CLAVES_IA = Object.freeze({
  MODO: 'whatsapp_ia_modo_v1',
  ALCANCE: 'whatsapp_ia_modo_alcance',
  TELEFONOS: 'whatsapp_ia_modo_telefonos',
  PUBLICAR_SELECTOR: 'whatsapp_ia_selector_publicar',
  SILENCIO: 'whatsapp_ia_silencio_personal_min',
  RESPALDO: 'whatsapp_ia_modo_respaldo',
});
export const MODOS_IA = Object.freeze(['formulario', 'recepcionista']);
export const ALCANCES_IA = Object.freeze(['prueba', 'todos']);
export const SILENCIO_POR_OMISION_MIN = 180;
// Una pregunta del bot que el cliente no contestó con las opciones, o un
// mensaje no reconocido: la segunda vez dentro de esta ventana, una persona.
export const MINUTOS_INSISTE = 30;
// Un formulario de pedido entregado hace menos de esto: volver a escribir el
// pedido es no poder usarlo.
export const MINUTOS_FORMULARIO_RECIENTE = 30;
// Con el local cerrado, el acuse sale una vez por esta ventana; lo demás se
// queda en el chat del panel sin contestar (c81777008: «Hola» ×3 de noche).
export const MINUTOS_CERRADO_REPETIDO = 60;
// Más pedidos activos que esto en el teléfono: no se listan, los revisa el personal.
export const MAX_PEDIDOS_EN_ESTADO = 3;

/** Minutos de silencio tras un mensaje del personal (PARTE 2, R0). 1–720; otro valor = 180. */
export function ventanaSilencio(cfg) {
  const v = String(cfg?.[CLAVES_IA.SILENCIO] ?? '').trim();
  const n = /^\d{1,3}$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 720 ? n : SILENCIO_POR_OMISION_MIN;
}

/**
 * Las precondiciones que se ven en cada turno, con la configuración del turno.
 * Devuelve las que FALLAN. Sin cualquiera de ellas el modo no puede operar
 * (sin formularios no hay dónde pedir; sin botones no hay «Hablar con
 * alguien»; sin rescate y beta híbrida el texto de persona no sale).
 */
export function precondicionesDeTurno(cfg, telefono) {
  const faltan = [];
  if (!flowsActivos(cfg, telefono)) faltan.push('formularios');
  if (!interactivosActivos(cfg)) faltan.push('interactivos');
  if (!eleccionesActivas(cfg)) faltan.push('elecciones');
  if (!rescateActivo(cfg)) faltan.push('rescate');
  if (!inicioMapoActivo(cfg)) faltan.push('inicio_mapo');
  if (!betaHibridaActiva(cfg, telefono)) faltan.push('beta_hibrida');
  if (String(cfg?.whatsapp_eventos_formulario_v1) !== 'true' || !/^\d{5,30}$/.test(cfg?.whatsapp_flow_evento_id || '')) {
    faltan.push('eventos_formulario');
  }
  return faltan;
}

/**
 * ¿El modo está encendido para ESTE cliente? → null (comportamiento de hoy)
 * o { modo, completo, faltan, publicarSelector, silencioMin }. Igualdad
 * estricta de cadenas: 'Formulario', ' formulario' o 'true' no encienden.
 * Con precondiciones caídas devuelve el modo con `completo: false`: el turno
 * pasa a una persona (falla cerrado), nunca vuelve al modelo que arma pedidos.
 */
export function modoIA(cfg, telefono) {
  const modo = cfg?.[CLAVES_IA.MODO];
  if (!MODOS_IA.includes(modo)) return null;
  const alcance = cfg?.[CLAVES_IA.ALCANCE];
  if (!ALCANCES_IA.includes(alcance)) return null;
  if (alcance === 'prueba' && !enElCanario(telefono, { lista: cfg?.[CLAVES_IA.TELEFONOS], porcentaje: 0 }).dentro) return null;
  const faltan = precondicionesDeTurno(cfg, telefono);
  return {
    modo, alcance, completo: !faltan.length, faltan,
    publicarSelector: modo === 'recepcionista' && cfg?.[CLAVES_IA.PUBLICAR_SELECTOR] === 'true',
    silencioMin: ventanaSilencio(cfg),
  };
}

// ── La configuración que cambia DESPUÉS de activar ───────────────────────
// El script de activación exige que el Mesero atienda a todo el alcance del
// modo, pero eso se revisa una vez. Si después alguien baja el porcentaje del
// Mesero, cambia su lista, pone bot_whatsapp_solo_prueba o apaga
// MESERO_AGENTE_MODE, esos clientes vuelven a brain.js, que arma pedidos por
// texto, con el modo todavía puesto. modoDelPedido.js (la decisión
// agente/brain.js de cada mensaje) avisa aquí; la decisión no cambia, pero el
// log grita, una vez cada 10 minutos por negocio. Sin la bandera, nada.
export const MINUTOS_ALERTA_FUERA_DEL_MESERO = 10;
const alertasFueraDelMesero = new Map();
export function alertaModoFueraDelMesero({ negocioId, telefono, cfg, agente, ahora = Date.now() } = {}) {
  if (agente || !telefono || !modoIA(cfg, telefono)) return false;
  const ultima = alertasFueraDelMesero.get(negocioId);
  if (ultima && ahora - ultima < MINUTOS_ALERTA_FUERA_DEL_MESERO * 60 * 1000) return false;
  alertasFueraDelMesero.set(negocioId, ahora);
  console.error(`[RECEPCION] ALERTA modo_fuera_del_mesero negocio=${negocioId} tel=…${String(telefono).slice(-4)}: `
    + 'el modo formulario está puesto pero este cliente NO lo atiende el Mesero (lo atiende brain.js, que arma pedidos por texto). '
    + 'Revisa mesero_agente_v1, mesero_agente_porcentaje, mesero_agente_telefonos, bot_whatsapp_solo_prueba y MESERO_AGENTE_MODE, o revierte el modo.');
  return true;
}
observarDecisionDelModo(alertaModoFueraDelMesero);

// ── 2. DETECTORES (puros, sobre el texto normalizado) ─────────────────────

const norm = (m) => normalizarEleccion(m);

/** ¿El turno trae una imagen? (la nota que pone whatsapp-meta.js o el bloque de visión) */
export function traeImagen(mensaje) {
  const s = String(mensaje || '');
  return s.includes(NOTA_IMAGEN_PARA_IA) || s.includes('[CONTEXTO VISUAL]') || new RegExp(RE_MARCA_IMAGEN.source).test(s);
}

const QUEJA = /\b(queja|quejarme|quejar|reclamo|reclamar|reclamacion|pesimo|pesima|malisimo|malisima|horrible|asqueroso|asquerosa|(llego|vino|estaba|esta|venia) (frio|fria|crudo|cruda|quemado|quemada|mal|incompleto|incompleta)|pedido (equivocado|incompleto)|me (trajeron|mandaron|dieron) (otra cosa|otro|algo que no pedi)|me cobraron|cobraron de mas|cobro de mas|cobro doble|doble cobro|cobraron doble|reembolso|devolucion|devuelvan|me falto|faltaron|nunca llego|no me llego|mal servicio|mala atencion|pesimo servicio)\b/;
/** Una queja (y las palabras críticas que configuró el negocio). */
export function esQueja(mensaje, palabrasCriticas = []) {
  const t = norm(mensaje);
  if (!t) return false;
  if (QUEJA.test(t)) return true;
  return (Array.isArray(palabrasCriticas) ? palabrasCriticas : []).map(norm).filter((p) => p.length >= 3)
    .some((p) => ` ${t} `.includes(` ${p} `));
}

const RETRASO = /\b(no (ha|han) llegado|no llega|aun no llega|todavia no llega|sigue sin llegar|no ha salido|tarda(n)? mucho|se tardaron|ya se tardaron|ya tardo|llevo (mas de |casi )?(una|media|dos) hora|ya paso (mas de )?(una|media) hora|demasiado tiempo|mucho tiempo esperando|ya es mucho)\b/;
/** Un reclamo por la espera (solo cuenta con un pedido activo). */
export const esRetraso = (mensaje) => RETRASO.test(norm(mensaje));

// Un problema con el pago: «No me acepta la tarjeta» (ced4cc7b4), «Estoy
// teniendo problemas con el pago» (c7d56ed24), «me aparece declinado»
// (c69889eec). Es dinero: lo ve una persona y la pausa nunca vence sola.
const PAGO_FALLIDO = /\b(problemas? con (el|mi) (pago|cobro|enlace|link|tarjeta)|no (me )?(acepta|acepto|pasa|paso|deja|dejo|jala|jalo) (la |mi |el )?(tarjeta|pago|enlace|link)|(tarjeta|pago) (rechazad[oa]|declinad[oa])|me (aparece|aprecia|sale|salio|aparecio) (como )?(declinad[oa]|rechazad[oa])|no se (hizo|realizo|reflejo|refleja|completo) (el|mi) pago)\b/;
/** Un problema con el pago del cliente (R4, RECEPCION_QUEJA_PAGO). */
export const esProblemaDePago = (mensaje) => PAGO_FALLIDO.test(norm(mensaje));

const PERSONA_A_SECAS = /^(?:(?:con )?(?:una|un|el|la) )?(?:persona|humano|asesor|asesora|encargado|encargada|gerente|alguien)(?: (?:real|por favor|porfa|porfavor|porfis|plis|xfa|xfis|please))*$/;
const PERSONA_EN_FRASE = /\b(?:hablar|comunicarme|platicar) con (?:alguien|una persona|un humano|el encargado|la encargada|el gerente|un asesor)\b/;
/** Pide hablar con una persona (la regla de siempre más «persona» a secas). */
export function pideHablarConPersona(mensaje) {
  const t = norm(mensaje);
  return solicitaAtencionHumana(mensaje) || PERSONA_A_SECAS.test(t) || PERSONA_EN_FRASE.test(t);
}

const VACANTE = /\b(vacantes?|empleo|solicitud de (empleo|trabajo)|busco trabajo|buscan personal|ocupan personal|contratando|estan contratando|trabajar con ustedes|trabajar (aqui|ahi)|curriculum|curriculo|proveedor|proveedores|proveedora|distribuidor|distribuidora|soy (vendedor|vendedora|representante)|les ofrezco|ofrecemos (nuestros|productos|servicios)|ofrecer(le|les)? (mi|mis|nuestro|nuestros|un|unos) (producto|productos|servicio|servicios)|vender(las|los)? en su (mostrador|local|tienda|negocio))\b/;
/** Vacantes y proveedores: no son clientes; lo revisa el personal. */
export const esVacanteOProveedor = (mensaje) => VACANTE.test(norm(mensaje));

const NO_PUEDE = /\b(no (me )?(carga|cargo|abre|abrio|deja|dejo|sale|salio|aparece|aparecio|funciona|funciono|sirve)|no puedo (pedir|ordenar|abrir|entrar|elegir|seleccionar|usar|ver|picar|continuar|terminar)|no se (como|usar|usarlo)|no le entiendo (al|a la) (formulario|menu|pagina|app)|mejor (por aqui|por mensaje|por chat)|prefiero (escribir|por aqui|por mensaje|por chat))\b/;
/** Dice que no puede usar el formulario (cuenta solo si se le entregó uno de pedido hace poco). */
export const noPuedeUsarFormulario = (mensaje) => NO_PUEDE.test(norm(mensaje));

// «En cuánto tiempo llega?» (c1c28839e) también: con un pedido activo se
// contesta su estado con el tiempo; sin pedido, sigue a la respuesta de tiempos.
const ESTADO = /\b(como va (mi|el) (pedido|orden)|en que va (mi|el)|cuanto (le )?falta|a que hora (llega|me llega|estara|esta listo)|ya (viene|llego|salio|esta listo|esta lista|lo mandaron|va en camino)|estado de (mi|el) (pedido|orden)|mi (pedido|orden) ya|ya esta mi (pedido|orden)|tiempo de entrega|en cuanto tiempo (llega|me llega|esta|estara|sale)|cuanto (tiempo )?(tarda|tardara|falta) (mi|el) (pedido|orden))\b/;
/** Pregunta por el estado de su pedido. */
export function esConsultaDeEstado(mensaje) {
  return !contieneDecisionDePedido(mensaje) && ESTADO.test(norm(mensaje));
}

// «Acabo de realizar un pedido» (ca5f9d2be) y «Acabo de hacer este pedido» (c3bca7127) también.
// Y «Realicé un pedido en línea» (c9ef5c451), «Disculpa hicimos un pedido» (c78b696b9).
const PEDIDO_HECHO = /\b(ya (hice|realice|mande|pedi|ordene|pague) (mi|el|un)? ?(pedido|orden)?|(hice|hicimos|realice|realizamos|mandamos) (mi|un|el|nuestro) pedido|acabo de (hacer|realizar|mandar|enviar|pedir|ordenar|levantar) (mi|un|el|este|una)? ?(pedido|orden)|pedi (en linea|por (la|el) (pagina|tienda|app|web))|mi pedido (en linea|de la pagina|de la tienda|de la web))\b/;
/** Dice que ya hizo su pedido (en línea, por la tienda…). */
export const dicePedidoHecho = (mensaje) => PEDIDO_HECHO.test(norm(mensaje));

// Un agradecimiento o un cierre, renglón por renglón: «Si muchas gracias»,
// «Ya la recibí», «👍». NO lo son «sí», «sí por favor», «ok» ni «listo»: tras
// un mensaje del personal pueden ser la respuesta a su pregunta («Si porfavor»
// de c090529eb, que nadie atendió) o un «ya pagué». Esos avisan al equipo.
const CORTESIA = new RegExp(`^(?:${[
  '(?:(?:si|ok|okey|okay|va|vale|sale|perfecto|claro|excelente|super|genial|muy bien|esta bien|de acuerdo|entendido|enterado|recibido|recibida)\\s+)*'
    + '(?:(?:muchas|mil|muchisimas)\\s+)?gracias'
    + '(?:\\s+(?:por todo|por la atencion|por su atencion|por tu atencion|por la ayuda|por su ayuda|por tu ayuda|que amable|muy amable|'
    + 'igualmente|a ti|a usted|a ustedes|de nuevo|bendiciones|saludos|buen dia|bonito dia|lindo dia|feliz dia|buenas noches|buenas tardes|'
    + 'senorita|joven))*',
  'ya (?:la|lo|las|los|me) (?:recibi|tengo|llego|llegaron)',
  'ya (?:llego|llegaron)',
  'recibid[oa]', 'perfecto', 'excelente', 'muy amable', 'que amable', 'bendiciones', 'igualmente', 'de nada', 'saludos',
].join('|')})$`);
/** El mensaje entero es agradecimiento o cierre (cada renglón; emojis solos cuentan). Una pregunta nunca. */
export function esCortesia(mensaje) {
  const original = String(mensaje || '');
  if (/[?¿]/.test(original) || traeImagen(original)) return false;
  const lineas = original.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lineas.length) return false;
  return lineas.every((l) => { const t = norm(l); return !t || CORTESIA.test(t); });
}

// Un ACUSE o un agradecimiento sin pregunta (R-cortesía): «gracias», «ok
// gracias», «A Okis gracias» (c69889eec), «Listo» (cda850980), «👍», «Ya
// llegó, muchas gracias». No es una duda ni un pedido: no cuenta como «no te
// entendí» ni pasa a una persona. Más amplio que esCortesia a propósito: sin
// el personal de por medio (R0 va antes y usa esCortesia), «ok», «sí» y
// «listo» no esconden un «ya pagué» que alguien tenga que leer.
// Frases que por sí solas son el acuse, y frases que solo acompañan (un
// «buenas noches» solo es un saludo, no un acuse).
const FRASES_ACUSE = /\b(?:de acuerdo|esta bien|muy bien|que amable|muy amable|con gusto|de nada|dios (?:te|le|los|les) bendiga|ya (?:(?:la|lo|las|los|me) )?(?:recibi|tengo|llego|llegaron))\b/g;
const FRASES_RELLENO_ACUSE = /\b(?:por (?:todo|la atencion|su atencion|tu atencion|la ayuda|su ayuda|tu ayuda)|a (?:ti|usted|ustedes)|de nuevo|(?:buen|bonito|lindo|feliz|excelente) dia|buenas (?:noches|tardes))\b/g;
const NUCLEO_ACUSE = new Set(['ok', 'okey', 'okay', 'oki', 'okis', 'okas', 'okk', 'oka', 'va', 'vale', 'sale', 'listo', 'lista', 'listos',
  'perfecto', 'perfecta', 'excelente', 'super', 'genial', 'claro', 'si', 'sip', 'bueno', 'gracias', 'gracia', 'graciass', 'grax',
  'enterado', 'enterada', 'entendido', 'entendida', 'recibido', 'recibida', 'igualmente', 'bendiciones', 'thanks']);
const RELLENO_ACUSE = new Set(['a', 'ah', 'aa', 'oh', 'muchas', 'muchisimas', 'mil', 'saludos', 'thank', 'you', 'senorita', 'joven',
  'amiga', 'amigo', 'muy', 'y']);
/** El mensaje entero es un acuse o un agradecimiento (sin pregunta ni imagen; 12 palabras como mucho). */
export function esAcuse(mensaje) {
  const original = String(mensaje || '');
  if (!original.trim() || original.length > 160 || /[?¿]/.test(original) || traeImagen(original)) return false;
  if (esCortesia(original)) return true;
  // «Graciasss», «Okisss», «Siii»: tres letras iguales o más cuentan como una.
  const t = norm(original).replace(/([a-z])\1{2,}/g, '$1');
  if (!t) return true; // solo emojis
  let nucleo = false;
  const resto = t.replace(FRASES_ACUSE, () => { nucleo = true; return ' '; }).replace(FRASES_RELLENO_ACUSE, ' ')
    .split(' ').filter(Boolean);
  if (resto.length > 12) return false;
  for (const w of resto) {
    if (NUCLEO_ACUSE.has(w)) nucleo = true;
    else if (!RELLENO_ACUSE.has(w)) return false;
  }
  return nucleo;
}

/** Un saludo y nada más («Hola buenos días 😃», «Hola Buendía»), aunque el inicio Mapo no lo haya tomado. */
export function esSaludo(mensaje) {
  if (/[?¿]/.test(String(mensaje || '')) || traeImagen(mensaje)) return false;
  const t = norm(mensaje).replace(/\bbuen(os)?dias?\b/g, (x) => x.replace(/^buen(os)?/, (y) => `${y} `));
  return esSaludoSolo(mensaje) || intencionDeEntrada(t) === 'saludo';
}

const CAMBIO = /\b(quita\w*|cambia\w*|sin|ya no quiero|mejor)\b/;
// «Disculpa, quisiera hacer un pedido a domicilio» (cd8758f5a) y «¿podría
// levantarme un pedido?» (c090529eb): solicitudDeEntrada solo mira el principio.
// También «Disculpe pudiera hacer un pedido para pasar por él» (cba7740ef) y
// «quisiera order algo a dom.» (ce7a8a18c): pedir «algo» sin decir qué.
const PIDE_PEDIDO = new RegExp(`\\b(?:(?:quisiera|quiero|queria|me gustaria|puedo|podria|pudiera|podrias|pudieras|podemos|se puede|para|deseo|necesito) (?:hacer|realizar|levantar(?:me|nos|le)?|encargar|mandar|dejar|pedir|ordenar) (?:un |mi |el |una )?(?:pedido|orden|encargo)`
  + '|(?:podria|puede|pueden|podrian|pudiera|pudieran) (?:levantar|tomar|apuntar)(?:me|nos|le)? (?:un|mi|el) pedido'
  + '|(?:quisiera|quiero|queria|me gustaria|deseo|necesito|pudiera|podria|puedo) (?:order|ordenar|pedir|encargar)(?= (?:algo|comida|de comer|para (?:llevar|recoger|hoy)|a (?:domicilio|dom))\\b| *$)'
  // «Creo que sí pediré por aquí», «Voy a pedir…» (c69889eec).
  + '|pedire|ordenare|(?:voy|vamos) a (?:pedir|ordenar))\\b');
// Una nota para el pedido («¿le podrían poner un recado que diga…?», cc4cc9086;
// «poner una nota de feliz cumpleaños», cadd98934): con carrito es un cambio
// (el formulario lleva la nota); con el pedido ya registrado, una persona.
const NOTA_AL_PEDIDO = /\b(?:poner(?:le)?|agregar(?:le)?|agrega(?:le)?|anadir(?:le)?|incluir(?:le)?|escribir(?:le)?) (?:un |una |el |la )?(?:recado|nota|mensaje|tarjeta|dedicatoria|letrero)\b/;
const PIDE_CARTA = /\b(menu|carta)\b/;
const PETICION_CARTA = /\b(pasa|pasame|pasan|manda|mandame|mandan|ver|tienes|tienen|quiero|envia|enviame|envian|muestra|muestrame|me (das|pasas|mandas|compartes|comparten))\b/;
/** Pide la carta (el respaldo sin menuAutomatico.mensajePideMenu). */
export const pideCarta = (mensaje) => { const t = norm(mensaje); return PIDE_CARTA.test(t) && PETICION_CARTA.test(t); };

/**
 * ¿El mensaje quiere pedir o cambiar el pedido? → la clase (decide la frase
 * del formulario) o null. Orden de la tabla 3.1 de ia-diseno.md.
 *
 * `pedido_escrito` por una palabra de decisión («quiero…») sin ningún platillo
 * de la carta no gana a una duda que tiene respuesta aprobada: «quiero
 * reservar una mesa» es la pregunta de mesas, no un pedido (`respuestaFija`).
 */
export function clasificarIntencion({ mensaje, estado, catalogo = [], pideMenu = pideCarta, respuestaFija = () => null }) {
  const t = norm(mensaje);
  if (!t) return null;
  const carrito = !!estado?.carrito?.items?.length;
  const pregunta = /[?¿]/.test(String(mensaje));
  if (estado?.pendiente?.tipo === 'confirmar_resumen' && esNegativaCorta(mensaje)) return 'no_al_resumen';
  if (esListaDeOrdenEscrita(mensaje)) return carrito ? 'cambiar' : 'pedido_escrito';
  if (RETOMAR_PEDIDO.test(t)) return 'retomar';
  // Con el pedido ya registrado el carrito sigue lleno, pero no hay formulario
  // que reabrir: ese saludo lo contesta R14 (sin botones), no una persona.
  if (carrito && libre(estado) && esSaludo(mensaje)) return 'saludo';
  if (pideMenu(mensaje)) return 'carta';
  const conPlatillo = () => buscarProductos(catalogo, mensaje, { limite: 1 }).length > 0;
  if (solicitudDeEntrada(mensaje)?.intencion === 'ordenar' || PIDE_PEDIDO.test(t) || pideAgregarOtro(estado, mensaje)) {
    // «Voy a pedir: ...» con renglones de platillos ya contiene la orden;
    // necesita el acuse específico, no otra pregunta sobre qué quiere pedir.
    return conPlatillo() ? 'pedido_escrito' : 'pedir';
  }
  // Con carrito, un cambio abre la edición. No lo es una DUDA que trae un «sin»
  // o un «mejor»: la que tiene respuesta aprobada («O si tiene para hacer
  // trasferencia mejor», ced4cc7b4) o una consulta («¿Tienen opciones sin
  // gluten?»). Esas siguen a R11/R12, que con carrito llevan «Continuar
  // pedido» debajo de la respuesta (C-2: nunca el carrito en lugar de contestar).
  if (carrito && NOTA_AL_PEDIDO.test(t)) return 'cambiar';
  if (carrito && (contieneDecisionDePedido(mensaje) || CAMBIO.test(t)) && !respuestaFija(mensaje)
    && !(pregunta && politicaDelTurno(mensaje).soloLectura)) return 'cambiar';
  if (contieneDecisionDePedido(mensaje) && (conPlatillo() || !respuestaFija(mensaje))) return 'pedido_escrito';
  if (!pregunta && !politicaDelTurno(mensaje).soloLectura && conPlatillo()) return 'pedido_escrito';
  return null;
}
const AVISO_DE_CLASE = { no_al_resumen: 'CAMBIAR', retomar: 'RETOMAR', saludo: 'SALUDO_CON_CARRITO', carta: 'CARTA',
  pedir: 'PEDIR', cambiar: 'CAMBIAR', pedido_escrito: 'PEDIDO_ESCRITO' };

// ── 3. LECTURAS ───────────────────────────────────────────────────────────

/** Los flowId de los formularios de PEDIDO del negocio (los de hoy y la tienda). */
export const flowIdsDePedido = (cfg) => [...new Set([...CLAVES_FLOW_PEDIDO, FLOW_TIENDA_ID]
  .map((k) => cfg?.[k]).filter((id) => /^\d{5,30}$/.test(id || '')))];

/**
 * ¿Le llegó a este cliente un formulario de PEDIDO hace poco? Como
 * formularioEntregadoReciente (rescateHumano.js) pero solo los Flows de pedido:
 * uno de factura o de evento no cuenta. Error de lectura = no (sin evidencia
 * no hay persona por esta vía).
 *
 * A diferencia del rescate de hoy, cuenta también el que salió como TEXTO de
 * respaldo (texto_enviado: el teléfono no recibió el Flow y se le dijo «puedes
 * pedir ayuda a una persona»): volver a escribir el pedido o «no abre» después
 * de eso es una persona, no otro intento de formulario. Y no cuenta el que el
 * cliente ya ENVIÓ (llegó una respuesta de Flow después): «quiero hacer otro
 * pedido» tras pedir por el formulario es pedir otra vez, no insistir.
 */
export async function formularioDePedidoReciente(db, { negocioId, telefono, cfg, minutos = MINUTOS_FORMULARIO_RECIENTE } = {}) {
  const ids = flowIdsDePedido(cfg);
  if (!db || !negocioId || !telefono || !ids.length) return false;
  try {
    const { rows: [r] } = await db.query(
      `SELECT EXISTS(SELECT 1 FROM agente_outbox o
          WHERE o.negocio_id = $1 AND o.tipo = 'respuesta_cliente' AND o.estado = 'entregado'
            AND o.carga->>'telefono' = $2 AND o.carga->'interactivo'->>'type' = 'flow'
            AND o.carga->'interactivo'->'action'->'parameters'->>'flow_id' = ANY($4::text[])
            AND o.created_at > now() - make_interval(mins => $3::int + 5)
            AND o.entregado_at > now() - make_interval(mins => $3::int)
            AND NOT EXISTS (SELECT 1 FROM whatsapp_entradas e
                 WHERE e.negocio_id = o.negocio_id AND e.telefono = $2 AND e.recibido_at > o.entregado_at
                   AND e.payload->'message'->'interactive'->>'type' = 'nfm_reply')) AS reciente`,
      [negocioId, String(telefono), Number(minutos) || MINUTOS_FORMULARIO_RECIENTE, ids]);
    return r?.reciente === true;
  } catch (e) {
    console.error(`[RECEPCION] no se pudo leer el último formulario de pedido negocio=${negocioId}: ${e?.message}`);
    return false;
  }
}

/**
 * El último mensaje SALIENTE de la conversación (R0): quién lo escribió, hace
 * cuántos minutos y si una persona devolvió la conversación al bot después
 * («Devolver al bot» deja updated_by; el vencimiento automático de una pausa
 * lo deja en NULL y no cuenta). `timestamp` no tiene zona: se compara en SQL,
 * como vencimientoPausasWhatsapp.js; nunca se lee la fecha en JS. Error de
 * lectura = null: sin evidencia no hay silencio (se contesta con texto fijo).
 */
export async function leerUltimoSaliente(db, { negocioId, telefono } = {}) {
  if (!db || !negocioId || !telefono) return null;
  try {
    const { rows: [r] } = await db.query({ text: `SELECT m.origen,
          EXTRACT(EPOCH FROM (now() - m."timestamp"::timestamptz)) / 60 AS minutos,
          COALESCE(cc.bot_pausado IS FALSE AND cc.updated_by IS NOT NULL
                   AND cc.updated_at > m."timestamp"::timestamptz, false) AS liberada_despues
        FROM mensajes m
        LEFT JOIN conversaciones_control cc ON cc.negocio_id = m.negocio_id AND cc.telefono = m.telefono
       WHERE m.negocio_id = $1 AND m.telefono = $2 AND m.direccion = 'saliente'
       ORDER BY m.id DESC LIMIT 1`, values: [negocioId, String(telefono)], query_timeout: 2000 });
    if (!r) return null;
    return { origen: r.origen || null, minutos: Number(r.minutos), liberadaDespues: r.liberada_despues === true };
  } catch (e) {
    console.error(`[RECEPCION] no se pudo leer el último mensaje saliente negocio=${negocioId}: ${e?.message}`);
    return null;
  }
}

/**
 * Los pedidos activos del TELÉFONO (R8, C-1), también los que no hizo el bot
 * (los del personal, la tienda o el POS con ese teléfono): misma comparación
 * por los últimos 10 dígitos que obtenerPedidosActivosPorTelefono, de las
 * últimas 24 horas (un pedido viejo sin archivar no es «tu pedido») y hasta
 * MAX_PEDIDOS_EN_ESTADO + 1 (para saber si hay más). null si no se pudo leer.
 */
export async function leerPedidosActivosDelTelefono(db, { negocioId, telefono } = {}) {
  const digitos = String(telefono || '').replace(/[^0-9]/g, '').slice(-10);
  if (!db || !negocioId || digitos.length !== 10) return null;
  try {
    const { rows } = await db.query({ text: `SELECT folio, estado, datos->>'modalidad' AS modalidad
        FROM pedidos_activos
       WHERE negocio_id = $1 AND estado NOT IN ('entregado', 'cancelado')
         AND created_at > now() - interval '24 hours'
         AND (right(regexp_replace(COALESCE(datos->'cliente'->>'telefono', ''), '[^0-9]', '', 'g'), 10) = $2
           OR right(regexp_replace(COALESCE(datos->>'telefono_conversacion', ''), '[^0-9]', '', 'g'), 10) = $2)
       ORDER BY created_at DESC LIMIT $3`, values: [negocioId, digitos, MAX_PEDIDOS_EN_ESTADO + 1], query_timeout: 2000 });
    return rows.map((r) => ({ folio: r.folio, estado: r.estado, modalidad: r.modalidad || null }));
  } catch (e) {
    console.error(`[RECEPCION] no se pudieron leer los pedidos del teléfono negocio=${negocioId}: ${e?.message}`);
    return null;
  }
}

/**
 * R0 — tras un mensaje del PERSONAL el bot no habla (c33c16f63: la clienta
 * contestó «Si muchas gracias / Ya la recibí» a la persona que le mandó su
 * factura y el Mesero le preguntó «¿Qué te gustaría ordenar hoy?»). Si el
 * último saliente es del personal, de hace menos de `ia.silencioMin` minutos,
 * y nadie devolvió la conversación al bot después: una cortesía no recibe
 * nada; cualquier otra cosa tampoco, pero avisa al equipo
 * (RECEPCION_TRAS_PERSONAL: revisión + panel). null = sigue el router.
 */
export async function decidirSilencio({ ia, mensaje = '', lectores = {} } = {}) {
  if (!ia) return null;
  let ultimo = null;
  try { ultimo = await lectores.ultimoSaliente?.(); } catch { ultimo = null; }
  if (!ultimo || ultimo.origen !== 'humano' || ultimo.liberadaDespues === true) return null;
  const minutos = Number(ultimo.minutos);
  // Un reloj desfasado (minutos muy negativos) no es evidencia: se contesta.
  if (!Number.isFinite(minutos) || minutos < -5 || minutos >= (Number(ia.silencioMin) || SILENCIO_POR_OMISION_MIN)) return null;
  const cortesia = esCortesia(mensaje);
  return { ruta: 'silencio', paso: 'R0', tipo: cortesia ? 'cortesia_tras_personal' : 'tras_personal', respuesta: null,
    persona: null, formulario: null, estadoRecepcion: null,
    alerta: cortesia ? null : { motivo: MOTIVOS_RECEPCION.TRAS_PERSONAL } };
}

// ── 4. RESPUESTAS ─────────────────────────────────────────────────────────

const libre = (e) => !!e && !e.folio && !e.evento && !e.confirmacionIncierta && !Object.values(e.hechos || {}).some(Boolean);
const confirmado = (e) => !!e?.folio && !!e?.hechos?.confirmado;
const dineroDe = (s) => `$${Number(s)}`;

/** La respuesta a «¿tienen…?», «¿cuánto cuesta…?», «¿qué trae…?»: solo datos de la carta; nunca «no tenemos». */
export function respuestaDeProducto(mensaje, encontrados = []) {
  const lista = encontrados.slice(0, 5);
  let t;
  if (preguntaDeContenido(mensaje) && lista.length === 1) {
    const p = lista[0];
    const d = String(p.descripcion || '').trim().replace(/[.\s]+$/, '');
    const precio = Number.isFinite(Number(p.precio)) && p.precio !== null ? p.precio : null;
    t = d ? `${p.nombre}: ${d}.${precio !== null ? ` Precio base: ${dineroDe(precio)}.` : ''}`
      : `${p.nombre}${precio !== null ? `: precio base ${dineroDe(precio)}` : ''}.`;
  } else {
    t = `Sí, en el menú tenemos: ${lista.map((p) => `${p.nombre}${Number.isFinite(Number(p.precio)) && p.precio !== null
      ? ` (${dineroDe(p.precio)})` : ''}`).join(', ')}.`;
  }
  return `${t}\n\n${FRASES.PRODUCTO_PIE}`;
}

const sinMeta = ({ dialogo_id: _d, intentos: _i, turno: _t, ...resto } = {}) => resto;
const reciente = (marca, ahora, minutos) => {
  const t = Date.parse(marca?.en || '');
  return Number.isFinite(t) && ahora - t >= 0 && ahora - t < minutos * 60 * 1000;
};
const estadoRec = (ultimo, ahora) => ({ ultimo, en: new Date(ahora).toISOString() });
const alertados = new Set();

/**
 * Las respuestas que salen de aquí. `respuesta` es una respuesta de sistema
 * para atenderTurnoConHerramientas; `formulario` dice cómo componer el Flow en
 * el commit (aviso, o cuerpo y CTA con carrito).
 */
const resp = (paso, tipo, respuesta, extra = {}) => ({ ruta: 'respuesta', paso, tipo, respuesta, persona: null,
  formulario: null, estadoRecepcion: null, ...extra });

/** El texto de una entrada (las dinámicas se consultan ahora). */
export async function textoDeEntrada(entrada, { lectores, mensaje = '' } = {}) {
  if (entrada.origen !== 'dinamica') return entrada.texto;
  try {
    const t = await lectores?.promocionesOficiales?.(mensaje);
    return typeof t === 'string' && t.trim() && t.length <= 1024 ? t.trim() : FRASES.PROMOS_NO_DISPONIBLES;
  } catch { return FRASES.PROMOS_NO_DISPONIBLES; }
}

/** La respuesta a una duda con texto aprobado (R11 y el toque de un tema). */
function respuestaInformativa(texto, { estado, cerrado, paso, tipo, extra = {} }) {
  const carrito = !!estado?.carrito?.items?.length;
  if (cerrado || !libre(estado)) {
    return resp(paso, tipo, { tipo: 'recepcion_respuesta', texto, acciones: [], sinSaludo: true, pendiente: null }, extra);
  }
  if (carrito) {
    const cuerpo = textoConsultaConCarrito(texto);
    if (cuerpo) {
      return resp(paso, tipo, { tipo: 'recepcion_respuesta', texto, acciones: [], sinSaludo: true, pendiente: { tipo: 'editar_pedido' } },
        { ...extra, formulario: { cuerpo, cta: 'Continuar pedido' } });
    }
  }
  return resp(paso, tipo, { tipo: 'recepcion_respuesta', texto, acciones: [], sinSaludo: true,
    pendiente: { tipo: 'recepcion', menu: 'botones' } }, extra);
}

const lista = (paso, tipo, estado, menu = 'informacion', texto = FRASES.INFORMACION_MENU) => resp(paso, tipo,
  { tipo: 'recepcion_informacion', texto, acciones: [], sinSaludo: true, pendiente: libre(estado) ? { tipo: 'recepcion', menu } : null });

// ── 5. EL ROUTER ──────────────────────────────────────────────────────────

/**
 * DECIDE el turno de TEXTO de un cliente con el modo encendido (ver la tabla
 * de §3 en ia-diseno.md). Devuelve:
 *
 *   { ruta: 'turno'|'existente'|'formulario'|'respuesta'|'persona'|'cerrado'|'silencio',
 *     respuesta, persona: {motivo, texto}|null, alerta: {motivo}|null,
 *     formulario: {aviso}|{cuerpo, cta}|null,
 *     recepcion: {paso, tipo, selector}, estadoRecepcion: {ultimo, en}|null,
 *     avisoEleccion?, fueraHorario? }
 *
 * `lectores` son perezosos: solo se llaman cuando la ruta los necesita.
 * `elegir(mensaje, entradas)` es el selector (solo modo «recepcionista»):
 * devuelve una DECISIÓN, nunca un texto.
 */
export async function decidirRecepcion(ctx) {
  const { selector = null, ...d } = await decidir(ctx);
  return { alerta: null, ...d, recepcion: { paso: d.paso, tipo: d.tipo, selector } };
}

async function decidir({
  ia, cfg = {}, reglas = {}, estado, mensaje = '', catalogo = [], metodosPago = [], modalidades = null,
  configTienda = null, estadoRestaurante = {}, cancelacionCatering = null, negocioId = null, telefono = null,
  lectores = {}, entradas = null, ahora = Date.now(), promociones = [], elegir = null,
}) {
  const cerrado = estadoRestaurante?.abierto === false;
  const carrito = !!estado?.carrito?.items?.length;
  const persona = (paso, motivo, base) => {
    const texto = cerrado && !PERSONA_SIN_HORA.includes(base) ? FRASES.PERSONA_CERRADO : base;
    return { ruta: 'persona', paso, tipo: motivo, respuesta: respuestaDeRescate(motivo, texto), persona: { motivo, texto },
      formulario: null, estadoRecepcion: null };
  };

  // R0 — el personal escribió hace poco: el bot no habla encima.
  const silencio = await decidirSilencio({ ia, mensaje, lectores });
  if (silencio) return silencio;

  // R1 — sin precondiciones no hay modo: una persona, nunca el modelo.
  if (!ia?.completo) {
    const clave = `${negocioId}|${(ia?.faltan || []).join(',')}`;
    if (!alertados.has(clave)) {
      alertados.add(clave);
      console.error(`[RECEPCION] ALERTA precondicion_falsa negocio=${negocioId} faltan=${(ia?.faltan || []).join(',')}`);
    }
    return persona('R1', MOTIVOS_RECEPCION.SIN_PRECONDICIONES, FRASES.PERSONA);
  }

  // R2 — una imagen (o un comprobante) la revisa el personal.
  if (traeImagen(mensaje)) return persona('R2', MOTIVOS_RECEPCION.IMAGEN, FRASES.PERSONA_IMAGEN);

  // R3 — una captura de evento por chat heredada.
  if (cancelacionCatering) return { ruta: 'existente', paso: 'R3', tipo: 'catering_cancelado', respuesta: null, persona: null,
    formulario: null, estadoRecepcion: null };
  if (estado?.evento) return persona('R3', 'SOLICITUD_EVENTO', FRASES.PERSONA_EVENTO);

  // R4 — queja, problema con el pago o reclamo por la espera.
  if (esProblemaDePago(mensaje)) return persona('R4', MOTIVOS_RECEPCION.QUEJA_PAGO, FRASES.PERSONA_QUEJA);
  if (esQueja(mensaje, reglas?.bot?.palabras_criticas)) {
    return persona('R4', motivoDeDineroOIncierto(mensaje) ? MOTIVOS_RECEPCION.QUEJA_PAGO : MOTIVOS_RECEPCION.QUEJA,
      FRASES.PERSONA_QUEJA);
  }
  if (esRetraso(mensaje) && confirmado(estado)) return persona('R4', MOTIVOS_RECEPCION.RETRASO, FRASES.PERSONA_RETRASO);

  // R5 — pide una persona; vacantes y proveedores.
  if (pideHablarConPersona(mensaje)) return persona('R5', MOTIVOS_RECEPCION.PIDE_PERSONA, FRASES.PERSONA);
  if (esVacanteOProveedor(mensaje)) return persona('R5', MOTIVOS_RECEPCION.OTRO, FRASES.PERSONA_OTRO);

  // R6 — no puede usar el formulario. El rescate de hoy (FORMULARIO_NO_CARGA)
  // tal cual; además, la queja amplia si le llegó un formulario de pedido.
  const rescate = await rescateAntesDelModelo({ cfg, estado, mensaje, interaccion: null,
    formularioReciente: lectores.formularioRescate || (async () => false) });
  if (rescate) return persona('R6', rescate.motivo, rescate.texto);
  if (noPuedeUsarFormulario(mensaje) && await (lectores.formularioReciente?.() ?? false) === true) {
    return persona('R6', MOTIVOS_RECEPCION.NO_PUEDE, FRASES.PERSONA_PEDIDO);
  }

  // R-turno — lo que el turno del Mesero sigue haciendo sin el modelo: la
  // cortesía tras el pedido, cancelar el borrador (D1) y el «sí» al resumen
  // (D2, ligado a su huella). Con el local cerrado no se confirma nada.
  if (cortesiaPostPedido({ estado, mensaje })) return { ruta: 'turno', paso: 'R-turno', tipo: 'cortesia', respuesta: null,
    persona: null, formulario: null, estadoRecepcion: null };
  if (!estado?.folio && !estado?.evento && puedeRecuperarSinEfectos(estado) && autorizaCancelacion(mensaje)) {
    return { ruta: 'turno', paso: 'R-turno', tipo: 'D1', respuesta: null, persona: null, formulario: null, estadoRecepcion: null };
  }
  if (!cerrado && estado?.pendiente?.tipo === 'confirmar_resumen' && !/[?¿]/.test(mensaje)
    && String(mensaje).split('\n').filter((l) => l.trim()).length <= 1 && esConfirmacionVerbal(mensaje)) {
    return { ruta: 'turno', paso: 'R-turno', tipo: 'D2', respuesta: null, persona: null, formulario: null, estadoRecepcion: null };
  }

  const contextoForm = { catalogo, modalidades, metodosPago, reglas, cfg, telefono, promociones };

  // R-cortesía — un agradecimiento o un acuse («gracias», «ok», «Listo», «👍»)
  // sin una pregunta abierta que lo reclame (el resumen y las opciones siguen
  // sus pasos). No es una duda ni un pedido: nunca «no te entendí» ni una
  // persona por insistir (c69889eec, cda850980).
  if (esAcuse(mensaje) && !PENDIENTES_QUE_ESPERAN_RESPUESTA.has(estado?.pendiente?.tipo)) {
    return cortesia({ estado, cerrado, ahora, contextoForm });
  }

  const catalogoResp = entradas || catalogoDeRespuestas({ reglas, cfg, metodosPago, modalidades, estadoRestaurante }).entradas;
  const fija = buscarRespuestaFija(mensaje, catalogoResp);

  // R8 — el estado del pedido, siempre con el tiempo estimado mientras no
  // sale (C-1). El de ESTA conversación por su folio; sin folio, los pedidos
  // activos del teléfono (los del personal o de la tienda también). Sin
  // ninguno, «ya hice mi pedido» lo confirma una persona (nunca «no veo tu
  // pedido»: c64517ec9, ca5f9d2be) y «¿tiempo de entrega?» sigue a R11.
  if (esConsultaDeEstado(mensaje) || dicePedidoHecho(mensaje)) {
    if (confirmado(estado)) {
      const actual = await (lectores.estadoOperativo?.(estado.folio) ?? null);
      const texto = respuestaOperativaVerificada(estado, actual, reglas);
      if (texto) return resp('R8', 'estado', { tipo: 'recepcion_estado', texto, acciones: [], sinSaludo: true, pendiente: null });
    } else if (!estado?.folio) {
      let pedidos = null;
      try { pedidos = await (lectores.pedidosActivos?.() ?? null); } catch { pedidos = null; }
      if (Array.isArray(pedidos) && pedidos.length > MAX_PEDIDOS_EN_ESTADO) {
        return persona('R8', MOTIVOS_RECEPCION.RETRASO, FRASES.PERSONA_RETRASO);
      }
      if (Array.isArray(pedidos) && pedidos.length) {
        const lineas = pedidos.map((p) => textoEstadoDePedido(p, reglas, { pie: pedidos.length === 1 }));
        // Un estado sin etiqueta (pendiente de pago, programado…) no se adivina.
        if (!lineas.every(Boolean)) return persona('R8', MOTIVOS_RECEPCION.PEDIDO_EXTERNO, FRASES.PERSONA_PEDIDO_EXTERNO);
        const texto = pedidos.length === 1 ? lineas[0] : `${lineas.join('\n')}\n${PIE_ESTADO_DE_PEDIDO}`;
        return resp('R8', pedidos.length === 1 ? 'estado_telefono' : 'estado_telefono_varios',
          { tipo: 'recepcion_estado', texto, acciones: [], sinSaludo: true, pendiente: null });
      }
      if (dicePedidoHecho(mensaje)) return persona('R8', MOTIVOS_RECEPCION.PEDIDO_EXTERNO, FRASES.PERSONA_PEDIDO_EXTERNO);
      // Pregunta por SU pedido y no lo encontramos (lo hizo con otro número, por
      // teléfono, en el local…): lo confirma una persona; nunca «no te
      // entendí» (c89ba2c32: «solo para preguntar el estado de mi pedido»). Un
      // «¿tiempo de entrega?» sin pedido sigue a la respuesta de tiempos (R11).
      if (fija !== 'tiempos') return persona('R8', MOTIVOS_RECEPCION.PEDIDO_EXTERNO, FRASES.PERSONA_PEDIDO_EXTERNO);
    }
  }

  // R7 — cerrado impide pedidos inmediatos, pero no el seguimiento de uno
  // registrado. Solo se silencian saludos repetidos: una nueva orden o duda
  // necesita respuesta aunque ya se haya avisado el cierre en la última hora.
  if (cerrado) {
    const cerradoReciente = estado?.recepcion?.ultimo === 'cerrado' && reciente(estado.recepcion, ahora, MINUTOS_CERRADO_REPETIDO);
    const clase = clasificarIntencion({ mensaje, estado, catalogo,
      respuestaFija: () => (fija && fija !== 'informacion' ? fija : null) });
    const avisoPedido = ['pedido_escrito', 'cambiar'].includes(clase) ? FRASES.PEDIDO_ESCRITO_CERRADO : '';
    const aviso = construirAvisoFueraDeHorario({ estadoRestaurante, reglas, configTienda, recepcion: true });
    const marca = cerradoReciente ? estado.recepcion : estadoRec('cerrado', ahora);
    const entrada = fija && fija !== 'informacion' ? catalogoResp.find((e) => e.id === fija) : null;
    if (entrada && !avisoPedido) {
      // También una primera duda debe saber que no hay atención inmediata.
      // Un pedido con detalles y una pregunta no se toma como solo información.
      const informacion = await textoDeEntrada(entrada, { lectores, mensaje });
      return resp('R7', `fija:${fija}`, { tipo: 'recepcion_respuesta',
        texto: cerradoReciente ? informacion : `${aviso}\n\n${informacion}`,
        acciones: [], sinSaludo: true, pendiente: null }, { estadoRecepcion: marca });
    }
    if (cerradoReciente && esSaludo(mensaje)) {
      return { ruta: 'silencio', paso: 'R7', tipo: 'cerrado_repetido', respuesta: null, persona: null, alerta: null,
        formulario: null, estadoRecepcion: null };
    }
    const informacion = avisoPedido && entrada ? await textoDeEntrada(entrada, { lectores, mensaje }) : null;
    return { ruta: 'cerrado', paso: 'R7', tipo: 'cerrado', persona: null, formulario: null, fueraHorario: true,
      respuesta: { tipo: 'fuera_horario', acciones: [], sinSaludo: true,
        texto: avisoPedido + aviso + (informacion ? `\n\n${informacion}` : '') },
      estadoRecepcion: marca };
  }

  // R9 — un pedido para otro día: la tienda en línea, o una persona.
  if (esSolicitudDePedidoProgramado(mensaje, { hayPedidoEnCurso: carrito })) {
    const r = respuestaAPedidoProgramado({ configTienda, recepcion: true });
    if (r.escalar) return persona('R9', MOTIVOS_RECEPCION.PROGRAMADO, FRASES.PERSONA_PROGRAMADO);
    return resp('R9', 'programado_tienda', { tipo: 'recepcion_programado', texto: r.texto, acciones: [], sinSaludo: true,
      pendiente: libre(estado) ? { tipo: 'recepcion', menu: 'botones_hoy' } : null });
  }

  // R10 — quiere pedir, cambiar o ver la carta: el formulario. (También la
  // decisión «pedido» del selector, R13.)
  const alFormulario = async (paso, clase) => {
    if (['pedir', 'pedido_escrito'].includes(clase) && await (lectores.formularioReciente?.() ?? false) === true) {
      return persona(paso, MOTIVOS_RECEPCION.PEDIDO_ESCRITO, FRASES.PERSONA_PEDIDO);
    }
    if (!formularioDePedidoPosible({ ...contextoForm, estado })) {
      return persona(paso, MOTIVOS_RECEPCION.FORMULARIO_NO_DISPONIBLE,
        confirmado(estado) && ['cambiar', 'no_al_resumen'].includes(clase) ? FRASES.PERSONA_CONFIRMADO : FRASES.PERSONA_PEDIDO);
    }
    let aviso = FRASES[AVISO_DE_CLASE[clase]];
    const pendiente = carrito ? { tipo: 'editar_pedido' } : { tipo: 'agregar_otro' };
    const entrada = fija && fija !== 'informacion' ? catalogoResp.find(e => e.id === fija) : null;
    if (['pedido_escrito', 'cambiar'].includes(clase) && entrada) {
      const informacion = await textoDeEntrada(entrada, { lectores, mensaje });
      const completo = `${aviso}\n${informacion}\n\n`;
      const prueba = { ...estado, pendiente,
        dialogo: { ...(estado.dialogo || {}), ciclo: estado.conversacionId, texto: '·' } };
      const form = construirFormulario({ ...contextoForm, estado: prueba, texto: '·', aviso: completo,
        pedido: { huella: null, total: null, aclaraciones: [] } });
      // No se trunca la información aprobada ni se manda un Flow demasiado
      // largo. Tampoco se promete un formulario que no cabe: queda una vía
      // textual a una persona aun si no caben los botones de recepción.
      if (!form || form.texto.length > 1024) {
        return respuestaInformativa(`${FRASES.PEDIDO_ESCRITO_INFORMACION}\n\n${informacion}`, { estado, cerrado, paso,
          tipo: 'pedido_escrito_informacion' });
      }
      aviso = completo;
    }
    return { ruta: 'formulario', paso, tipo: clase, persona: null, estadoRecepcion: null,
      respuesta: { tipo: 'recepcion_formulario', texto: aviso.trim(), acciones: [], sinSaludo: true,
        pendiente },
      formulario: { aviso } };
  };
  let pideMenu = pideCarta;
  try {
    const { mensajePideMenu } = await import('../services/menuAutomatico.js');
    pideMenu = (m) => mensajePideMenu(m) || pideCarta(m);
  } catch { /* sin el módulo del menú, la regla propia */ }
  const clase = clasificarIntencion({ mensaje, estado, catalogo, pideMenu,
    respuestaFija: () => (fija && fija !== 'informacion' ? fija : null) });
  if (clase) return alFormulario('R10', clase);

  // R10b — contesta por texto una pregunta que tiene opciones (o la dirección).
  const pendiente = estado?.pendiente;
  if (['elegir_opcion', 'modalidad', 'pago', 'direccion'].includes(pendiente?.tipo) && !/[?¿]/.test(mensaje)) {
    if (['usa_opciones', 'no_reconocido'].includes(estado?.recepcion?.ultimo) && reciente(estado.recepcion, ahora, MINUTOS_INSISTE)) {
      return persona('R10b', MOTIVOS_RECEPCION.INSISTE, FRASES.PERSONA);
    }
    const misma = sinMeta(pendiente);
    const conFormulario = formularioDePedidoPosible({ ...contextoForm, estado, pendiente: misma });
    const conLista = interactivosActivos(cfg) && eleccionesActivas(cfg) && misma.tipo !== 'direccion'
      && opcionesInteractivas({ estado: { ...estado, pendiente: misma }, catalogo, modalidades, metodosPago, promociones }).length > 0;
    if (!conFormulario && !conLista) return persona('R10b', MOTIVOS_RECEPCION.FORMULARIO_NO_DISPONIBLE, FRASES.PERSONA_PEDIDO);
    return resp('R10b', `usa_opciones:${misma.tipo}`, { tipo: 'recepcion_usa_opciones', acciones: [], sinSaludo: true,
      texto: String(estado?.dialogo?.texto || '').trim() || FRASES.USA_OPCIONES.trim(), pendiente: misma },
    { formulario: { aviso: misma.tipo === 'direccion' ? FRASES.DIRECCION_EN_FORMULARIO : FRASES.USA_FORMULARIO },
      avisoEleccion: FRASES.USA_OPCIONES, estadoRecepcion: estadoRec('usa_opciones', ahora) });
  }

  // R11 — una duda con respuesta aprobada (o la lista «Información»).
  if (fija === 'informacion' && libre(estado)) return lista('R11', 'informacion', estado);
  const entrada = fija && fija !== 'informacion' ? catalogoResp.find((e) => e.id === fija) : null;
  if (entrada) {
    return respuestaInformativa(await textoDeEntrada(entrada, { lectores, mensaje }), { estado, cerrado, paso: 'R11', tipo: `fija:${fija}` });
  }

  // R12 — pregunta por un platillo: datos de la carta y el menú debajo.
  const deProducto = (paso, encontrados) => {
    const texto = respuestaDeProducto(mensaje, encontrados);
    if (libre(estado) && formularioDePedidoPosible({ ...contextoForm, estado })) {
      const cuerpo = carrito ? textoConsultaConCarrito(texto) : texto;
      if (cuerpo && cuerpo.length <= 1024) {
        return resp(paso, 'producto', { tipo: 'recepcion_producto', texto, acciones: [], sinSaludo: true,
          pendiente: carrito ? { tipo: 'editar_pedido' } : { tipo: 'agregar_otro' } },
        { formulario: carrito ? { cuerpo, cta: 'Continuar pedido' } : { cuerpo } });
      }
    }
    return resp(paso, 'producto', { tipo: 'recepcion_producto', texto, acciones: [], sinSaludo: true,
      pendiente: libre(estado) ? { tipo: 'recepcion', menu: 'botones' } : null });
  };
  const t = norm(mensaje);
  if (politicaDelTurno(mensaje).soloLectura || /^(?:hay|tienen)\b/.test(t)) {
    const encontrados = buscarProductos(catalogo, mensaje, { limite: 5 });
    if (encontrados.length) return deProducto('R12', encontrados);
    if (libre(estado)) {
      return resp('R12', 'producto_no_encontrado', { tipo: 'recepcion_producto', texto: FRASES.PRODUCTO_NO_ENCONTRADO,
        acciones: [], sinSaludo: true, pendiente: { tipo: 'recepcion', menu: 'botones' } });
    }
  }

  // R13 — modo «recepcionista»: el selector ELIGE entre lo aprobado (nunca
  // escribe). Publicado, su decisión toma la ruta de R10, R11, R12 o persona;
  // en sombra (sin whatsapp_ia_selector_publicar) solo queda registrada y el
  // cliente recibe lo mismo que en modo «formulario» (R14).
  let selector = null;
  if (ia.modo === 'recepcionista' && typeof elegir === 'function') {
    let sel = null;
    try { sel = await elegir(mensaje, catalogoResp); } catch { sel = null; }
    const elegida = typeof sel?.decision === 'string' ? sel.decision : 'ninguna';
    selector = { decision: elegida, confianza: sel?.confianza ?? null, ms: Number.isFinite(sel?.ms) ? sel.ms : null,
      error: sel ? (sel.error ?? null) : 'proveedor', publicada: ia.publicarSelector === true };
    if (selector.publicada) {
      let r = null;
      if (elegida === 'pedido') r = await alFormulario('R13', 'pedir');
      else if (elegida === 'persona') r = persona('R13', MOTIVOS_RECEPCION.PIDE_PERSONA, FRASES.PERSONA);
      else if (elegida === 'producto') {
        const encontrados = buscarProductos(catalogo, mensaje, { limite: 5 });
        if (encontrados.length) r = deProducto('R13', encontrados);
      } else if (!['ninguna', 'informacion'].includes(elegida)) {
        // Solo un id de ESTE turno: uno ajeno (o inventado) no contesta nada.
        const elegidaEntrada = catalogoResp.find((e) => e.id === elegida);
        if (elegidaEntrada) {
          r = respuestaInformativa(await textoDeEntrada(elegidaEntrada, { lectores, mensaje }),
            { estado, cerrado, paso: 'R13', tipo: `fija:${elegida}` });
        }
      }
      if (r) return { ...r, selector };
    }
  }

  // R14 — no reconocido.
  return { ...noReconocido({ estado, mensaje, ahora, persona }), selector };
}

// La pregunta abierta que un «sí» o un «ok» podría estar contestando: el
// resumen (D2) y las opciones (R10b) siguen sus propios pasos.
export const PENDIENTES_QUE_ESPERAN_RESPUESTA = Object.freeze(new Set(['confirmar_resumen', 'elegir_opcion', 'modalidad', 'pago', 'direccion']));
// Los pendientes cuyo último mensaje del bot fue un formulario de PEDIDO.
export const FORMULARIOS_DE_PEDIDO = Object.freeze(new Set(['agregar_otro', 'editar_pedido', 'configurar_pedido']));

/**
 * R-cortesía. Con el local cerrado: un texto fijo sin botones, o nada si ya se
 * le contestó en la última hora (el acuse de cerrado) o en la última media
 * hora (otra cortesía). Abierto, con un formulario de pedido en curso: el
 * mismo formulario otra vez con «¡Con gusto!» (cualquier texto del cliente
 * vence el que ya tenía: texto_posterior, interactivos.js). Si no: el texto de
 * cortesía, con los botones si el estado está libre, y una segunda cortesía
 * dentro de la media hora no recibe nada. Nunca guarda «no_reconocido».
 */
function cortesia({ estado, cerrado, ahora, contextoForm }) {
  const ultimo = estado?.recepcion?.ultimo;
  const nada = (tipo) => ({ ruta: 'silencio', paso: 'R-cortesia', tipo, respuesta: null, persona: null, alerta: null,
    formulario: null, estadoRecepcion: null });
  const repetida = ultimo === 'cortesia' && reciente(estado.recepcion, ahora, MINUTOS_INSISTE);
  const texto = (pendiente) => resp('R-cortesia', 'cortesia', { tipo: 'recepcion_cortesia', texto: FRASES.CORTESIA, acciones: [],
    sinSaludo: true, pendiente }, { estadoRecepcion: estadoRec('cortesia', ahora) });
  if (cerrado) {
    if (ultimo === 'cerrado' && reciente(estado.recepcion, ahora, MINUTOS_CERRADO_REPETIDO)) return nada('cortesia_cerrado');
    return repetida ? nada('cortesia_repetida') : texto(null);
  }
  const tipoForm = estado?.pendiente?.tipo;
  if (FORMULARIOS_DE_PEDIDO.has(tipoForm) && formularioDePedidoPosible({ ...contextoForm, estado, pendiente: { tipo: tipoForm } })) {
    return { ruta: 'formulario', paso: 'R-cortesia', tipo: 'cortesia_formulario', persona: null, estadoRecepcion: null,
      respuesta: { tipo: 'recepcion_formulario', texto: FRASES.CORTESIA_FORMULARIO.trim(), acciones: [], sinSaludo: true,
        pendiente: { tipo: tipoForm } },
      formulario: { aviso: FRASES.CORTESIA_FORMULARIO } };
  }
  if (repetida) return nada('cortesia_repetida');
  return texto(libre(estado) ? { tipo: 'recepcion', menu: 'botones' } : null);
}

function noReconocido({ estado, mensaje, ahora, persona }) {
  // Un saludo (que el inicio Mapo no tomó: tras el pedido, con un emoji que no
  // reconoce…) no es «no te entendí» ni insistir: no cuenta para la persona.
  if (esSaludo(mensaje)) {
    return libre(estado)
      ? resp('R14', 'saludo', { tipo: 'recepcion_saludo', texto: FRASES.SALUDO, acciones: [], sinSaludo: true,
        pendiente: { tipo: 'recepcion', menu: 'botones' } })
      : resp('R14', 'saludo_sin_botones', { tipo: 'recepcion_saludo', texto: SALUDO_SIN_BOTONES, acciones: [], sinSaludo: true,
        pendiente: null });
  }
  if (['no_reconocido', 'usa_opciones'].includes(estado?.recepcion?.ultimo) && reciente(estado.recepcion, ahora, MINUTOS_INSISTE)) {
    return persona('R14', MOTIVOS_RECEPCION.INSISTE, FRASES.PERSONA);
  }
  if (!libre(estado)) {
    // Tras el pedido no hay botones (el menú de inicio no vale con un folio).
    return resp('R14', 'no_reconocido_sin_botones', { tipo: 'recepcion_no_reconocido', texto: NO_RECONOCIDO_SIN_BOTONES,
      acciones: [], sinSaludo: true, pendiente: null }, { estadoRecepcion: estadoRec('no_reconocido', ahora) });
  }
  return resp('R14', 'no_reconocido', { tipo: 'recepcion_no_reconocido', texto: FRASES.NO_RECONOCIDO, acciones: [], sinSaludo: true,
    pendiente: { tipo: 'recepcion', menu: 'botones' } }, { estadoRecepcion: estadoRec('no_reconocido', ahora) });
}

// Tras un pedido confirmado no hay botones que ofrecer: el texto lleva el camino a una persona.
export const NO_RECONOCIDO_SIN_BOTONES = 'Perdón, no te entendí bien. 🙏 Si necesitas algo de tu pedido, escribe «hablar con alguien».';

// ── 6. TOQUES («Información», un tema, «Más preguntas») ───────────────────

const VALOR_RECEPCION = /^(?:informacion|mas_preguntas|info:[a-z0-9_:]{1,40})$/;
export const esValorDeRecepcion = (valor) => VALOR_RECEPCION.test(String(valor || ''));

/** ¿Este valor de un botón menu_mapo es de recepción y vale para este cliente? */
export function valorDeRecepcionVigente(valor, { cfg, telefono } = {}) {
  return esValorDeRecepcion(valor) && !!modoIA(cfg, telefono)?.completo;
}

/**
 * El toque de un botón de recepción (menu_mapo con un valor propio). «Hacer
 * pedido» (ordenar) y «Hablar con alguien» (humano) los atiende el canal como
 * hoy. `vencido`: el toque llegó como aviso (botón viejo).
 */
export async function respuestaDeToqueRecepcion({ valor, vencido = false, estado, cerrado = false, entradas = [],
  lectores = {} } = {}) {
  const decide = (paso, tipo, r) => ({ ...r, recepcion: { paso, tipo, selector: null } });
  if (vencido) {
    return decide('toque', 'vencido', resp('toque', 'vencido', { tipo: 'recepcion_reintento', texto: FRASES.MENU_CAMBIO,
      acciones: [], sinSaludo: true, pendiente: libre(estado) && !cerrado ? { tipo: 'recepcion', menu: 'botones' } : null }));
  }
  if (valor === 'informacion') return decide('toque', 'informacion', lista('toque', 'informacion', estado));
  if (valor === 'mas_preguntas') return decide('toque', 'mas_preguntas', lista('toque', 'mas_preguntas', estado, 'informacion_2'));
  const id = String(valor || '').replace(/^info:/, '');
  const entrada = entradas.find((e) => e.id === id);
  if (!entrada) return decide('toque', 'info_cambio', lista('toque', 'info_cambio', estado, 'informacion', FRASES.INFO_CAMBIO));
  const texto = await textoDeEntrada(entrada, { lectores, mensaje: entrada.id === 'promociones' ? 'promociones de hoy' : '' });
  return decide('toque', `info:${id}`, respuestaInformativa(texto, { estado, cerrado, paso: 'toque', tipo: `info:${id}` }));
}

// ── 7. LOS BOTONES Y LA LISTA ─────────────────────────────────────────────

export const MAX_FILAS = 10;
/** Las filas de cada lista: la primera (9 + «Más preguntas» si no caben) y la segunda (solo preguntas frecuentes). */
export function filasDeInformacion(entradas = [], menu = 'informacion') {
  const todas = entradas.map((e) => ({ valor: `info:${e.id}`, title: e.titulo, description: e.descripcion || '' }));
  if (menu === 'informacion_2') return todas.slice(MAX_FILAS - 1).slice(0, MAX_FILAS);
  if (todas.length <= MAX_FILAS) return todas;
  return [...todas.slice(0, MAX_FILAS - 1), { valor: 'mas_preguntas', title: 'Más preguntas', description: 'Otras preguntas frecuentes' }];
}

/**
 * Los botones «Hacer pedido · Información · Hablar con alguien» o la lista de
 * temas, como un preparado para confirmarTurno (mismo formato que
 * construirInicioMapo). null si no aplica: el commit sigue con lo de hoy.
 */
export function construirRecepcion({ estado, pedido, texto, cfg, telefono, entradas = [] }) {
  if (!modoIA(cfg, telefono)?.completo || estado?.pendiente?.tipo !== 'recepcion' || !libre(estado)
    || estado.dialogo?.texto !== texto || estado.dialogo?.ciclo !== estado.conversacionId
    || !texto || texto.length > 1024) return null;
  const token = () => `xb1:${randomBytes(16).toString('base64url')}`;
  const base = { preguntaId: randomUUID(), ciclo: estado.conversacionId, dialogoId: estado.dialogo.id,
    huella: pedido?.huella ?? null, total: pedido?.total ?? null, texto, textoFallback: `${texto}\n\n${PIE_SIN_BOTONES}` };
  const menu = estado.pendiente.menu;
  if (menu === 'botones' || menu === 'botones_hoy') {
    const carrito = !!estado.carrito?.items?.length;
    const opciones = [
      { valor: 'ordenar', title: menu === 'botones_hoy' ? 'Pedir para hoy' : carrito ? 'Continuar pedido' : 'Hacer pedido' },
      { valor: 'informacion', title: 'Más información' },
      { valor: 'humano', title: 'Hablar con alguien' },
    ];
    const botones = opciones.map((o) => ({ token: token(), accion: 'menu_mapo', title: o.title, datos: { valor: o.valor } }));
    return { ...base, botones, carga: { type: 'button', body: { text: texto }, action: {
      buttons: botones.map((b) => ({ type: 'reply', reply: { id: b.token, title: b.title } })) } } };
  }
  const filas = filasDeInformacion(entradas, menu);
  if (!filas.length) return null;
  const botones = filas.map((f) => ({ token: token(), accion: 'menu_mapo', title: f.title, description: f.description,
    datos: { valor: f.valor } }));
  return { ...base, botones, carga: { type: 'list', body: { text: texto }, action: { button: 'Ver temas',
    sections: [{ title: 'Información', rows: botones.map((b) => ({ id: b.token, title: b.title,
      ...(b.description ? { description: b.description } : {}) })) }] } } };
}

// ── 8. EL SIMULADOR DEL PANEL ─────────────────────────────────────────────

/**
 * El modo para el simulador del módulo Asistente: muestra lo que vería un
 * cliente DEL ALCANCE, así que una prueba por teléfonos cuenta como «todos».
 */
export function modoIAParaSimulador(cfg) {
  const alcance = cfg?.[CLAVES_IA.ALCANCE] === 'prueba' ? 'todos' : cfg?.[CLAVES_IA.ALCANCE];
  return modoIA({ ...(cfg || {}), [CLAVES_IA.ALCANCE]: alcance }, null);
}

/** El CTA del formulario de pedido que saldría para ese estado, o null. */
export function ctaDeFormularioDePedido({ estado, cfg, telefono = null, pendiente = null, ...ctx }) {
  if (!estado) return null;
  const tipo = pendiente || (estado.carrito?.items?.length ? { tipo: 'editar_pedido' } : { tipo: 'agregar_otro' });
  const prueba = { ...estado, pendiente: tipo, dialogo: { ...(estado.dialogo || {}), ciclo: estado.conversacionId, texto: '·' } };
  const f = construirFormulario({ ...ctx, estado: prueba, pedido: { huella: null, total: null, aclaraciones: [] }, texto: '·', cfg, telefono });
  return f?.carga?.action?.parameters?.flow_cta || null;
}

/**
 * Lo interactivo que acompañaría a la respuesta y, en modo «recepcionista»,
 * lo que eligió el selector (solo el simulador del panel).
 */
export function describirParaSimulador(decision, ctx = {}) {
  const sel = decision?.recepcion?.selector;
  const linea = sel ? `[Selector${sel.publicada ? '' : ' (sombra)'}: ${sel.decision}${sel.error ? ` · ${sel.error}` : ''}]` : '';
  return [describirInteractivo(decision, ctx), linea].filter(Boolean).join('\n');
}

function describirInteractivo(decision, { estado, cfg, entradas = [], ...ctx } = {}) {
  if (!decision) return '';
  if (decision.ruta === 'persona') return `[Pasa a una persona: ${decision.persona?.motivo}]`;
  const p = decision.respuesta?.pendiente;
  if (decision.formulario?.cta || ['agregar_otro', 'editar_pedido'].includes(p?.tipo)) {
    const cta = decision.formulario?.cta || ctaDeFormularioDePedido({ ...ctx, estado, cfg, pendiente: p });
    return cta ? `[Formulario: ${cta}]` : '[Botones: Hacer pedido · Más información · Hablar con alguien]';
  }
  if (p?.tipo !== 'recepcion') return '';
  if (p.menu === 'botones' || p.menu === 'botones_hoy') {
    const primero = p.menu === 'botones_hoy' ? 'Pedir para hoy' : estado?.carrito?.items?.length ? 'Continuar pedido' : 'Hacer pedido';
    return `[Botones: ${primero} · Más información · Hablar con alguien]`;
  }
  return `[Lista: ${filasDeInformacion(entradas, p.menu).map((f) => f.title).join(' · ')}]`;
}

/** La marca de la recuperación del turno: 'recepcion:<paso>:<tipo>' (≤ 120). */
export function recuperacionDeRecepcion(recepcion, previa = null) {
  if (!recepcion) return previa;
  const sel = recepcion.selector ? `:sel=${recepcion.selector.decision}${recepcion.selector.publicada ? '' : '(sombra)'}` : '';
  return `recepcion:${recepcion.paso}:${recepcion.tipo}${sel}${previa ? `|${previa}` : ''}`.slice(0, 120);
}
