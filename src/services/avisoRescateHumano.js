/**
 * avisoRescateHumano.js — cuando el agente pasa una conversación a una
 * persona, el equipo se entera EN ESE MOMENTO.
 *
 * INCIDENTE QUE LO ORIGINA (2-oct-2026, Mapolato Obispado): el bot falló dos
 * veces, el cliente escribió «No carga» y se fue. Aunque el agente hubiera
 * pasado la conversación, el aviso al equipo era pasivo: `escalarAHumano` del
 * agente (whatsapp-meta.js) solo pausa el bot y emite `bot_pausado` (que el
 * panel solo usa para refrescar el chat ABIERTO, y que el operador no recibe)
 * y `alerta_transaccional` (que el panel no maneja). No manda WhatsApp al
 * encargado ni push. El cliente esperaba a alguien que nadie sabía que existía.
 *
 * Se llama desde UN solo punto, `avisarAHumano` (canalDelAgente.js), después
 * de que la pausa quedó confirmada. Así cubre todos los escalados del agente
 * —los dos motivos de rescate, `pedir_humano`, el menú de inicio, la frase
 * prohibida, la afirmación sin guardar, el evento, el enlace de pago que
 * falló— y no solo los nuevos.
 *
 * Mismo criterio que rescateConversaciones.js: solo AVISA. No responde por
 * nadie, no toca la pausa ni el pedido. Sus efectos se inyectan desde
 * server.js (sin importar whatsapp-meta.js, que es protegido y causaría un
 * ciclo de módulos). Nunca lanza: lo peor que puede pasar aquí es que no
 * llegue un aviso, jamás que se caiga el turno del cliente.
 *
 * QUÉ GARANTIZA Y QUÉ NO (revisión del 3-oct; antes decía «nunca uno
 * perdido», y no era cierto). Es un aviso de MEJOR ESFUERZO, en memoria:
 *   · se pierde si el proceso se reinicia entre la pausa y el envío;
 *   · el push y el WhatsApp pueden no llegar (suscripción vencida, Meta
 *     rechaza el texto libre fuera de la ventana de 24 h): solo queda el log;
 *   · si el handoff mismo revienta y whatsapp-meta.js (protegido) recurre a
 *     `pasarAgenteARevision(AGENTE_NO_PUDO_ATENDER)`, ese camino no pasa por
 *     aquí: sale su WhatsApp de siempre (avisarEquipoRevision), sin evento
 *     al panel ni push (fase 2).
 * Lo DURABLE es la pausa: `whatsapp_conversaciones.requiere_revision`, que el
 * panel muestra en Chats como «⚠ Requiere revisión» al entrar al sistema. Es
 * también la vía que prefiere el dueño (3-oct): los avisos se revisan al
 * entrar, no por WhatsApp; por eso el WhatsApp al encargado va detrás de su
 * propia bandera, apagada.
 *
 * Detrás de `whatsapp_rescate_humano_v1` (por negocio, apagada por omisión).
 */

import { createHmac, randomBytes } from 'node:crypto';
import { pool, obtenerConfiguracion } from './database.js';
import { telefonoEnmascarado } from './rescateConversaciones.js';
import { BANDERA_RESCATE, MOTIVOS_RESCATE } from '../mesero-agente/rescateHumano.js';

/** Las claves de aviso se sueltan a las 6 horas, como en rescateConversaciones. */
export const TTL_AVISO_MS = 6 * 60 * 60 * 1000;
/** Lo más que el turno del cliente espera la DECISIÓN del aviso (nunca el envío). */
export const ESPERA_MAX_DECISION_MS = 2000;
/**
 * El WhatsApp al encargado (`wa_admin_numero`). Apagado por omisión: el dueño
 * prefiere revisar los avisos al entrar al sistema. Sin ella, el aviso es el
 * evento del panel y su push.
 */
export const BANDERA_AVISO_WHATSAPP = 'whatsapp_rescate_aviso_whatsapp_v1';
const EXTRACTO = 120;

