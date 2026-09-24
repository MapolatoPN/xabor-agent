import { tieneEfecto } from './contratoDeHerramientas.js';

const normalizar = (valor) => String(valor ?? '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

const HORA_EN_PALABRAS = '(?:una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|dieciseis|diecisiete|dieciocho|diecinueve|veinte|veintiuna|veintiuno|veintidos|veintitres|veinticuatro)';

const DIAS = '(?:lunes|martes|miercoles|jueves|viernes|sabado|domingo)';
const MESES = '(?:enero|ene|febrero|feb|marzo|mar|abril|abr|mayo|may|junio|jun|julio|jul|agosto|ago|septiembre|setiembre|sept|sep|octubre|oct|noviembre|nov|diciembre|dic)';
const HORA_NUMERICA = '(?:[01]?\\d|2[0-3])(?::[0-5]\\d)?';
const CALIFICADOR_HORA = '(?:\\s*(?:a\\.?\\s*m\\.?|p\\.?\\s*m\\.?)|\\s+de\\s+la\\s+(?:manana|tarde|noche))?';

const HORAS_EN_PALABRAS = Object.freeze({
  una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8,
  nueve: 9, diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15,
  dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19, veinte: 20,
  veintiuna: 21, veintiuno: 21, veintidos: 22, veintitres: 23, veinticuatro: 24,
});

const primeraCoincidencia = (texto, patrones) => {
  for (const patron of patrones) {
    const coincidencia = patron.exec(texto);
    if (coincidencia?.[0]) return coincidencia[0].trim().replace(/[.!?,;:]+$/, '');
  }
  return null;
};

const isoSeguro = (valor) => {
  const s = String(valor ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s)) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) || d.toISOString() !== s ? null : s;
};

