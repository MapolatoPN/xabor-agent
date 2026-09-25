import { siguientePreguntaDelPedido } from './continuidadDeterminista.js';
import { tieneEfecto } from './contratoDeHerramientas.js';
import { etiquetaTipoPago } from './politicaDePagos.js';
import { TZ_DEFAULT } from '../services/zonaHoraria.js';

export const esSaludoSolo = (texto) => /^(?:hola|buenos dias|buenas tardes|buenas noches|buen dia|buenas)[!.\s]*$/
  .test(String(texto || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim());

// Recuperar una redacción no significa reintentar un efecto. Si ya hubo un
// intento de escritura, una confirmación incierta o un estado terminal, la
// barrera habitual conserva la autoridad y decide el escalado.
export function puedeRecuperarSinEfectos(estado, operaciones = []) {
  return !estado?.confirmacionIncierta
    && !Object.values(estado?.hechos || {}).some(Boolean)
    && !estado?.evento
    && !operaciones.some((op) => tieneEfecto(op?.herramienta));
}

export function respuestaDesdePedido({ estado, pedido, modalidades, metodosPago, requierePago,
  zonaDelNegocio = TZ_DEFAULT }) {
  if (estado.programacionRequerida && !pedido.programado_para) {
    estado.foco = null;
    return 'Tu borrador tiene pendiente la fecha de entrega. ¿Lo necesitas para hoy o para otra fecha?';
  }
  const pregunta = siguientePreguntaDelPedido({ pedido, modalidades, metodosPago, requierePago });
  if (pregunta) {
    estado.foco = pregunta.foco;
    return pregunta.texto;
  }
  estado.foco = null;
  if (!pedido.lineas.length) return '¿Qué te gustaría pedir?';
  if (pedido.falta.length || pedido.total == null) return '¿Qué deseas revisar de tu pedido?';
  const lineas = pedido.lineas.map((l) => `${l.cantidad} × ${l.producto}`
    + (l.opciones.length ? ` (${l.opciones.map((o) => o.opcion).join(', ')})` : ''));
  const fecha = pedido.programado_para ? new Intl.DateTimeFormat('es-MX', {
    timeZone: zonaDelNegocio, dateStyle: 'long', timeStyle: 'short',
  }).format(new Date(pedido.programado_para)) : null;
  return `Tu borrador contiene:\n${lineas.join('\n')}\n`
    + `Modalidad: ${pedido.modalidad}.\n`
    + (pedido.forma_pago ? `Forma de pago: ${etiquetaTipoPago(pedido.forma_pago)}.\n` : '')
    + (fecha ? `Fecha de entrega: ${fecha}.\n` : '')
    + `Total: $${pedido.total}.\n¿Confirmas este pedido?`;
}