// Lo que lee el encargado. Las etiquetas de whatsapp-meta.js (ETIQUETA_MOTIVO)
// no cubren los motivos del agente y ese archivo es protegido: estas son las
// del agente, en el mismo tono.
const ETIQUETAS = {
  [MOTIVOS_RESCATE.FALLO_REPETIDO]: 'el bot falló dos veces seguidas con este cliente',
  [MOTIVOS_RESCATE.FORMULARIO_NO_CARGA]: 'el cliente dice que el formulario no le abre',
  // La herramienta `pedir_humano`: la decide el modelo, a veces porque el
  // cliente lo pidió y a veces porque no supo seguir. Se dice solo lo cierto.
  AGENTE_PIDE_HUMANO: 'el asistente pasó la conversación a una persona',
  AGENTE_RESPUESTA_PROHIBIDA: 'la respuesta del bot traía una frase que el negocio prohibió',
  AGENTE_AFIRMO_CAMBIO_SIN_GUARDAR: 'el bot dijo que hizo un cambio que no quedó guardado',
  SOLICITUD_EVENTO: 'el cliente pidió un evento o catering',
  SOLICITUD_EVENTO_RESPUESTA_PROHIBIDA: 'la solicitud de evento necesita revisión humana',
  AGENTE_ENLACE_PAGO_FALLO: 'no se pudo crear el enlace de pago del pedido',
  AGENTE_ESTADO_INCIERTO: 'no se sabe si el pedido quedó registrado: revisen antes de registrarlo otra vez',
  AGENTE_CONFIRMACION_INCIERTA: 'no se sabe si el pedido quedó registrado: revisen antes de registrarlo otra vez',
  AGENTE_HANDOFF_PENDIENTE: 'el bot no pudo pasar la conversación a la primera',
  FACTURACION_REVISION_HUMANA: 'el cliente pidió factura',
};
// El menú de inicio («Otra duda · Hablar con una persona») llega con el mismo
// AGENTE_PIDE_HUMANO (solicitudesServicio.js), pero ahí lo pidió el CLIENTE.
const ETIQUETAS_DEL_CLIENTE = {
  AGENTE_PIDE_HUMANO: 'el cliente pidió hablar con una persona',
};
export const etiquetaDeMotivo = (motivo, origen = null) =>
  (origen === 'cliente' && ETIQUETAS_DEL_CLIENTE[motivo])
  || ETIQUETAS[motivo] || 'el bot pasó la conversación a una persona';

export function textoDeAvisoHandoff({ telefono, motivo, mensaje = '', origen = null } = {}) {
  const extracto = String(mensaje || '').replace(/\s+/g, ' ').trim().slice(0, EXTRACTO);
  return `🙋 *Xabor*: un cliente necesita a una persona.\n\n`
    + `Cliente: ${telefonoEnmascarado(telefono)}\nMotivo: ${etiquetaDeMotivo(motivo, origen)}\n`
    + (extracto ? `Escribió: «${extracto}»\n` : '')
    + `\nEl bot ya no le va a contestar. Atiéndanlo desde el panel, en Chats, y al terminar `
    + `usen «Revisé y atendí los pendientes» para devolverlo al bot.`;
}

// Identidad de la conversación para agrupar las notificaciones en el teléfono
// (el `tag` del push, panel/sw.js): la misma para el mismo cliente, distinta
// entre clientes, y sin el teléfono (el evento también le llega al operador).
// HMAC con una sal de ESTE proceso: tras un reinicio cambia, y lo peor es una
// notificación más del mismo cliente.
const SAL_REFERENCIA = randomBytes(16);
export const referenciaDeConversacion = (negocioId, telefono) =>
  createHmac('sha256', SAL_REFERENCIA).update(`${negocioId}:${telefono}`).digest('hex').slice(0, 16);

