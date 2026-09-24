import { tieneEfecto } from './contratoDeHerramientas.js';

const normalizar = (valor) => String(valor ?? '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

const HORA_EN_PALABRAS = '(?:una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|dieciseis|diecisiete|dieciocho|diecinueve|veinte|veintiuna|veintiuno|veintidos|veintitres|veinticuatro)';

/**
 * Reconoce cuándo el cliente está armando un pedido futuro. El adaptador deja
 * esa intención como hecho durable: si el modelo no llama `programar_para`, la
 * barrera de confirmación impide convertirlo por accidente en pedido de hoy.
 */
export function esSolicitudDePedidoProgramado(texto, {
  hayPedidoEnCurso = false, hayProgramacionPrevia = false,
} = {}) {
  const t = normalizar(texto).trim();
  const dias = '(?:lunes|martes|miercoles|jueves|viernes|sabado|domingo)';
  const fechaNatural = /\b(?:el\s+)?\d{1,2}\s+(?:de\s+)?(?:enero|ene|febrero|feb|marzo|mar|abril|abr|mayo|may|junio|jun|julio|jul|agosto|ago|septiembre|setiembre|sept|sep|octubre|oct|noviembre|nov|diciembre|dic)\.?(?:\s+(?:de\s+)?\d{4})?\b/;
  const fechaIso = /\b(?:19|20)\d{2}-\d{1,2}-\d{1,2}\b/;
  // Un guion entre dos números también es una cantidad («2-3 tacos»). Solo
  // cuenta como fecha si trae año o contexto temporal explícito (para/el).
  const fechaNumerica = /\b\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}\b/.test(t)
    // La diagonal es notación inequívoca de fecha aun dentro de una frase
    // nominal ("dos waffles 25/09"). El guion corto sigue necesitando
    // contexto para no confundir cantidades como "2-3 tacos".
    || /\b\d{1,2}\/\d{1,2}\b/.test(t)
    || /\b(?:para|el)\s+(?:el\s+)?\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?\b/.test(t);
  // «para el 25» necesita contexto: el número desnudo de «quiero 25 tacos»
  // es cantidad, no fecha. Con artículo/preposición temporal sí es día de mes;
  // la validez concreta la resolverá programar_para, no este detector.
  const diaDelMes = /\b(?:para\s+(?:el\s+)?|el\s+)\d{1,2}\b/.test(t);
  // Una vez que ya hay artículos, el cliente suele contestar solo la parte
  // temporal. Incluye los prefijos naturales que aparecieron en revisión y
  // «a las 10 del viernes»; el cierre sin `?` evita secuestrar preguntas.
  const continuacionConDia = new RegExp(
    `^(?:(?:si|ok|vale|mejor|seria)\\s*,?\\s*)?`
      + `(?:(?:dejalo|ponlo|hazlo)\\s+(?:para\\s+)?)?`
      + `(?:(?:para\\s+)?(?:este|el)\\s+)?${dias}(?:\\s+que\\s+viene)?`
      + `(?:\\s+(?:a\\s+las?\\s+[\\w:.]+|por\\s+la\\s+(?:manana|tarde|noche)))?`
      + `(?:\\s+por\\s+favor)?[.!]?$`,
  );
  const horaDelDia = new RegExp(
    `^(?:(?:si|ok|vale|mejor|seria)\\s*,?\\s*)?a\\s+las?\\s+[\\w:.]+\\s+del\\s+${dias}[.!]?$`,
  );
  // Si ya hay una fecha durable, «a las 11» corrige la hora de ESA reserva.
  // Sin esta precondición sería demasiado ancho para pedidos inmediatos.
  const correccionSoloHora = hayProgramacionPrevia
    && new RegExp(
      `^(?:(?:si|ok|vale|mejor|prefiero|seria)\\s*,?\\s*)?`
        + `(?:(?:cambia(?:lo)?|mueve(?:lo)?|pasalo|dejalo|ponlo)\\s+)?`
        + `(?:a|para)\\s+las?\\s+`
        + `(?:\\d{1,2}(?::\\d{2})?|${HORA_EN_PALABRAS}(?:\\s+y\\s+(?:media|cuarto))?)`
        + `(?:\\s*(?:a\\.?\\s*m\\.?|p\\.?\\s*m\\.?)|\\s+de\\s+la\\s+(?:manana|tarde|noche))?`
        + `(?:\\s+por\\s+favor)?[.!]?$`,
    ).test(t);
  const continuacionTemporal = hayPedidoEnCurso
    && (continuacionConDia.test(t) || horaDelDia.test(t) || correccionSoloHora);
  // El día puede venir sin preposición: «quiero dos waffles viernes» y
  // «necesito desayuno este sábado» son peticiones futuras completas. Que la
  // sola mención del día no secuestre consultas se decide abajo con las
  // señales de pedido/consulta, no aquí en el reconocimiento temporal.
  const mencionaDia = new RegExp(`\\b${dias}\\b`).test(t);
  const futuro = /\b(?:manana|pasado manana|proxim[oa]s?\s+(?:lunes|martes|miercoles|jueves|viernes|sabado|domingo|semana))\b/.test(t)
    || mencionaDia
    || fechaNatural.test(t) || fechaIso.test(t) || fechaNumerica || diaDelMes
    || continuacionTemporal;

  if (!futuro) return false;
  const negada = /\b(?:no|ya no)\s+(?:(?:lo|la)\s+)?(?:(?:quiero|quisiera|necesito|voy a)\s+)?(?:pedir|ordenar|encargar|apartar|reservar|programar|agendar)\b/.test(t)
    || /\b(?:no|ya no)\s+(?:es|seria|lo quiero)\s+para\s+(?:manana|pasado manana|el\s+(?:lunes|martes|miercoles|jueves|viernes|sabado|domingo))\b/.test(t);
  if (negada) return false;

  // Una fecha también aparece al administrar algo que NO es un pedido nuevo.
  // Estos verbos deben ganar incluso ante "quiero/necesito"; de lo contrario
  // el cierre desviaría recordatorios, cancelaciones, facturas o reservas de
  // mesa al flujo que puede registrar comida.
  const gestionAjenaAlPedido = /\b(?:me\s+)?(?:avisen|avisas|avisa|avisame|notifiquen|notificame|recuerdame)\b/.test(t)
    || /\b(?:cancelar|cancela|cancelen|anular|anula)\b.{0,45}\bpedido\b/.test(t)
    || /\b(?:facturar|factura|facturen)\b(?:.{0,45}\bpedido\b)?/.test(t)
    || /\b(?:reservar|reserva|apart(?:ar|a))\b.{0,35}\bmesa\b/.test(t)
    || /\bmesa\b.{0,35}\b(?:reservar|reserva|apart(?:ar|a))\b/.test(t);
  if (gestionAjenaAlPedido) return false;

  // Sustantivos («¿tienen pedidos?») y verbos informativos («¿dónde
  // entregan?») no son órdenes. Solo formas de acción inequívocas o un deseo
  // no informativo habilitan el desvío mientras el negocio está cerrado.
  const accionDePedido = /\b(?:pedir|ordenar|encargar|apartar|reservar|programar|agendar)\b/.test(t)
    || /\b(?:prepara|preparen|enviame|envienme|apartame|reservame|programame|agendame)\b/.test(t)
    || /\bseria\s+para\s+(?:enviar|entregar|recoger)\w*\b/.test(t);
  // «Quiero dos waffles para el 25» también es un pedido, pero «quiero saber
  // si abren el 25» no. Los verbos informativos ganan cuando no hay una acción
  // explícita de pedido; así una fecha natural no secuestra dudas de horario,
  // promociones o disponibilidad mientras el local está cerrado.
  const deseo = /\b(?:quisiera|quiero|necesito|me\s+gustaria|me\s+das?)\b/.test(t);
  const consultaInformativa = /\b(?:saber|preguntar|consultar|promociones?|horarios?|abren|abre|cierran|cierra|disponibilidad|disponible|hay|tienen|manejan)\b/.test(t)
    || /^[¿\s]*(?:que|cual|cuales|cuando|donde|como|cuanto)\b/.test(t);
  // Muchos clientes no conjugan un verbo: «dos waffles para el viernes»,
  // «chilaquiles para mañana», «para mañana dos waffles». La combinación de
  // un tramo nominal + una referencia temporal explícita es suficiente, salvo
  // que la frase tenga una señal informativa/negativa (guardas de arriba).
  const cantidad = '(?:\\d+|un|una|unos|unas|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)';
  const palabra = '[a-zñ][a-zñ-]{2,}';
  const meses = '(?:enero|ene|febrero|feb|marzo|mar|abril|abr|mayo|may|junio|jun|julio|jul|agosto|ago|septiembre|setiembre|sept|sep|octubre|oct|noviembre|nov|diciembre|dic)';
  const tiempo = `(?:(?:para\\s+)?(?:manana|pasado\\s+manana)`
    + `|(?:para\\s+)?(?:este|el)\\s+${dias}`
    + `|(?:para\\s+)?el\\s+\\d{1,2}(?:\\s+(?:de\\s+)?${meses})?`
    + `|(?:para\\s+)?\\d{1,2}\\/\\d{1,2}(?:\\/\\d{2,4})?`
    + `|(?:para\\s+)?(?:19|20)\\d{2}-\\d{1,2}-\\d{1,2})`;
  const nominalAntes = new RegExp(`^(?:${cantidad}\\s+)?${palabra}(?:\\s+${palabra}){0,5}\\s+${tiempo}\\b`);
  const nominalDespues = new RegExp(`^${tiempo}\\b(?:\\s+a\\s+las?\\s+[\\w:.]+)?\\s+(?:${cantidad}\\s+)?${palabra}\\b`);
  const pedidoNominal = !consultaInformativa
    && !/^(?:no|ya\s+no)\b/.test(t)
    && (nominalAntes.test(t) || nominalDespues.test(t));
  const pedido = accionDePedido || (deseo && !consultaInformativa) || pedidoNominal;
  const soloTiempo = /^(?:para\s+)?(?:el\s+)?(?:manana|pasado manana|lunes|martes|miercoles|jueves|viernes|sabado|domingo|(?:19|20)\d{2}-\d{1,2}-\d{1,2}|\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?|\d{1,2}\s+(?:de\s+)?(?:enero|ene|febrero|feb|marzo|mar|abril|abr|mayo|may|junio|jun|julio|jul|agosto|ago|septiembre|setiembre|sept|sep|octubre|oct|noviembre|nov|diciembre|dic)\.?(?:\s+(?:de\s+)?\d{4})?|\d{1,2})(?:\s+(?:a\s+las?\s+[\w:.]+|por\s+la\s+(?:manana|tarde|noche)))?(?:\s+por\s+favor)?[.!]?$/;
  return pedido || (hayPedidoEnCurso && !consultaInformativa
    && (continuacionTemporal || soloTiempo.test(t)));
}

