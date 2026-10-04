import { siguientePreguntaDelPedido } from './continuidadDeterminista.js';
import { tieneEfecto } from './contratoDeHerramientas.js';
import { etiquetaTipoPago } from './politicaDePagos.js';
import { TZ_DEFAULT } from '../services/zonaHoraria.js';
import { respuestaAfirmaCambioSinAplicar } from './seguridadConversacional.js';
import { detectarSalidaInterna } from './salidaPublicable.js';
import { respuestaProhibidaEncontrada } from './reglasDelAsistente.js';
import { preguntaDePedidoMultiple } from './preguntaDePedidoMultiple.js';
import { opcionesAgrupadas, tituloVisible } from './presentacionDeOpciones.js';
import { FRASES } from './frasesRecepcion.js';

// El resumen agrupado («Sabor: Melón») se usa solo si cabe con holgura: el
// cuerpo con botones no puede pasar de 1024 caracteres y al resumen se le
// anteponen avisos, el saludo o «Actualicé tu pedido…» y se le suman las
// promociones (hasta ~430). Si no cabe, sale el formato plano de siempre.
export const MAX_RESUMEN_AGRUPADO = 590;

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

// `recepcion` (modo formulario, recepcionista.js): las dos preguntas abiertas
// de abajo invitarían a escribir el pedido; en ese modo señalan el formulario,
// que el canal manda debajo.
export function respuestaDesdePedido({ estado, pedido, modalidades, metodosPago, requierePago,
  zonaDelNegocio = TZ_DEFAULT, reglas = null, recepcion = false }) {
  if (estado.programacionRequerida && !pedido.programado_para) {
    estado.foco = null;
    return 'Tu borrador tiene pendiente la fecha de entrega. ¿Lo necesitas para hoy o para otra fecha?';
  }
  const conjunta = preguntaDePedidoMultiple(pedido);
  if (conjunta) {
    estado.foco = null; // Un «pollo» suelto no autoriza repartirlo entre platos.
    return conjunta;
  }
  const pregunta = siguientePreguntaDelPedido({ pedido, modalidades, metodosPago, requierePago });
  if (pregunta) {
    estado.foco = pregunta.foco;
    return pregunta.texto;
  }
  estado.foco = null;
  if (!pedido.lineas.length) return recepcion ? FRASES.ELIGE_EN_MENU : '¿Qué te gustaría pedir?';
  if (pedido.falta.length || pedido.total == null) return recepcion ? FRASES.REVISA_EN_FORMULARIO : '¿Qué deseas revisar de tu pedido?';
  const limpio = v => String(v ?? '').replace(/[*_~`]/g, '').trim();
  const dinero = v => Number(Number(v).toFixed(2));
  const plano = (l) => l.opciones.map((o) => limpio(o.opcion)).join(' · ');
  // Un nombre de grupo del menú no puede hacer que el resumen parezca afirmar
  // un cambio («Registro», «¿Te lo agregamos?») ni coincidir con una frase
  // prohibida del negocio. Se revisa el RENGLÓN completo, porque dos
  // etiquetas inocentes pueden disparar juntas; si dispara, sale plano.
  const dispara = (t) => respuestaAfirmaCambioSinAplicar({ texto: t, operaciones: [] })
    || !!respuestaProhibidaEncontrada(t, reglas);
  const agrupado = (l) => {
    const conGrupos = opcionesAgrupadas(l.opciones, l.gruposEnOrden);
    return dispara(conGrupos) && !dispara(plano(l)) ? plano(l) : conGrupos;
  };
  const armarLineas = (opcionesDe) => pedido.lineas.map((l) => `*${l.cantidad} × ${limpio(l.producto)}`
    + (l.precio_unitario != null ? ` · $${dinero(l.precio_unitario*l.cantidad)}` : '') + '*'
    + (l.cantidad>1 && l.precio_unitario!=null ? `\n$${l.precio_unitario} c/u` : '')
    + (l.opciones.length ? `\n${opcionesDe(l)}` : '')
    + (l.nota ? `\nNota: ${limpio(l.nota)}` : ''));
  const cliente = pedido.cliente || {};
  const datosCliente = [['nombre', 'Nombre'], ['telefono', 'Teléfono'], ['calle', 'Calle'],
    ['numero_exterior', 'Número exterior'], ['numero_interior', 'Interior'], ['colonia', 'Colonia'],
    ['entre_calles', 'Entre calles'], ['referencia', 'Referencia'], ['direccion', 'Dirección']]
    .filter(([campo]) => cliente[campo] != null && String(cliente[campo]).trim())
    .map(([campo, etiqueta]) => `${etiqueta}: ${limpio(cliente[campo])}\n`).join('');
  const fecha = pedido.programado_para ? new Intl.DateTimeFormat('es-MX', {
    timeZone: zonaDelNegocio, dateStyle: 'long', timeStyle: 'short',
  }).format(new Date(pedido.programado_para)) : null;
  const armar = (lineas) => `*Revisa tu pedido*\n\n${lineas.join('\n\n')}\n\n`
    + `Modalidad: ${tituloVisible(pedido.modalidad)}\n`
    + (pedido.forma_pago ? `Forma de pago: ${tituloVisible(etiquetaTipoPago(pedido.forma_pago))}\n` : '')
    + (fecha ? `Fecha de entrega: ${fecha}.\n` : '')
    + datosCliente
    // La nota del pedido sale en la comanda: el cliente la lee antes del «sí».
    + (pedido.nota_pedido ? `Nota del pedido: ${limpio(pedido.nota_pedido)}\n` : '')
    + '\n'
    + (pedido.costo_envio ? `Subtotal: $${pedido.subtotal}\nEnvío: $${pedido.costo_envio}\n` : '')
    + `*Total: $${pedido.total}*\n¿Confirmas este pedido?`;
  const conGrupos = armar(armarLineas(agrupado));
  return conGrupos.length <= MAX_RESUMEN_AGRUPADO ? conGrupos : armar(armarLineas(plano));
}