const fechaCalendarioSegura = (valor) => {
  const s = String(valor ?? '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1
    && d.getUTCDate() === +m[3] ? s : null;
};

const horaValidadaSegura = (valor) => {
  const s = String(valor ?? '').trim();
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(s) ? s : null;
};

const extraerReferencias = (t) => {
  const hora = primeraCoincidencia(t, [
    new RegExp(`\\ba\\s+las?\\s+(?:${HORA_NUMERICA}|${HORA_EN_PALABRAS}`
      + `(?:\\s+y\\s+(?:media|cuarto))?|mediodia|medianoche)${CALIFICADOR_HORA}\\b`),
    /\b(?:por|en)\s+la\s+(?:manana|tarde|noche)\b/,
    /\b(?:[01]?\d|2[0-3]):[0-5]\d(?:\s*(?:a\.?\s*m\.?|p\.?\s*m\.?))?\b/,
    /\b(?:[01]?\d|2[0-3])\s*(?:a\.?\s*m\.?|p\.?\s*m\.?)\b/,
    /\b(?:[01]?\d|2[0-3])\s+de\s+la\s+(?:manana|tarde|noche)\b/,
    new RegExp(`^(?:(?:si|ok|vale|mejor|prefiero|seria)\\s*,?\\s*)?`
      + `(?:${HORA_NUMERICA}|${HORA_EN_PALABRAS}(?:\\s+y\\s+(?:media|cuarto))?|mediodia|medianoche)`
      + `${CALIFICADOR_HORA}(?:\\s+por\\s+favor)?[.!]?$`),
  ]);

  // «por la mañana» es una franja horaria, no la fecha relativa «mañana».
  // Se retira antes de buscar la fecha para no fabricar dos evidencias de una.
  const sinHora = hora ? t.replace(hora, ' ') : t;
  const fecha = primeraCoincidencia(sinHora, [
    /\b(?:19|20)\d{2}-(?:0?[1-9]|1[0-2])-(?:0?[1-9]|[12]\d|3[01])\b/,
    /\b(?:0?[1-9]|[12]\d|3[01])[\/-](?:0?[1-9]|1[0-2])[\/-](?:\d{2}|(?:19|20)\d{2})\b/,
    /\b(?:0?[1-9]|[12]\d|3[01])\/(?:0?[1-9]|1[0-2])\b/,
    new RegExp(`\\b(?:para\\s+)?(?:el\\s+)?(?:[1-9]|[12]\\d|3[01])\\s+`
      + `(?:de\\s+)?${MESES}\\.?(?:\\s+(?:de\\s+)?(?:19|20)\\d{2})?\\b`),
    /\bpasado\s+manana\b/,
    new RegExp(`\\bproxim[oa]\\s+(?:semana|${DIAS})\\b`),
    /\bmanana\b/,
    new RegExp(`\\b(?:(?:para\\s+)?(?:este|el)\\s+)?${DIAS}(?:\\s+que\\s+viene)?\\b`),
    /\b(?:para\s+)?el\s+(?:[1-9]|[12]\d|3[01])\b/,
  ]);
  return { fecha, hora };
};

/**
 * Extrae únicamente fragmentos temporales de una lista cerrada.
 *
 * Nunca conserva la frase completa: nombre, teléfono, dirección, notas y
 * cualquier otra palabra quedan fuera del estado durable. Tampoco convierte
 * «mañana» a una fecha; esa interpretación sigue siendo trabajo del modelo y
 * `programar_para` la somete después a la política dura del negocio.
 */
export function referenciasTemporalesDePedido(texto) {
  const t = normalizar(texto).replace(/\s+/g, ' ').trim().slice(0, 1000);
  if (!t) return { fecha: null, hora: null };
  const total = extraerReferencias(t);
  // En «ya no mañana, mejor el viernes», lo que autoriza es el tramo de la
  // corrección. Si ese tramo solo cambia la hora («mañana, mejor a las 11»),
  // la fecha anterior de la misma frase sigue siendo útil.
  const senales = [...t.matchAll(/\b(?:mejor|prefiero|cambia(?:lo)?|mueve(?:lo)?|pasalo|dejalo|ponlo)\b/g)];
  const ultima = senales.at(-1);
  if (!ultima) return total;
  const corregida = extraerReferencias(t.slice(ultima.index));
  return {
    fecha: corregida.fecha || total.fecha,
    hora: corregida.hora || total.hora,
  };
}

/**
 * Horas de pared que las palabras del cliente permiten literalmente.
 *
 * «por la tarde» no devuelve ninguna: es una franja, no una hora. Una hora
 * sin AM/PM conserva sus dos lecturas reales ("a las 2" → 02:00 o 14:00),
 * para que el horario del negocio pueda decidir sin que el modelo invente una
 * tercera. El resultado nunca viene de argumentos de herramienta.
 */
export function horasExactasDePedido(texto) {
  const t = normalizar(texto).replace(/\s+/g, ' ').trim();
  const marcaHora = `(?:${HORA_NUMERICA}|${HORA_EN_PALABRAS}`
    + `(?:\\s+y\\s+(?:media|cuarto))?)${CALIFICADOR_HORA}`;
  const rango = new RegExp(`\\b(?:entre\\s+(?:las?\\s+)?${marcaHora}`
    + `\\s+y\\s+(?:las?\\s+)?${marcaHora}`
    + `|de\\s+(?:las?\\s+)?${marcaHora}\\s+a\\s+(?:las?\\s+)?${marcaHora})\\b`);
  if (rango.test(t)) return [];
  const fragmento = referenciasTemporalesDePedido(texto).hora;
  if (!fragmento || /^(?:por|en)\s+la\s+(?:manana|tarde|noche)$/.test(fragmento)) return [];
  if (/\bmediodia\b/.test(fragmento)) return ['12:00'];
  if (/\bmedianoche\b/.test(fragmento)) return ['00:00'];

  let hora = null;
  let minutos = 0;
  const numerica = /\b([01]?\d|2[0-3])(?::([0-5]\d))?\b/.exec(fragmento);
  if (numerica) {
    hora = Number(numerica[1]);
    minutos = Number(numerica[2] || 0);
  } else {
    const palabras = new RegExp(`\\b(${Object.keys(HORAS_EN_PALABRAS).join('|')})\\b`).exec(fragmento);
    if (!palabras) return [];
    hora = HORAS_EN_PALABRAS[palabras[1]];
    if (/\by\s+media\b/.test(fragmento)) minutos = 30;
    else if (/\by\s+cuarto\b/.test(fragmento)) minutos = 15;
  }

  if (hora === 24) hora = 0;
  const esAM = /\ba\.?\s*m\.?\b|\bde\s+la\s+manana\b/.test(fragmento);
  const esPM = /\bp\.?\s*m\.?\b|\bde\s+la\s+(?:tarde|noche)\b/.test(fragmento);
  let candidatas;
  if (esAM) candidatas = [hora === 12 ? 0 : hora];
  else if (esPM) candidatas = [hora < 12 ? hora + 12 : hora];
  else if (hora > 12 || hora === 0) candidatas = [hora];
  else candidatas = hora === 12 ? [0, 12] : [hora, hora + 12];

  return [...new Set(candidatas)]
    .filter((h) => h >= 0 && h <= 23)
    .map((h) => `${String(h).padStart(2, '0')}:${String(minutos).padStart(2, '0')}`);
}

/** Solo deja entrar al estado la forma cerrada que Xabor sabe volver a leer. */
export function referenciaProgramacionSegura(referencia) {
  if (!referencia || typeof referencia !== 'object') return null;
  const fechaCliente = referenciasTemporalesDePedido(referencia.fechaCliente).fecha;
  const horaCliente = referenciasTemporalesDePedido(referencia.horaCliente).hora;
  const fechaAncla = fechaCalendarioSegura(referencia.fechaAncla);
  const fechaValidada = fechaCalendarioSegura(referencia.fechaValidada);
  const horaValidada = horaValidadaSegura(referencia.horaValidada);
  const isoValidado = isoSeguro(referencia.isoValidado);
  const fechaIntentada = fechaCalendarioSegura(referencia.fechaIntentada);
  const horaIntentada = horaValidadaSegura(referencia.horaIntentada);
  const segura = {
    fechaCliente, horaCliente, fechaValidada, horaValidada, isoValidado,
    ...(fechaAncla ? { fechaAncla } : {}),
    ...(fechaIntentada ? { fechaIntentada } : {}),
    ...(horaIntentada ? { horaIntentada } : {}),
  };
  return Object.values(segura).some(Boolean) ? segura : null;
}

/**
 * Mezcla una referencia nueva sin revivir la parte corregida de una reserva.
 * Una corrección de hora conserva la fecha validada (y viceversa), pero el ISO
 * completo deja de ser vigente. En estados legacy, donde solo existe el ISO,
 * se conserva como fallback hasta que la herramienta vuelva a validar.
 */
export function fusionarReferenciaProgramacion(referencia, nuevas = {}, {
  isoAnterior = null, fechaAncla = null,
} = {}) {
  const previa = referenciaProgramacionSegura(referencia) || {
    fechaCliente: null, horaCliente: null, fechaAncla: null, fechaValidada: null,
    horaValidada: null, isoValidado: null, fechaIntentada: null, horaIntentada: null,
  };
  const fechaNueva = referenciasTemporalesDePedido(nuevas.fecha).fecha;
  const horaNueva = referenciasTemporalesDePedido(nuevas.hora).hora;
  const anterior = { ...previa, isoValidado: previa.isoValidado || isoSeguro(isoAnterior) };
  const mezclada = { ...anterior };

  if (fechaNueva) {
    mezclada.fechaCliente = fechaNueva;
    mezclada.fechaAncla = fechaCalendarioSegura(fechaAncla);
    mezclada.fechaValidada = null;
  }
  if (horaNueva) {
    mezclada.horaCliente = horaNueva;
    mezclada.horaValidada = null;
  }
  if (fechaNueva || horaNueva) {
    const faltaFechaExplicita = !mezclada.fechaCliente && !mezclada.fechaValidada;
    const faltaHoraExplicita = !mezclada.horaCliente && !mezclada.horaValidada;
    mezclada.isoValidado = (faltaFechaExplicita || faltaHoraExplicita)
      ? anterior.isoValidado : null;
  }
  return referenciaProgramacionSegura(mezclada);
}

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
      `^(?:(?:no|si|ok|vale)\\s*,?\\s*)?`
        + `(?:(?:mejor|prefiero|seria|cambia(?:lo)?|mueve(?:lo)?|pasalo|dejalo|ponlo)\\s+)?`
        + `(?:(?:a|para)\\s+las?\\s+`
        + `(?:\\d{1,2}(?::\\d{2})?|${HORA_EN_PALABRAS}(?:\\s+y\\s+(?:media|cuarto))?)`
        + `(?:\\s*(?:a\\.?\\s*m\\.?|p\\.?\\s*m\\.?)|\\s+de\\s+la\\s+(?:manana|tarde|noche))?`
        + `|(?:\\d{1,2}(?::\\d{2})?|${HORA_EN_PALABRAS}(?:\\s+y\\s+(?:media|cuarto))?)`
        + `(?:\\s*(?:a\\.?\\s*m\\.?|p\\.?\\s*m\\.?)|\\s+de\\s+la\\s+(?:manana|tarde|noche)))`
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

  const consultaInformativa = /\b(?:saber|preguntar|consultar|promociones?|horarios?|abren|abre|cierran|cierra|disponibilidad|disponible|hay|tienen|manejan)\b/.test(t)
    || /^[¿\s]*(?:que|cual|cuales|cuando|donde|como|cuanto)\b/.test(t);
  // Una pregunta de capacidad no es todavía una instrucción, aunque incluya
  // literalmente el verbo «pedir». El modelo debe contestarla o pedir una
  // confirmación; no puede convertir «¿puedo pedir mañana?» en una mutación.
  const consultaDePosibilidad = /\b(?:quiero|quisiera|necesito|me\s+gustaria)\s+(?:saber|consultar|preguntar)\b/.test(t)
    || /\b(?:puedo|podria|podemos|podriamos)\s+(?:hacer\s+un\s+pedido|pedir|ordenar|encargar|apartar|reservar|programar|agendar|cambiar|mover)\b/.test(t)
    || /\b(?:se\s+puede|es\s+posible)\s+(?:hacer\s+un\s+pedido|pedir|ordenar|encargar|apartar|reservar|programar|agendar|cambiar|mover)\b/.test(t);
  if (consultaDePosibilidad) return false;

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

  // Una programación ya existente cambia con expresiones tersas que no son
  // pedidos nuevos: «no, a las 11», «mejor 11 am» o «ya no mañana, mejor el
  // viernes». Se reconoce el reemplazo ANTES de la negación; la consulta
  // informativa y las preguntas siguen sin autorizar ninguna mutación.
  const referencias = referenciasTemporalesDePedido(t);
  const senalDeCorreccion = /\b(?:mejor|prefiero|cambia(?:lo)?|mueve(?:lo)?|pasalo|dejalo|ponlo)\b/.test(t);
  const correccionTersa = correccionSoloHora
    || /^(?:no\s*,?\s*)?a\s+las?\s+(?:\d{1,2}(?::\d{2})?|[a-z]+)(?:\s+por\s+favor)?[.!]?$/.test(t);
  if (hayProgramacionPrevia && (referencias.fecha || referencias.hora)
      && !consultaInformativa && !/[?¿]/.test(t)
      && (senalDeCorreccion || correccionTersa)) return true;

  const negada = /\b(?:no|ya no)\s+(?:(?:lo|la)\s+)?(?:(?:quiero|quisiera|necesito|voy a)\s+)?(?:pedir|ordenar|encargar|apartar|reservar|programar|agendar)\b/.test(t)
    || /\b(?:no|ya no)\s+(?:es|seria|lo quiero)\s+para\s+(?:manana|pasado manana|el\s+(?:lunes|martes|miercoles|jueves|viernes|sabado|domingo))\b/.test(t);
  if (negada) return false;

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