/** El cliente no solo menciona una fecha: corrige la que ya estaba fijada. */
export function pideCambiarProgramacion(texto, { hayPedidoEnCurso = false } = {}) {
  const t = normalizar(texto).trim();
  if (!esSolicitudDePedidoProgramado(t, { hayPedidoEnCurso })) return false;
  return /\b(?:mejor|prefiero|seria|cambia(?:lo)?|mueve(?:lo)?|pasalo|dejalo|ponlo)\b/.test(t);
}

/** Cambio explícito a inmediato o rechazo de la programación ya guardada. */
export function pideQuitarProgramacion(texto, { hayProgramacionPrevia = false } = {}) {
  const t = normalizar(texto).trim();
  const referenciaInmediata = /\b(?:para|mejor|prefiero|quiero|seria|hazlo|dejalo)\s+(?:para\s+)?(?:hoy|ahora)\b/.test(t)
    || /\blo\s+antes\s+posible\b/.test(t);
  // Preguntar por promociones, horario o disponibilidad de hoy no modifica
  // el pedido que ya se estaba armando para otro día. Una corrección explícita
  // dentro de la misma frase (p. ej. «mejor para hoy») sí conserva prioridad.
  const consultaInformativa = /\b(?:saber|preguntar|consultar|promociones?|horarios?|abren|abre|cierran|cierra|disponibilidad|disponible|hay|tienen|manejan)\b/.test(t)
    || /^[¿\s]*(?:que|cual|cuales|cuando|donde|como|cuanto)\b/.test(t);
  const cambioExplicito = /\b(?:mejor|prefiero|seria|hazlo|dejalo|cambia(?:lo)?|mueve(?:lo)?|pasalo|ponlo)\b/.test(t)
    || /\bquiero\s+(?:que\s+sea\s+)?(?:para\s+)?(?:hoy|ahora)\b/.test(t);
  const hoy = referenciaInmediata && (!consultaInformativa || cambioExplicito);
  // «hoy» o «ahora» solos solo tienen sentido como corrección cuando ya hay
  // una reserva guardada. Sin esa precondición no deben convertirse en una
  // señal global que intercepte un pedido inmediato nuevo.
  const inmediataTersa = hayProgramacionPrevia && /^(?:hoy|ahora)[.!]?$/.test(t);
  const niegaPrograma = /\b(?:no|ya no)\s+(?:(?:lo|la)\s+)?(?:(?:quiero|necesito)\s+)?(?:programar|agendar|reservar)\b/.test(t)
    || /\b(?:no|ya no)\s+(?:es|seria|lo quiero)\s+para\s+(?:manana|pasado manana|el\s+(?:lunes|martes|miercoles|jueves|viernes|sabado|domingo))\b/.test(t)
    || /\b(?:no|ya no)\s+(?:(?:quiero|quisiera|necesito)\s+)?(?:pedir|ordenar|encargar)\b.*\b(?:manana|pasado manana)\b/.test(t)
    || /\b(?:ya\s+)?no\s+(?:para\s+)?(?:manana|pasado manana)\b/.test(t);
  return hoy || inmediataTersa || niegaPrograma;
}

