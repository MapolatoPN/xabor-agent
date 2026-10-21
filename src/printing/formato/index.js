// ─── Documento de impresión v1: lo que el servidor manda al Edge ────────────
//
// `formatoDeDocumento` arma { v: 1, renglones } para un trabajo. El payload
// de siempre viaja intacto al lado: un Edge instalado antes de esta versión
// no conoce `formato`, lo ignora e imprime como siempre; uno nuevo imprime
// estos renglones tal cual (edge/renderers/formato.js). Nada se rompe
// mientras las sucursales se actualizan.
//
// Nunca lanza: si algo falla al armar, devuelve null y el trabajo sale con
// el formato de siempre. El papel del restaurante manda.
import { parrafo, linea, espacio, corte } from './maquetador.js';
import { renglonesDeComanda, horaDe } from './comanda.js';
import { renglonesDeTicket } from './ticket.js';
import { renglonesDeTicketDePedido } from './ticketPedido.js';
import { normalizarFormato } from './opciones.js';
import { tituloPersona } from '../../../edge/renderers/personas.js';

export { normalizarFormato, FORMATO_POR_DEFECTO, FORMATO_CLAVE } from './opciones.js';
export const VERSION_FORMATO = 1;
// Un documento con más renglones que esto es un error de armado, no una
// comanda: se descarta y sale el formato de siempre.
export const MAX_RENGLONES = 1500;

export function renglonesDeCancelacion(d, { ancho = 42 } = {}) {
  const R = [];
  const add = (...xs) => { for (const x of xs) Array.isArray(x) ? R.push(...x) : R.push(x); };
  add(parrafo('*** CANCELADO ***', { tam: 'doble', negrita: true, alinear: 'centro' }, ancho), linea('='));
  if (d.mesa != null) add(parrafo(`MESA ${d.mesa}`, { tam: 'alto', negrita: true }, ancho));
  add(parrafo(horaDe(d.emitidoAt), {}, ancho), linea('-'));
  for (const item of Array.isArray(d.items) ? d.items : []) {
    add(parrafo(`${item.cantidad} ${String(item.producto ?? '').toUpperCase()}`, { tam: 'alto', negrita: true }, ancho));
    if (item.persona) add(parrafo(tituloPersona(item.persona), {}, ancho, { sangria: '  ' }));
  }
  if (d.motivo) add(espacio(1), parrafo(`MOTIVO: ${d.motivo}`, { negrita: true }, ancho));
  add(linea('='), espacio(3), corte());
  return R;
}

// La prueba sirve para el levantamiento en sitio: dice a qué impresora salió
// y desde qué equipo, trae la regla de columnas (si se parte en dos, el ancho
// configurado no es el del papel) y un renglón de acentos y tamaños.
export function renglonesDePrueba(d, { ancho = 42 } = {}) {
  const R = [];
  const add = (...xs) => { for (const x of xs) Array.isArray(x) ? R.push(...x) : R.push(x); };
  add(parrafo('XABOR', { tam: 'alto', negrita: true, alinear: 'centro' }, ancho), linea('='));
  add(parrafo('PRUEBA DE IMPRESORA', { negrita: true, alinear: 'centro' }, ancho), espacio(1));
  add(parrafo(`Negocio: ${d.negocio || '-'}`, {}, ancho), parrafo(`Impresora: ${d.impresora || '-'}`, {}, ancho),
    parrafo(`Equipo: ${d.terminal || '-'}`, {}, ancho), parrafo(`Ancho: ${ancho} columnas`, {}, ancho),
    parrafo(`Hora: ${horaDe(d.emitidoAt)}`, {}, ancho), linea('-'));
  add({ texto: '1234567890'.repeat(Math.ceil(ancho / 10)).slice(0, ancho) });
  add(parrafo('Acentos: áéíóú ÁÉÍÓÚ ñÑ ü ¿? ¡! ·', {}, ancho));
  add(parrafo('Letra alta', { tam: 'alto', negrita: true }, ancho), parrafo('Letra doble', { tam: 'doble', negrita: true }, ancho));
  add(linea('='), espacio(3), corte());
  return R;
}

const ARMADORES = {
  comanda: (d, ctx) => renglonesDeComanda(d, ctx),
  // El ticket de un pedido (cobro y 🧾 del panel) trae sus datos en
  // `ticketDePedido`; las cuentas de Mesas siguen con su armado.
  cuenta: (d, ctx) => (d.ticketDePedido ? renglonesDeTicketDePedido(d.ticketDePedido, ctx) : renglonesDeTicket(d, ctx)),
  cancelacion: (d, ctx) => renglonesDeCancelacion(d, ctx),
  prueba: (d, ctx) => renglonesDePrueba(d, ctx),
};

export const documentosConFormato = Object.keys(ARMADORES);

// `datos`: lo que el armador necesita (para la comanda, los items ORIGINALES).
// `ctx`: { ancho, formato (crudo o normalizado), negocio }.
export function formatoDeDocumento(documento, datos, { ancho = 42, formato = null, negocio = {} } = {}) {
  try {
    const armar = ARMADORES[documento];
    if (!armar || !datos || typeof datos !== 'object') return null;
    const cols = Number.isInteger(Number(ancho)) && Number(ancho) >= 20 && Number(ancho) <= 96 ? Number(ancho) : 42;
    const renglones = armar(datos, { ancho: cols, formato: normalizarFormato(formato), negocio: negocio || {} });
    if (!Array.isArray(renglones) || !renglones.length || renglones.length > MAX_RENGLONES) return null;
    return { v: VERSION_FORMATO, ancho: cols, renglones };
  } catch (e) {
    console.error(`[Formato] no se pudo armar ${documento}: ${e.message}`);
    return null;
  }
}
