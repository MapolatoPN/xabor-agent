import { randomUUID } from 'node:crypto';
import { esConfirmacionVerbal } from '../agent/confirmacionVerbal.js';
import { mismaPalabraFlexible } from '../agent/mencionesComerciales.js';
import { respuestaDesdePedido } from './recuperacionDelTurno.js';

const normalizar = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

export function autorizaConfirmacion({ estado, mensaje, huella }) {
  const d = estado.dialogo;
  return !/[¿?]/.test(String(mensaje)) && esConfirmacionVerbal(mensaje) && d?.enviado === true
    && d.tipo === 'resumen' && d.huella === huella && d.ciclo === estado.conversacionId
    && !escritoAntesDelAcuse(estado);
}

// ── UNA RESPUESTA ESCRITA ANTES DE QUE LLEGARA LA PREGUNTA ───────────────
//
// El acuse dice que Meta ENTREGÓ la pregunta (el resumen, una oferta). Un
// mensaje que el cliente escribió ANTES de esa hora no la contesta: todavía no
// la veía. «ok» enviado mientras el resumen se armaba no confirma el pedido que
// después se le mostró. `acusadoAt` lo pone el acuse (reloj de la base) y
// `recibidoTurno` (no enumerable: no se persiste) lo pone el canal con la hora
// de recepción más temprana del lote, también del reloj de la base. Sin
// alguna de las dos no se puede afirmar nada y no se bloquea (transporte
// simulado, replays, estados anteriores).
export function escritoAntesDelAcuse(estado) {
  const acusado = Date.parse(estado?.dialogo?.acusadoAt || '');
  const recibido = Date.parse(estado?.recibidoTurno || '');
  return Number.isFinite(acusado) && Number.isFinite(recibido) && recibido < acusado;
}

/** Fija la recepción del lote para ESTE turno, sin que viaje al estado persistido. */
export function fijarRecepcionDelTurno(estado, recibidoAt) {
  if (!estado || !recibidoAt) return;
  const iso = recibidoAt instanceof Date ? recibidoAt.toISOString() : String(recibidoAt);
  Object.defineProperty(estado, 'recibidoTurno', { value: iso, enumerable: false, configurable: true, writable: true });
}

// ── CANCELAR TODO: una regla de gramática, no una lista de frases ────────
//
// Cancela el pedido completo un mensaje que (1) no es una pregunta, (2) trae
// un verbo de cancelar en imperativo o infinitivo SIN negación pegada («no
// canceles»), y (3) después del verbo solo nombra el pedido entero o cortesía:
// si nombra otra cosa («cancela el licuado») es quitar un renglón, no cancelar.
// Antes del verbo solo se admiten muletillas («mejor ya no, …», «oye, …»).
const VERBO_CANCELAR = /\b(?:cancela|cancelalo|cancelala|cancelame|cancelen|cancelenlo|cancelar|cancelarlo|cancelarla)\b/;
const OBJETO_TOTAL = new Set(['todo', 'el', 'mi', 'pedido', 'la', 'orden', 'por', 'favor', 'porfa', 'gracias',
  'ya', 'entonces', 'mejor', 'mismo', 'completo', 'toda']);
const PREFIJO_CANCELAR = new Set(['mejor', 'ya', 'no', 'oye', 'sabes', 'que', 'bueno', 'pues', 'este', 'ay',
  'disculpa', 'perdon', 'entonces', 'siempre', 'mejor', 'por', 'favor', 'porfa', 'quiero', 'quisiera', 'necesito',
  'me', 'puedes', 'podrias', 'lo', 'la', 'olvidalo']);

