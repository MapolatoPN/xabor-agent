import { siguientePreguntaDelPedido } from './continuidadDeterminista.js';
import { tieneEfecto } from './contratoDeHerramientas.js';
import { etiquetaTipoPago } from './politicaDePagos.js';
import { TZ_DEFAULT } from '../services/zonaHoraria.js';
import { respuestaAfirmaCambioSinAplicar } from './seguridadConversacional.js';
import { detectarSalidaInterna } from './salidaPublicable.js';
import { respuestaProhibidaEncontrada } from './reglasDelAsistente.js';

export function saludoDelNegocio({ reglas, zonaDelNegocio = TZ_DEFAULT,
  ahora = new Date(), inicio = true } = {}) {
  const hora = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: zonaDelNegocio, hour: 'numeric', hourCycle: 'h23',
  }).format(ahora));
  const saludoHora = hora < 12 ? 'Buenos días' : hora < 19 ? 'Buenas tardes' : 'Buenas noches';
  const base = `¡${saludoHora}! Con gusto te atendemos.`;
  const configurado = inicio ? String(reglas?.bot?.saludo || '').trim() : '';
  if (!configurado || detectarSalidaInterna(configurado)
    || respuestaAfirmaCambioSinAplicar({ texto: configurado, operaciones: [] })
    || respuestaProhibidaEncontrada(configurado, reglas)) {
    return `${base}${inicio ? ' ¿Cómo podemos ayudarte?' : ''}`;
  }
  // El saludo escrito por el negocio conserva su voz. Solo la franja del
  // día se adapta al reloj de SU zona, nunca al del servidor.
  const franja = /\b(?:buenos d[ií]as|buen d[ií]a|buenas tardes|buenas noches)\b/i;
  const ajustado = franja.test(configurado)
    ? configurado.replace(franja, (original) => /^[A-Z]/.test(original)
      ? saludoHora : saludoHora.toLowerCase())
    : `¡${saludoHora}! ${configurado}`;
  return /[?¿]/.test(ajustado) ? ajustado : `${ajustado} ¿Cómo podemos ayudarte?`;
}

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

// Agotar el presupuesto de interpretación no invalida escrituras de borrador
// comprobadas. Nunca se recuperan aquí efectos externos, rechazos o terminales.
const CAMBIOS_DE_BORRADOR = new Set(['agregar_producto', 'modificar_linea', 'quitar_linea',
  'definir_entrega', 'definir_pago', 'definir_cliente', 'programar_para']);
const LECTURAS_DE_PEDIDO = new Set(['ver_pedido', 'buscar_producto', 'ver_opciones_producto']);
export function puedeCerrarConAvance(estado, operaciones = []) {
  if (estado?.folio || estado?.confirmacionIncierta || estado?.evento
    || Object.values(estado?.hechos || {}).some(Boolean)) return false;
  return operaciones.some((op) => CAMBIOS_DE_BORRADOR.has(op.herramienta))
    && operaciones.every((op) => {
      if (!op.resultado || op.resultado.error || op.resultado.parcial
        || ['ilegal', 'rechazada', 'error'].includes(op.resultado.estado)) return false;
      return CAMBIOS_DE_BORRADOR.has(op.herramienta)
        ? op.resultado.aplicado === true
        : LECTURAS_DE_PEDIDO.has(op.herramienta) && op.resultado.aplicado !== false;
    });
}

export function respuestaDeAvance({ estado, pedido, modalidades, metodosPago, requierePago }) {
  const lineas = pedido.lineas.map((l) => `${l.cantidad} × ${l.producto}`
    + (l.opciones.length ? ` (${l.opciones.map((o) => o.opcion).join(', ')})` : '')
    + (l.nota ? ` — ${l.nota}` : ''));
  const pregunta = siguientePreguntaDelPedido({ pedido, modalidades, metodosPago, requierePago });
  estado.foco = pregunta?.foco ?? null;
  // La interpretación pudo quedar incompleta. Mostrar lo guardado permite al
  // cliente detectar omisiones sin afirmar que toda su solicitud se completó.
  return `Hasta ahora tu borrador contiene:\n${lineas.join('\n') || 'Sin productos.'}\n`
    + 'Si falta algún producto o cambio que pediste, dime cuál para completarlo.'
    + (pregunta ? `\n${pregunta.texto}` : '\n¿Falta algo más antes de revisar el pedido?');
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
    + (l.opciones.length ? ` (${l.opciones.map((o) => o.opcion).join(', ')})` : '')
    + (l.nota ? ` — ${l.nota}` : '')
    + (l.precio_unitario != null ? `: $${l.precio_unitario} c/u` : ''));
  const cliente = pedido.cliente || {};
  const datosCliente = [['nombre', 'Nombre'], ['telefono', 'Teléfono'], ['calle', 'Calle'],
    ['numero_exterior', 'Número exterior'], ['numero_interior', 'Interior'], ['colonia', 'Colonia'],
    ['entre_calles', 'Entre calles'], ['referencia', 'Referencia'], ['direccion', 'Dirección']]
    .filter(([campo]) => cliente[campo] != null && String(cliente[campo]).trim())
    .map(([campo, etiqueta]) => `${etiqueta}: ${cliente[campo]}.\n`).join('');
  const fecha = pedido.programado_para ? new Intl.DateTimeFormat('es-MX', {
    timeZone: zonaDelNegocio, dateStyle: 'long', timeStyle: 'short',
  }).format(new Date(pedido.programado_para)) : null;
  return `Tu borrador contiene:\n${lineas.join('\n')}\n`
    + `Modalidad: ${pedido.modalidad}.\n`
    + (pedido.forma_pago ? `Forma de pago: ${etiquetaTipoPago(pedido.forma_pago)}.\n` : '')
    + (fecha ? `Fecha de entrega: ${fecha}.\n` : '')
    + datosCliente
    + (pedido.costo_envio ? `Subtotal: $${pedido.subtotal}. Envío: $${pedido.costo_envio}.\n` : '')
    + `Total: $${pedido.total}.\n¿Confirmas este pedido?`;
}
