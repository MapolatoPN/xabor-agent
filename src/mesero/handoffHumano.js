// ─── Cuándo llamar a una persona, y qué dejarle ───────────────────────────
//
// Módulo puro. Decide si este turno debe salir del bot, y arma el traspaso.
//
// ── No se inventa un mecanismo nuevo ─────────────────────────────────────
//
// Xabor ya tiene tres formas de que el bot calle: `bot_pausado` por cliente, el
// takeover humano de la Business App, y `enviarARevision` de la continuidad —
// que pausa, marca la conversación y avisa al panel en vivo. Esa última es la
// que usa el canal cuando algo no cuadra, y es la que se usa aquí. Escribir un
// cuarto camino habría dejado cuatro sitios donde el bot puede callarse y solo
// tres donde alguien lo sabe.
//
// Lo que este módulo aporta no es el mecanismo: es el CRITERIO y el EQUIPAJE.
//
// ── El equipaje ──────────────────────────────────────────────────────────
//
// Cuando una persona toma la conversación, lo que necesita no es el historial
// —ya lo ve en el panel— sino lo que el bot había entendido: qué pedido llevaba
// provisional, qué quedaba pendiente, qué acababa de preguntar. Sin eso, quien
// entra empieza de cero delante de un cliente que ya lo dijo todo.
import { resumenDelPedido } from './resumenDelPedido.js';
import { resumenDelContexto } from './contextoMesa.js';

export const MOTIVOS = Object.freeze({
  SOLICITUD_CLIENTE: 'el cliente pidió hablar con una persona',
  QUEJA: 'una queja',
  DEVOLUCION: 'una devolución o un reembolso',
  PEDIDO_PREVIO: 'un pedido anterior',
  FUERA_DE_ALCANCE: 'algo que el asistente no cubre',
  DEMASIADAS_ACLARACIONES: 'demasiadas idas y vueltas sin entenderse',
  ERROR: 'un error del asistente',
  CLIENTE_MOLESTO: 'un cliente molesto',
});

const norm = (s) => String(s || '')
  .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9ñ ]/g, ' ').replace(/\s+/g, ' ').trim();

// Vocabulario de MALESTAR, no de productos. Es lo mismo que ya hace
// `solicitaAtencionHumana` en el canal; aquí se cubren los casos que no son una
// petición explícita.
const QUEJA = /\b(queja|quejar|reclamo|reclamar|pesimo|p[eé]simo|horrible|asqueroso|malisimo|mal[ií]simo|no llego|nunca llego|frio|fr[ií]o|crudo|equivocado|se equivocaron|me cobraron de mas|cobro de mas|mal servicio|pesima atencion)\b/;
const DEVOLUCION = /\b(devolucion|devoluci[oó]n|reembolso|regresenme|regr[eé]senme mi dinero|me devuelven|quiero mi dinero|cancelen y devuelvan)\b/;
const PEDIDO_PREVIO = /\b(mi pedido de ayer|el pedido pasado|la vez pasada me|el de la semana pasada|folio|xab-)\b/;
const MOLESTO = /\b(estoy molesto|estoy enojado|es el colmo|ya basta|inaceptable|no puede ser|llevo esperando|una hora esperando|nadie contesta)\b/;

/** Cuántas aclaraciones seguidas sin avanzar se aguantan antes de llamar a alguien. */
export const TOPE_ACLARACIONES = 3;

/**
 * ¿Hay que pasar esta conversación a una persona?
 *
 * Devuelve `{ escalar, motivo, etiqueta }`. `motivo` es una de las claves de
 * `MOTIVOS`, que son las que ya entiende el panel a través de la continuidad.
 */
export function decidirHandoff({ texto = '', intenciones = [], contexto = null, huboError = false } = {}) {
  const t = norm(texto);
  const no = { escalar: false, motivo: null, etiqueta: null };
  const si = (motivo) => ({ escalar: true, motivo, etiqueta: MOTIVOS[motivo] });

  if (huboError) return si('ERROR');
  if (intenciones.includes('PEDIR_HUMANO')) return si('SOLICITUD_CLIENTE');
  if (DEVOLUCION.test(t)) return si('DEVOLUCION');
  if (QUEJA.test(t)) return si('QUEJA');
  if (MOLESTO.test(t)) return si('CLIENTE_MOLESTO');
  if (PEDIDO_PREVIO.test(t)) return si('PEDIDO_PREVIO');

  // Demasiadas idas y vueltas: el bot pregunta, el cliente contesta, el bot
  // vuelve a preguntar lo mismo. Se cuenta por INSISTENCIAS sobre el mismo
  // pendiente, no por número de turnos: una conversación larga y que avanza no
  // es un problema.
  const insistidas = (contexto?.pendientes || []).filter((p) => (p.veces || 1) >= TOPE_ACLARACIONES);
  if (insistidas.length) return si('DEMASIADAS_ACLARACIONES');

  return no;
}

/**
 * Lo que se le deja a quien entra.
 *
 * Sin el historial —el panel ya lo enseña— y sin datos personales de más: lo
 * que el bot ENTENDIÓ, que es justo lo que no se ve leyendo el chat.
 */
export function equipajeDelHandoff({ contexto = null, carrito = null, motivo = null,
  ultimaPregunta = null, aclaraciones = [] } = {}) {
  const resumen = resumenDelPedido(carrito || { items: [] });
  return {
    motivo,
    etiqueta: motivo ? MOTIVOS[motivo] : null,
    fase: contexto?.fase || 'inicio',
    // Provisional, y se dice: nada de esto se registró como pedido.
    pedido_provisional: resumen.items.length ? resumen : null,
    pendientes: (contexto?.pendientes || []).map((p) => ({ que: p.clave, veces: p.veces || 1 })),
    aclaraciones_abiertas: (aclaraciones || []).map((a) => a.tipo),
    ultima_pregunta: ultimaPregunta || null,
    ofrecido_y_sin_contestar: (contexto?.propuestas || [])
      .filter((p) => p.estado === 'propuesto').map((p) => p.referencia),
    contexto: resumenDelContexto(contexto),
  };
}

/**
 * El aviso corto para el panel. Una línea, sin PII y sin el texto del cliente.
 *
 * El chat ya está en el panel: repetir aquí lo que dijo el cliente solo lo
 * duplicaría en un sitio más, con una copia más que borrar el día que alguien
 * pida que se borre.
 */
export function avisoParaElPanel(equipaje) {
  const partes = [`motivo=${equipaje?.motivo || 'desconocido'}`, `fase=${equipaje?.fase || 'inicio'}`];
  const n = equipaje?.pedido_provisional?.items?.length || 0;
  partes.push(`renglones_provisionales=${n}`);
  if (equipaje?.pendientes?.length) partes.push(`pendientes=${equipaje.pendientes.map((p) => p.que).join(',')}`);
  if (equipaje?.ultima_pregunta) partes.push(`ultima_pregunta=${equipaje.ultima_pregunta}`);
  return partes.join(' ');
}