/** Frases afirmativas que aseguran que Xabor cambió o guardó algo. */
export function textoAfirmaCambioGuardado(texto) {
  const t = normalizar(texto);
  const verbo = '(?:anote|anoto|anotamos|apunte|apunto|apuntamos|agregue|agrego|agregamos|anadi|anado|anadimos|registre|registro|registramos|programe|programo|programamos|guarde|guardo|guardamos)';
  const participio = '(?:anotad[oa]s?|apuntad[oa]s?|agregad[oa]s?|anadid[oa]s?|registrad[oa]s?|programad[oa]s?|guardad[oa]s?)';
  const patrones = [
    new RegExp(`\\b(?:ya\\s+)?(?:te\\s+)?(?:lo\\s+|la\\s+|los\\s+|las\\s+)?${verbo}\\b`, 'g'),
    // «El pedido quedó registrado» también puede ser una consulta legítima
    // sobre un pedido previo. Aquí solo se persiguen afirmaciones de una
    // acción del turno: primera persona, «va anotado» o «listo/perfecto».
    new RegExp(`\\b(?:va|deje)\\s+(?:ya\\s+)?${participio}\\b`, 'g'),
    new RegExp(`\\b(?:listo|perfecto|hecho)\\b[^.!?\\n]{0,60}\\b${participio}\\b`, 'g'),
  ];
  for (const patron of patrones) {
    for (const coincidencia of t.matchAll(patron)) {
      const antes = t.slice(Math.max(0, coincidencia.index - 16), coincidencia.index);
      if (!/\bno(?:\s+\w+){0,2}\s*$/.test(antes)) return true;
    }
  }
  return false;
}

/**
 * Detecta la divergencia más peligrosa de un turno: texto que dice «anotado»
 * aunque ninguna herramienta de efecto haya quedado aplicada.
 */
export function respuestaAfirmaCambioSinAplicar(salida) {
  if (!textoAfirmaCambioGuardado(salida?.texto)) return false;
  return !(salida?.operaciones || []).some((op) =>
    tieneEfecto(op?.herramienta)
      && op?.herramienta !== 'pedir_humano'
      && op?.resultado?.aplicado === true);
}

export const TEXTO_PEDIDO_PROGRAMADO =
  'Para programar tu pedido para otro día necesito pasarte con alguien del equipo. '
  + 'Así confirmamos la fecha y la hora sin registrar algo incorrecto.';

export const TEXTO_CAMBIO_NO_GUARDADO =
  'Permíteme revisar este pedido con el equipo antes de confirmarte un cambio que no haya quedado guardado.';