// El episodio de espera de la conversación: `revision` y `motivo`.
//
// OJO (revisión del 3-oct): ni `revision` ni `actualizado_at` cambian SOLO al
// entrar en revisión. `ejecutar` (whatsappContinuidad.js) les suma uno / los
// pone en now() al cerrar CADA lote, también el que acaba de escalar. Por eso
// esta lectura no va en la parte asíncrona del aviso: `avisarAHumano` la
// ESPERA dentro del turno, antes de que ese lote cierre, y dos handoffs del
// mismo turno leen el mismo valor. Toda liberación (Revisé y atendí, el
// vencimiento de pausas, `soltar`) suma uno a `revision`: un episodio nuevo
// siempre trae otra clave. El `motivo` de la fila separa el único caso en que
// la misma revisión cambia de causa a propósito (AGENTE_ESTADO_INCIERTO, que
// `enviarARevision` deja reescribir para que el panel se entere).
async function leerRevisionVigente(negocioId, telefono) {
  const { rows: [r] } = await pool.query(
    `SELECT requiere_revision, revision, motivo FROM whatsapp_conversaciones
      WHERE negocio_id = $1 AND telefono = $2`, [negocioId, telefono]);
  return r || null;
}

let _efectos = null;
const _avisados = new Map();
const _enCurso = new Set();

/**
 * Se llama una vez al arrancar (server.js). Sin esto, avisar no hace nada:
 * las pruebas, la sombra y los replays no mandan avisos a nadie.
 */
export function configurarAvisoRescate({
  broadcastPanel = null, enviarAvisoWhatsapp = null,
  leerConfiguracion = obtenerConfiguracion, leerRevision = leerRevisionVigente,
  log = console.warn, reloj = () => Date.now(), esperaMaxMs = ESPERA_MAX_DECISION_MS,
} = {}) {
  _efectos = { broadcastPanel, enviarAvisoWhatsapp, leerConfiguracion, leerRevision, log, reloj, esperaMaxMs };
}

/** Solo para pruebas. */
export function reiniciarAvisoRescate() { _efectos = null; _avisados.clear(); _enCurso.clear(); }
/** Solo para pruebas: espera los avisos que salieron sin await (también los que salen después). */
export async function esperarAvisosEnCurso() {
  while (_enCurso.size) await Promise.allSettled([..._enCurso]);
}
function seguir(p) {
  _enCurso.add(p);
  p.finally(() => _enCurso.delete(p)).catch(() => {});
  return p;
}

/**
 * Un aviso por episodio de revisión, no uno por llamada: la clave lleva la
 * `revision` de la conversación y el `motivo` con que quedó (ver
 * leerRevisionVigente). En memoria y con TTL: con varias instancias, o si la
 * decisión tardó más que su tope y leyó la revisión después del cierre del
 * lote, el peor caso es un aviso repetido.
 */
export function claveDeAvisoHandoff({ negocioId, telefono, revision, motivoRevision }) {
  return `${negocioId ?? ''}:${telefono ?? ''}:${revision ?? ''}:${motivoRevision ?? ''}`;
}
function reclamarAviso(clave, ahora) {
  for (const [k, t] of _avisados) if (ahora - t > TTL_AVISO_MS) _avisados.delete(k);
  if (_avisados.has(clave)) return false;
  _avisados.set(clave, ahora);
  return true;
}

const banderaEncendida = (cfg, clave) => String(cfg?.[clave] ?? '') === 'true';