export function autorizaCancelacion(mensaje) {
  const bruto = String(mensaje || '');
  if (/[¿?]/.test(bruto)) return false;
  const t = normalizar(bruto);
  if (/^(?:ya no quiero|no quiero) (?:el pedido|mi pedido|la orden|mi orden|nada)$/.test(t)) return true;
  const m = VERBO_CANCELAR.exec(t);
  if (!m) return false;
  // «no canceles», «no lo cancelen»: la negación pegada al verbo (sin coma de
  // por medio) lo invierte. «ya no, cancélalo» sí cancela.
  if (/\bno\s+(?:me\s+|lo\s+|la\s+|le\s+)?cancel/i.test(bruto.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''))) return false;
  const antes = t.slice(0, m.index).trim().split(' ').filter(Boolean);
  const despues = t.slice(m.index + m[0].length).trim().split(' ').filter(Boolean);
  return antes.every((w) => PREFIJO_CANCELAR.has(w)) && despues.every((w) => OBJETO_TOTAL.has(w));
}

// Solo una respuesta compuesta ENTERAMENTE por opciones conocidas permite
// omitir interpretación. Todo residuo («y agrega…», dirección, etc.) continúa.
export function soloElecciones(mensaje, acciones, candidatos = []) {
  let resto = ` ${normalizar(mensaje)} `;
  const nombres = [...new Set(acciones.flatMap(a => a.argumentos?.opciones || []).map(o => normalizar(o.opcion)))];
  for (const nombre of nombres.sort((a,b) => b.length-a.length)) resto = resto.split(` ${nombre} `).join(' ');
  const raiz = s => s.replace(/(?:os|as|es|o|a|s)$/, '');
  const grupos = acciones.flatMap(a => a.argumentos?.opciones || []).map(o => normalizar(o.grupo));
  const palabras = [...nombres, ...grupos, ...candidatos.map(normalizar)].flatMap(s => s.split(' '));
  const vocabulario = new Set(palabras.map(raiz));
  const cortesia = new Set('y con por favor porfa gracias quiero quisiera seria serian mejor los las el la de del un una sin'.split(' '));
  return (nombres.length > 0 || candidatos.length > 0) && resto.trim().split(/\s+/).filter(Boolean)
    .every(p => cortesia.has(p) || vocabulario.has(raiz(p)) || palabras.some(v => mismaPalabraFlexible(p, v)));
}

export function guardarDialogo(estado, { mensaje, texto, tipo = 'pregunta', huella = null }) {
  // El diálogo lleva la pregunta pendiente que ESTA respuesta le hace al
  // cliente. Mientras no llegue el acuse del transporte (`enviado`), esa
  // pregunta no autoriza ninguna confirmación.
  const id = randomUUID();
  if (estado.pendiente) estado.pendiente.dialogo_id = id;
  estado.dialogo = { id, ciclo: estado.conversacionId, mensaje, texto,
    tipo, huella, foco: estado.foco || null,
    pendiente: estado.pendiente ? { ...estado.pendiente } : null, enviado: false };
  return id;
}

// El canal llama esto únicamente después del acuse del transporte. También
// se usa en evaluaciones con un transporte simulado explícito.
export function acusarDialogo(estado, id, texto, { acusadoAt = null } = {}) {
  if (estado.dialogo?.id !== id || estado.dialogo.texto !== texto) return false;
  if (estado.dialogo.enviado) return true;
  estado.dialogo.enviado = true;
  if (acusadoAt) estado.dialogo.acusadoAt = acusadoAt instanceof Date ? acusadoAt.toISOString() : String(acusadoAt);
  estado.historialDialogo = [...(estado.historialDialogo || []),
    { rol: 'user', texto: estado.dialogo.mensaje }, { rol: 'assistant', texto }].slice(-20);
  return true;
}

export function respuestaCanonica(contexto) {
  const { pedido } = contexto;
  const texto = respuestaDesdePedido(contexto);
  return { texto, tipo: texto.endsWith('¿Confirmas este pedido?') ? 'resumen' : 'pregunta',
    huella: texto.endsWith('¿Confirmas este pedido?') ? pedido.huella : null };
}