// LA DECISIÓN: bandera, revisión vigente y clave reclamada. Es lo único que
// el turno espera.
async function decidir({ negocioId, telefono, cfg = null }) {
  const ef = _efectos;
  if (!ef) return { avisado: false, motivo: 'sin_configurar' };
  // Sin negocio no se lee configuración: obtenerConfiguracion caería al
  // negocio por omisión y avisaría al encargado equivocado.
  if (typeof negocioId !== 'string' || !negocioId.trim() || !telefono) return { avisado: false, motivo: 'sin_negocio' };
  // La configuración del turno la pasa el canal: con la bandera apagada no se
  // hace NINGUNA lectura. Solo quien no la trae paga la consulta.
  const config = cfg && typeof cfg === 'object' ? cfg : await ef.leerConfiguracion(negocioId);
  if (!banderaEncendida(config, BANDERA_RESCATE)) return { avisado: false, motivo: 'bandera_apagada' };
  const revision = await ef.leerRevision(negocioId, telefono);
  // Si ya no está en revisión, alguien la atendió entre la pausa y aquí.
  if (revision?.requiere_revision !== true) return { avisado: false, motivo: 'sin_revision' };
  const clave = claveDeAvisoHandoff({ negocioId, telefono, revision: revision.revision, motivoRevision: revision.motivo });
  if (!reclamarAviso(clave, ef.reloj())) return { avisado: false, motivo: 'ya_avisado' };
  return { avisado: true, ef, config };
}

// EL ENVÍO: sin que nadie lo espere.
async function enviar({ ef, config }, { negocioId, telefono, motivo, mensaje = '', origen = null }) {
  ef.log(`[RESCATE] evento=aviso_handoff negocio=${negocioId} telefono=${telefonoEnmascarado(telefono)} motivo=${motivo}`);
  // El panel primero, SIN el texto del cliente: este evento también le llega
  // al operador (staff), que no ve chats. server.js le cuelga el push, con un
  // tag por conversación (`ref`).
  if (typeof ef.broadcastPanel === 'function') {
    try {
      ef.broadcastPanel(negocioId, { tipo: 'rescate_humano', telefono: telefonoEnmascarado(telefono),
        motivo, razon: etiquetaDeMotivo(motivo, origen), ref: referenciaDeConversacion(negocioId, telefono) });
    } catch (e) { ef.log(`[RESCATE] panel: ${e?.message}`); }
  }
  // WhatsApp al encargado, solo si el negocio lo pidió (bandera aparte).
  if (banderaEncendida(config, BANDERA_AVISO_WHATSAPP) && typeof ef.enviarAvisoWhatsapp === 'function'
    && config?.wa_admin_numero) {
    try {
      await ef.enviarAvisoWhatsapp(config.wa_admin_numero,
        textoDeAvisoHandoff({ telefono, motivo, mensaje, origen }), negocioId);
    } catch (e) { ef.log(`[RESCATE] whatsapp: ${e?.message}`); }
  }
}

const logDelAviso = (e) => {
  try { (_efectos?.log || console.warn)(`[RESCATE] aviso fallido (no afecta al bot): ${e?.message}`); } catch { /* nada */ }
};

/**
 * Avisa al equipo. NUNCA rechaza: cualquier error termina en el log.
 *
 * Se cumple en cuanto el aviso quedó DECIDIDO (bandera, revisión y clave), o
 * al vencer `esperaMaxMs`, lo que pase primero: el cliente no espera más que
 * eso, y una decisión lenta sigue sola. El ENVÍO nunca se espera; las
 * pruebas lo alcanzan con `esperarAvisosEnCurso`. Aun sin await, todo lleva
 * su `.catch`: sin unhandledRejection global, una promesa rechazada sin dueño
 * tumba el proceso.
 *
 * `datos`: { negocioId, telefono, motivo, mensaje?, origen?, cfg? }.
 */
export function avisarEquipoDeHandoff(datos = {}) {
  const decision = seguir(decidir(datos).then((d) => {
    if (!d.avisado) return d;
    seguir(enviar(d, datos).catch(logDelAviso));
    return { avisado: true };
  }).catch((e) => { logDelAviso(e); return { avisado: false, motivo: 'error' }; }));
  const tope = Number(_efectos?.esperaMaxMs) >= 0 ? Number(_efectos.esperaMaxMs) : ESPERA_MAX_DECISION_MS;
  let reloj = null;
  const plazo = new Promise((resolver) => {
    reloj = setTimeout(() => resolver({ avisado: false, motivo: 'decision_en_curso' }), tope);
    reloj.unref?.();
  });
  return Promise.race([decision, plazo]).finally(() => clearTimeout(reloj));
}
