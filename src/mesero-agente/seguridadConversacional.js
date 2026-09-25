import { tieneEfecto } from './contratoDeHerramientas.js';

const normalizar = (valor) => String(valor ?? '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

const AFIRMACION_TEMPORAL = '(?:si|listo|ok|okay|vale|va|perfecto|de acuerdo|sale|claro|correcto|me parece bien|me sirve|me viene bien|me funciona|si me funciona|queda bien|sin problema)';

const HORA_EN_PALABRAS = '(?:una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|dieciseis|diecisiete|dieciocho|diecinueve|veinte|veintiuna|veintiuno|veintidos|veintitres|veinticuatro)';

const DIA_MES_EN_PALABRAS = '(?:primero|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|dieciseis|diecisiete|dieciocho|diecinueve|veinte|veintiun|veintiuno|veintidos|veintitres|veinticuatro|veinticinco|veintiseis|veintisiete|veintiocho|veintinueve|treinta(?:\\s+y\\s+(?:un|uno))?)';
const DIA_MES_PALABRA_NUMERO = Object.freeze({
  primero: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7,
  ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, trece: 13, catorce: 14,
  quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19,
  veinte: 20, veintiun: 21, veintiuno: 21, veintidos: 22, veintitres: 23,
  veinticuatro: 24, veinticinco: 25, veintiseis: 26, veintisiete: 27,
  veintiocho: 28, veintinueve: 29, treinta: 30, 'treinta y un': 31,
  'treinta y uno': 31,
});

const DIAS = '(?:lunes|martes|miercoles|jueves|viernes|sabado|domingo)';
const MESES = '(?:enero|ene|febrero|feb|marzo|mar|abril|abr|mayo|may|junio|jun|julio|jul|agosto|ago|septiembre|setiembre|sept|sep|octubre|oct|noviembre|nov|diciembre|dic)';
const HORA_NUMERICA = '(?:[01]?\\d|2[0-3])(?::[0-5]\\d)?';
const CALIFICADOR_HORA = '(?:\\s*(?:a\\.?\\s*m\\.?|p\\.?\\s*m\\.?)|\\s+de\\s+la\\s+(?:manana|tarde|noche))?';
const DIA_NUMERICO_DESNUDO = /\bel\s+(?:[1-9]|[12]\d|3[01])\b/g;
const ACCION_SELECCION_FUERTE_CERCANA = /\b(?:dame|deme|me\s+das|me\s+llevo|pido|ponle|ponme|pon|agrega(?:me)?|anade(?:me)?|quiero\s+(?:agregar|anadir|poner)|elige|elijo|elegi|escojo|escogi|escoji|selecciono|seleccione)(?:\s+(?:al?|en)\s+(?:mi\s+)?pedido)?\s*$/;
const ACCION_SELECCION_DEBIL_CERCANA = /\b(?:quiero|quisiera|prefiero)\s*$/;
const accionDeSeleccionCercana = (texto) => ACCION_SELECCION_FUERTE_CERCANA.test(texto)
  || ACCION_SELECCION_DEBIL_CERCANA.test(texto);
const contextoTemporalExplicitoAntes = (texto) => /\b(?:pedido|orden)\b[^.!?]{0,35}\b(?:(?:lo|la|tambien|ademas)\s+){0,2}(?:quiero|quisiera|prefiero)\s*$/.test(texto)
  || /\b(?:fecha|entrega|envio|recogida|recoleccion|programacion|agenda)\b[^.!?]{0,35}\b(?:(?:lo|la|tambien|ademas)\s+){0,2}(?:quiero|quisiera|prefiero|dame|deme|me\s+das|ponle|ponme|pon)\s*$/.test(texto);

// Referencias futuras reales que todavía no convertimos a un único día sin
// adivinar. Se conservan como barrera ambigua para preguntar, nunca se reduce
// «viernes dentro de dos semanas» al viernes inmediato ni se registra hoy.
const referenciaRelativaComplejaEn = (texto) => new RegExp(
  `\\b(?:dentro\\s+de|en)\\s+(?:\\d+|un|una|${HORA_EN_PALABRAS})\\s+`
    + `(?:dias?|semanas?|meses?)\\b|`
    + `\\b(?:para\\s+)?la\\s+semana\\s+que\\s+viene\\b|`
    + `\\b(?:para\\s+)?(?:la\\s+)?proxim[oa]\\s+semana\\b|`
    + `\\b(?:para\\s+)?la\\s+(?:otra\\s+semana|semana\\s+(?:siguiente|proxima))\\b|`
    + `\\b(?:para\\s+)?la\\s+(?:semana\\s+entrante|entrante\\s+semana)\\b|`
    + `\\b(?:el\\s+)?otro\\s+${DIAS}\\b|`
    + `\\b${DIAS}\\s+de\\s+(?:(?:la\\s+)?(?:otra|siguiente|proxima)\\s+semana|la\\s+semana\\s+(?:que\\s+viene|proxima|siguiente))\\b|`
    + `\\b(?:(?:siguiente|posterior)\\s+${DIAS}|${DIAS}\\s+(?:siguiente|posterior))\\b|`
    + `\\b${DIAS}\\s+despues\\s+de\\s+(?:este|el\\s+actual)\\b|`
    + `\\b(?:antes|despues)\\s+de(?:l)?\\s+(?:(?:este|el)\\s+)?${DIAS}\\b|`
    + `\\b(?:a\\s+partir\\s+de(?:l)?|hasta)\\s+(?:(?:el|este)\\s+)?${DIAS}\\b|`
    + `\\b(?:\\d+|un|una|dos|tres|cuatro|cinco|seis|siete)\\s+dias?\\s+(?:antes|despues)\\s+de(?:l)?\\s+(?:(?:este|el)\\s+)?${DIAS}\\b|`
    + `\\b(?:el\\s+)?dia\\s+(?:anterior|siguiente)\\s+a(?:l)?\\s+(?:(?:este|el)\\s+)?${DIAS}\\b|`
    + `\\b(?:para\\s+el|este|otro|proxim[oa]|el\\s+(?:otro|proxim[oa]))\\s+fin\\s+de\\s+semana(?:\\s+que\\s+viene)?\\b|`
    + `\\bfin\\s+de\\s+semana\\s+que\\s+viene\\b|`
    + `\\b(?:el\\s+)?mes\\s+que\\s+viene\\b|`
    + `\\b(?:para\\s+)?(?:(?:el\\s+)?(?:proximo|siguiente|entrante)\\s+mes|(?:el\\s+)?mes\\s+(?:proximo|siguiente|entrante))\\b|`
    + `\\b(?:el\\s+)?(?:proxim[oa]\\s+(?:dia\\s+)?\\d{1,2}|`
    + `\\d{1,2}\\s+del\\s+proximo\\s+mes)\\b`,
).test(texto);

const esSeleccionNumericaDeMenu = (textoNormalizado, coincidencia) => {
  const antes = textoNormalizado.slice(0, coincidencia.index).trim();
  const despues = textoNormalizado
    .slice((coincidencia.index || 0) + coincidencia[0].length).trim();
  const despuesSinSeparador = despues.replace(/^[,;:]\s*/, '');
  const numero = Number(coincidencia[0].match(/\d+/)?.[0]);
  const prefijoDiscursivo = new RegExp(
    `^(?:no|${AFIRMACION_TEMPORAL})(?:\\s*[,;:]\\s*(?:por\\s+favor|gracias|entonces|claro))*\\s*[,;:]?$`,
  ).test(antes);
  const sufijoConMes = new RegExp(`^(?:(?:de\\s+)?${MESES}\\b|del?\\s+proximo\\s+mes\\b)`).test(despuesSinSeparador);
  const sufijoConHora = /^(?:a\s+las?|por\s+la)\b/.test(despuesSinSeparador);
  const sufijoDeclaraFecha = /^(?:(?:esa|esta|aquella)\s+)?(?:es\s+)?(?:la\s+)?fecha(?:\s+de\s+(?:la\s+)?entrega)?\b/.test(despuesSinSeparador);
  const menuExplicitoDirecto = /\b(?:con|opcion|combo|numero|num|codigo|producto|articulo|item|platillo|paquete|lista|carta|menu|catalogo)\s*(?:[,;:\/—-]|\(\s*)?\s*$/.test(antes)
    || /\b(?:de\s+la\s+(?:lista|carta)|del?\s+(?:menu|catalogo)|de\s+las?\s+opciones?|de\s+los?\s+combos?)\s*(?:[,;:\/—-]|\(\s*)?\s*$/.test(antes)
    || /^(?:de\s+la\s+(?:lista|carta)|del?\s+(?:menu|catalogo)|de\s+las?\s+opciones?|de\s+los?\s+combos?)\b/.test(despuesSinSeparador);
  if (menuExplicitoDirecto) return true;
  // Cuando el propio cliente nombra el pedido/orden/entrega, «lo quiero el
  // 25» está fijando su día. Esa evidencia contextual gana a los verbos
  // débiles que, sin contexto, sí suelen escoger una opción del menú.
  if (contextoTemporalExplicitoAntes(antes)) return false;
  if (sufijoDeclaraFecha) return false;
  const menuExplicitoContextual = /\b(?:lista|carta|menu|catalogo|opciones?|combos?)\b[^.!?]{0,40}\b(?:tambien\s+|ademas\s+)?(?:quiero|prefiero|dame|deme|ponle|ponme|pon|agrega|anade|elige|elegi|escojo|escogi|escoji|selecciono|seleccione)\s*$/.test(antes)
    || /\b(?:y|tambien|ademas)\s+(?:quiero|prefiero|dame|deme|ponle|ponme|pon|agrega|anade|elige|elegi|escojo|escogi|escoji|selecciono|seleccione)\s*$/.test(antes);
  if (menuExplicitoContextual) return true;
  // «el 25 de septiembre» es fecha incluso en «lo quiero el 25...». Para una
  // selección el cliente aún puede decir «el 25 del menú», cubierta arriba.
  if (sufijoConMes) return false;
  // En una enumeración, «dos waffles, el 2» suele ser una selección; un día
  // alto o acompañado de hora/mes conserva su lectura temporal. «Sí, el 2»
  // y «No, el 2 sí/no» son respuestas discursivas, no enumeraciones.
  const indiceBajoTrasSeparador = numero <= 10 && /[,;]\s*$/.test(antes)
    && !prefijoDiscursivo && !sufijoConHora;
  return indiceBajoTrasSeparador
    || /\b(?:y|mas|tambien|ademas)\s*[,;:]?\s*$/.test(antes)
    || ACCION_SELECCION_FUERTE_CERCANA.test(antes)
    || (numero <= 12 && ACCION_SELECCION_DEBIL_CERCANA.test(antes));
};

const ocultarSeleccionesNumericasDeMenu = (textoNormalizado) => {
  const selecciones = [...textoNormalizado.matchAll(DIA_NUMERICO_DESNUDO)]
    .filter((coincidencia) => esSeleccionNumericaDeMenu(textoNormalizado, coincidencia));
  if (!selecciones.length) return textoNormalizado;
  // Los índices de RegExp son unidades UTF-16; split('') conserva ese mismo
  // sistema incluso si el mensaje trae un emoji antes de «el 2».
  const caracteres = textoNormalizado.split('');
  for (const seleccion of selecciones) {
    const fin = (seleccion.index || 0) + seleccion[0].length;
    for (let i = seleccion.index || 0; i < fin; i += 1) caracteres[i] = ' ';
  }
  return caracteres.join('');
};

/**
 * «el 2» suele ser opción/combo, no fecha. Solo se habilita como día cuando
 * hay contexto temporal inequívoco o ya se estaba esperando esa fecha.
 */
export function esDiaNumericoDesnudoAmbiguo(texto, { esperaFechaProgramacion = false } = {}) {
  const t = normalizar(texto).replace(/\s+/g, ' ').trim();
  const dias = [...t.matchAll(DIA_NUMERICO_DESNUDO)];
  if (!dias.length) return false;
  const dia = dias.at(-1);
  const antes = t.slice(0, dia.index).trim();
  const despues = t.slice((dia.index || 0) + dia[0].length).trim();
  const despuesSinSeparador = despues.replace(/^[,;:]\s*/, '');

  // Las referencias explícitas a una opción ganan sobre la lectura de fecha:
  // «con el 2», «el 2 de la lista» y «combo el 2» no programan una entrega.
  const seleccionDeMenu = esSeleccionNumericaDeMenu(t, dia);
  if (seleccionDeMenu) {
    const sinSelecciones = ocultarSeleccionesNumericasDeMenu(t);
    // Si la frase también contiene otro «el N», se evalúa ese candidato. Así
    // «quiero el 2 del menú para el 25» conserva el 25 y descarta solo el 2.
    if (/\bel\s+(?:[1-9]|[12]\d|3[01])\b/.test(sinSelecciones)) {
      return esDiaNumericoDesnudoAmbiguo(sinSelecciones, { esperaFechaProgramacion });
    }
    // Una opción y una fecha pueden coexistir: «el 2 del menú para
    // 2026-09-25». Ocultar la selección no debe ocultar la fecha independiente.
    const fechaIndependiente = /\b(?:19|20)\d{2}-\d{1,2}-\d{1,2}\b/.test(sinSelecciones)
      || /\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/.test(sinSelecciones)
      || new RegExp(`\\b(?:manana|pasado\\s+manana|(?:(?:el|este)\\s+)?${DIAS}`
        + `|(?:[1-9]|[12]\\d|3[01])\\s+(?:de\\s+)?${MESES})\\b`).test(sinSelecciones);
    return !fechaIndependiente;
  }
  // El estado puede estar esperando exactamente el día del mes, pero esa
  // excepción solo se consulta después de descartar una selección de menú.
  if (esperaFechaProgramacion) return false;
  const sufijoTemporalExplicito = new RegExp(
    `^(?:a\\s+las?|por\\s+la|(?:de\\s+)?${MESES}\\b)`,
  ).test(despuesSinSeparador)
    || /^(?:(?:esa|esta|aquella)\s+)?(?:es\s+)?(?:la\s+)?fecha(?:\s+de\s+(?:la\s+)?entrega)?\b/.test(despuesSinSeparador);
  if (accionDeSeleccionCercana(antes) && !contextoTemporalExplicitoAntes(antes)
      && !sufijoTemporalExplicito) return true;
  if (sufijoTemporalExplicito) return false;

  // Un tramo nominal real hace que «el 25» sea una fecha natural de entrega.
  // Se analizan tokens, no su longitud: «tacos al pastor», «té» o «2 kg de
  // pan» incluyen conectores/palabras cortas y no deben registrarse para hoy.
  const palabrasNoProducto = new Set([
    'a', 'al', 'de', 'del', 'el', 'la', 'las', 'los', 'y', 'o', 'con', 'sin',
    'para', 'por', 'en', 'un', 'una', 'unos', 'unas', 'mi', 'mis',
    'me', 'se', 'le', 'les', 'lo',
    'quiero', 'quisiera', 'dame', 'deme', 'ponle', 'pon', 'agrega', 'anade',
    'elige', 'escojo', 'selecciono', 'si', 'no', 'ok', 'vale', 'listo', 'perfecto',
    'hola', 'oye', 'gracias', 'favor', 'buenos', 'buenas', 'dias', 'tardes', 'noches',
  ]);
  const tieneProducto = (antes.match(/[a-zñ]+(?:-[a-zñ]+)*/g) || [])
    .some((token) => !palabrasNoProducto.has(token));
  if (tieneProducto) return false;
  if (/\bpara\s+el\s+(?:[1-9]|[12]\d|3[01])\b/.test(t)) return false;
  if (new RegExp(`\\bel\\s+(?:[1-9]|[12]\\d|3[01])\\s+(?:de\\s+)?${MESES}\\b`).test(t)) return false;
  if (/\b(?:a\s+las?|por\s+la)\b|\b(?:[01]?\d|2[0-3])(?::[0-5]\d)?\s*(?:a\.?\s*m\.?|p\.?\s*m\.?)\b/.test(t)) return false;
  if (/\b(?:pedido|orden|fecha|entrega|envio|recogida|recoleccion|programacion|agenda)(?:\s+(?:es|queda|seria))?(?:\s+para)?\s*[:,-]?$/.test(antes)) return false;
  return true;
}

/** «No, el viernes…» rechaza una fecha; «No, para el viernes…» la asigna. */
export function esRechazoTersoDeFecha(texto) {
  const t = normalizar(texto).replace(/\s+/g, ' ').trim();
  const encabezadoDeFecha = '(?:(?:(?:la|esa|aquella)\\s+fecha|(?:el|ese|aquel)\\s+dia)(?:\\s+(?:correspondiente\\s+)?(?:a|al|de|del|para))?\\s*[:,]?\\s*)?';
  const despuesDelNoInicial = t.replace(/^no\s*[,;]\s*/, '');
  const despuesSinNoAfirmativo = despuesDelNoInicial.replace(
    /\bno\s+(?:hay\s+(?:problema|inconveniente)|te\s+preocupes|se\s+preocupe|pasa\s+nada)\b/g,
    '',
  );
  const afirmacionTerminalNegada = new RegExp(
    `\\bno\\b[^.!?]{0,35}\\b(?:${AFIRMACION_TEMPORAL}|esta\\s+bien|bien)`
      + `(?:\\s+por\\s+favor)?[.!]?\\s*$`,
  ).test(despuesSinNoAfirmativo);
  const terminaAfirmando = new RegExp(
    `\\b(?:${AFIRMACION_TEMPORAL}|esta\\s+bien)(?:\\s+por\\s+favor)?[.!]?\\s*$`,
  ).test(t) && !afirmacionTerminalNegada;
  const terminaNegando = /\b(?:tampoco|no\s+(?:puedo|(?:me\s+)?(?:sirve|funciona|viene\s+bien|queda\s+bien)|esta\s+bien)|es\s+imposible|queda\s+descartad[oa])(?:\s+por\s+favor)?[.!]?\s*$/.test(t);
  const reemplazoConFecha = new RegExp(
    `\\b(?:mejor|prefiero|sino)\\b[^.!?]{0,50}\\b(?:para\\s+)?(?:manana|pasado\\s+manana|`
      + `(?:(?:el|este)\\s+)?(?:proxim[oa]\\s+)?${DIAS}(?:\\s+que\\s+viene)?|`
      + `(?:la\\s+)?proxima\\s+semana|(?:(?:el|este)\\s+)?\\d{1,2}`
      + `(?:\\s+(?:de\\s+)?${MESES})?|(?:el\\s+)?(?:19|20)\\d{2}-\\d{1,2}-\\d{1,2}|`
      + `(?:el\\s+)?\\d{1,2}[/-]\\d{1,2})\\b`,
  ).test(t);
  return /^no\s*[,;]\s*/.test(t)
    // Un sí/no terminal es la decisión inequívoca sobre el candidato y debe
    // llegar al analizador: «No, el viernes sí» afirma; «..., no» invalida.
    && !/\b(?:si|no)(?:\s+por\s+favor)?[.!]?\s*$/.test(t)
    && !terminaAfirmando
    && !terminaNegando
    && !reemplazoConFecha
    && new RegExp(
      `^no\\s*[,;]\\s*(?!para\\b)${encabezadoDeFecha}(?:manana|pasado\\s+manana|`
        + `(?:(?:el|este|ese|aquel)\\s+)?(?:proxim[oa]\\s+)?${DIAS}(?:\\s+que\\s+viene)?|`
        + `(?:la\\s+)?proxima\\s+semana|`
        + `(?:(?:el|este|ese|aquel)\\s+)?\\d{1,2}(?:\\s+(?:de\\s+)?${MESES})?|`
        + `(?:(?:el|este|ese|aquel)\\s+)?(?:19|20)\\d{2}-\\d{1,2}-\\d{1,2}|`
        + `(?:(?:el|este|ese|aquel)\\s+)?\\d{1,2}[/-]\\d{1,2})\\b`,
    ).test(t);
}

/**
 * Una referencia futura puede describir un pago, un comprobante o una
 * conversación posterior sin fijar la entrega del pedido. Se comparte entre
 * detector y canal para que una referencia ambigua tampoco borre una reserva.
 */
export function esGestionTemporalAjenaAlPedido(texto) {
  const t = normalizar(texto).replace(/\s+/g, ' ').trim();
  // Acciones personales inequívocas no administran el carrito aunque usen la
  // misma gramática temporal de una corrección (p. ej. «mañana no trabajo,
  // pero el sábado sí»). Ante una frase mixta se prefiere pedir precisión.
  const gestionPersonalInequivoca = /\b(?:no\s+)?trabaj(?:o|ar|are|aria|amos|an)\b/.test(t)
    || /\b(?:tengo|tendre|hay|voy\s+a)\s+(?:una\s+)?(?:clases?|cita)\b/.test(t)
    || /\b(?:ir|voy)\s+al?\s+medico\b/.test(t)
    || /\b(?:recoger|llevar)\s+(?:a\s+)?(?:mi\s+)?(?:hij[oa]s?|mama|madre|padre)\b/.test(t)
    || /\b(?:llevo|llevar)\b[^.!?]{0,35}\b(?:a\s+)?(?:mi|tu|su)\s+(?:hij[oa]s?|mama|madre|padre)\b/.test(t)
    || /\b(?:voy\s+a|pienso\s+|planeo\s+)(?:comprar|cocinar|desayunar|publicar)\b/.test(t)
    || /\b(?:quiero|quisiera|necesito)\s+(?:comprar|cocinar|desayunar|publicar)\b/.test(t)
    || /\b(?:cocino|publico)\b/.test(t)
    || /\b(?:preparar|entregar)\s+(?:(?:un|una|el|la)\s+)?(?:presentacion|reporte)\b/.test(t)
    || /\benviar\s+(?:(?:un|el)\s+)?paquete\b/.test(t)
    || /\b(?:pedir|agendar|programar|reservar)\s+(?:(?:un|una|el|la)\s+)?cita\b/.test(t)
    || /\bordenar\s+(?:(?:el|mi)\s+)?cuarto\b/.test(t)
    || /\bencargar\s+flores\b/.test(t)
    || /\b(?:fecha|agenda|programacion)\b[^.!?]{0,40}\b(?:cita|clases?)\b/.test(t)
    || /\b(?:mi|la|una)\s+agenda\b/.test(t)
    || /\b(?:entrega|envio|recogida|recoleccion)\s+(?:de\s+|del\s+|de la\s+)?(?:el\s+|la\s+|un\s+|una\s+|mi\s+|tu\s+|su\s+)?(?:paquete|amazon|hij[oa]s?|mama|madre|padre|clases?)\b/.test(t);
  const gestionAjenaAlPedido = /\b(?:me\s+|te\s+)?(?:aviso|avisen|avisas|avisa|avisame|notifico|notifiquen|notificame|recuerdo|recuerdame)\b/.test(t)
    || /\b(?:te\s+)?(?:llamo|marco)\b|\bnos\s+vemos\b|^hasta\s+(?:manana|pasado\s+manana|el\s+)?(?:lunes|martes|miercoles|jueves|viernes|sabado|domingo)[.!]?$/.test(t)
    || /\b(?:manana\s+)?(?:te\s+digo|lo\s+reviso|decido)\b|\bdejame\s+verlo\b|\bvoy\s+al?\s+medico\b/.test(t)
    || /\b(?:cancelar|cancela|cancelen|anular|anula)\b.{0,45}\bpedido\b/.test(t)
    || /\b(?:facturar|factura|facturen)\b(?:.{0,45}\bpedido\b)?/.test(t)
    || /\b(?:reservar|reserva|apart(?:ar|a))\b.{0,35}\bmesa\b/.test(t)
    || /\bmesa\b.{0,35}\b(?:reservar|reserva|apart(?:ar|a))\b/.test(t);
  const pideEnlace = /\b(?:enviame|mandame|pasame|comparte(?:me)?)\b.{0,30}\b(?:enlace|link)\b/.test(t);
  const administraDatos = /\b(?:te\s+|les\s+|me\s+)?(?:mando|mandare|envio|enviare|paso|pasare|comparto|compartire|envias?|mandas?|pasas?)\b[^.!?]{0,45}\b(?:direccion|ubicacion|comprobante|datos|foto|captura|recibo|factura)\b/.test(t)
    || /\b(?:direccion|ubicacion|comprobante|datos|foto|captura|recibo|factura)\b[^.!?]{0,45}\b(?:mando|envio|paso|comparto)\b/.test(t);
  const segmentos = t.split(/\s*(?:[;.]|\bpero\b|,\s*(?=(?:que|me|lo|la|los|las)\b))\s*/);
  const verboDeEntrega = /\b(?:entrega(?:lo|la|los|las|r|s|n)?|recog(?:er|es|e|en|emos)|recojo|manda(?:r|s|n)?|envia(?:r|s|n)?|trae(?:r|s|n)?|lleva(?:r|s|n)?|repartir|prepara(?:r|s|n)?|llegue)\b/;
  const referenciaTemporal = new RegExp(
    `\\b(?:manana|pasado\\s+manana|(?:(?:el|este|proxim[oa])\\s+)?${DIAS}`
      + `|(?:el\\s+)?\\d{1,2}(?:\\s+(?:de\\s+)?${MESES})?`
      + `|(?:19|20)\\d{2}-\\d{1,2}-\\d{1,2}|\\d{1,2}[/-]\\d{1,2})\\b`,
  );
  const asignaEntregaATemporal = segmentos.some((segmento) => verboDeEntrega.test(segmento)
    && (referenciaTemporal.test(segmento) || referenciaRelativaComplejaEn(segmento))
    && !/\b(?:direccion|ubicacion|comprobante|datos|foto|captura|recibo|factura|enlace|link)\b/.test(segmento));
  const senalEntregaExplicita = asignaEntregaATemporal
    || (/\b(?:entrega(?:r|s|n)?|recog(?:er|o|es|e|en|emos)|manda(?:r|s|n)?|envia(?:r|s|n)?|trae(?:r|s|n)?|lleva(?:r|s|n)?|repartir|prepara(?:r|s|n)?|llegue)\b/.test(t)
      && !pideEnlace && !administraDatos);
  const asignaPedidoATemporal = /\b(?:pedir|ordenar|encargar|programar|agendar)\b/.test(t)
    || (/\b(?:apartar|reservar)\b/.test(t) && !/\bmesa\b/.test(t))
    || /\b(?:quiero|quisiera|necesito)\s+(?:(?:este|el|mi)\s+)?pedido\s+para\b/.test(t)
    || /\b(?:(?:este|el|mi)\s+)?pedido\s+(?:es|seria)\s+para\b/.test(t);
  const asignacionTemporalExplicita = asignaPedidoATemporal || asignaEntregaATemporal;
  const vinculoPersonalAlPedido = /\b(?:pedido|orden)\b[^.!?]{0,60}\b(?:para|mejor|prefiero|cambia(?:lo)?|mueve(?:lo)?)\b/.test(t)
    || /\b(?:hoy|ahora|manana|pasado\s+manana|lunes|martes|miercoles|jueves|viernes|sabado|domingo|\d{1,2}(?:[/:.-]\d{1,2})?)\b[^.!?]{0,60}\bpara\s+(?:(?:el|mi|este|ese)\s+)?(?:pedido|orden)\b/.test(t);
  const objetivoTemporalAjeno = !asignacionTemporalExplicita && (
    pideEnlace || administraDatos || (!senalEntregaExplicita && (
      /\b(?:pagar|pago|pagamos|liquido|abono)\b/.test(t)
      || /\b(?:confirmo|confirmamos|te\s+confirmo)\b/.test(t)
      || /\b(?:hablamos|platicamos|te\s+escribo|nos\s+escribimos)\b/.test(t)
      || /\bhasta\s+manana\b|\bnos\s+vemos\s+manana\b/.test(t)
    ))
  );
  return (gestionPersonalInequivoca && !vinculoPersonalAlPedido)
    || (gestionAjenaAlPedido && !asignacionTemporalExplicita) || objetivoTemporalAjeno;
}

/** Preguntar si algo sería posible no autoriza a fijar una fecha. */
export function esConsultaDePosibilidadDePedido(texto) {
  const t = normalizar(texto).replace(/\s+/g, ' ').trim();
  const accionPosible = '(?:hacer\\s+un\\s+pedido|pedir|ordenar|encargar|apartar|reservar|programar|agendar|cambiar|mover|recoger|retirar|entregar|enviar|mandar|traer|llevar|pasar(?:\\s+por)?)';
  return /\b(?:quiero|quisiera|necesito|me\s+gustaria)\s+(?:saber|consultar|preguntar)\b/.test(t)
    || /\bsera\s+que\b/.test(t)
    || /\b(?:habra|hay|tienen)\s+(?:alguna\s+)?(?:forma|chance|posibilidad)\s+de\b/.test(t)
    || new RegExp(`\\b(?:puedo|podre|podria|podemos|podremos|podriamos|debo|deberiamos?|tengo\\s+que|tenemos\\s+que|conviene)\\s+${accionPosible}\\b`).test(t)
    || new RegExp(`\\b(?:se\\s+(?:puede|podra|podria)|(?:es|sera|seria)\\s+posible)\\s+${accionPosible}\\b`).test(t)
    || /\b(?:es|sera|seria)\s+posible\s+que\b[^.!?]{0,60}\b(?:llegue|lleguen|entregue|entreguen|envie|envien|mande|manden|traiga|traigan|lleve|lleven|recoja|recojan|prepare|preparen)\b/.test(t)
    || /\b(?:crees?|piensas?)\s+que\b[^.!?]{0,60}\b(?:llegue|lleguen|entregue|entreguen|envie|envien|mande|manden|traiga|traigan|lleve|lleven|recoja|recojan|prepare|preparen)\b/.test(t)
    || new RegExp(`\\b(?:me\\s+)?(?:puedes?|podras?|podrias?|pueden|podran|podrian)\\s+${accionPosible}\\b`).test(t)
    || new RegExp(`\\bme\\s+ayudas\\s+a\\s+${accionPosible}\\b`).test(t)
    || new RegExp(`\\b(?:crees?|piensas?)\\s+que\\s+(?:se\\s+)?(?:puede|pueden|podra|podran|podria|podrian)\\s+${accionPosible}\\b`).test(t);
}

const HORAS_EN_PALABRAS = Object.freeze({
  una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8,
  nueve: 9, diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15,
  dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19, veinte: 20,
  veintiuna: 21, veintiuno: 21, veintidos: 22, veintitres: 23, veinticuatro: 24,
});

const MESES_NUMERO = Object.freeze({
  enero: 1, ene: 1, febrero: 2, feb: 2, marzo: 3, mar: 3,
  abril: 4, abr: 4, mayo: 5, may: 5, junio: 6, jun: 6,
  julio: 7, jul: 7, agosto: 8, ago: 8,
  septiembre: 9, setiembre: 9, sept: 9, sep: 9,
  octubre: 10, oct: 10, noviembre: 11, nov: 11, diciembre: 12, dic: 12,
});

const DIA_SEMANA_NUMERO = Object.freeze({
  domingo: 0, lunes: 1, martes: 2, miercoles: 3,
  jueves: 4, viernes: 5, sabado: 6,
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

const fechaDesdePartes = (anio, mes, dia) => {
  const y = Number(anio);
  const m = Number(mes);
  const d = Number(dia);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  const candidata = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return fechaCalendarioSegura(candidata);
};

const sumarDiasCalendario = (fecha, dias) => {
  const segura = fechaCalendarioSegura(fecha);
  if (!segura || !Number.isInteger(dias)) return null;
  const [y, m, d] = segura.split('-').map(Number);
  const resultado = new Date(Date.UTC(y, m - 1, d + dias, 12));
  return fechaDesdePartes(resultado.getUTCFullYear(), resultado.getUTCMonth() + 1, resultado.getUTCDate());
};

const fechaSinAnioDesdeAncla = (mes, dia, fechaAncla) => {
  const ancla = fechaCalendarioSegura(fechaAncla);
  if (!ancla) return null;
  const anio = Number(ancla.slice(0, 4));
  const esteAnio = fechaDesdePartes(anio, mes, dia);
  if (esteAnio && esteAnio >= ancla) return esteAnio;
  return fechaDesdePartes(anio + 1, mes, dia);
};

const diaDelMesDesdeAncla = (dia, fechaAncla) => {
  const ancla = fechaCalendarioSegura(fechaAncla);
  if (!ancla) return null;
  const [anio, mes] = ancla.split('-').map(Number);
  const esteMes = fechaDesdePartes(anio, mes, dia);
  if (esteMes && esteMes >= ancla) return esteMes;
  const siguiente = new Date(Date.UTC(anio, mes, 1, 12));
  return fechaDesdePartes(siguiente.getUTCFullYear(), siguiente.getUTCMonth() + 1, dia);
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
    /\bhoy\b/,
    /\bahora\b/,
    /\blo\s+antes\s+posible\b/,
    new RegExp(`\\b(?:(?:para\\s+)?(?:este|el)\\s+)?${DIAS}(?:\\s+que\\s+viene)?\\b`),
    /\b(?:para\s+)?(?:el(?:\s+dia)?|este(?:\s+dia)?|dia)\s+(?:[1-9]|[12]\d|3[01])\b/,
    new RegExp(`\\b(?:para\\s+(?:el(?:\\s+dia)?|este(?:\\s+dia)?|dia)|(?:el|este)\\s+dia)\\s+${DIA_MES_EN_PALABRAS}\\b`),
  ]);
  return { fecha, hora };
};

const PATRONES_FECHA = Object.freeze([
  '\\b(?:19|20)\\d{2}-(?:0?[1-9]|1[0-2])-(?:0?[1-9]|[12]\\d|3[01])\\b',
  '\\b(?:0?[1-9]|[12]\\d|3[01])[\\/-](?:0?[1-9]|1[0-2])[\\/-](?:\\d{2}|(?:19|20)\\d{2})\\b',
  '\\b(?:0?[1-9]|[12]\\d|3[01])\\/(?:0?[1-9]|1[0-2])\\b',
  `\\b(?:para\\s+)?(?:el\\s+)?(?:[1-9]|[12]\\d|3[01])\\s+(?:de\\s+)?${MESES}`
    + '\\.?(?:\\s+(?:de\\s+)?(?:19|20)\\d{2})?\\b',
  '\\bpasado\\s+manana\\b',
  `\\bproxim[oa]\\s+(?:semana|${DIAS})\\b`,
  '\\bmanana\\b',
  '\\bhoy\\b',
  `\\b(?:(?:para\\s+)?(?:este|el)\\s+)?${DIAS}(?:\\s+que\\s+viene)?\\b`,
  '\\b(?:para\\s+)?(?:el(?:\\s+dia)?|este(?:\\s+dia)?|dia)\\s+(?:[1-9]|[12]\\d|3[01])\\b',
  `\\b(?:para\\s+(?:el(?:\\s+dia)?|este(?:\\s+dia)?|dia)|(?:el|este)\\s+dia)\\s+${DIA_MES_EN_PALABRAS}\\b`,
]);

const PATRONES_HORA = Object.freeze([
  `\\ba\\s+las?\\s+(?:${HORA_NUMERICA}|${HORA_EN_PALABRAS}`
    + `(?:\\s+y\\s+(?:media|cuarto))?|mediodia|medianoche)${CALIFICADOR_HORA}\\b`,
  '\\b(?:por|en)\\s+la\\s+(?:manana|tarde|noche)\\b',
  '\\b(?:[01]?\\d|2[0-3]):[0-5]\\d(?:\\s*(?:a\\.?\\s*m\\.?|p\\.?\\s*m\\.?))?\\b',
  '\\b(?:[01]?\\d|2[0-3])\\s*(?:a\\.?\\s*m\\.?|p\\.?\\s*m\\.?)\\b',
  '\\b(?:[01]?\\d|2[0-3])\\s+de\\s+la\\s+(?:manana|tarde|noche)\\b',
  `\\b${HORA_EN_PALABRAS}(?:\\s+y\\s+(?:media|cuarto))?`
    + '\\s*(?:a\\.?\\s*m\\.?|p\\.?\\s*m\\.?|de\\s+la\\s+(?:manana|tarde|noche))\\b',
]);

const coincidenciasTemporales = (texto, patrones) => {
  const todas = [];
  for (const fuente of patrones) {
    for (const coincidencia of texto.matchAll(new RegExp(fuente, 'g'))) {
      const valor = coincidencia[0]?.trim().replace(/[.!?,;:]+$/, '');
      if (!valor) continue;
      todas.push({
        valor,
        inicio: coincidencia.index,
        fin: coincidencia.index + coincidencia[0].length,
      });
    }
  }
  // Los patrones intencionalmente se solapan: «pasado mañana» también
  // contiene «mañana», y «a las 10 am» contiene «10 am». Conservamos el
  // fragmento más largo que empieza antes para que una sola evidencia nunca
  // parezca una alternativa.
  todas.sort((a, b) => a.inicio - b.inicio || (b.fin - b.inicio) - (a.fin - a.inicio));
  const elegidas = [];
  for (const candidata of todas) {
    if (elegidas.some((actual) => candidata.inicio < actual.fin && candidata.fin > actual.inicio)) continue;
    elegidas.push(candidata);
  }
  return elegidas;
};

const distintas = (coincidencias) => {
  const vistas = new Set();
  return coincidencias.filter(({ valor }) => {
    const clave = normalizar(valor).replace(/\s+/g, ' ').trim();
    if (vistas.has(clave)) return false;
    vistas.add(clave);
    return true;
  });
};

const destinoInmediatoEn = (texto) => {
  const t = texto.trim();
  return /\b(?:para|mejor|prefiero|seria|hazlo|dejalo|cambialo|muevelo|pasalo|ponlo)\s+(?:para\s+)?(?:hoy|ahora)\b/.test(t)
    || /\blo\s+quiero\s+(?:para\s+)?(?:hoy|ahora)\b/.test(t)
    || /\bquiero\s+que\s+sea\s+(?:para\s+)?(?:hoy|ahora)\b/.test(t)
    || /\blo\s+antes\s+posible\b/.test(t)
    || /^(?:hoy|ahora)[.!]?\s*$/.test(t);
};

const rangoHorarioEn = (texto) => {
  const marcaHora = `(?:${HORA_NUMERICA}|${HORA_EN_PALABRAS}`
    + `(?:\\s+y\\s+(?:media|cuarto))?)${CALIFICADOR_HORA}`;
  return new RegExp(`\\b(?:entre\\s+(?:las?\\s+)?${marcaHora}`
    + `\\s+(?:y|o|u)\\s+(?:las?\\s+)?${marcaHora}`
    + `|de\\s+(?:las?\\s+)?${marcaHora}\\s+(?:a|hasta)\\s+(?:las?\\s+)?${marcaHora}`
    + `|a\\s+las?\\s+${marcaHora}\\s+(?:o|u)\\s+(?:a\\s+las?\\s+)?${marcaHora})\\b`).test(texto);
};

const referenciasCrudas = (texto) => {
  const horas = distintas(coincidenciasTemporales(texto, PATRONES_HORA));
  // «por la mañana» es una hora aproximada, no una segunda fecha. El mismo
  // descarte se aplica a cualquier solapamiento entre los dos vocabularios.
  const fechas = distintas(coincidenciasTemporales(texto, PATRONES_FECHA)
    .filter((fecha) => !horas.some((hora) => fecha.inicio < hora.fin && fecha.fin > hora.inicio)));
  const respaldo = extraerReferencias(texto);
  if (!fechas.length && respaldo.fecha
      && !/^(?:ahora|lo antes posible)$/.test(respaldo.fecha)) {
    fechas.push({ valor: respaldo.fecha, inicio: -1, fin: -1 });
  }
  if (!horas.length && respaldo.hora) {
    horas.push({ valor: respaldo.hora, inicio: -1, fin: -1 });
  }
  return {
    fechas,
    horas,
    ambiguaFecha: fechas.length > 1 || referenciaRelativaComplejaEn(texto),
    ambiguaHora: horas.length > 1 || rangoHorarioEn(texto),
    inmediato: destinoInmediatoEn(texto),
    correccion: false,
  };
};

const ultimaFronteraDeCorreccion = (texto) => {
  const fronteras = [];
  const agregar = (patron, modo, desplazarAlFinal = true) => {
    for (const coincidencia of texto.matchAll(patron)) {
      fronteras.push({
        inicio: coincidencia.index,
        fin: desplazarAlFinal
          ? coincidencia.index + coincidencia[0].length
          : coincidencia.index,
        modo,
      });
    }
  };
  agregar(/\b(?:mejor|prefiero|cambia(?:lo)?|mueve(?:lo)?|pasalo|dejalo|ponlo|perdon|digo|corrijo|quise\s+decir|mas\s+bien|en\s+realidad|sino)\b/g, 'reemplaza');
  // En «mañana no, pero el sábado sí» la referencia afirmada está después
  // de la coordinación. Esta frontera debe ganar a la regla genérica de `no`.
  agregar(/\bno\b\s*,?\s*(?:pero|y)\s+(?=[^,;.?!]{0,100}\bsi\b)/g, 'reemplaza');
  // «viernes, no, sábado» y «viernes no; sábado» afirman lo que sigue.
  agregar(/(?:,\s*)?\bno\b\s*[,;]\s*/g, 'reemplaza');
  // Una negación sin coma niega el candidato que la sigue. La coma cambia la
  // semántica: «no, mañana» sí es una autocorrección afirmativa y la cubre la
  // frontera `reemplaza` anterior.
  agregar(new RegExp(
    `\\bno\\b(?!\\s*[,;])(?=[^,;.?!]{0,100}\\b(?:hoy|ahora|manana|pasado\\s+manana|${DIAS}`
      + `|(?:el\\s+)?\\d{1,2}(?:\\s+(?:de\\s+)?${MESES})?`
      + `|(?:19|20)\\d{2}-\\d{1,2}-\\d{1,2}|\\d{1,2}[/-]\\d{1,2}`
      + `|a\\s+las?|por\\s+la|\\d{1,2}(?::\\d{2})?\\s*(?:a\\.?\\s*m\\.?|p\\.?\\s*m\\.?))\\b)`,
    'g',
  ), 'niega_sufijo', false);
  agregar(new RegExp(`\\b(?:excepto|salvo|cualquier\\s+(?:dia|fecha)\\s+menos)\\s+`
    + `(?=(?:el\\s+)?(?:manana|pasado\\s+manana|${DIAS})\\b)`, 'g'), 'niega_sufijo', false);
  agregar(/\bsin\s+(?:entrega|envio|recogida|recoleccion)\b/g, 'niega_sufijo', false);
  // «viernes, no sábado» niega solo el segundo candidato: conserva el tramo
  // anterior y nunca elige silenciosamente la referencia negada.
  agregar(new RegExp(
    `[,;]\\s*\\bno\\b(?!\\s*[,;])\\s+(?=[^,;.?!]{0,100}\\b(?:hoy|ahora|manana|pasado\\s+manana|${DIAS}`
      + `|(?:el\\s+)?\\d{1,2}(?:\\s+(?:de\\s+)?${MESES})?`
      + `|(?:19|20)\\d{2}-\\d{1,2}-\\d{1,2}|\\d{1,2}[/-]\\d{1,2}`
      + `|a\\s+las?|por\\s+la|\\d{1,2}(?::\\d{2})?\\s*(?:a\\.?\\s*m\\.?|p\\.?\\s*m\\.?))\\b)`,
    'g',
  ), 'niega_sufijo', false);
  // Forma inicial: «no viernes, sábado». La coma cierra lo rechazado.
  const inicial = /^\s*no\b[^,;]{1,120}([,;]\s*)/.exec(texto);
  if (inicial) {
    const fin = inicial.index + inicial[0].length;
    fronteras.push({ inicio: 0, fin, modo: 'reemplaza' });
  }
  return fronteras.sort((a, b) => a.inicio - b.inicio || a.fin - b.fin).at(-1) || null;
};

const resolverReferencias = (texto, profundidad = 0) => {
  if (profundidad > 8) return referenciasCrudas(texto);
  const frontera = ultimaFronteraDeCorreccion(texto);
  if (!frontera) return referenciasCrudas(texto);

  const anteriores = resolverReferencias(texto.slice(0, frontera.inicio), profundidad + 1);
  if (frontera.modo === 'niega_sufijo') {
    return { ...anteriores, correccion: true };
  }

  const posteriores = resolverReferencias(texto.slice(frontera.fin), profundidad + 1);
  const posteriorDefineFecha = posteriores.fechas.length > 0
    || posteriores.ambiguaFecha || posteriores.inmediato;
  const posteriorDefineHora = posteriores.horas.length > 0 || posteriores.ambiguaHora;
  return {
    fechas: posteriorDefineFecha ? posteriores.fechas : anteriores.fechas,
    horas: posteriorDefineHora ? posteriores.horas : anteriores.horas,
    ambiguaFecha: posteriorDefineFecha ? posteriores.ambiguaFecha : anteriores.ambiguaFecha,
    ambiguaHora: posteriorDefineHora ? posteriores.ambiguaHora : anteriores.ambiguaHora,
    inmediato: posteriorDefineFecha ? posteriores.inmediato : anteriores.inmediato,
    correccion: true,
  };
};

/**
 * Resuelve correcciones solo cuando el texto deja un candidato afirmado.
 * Alternativas, rangos y contradicciones quedan explícitamente ambiguos para
 * que el canal invalide la reserva anterior y pida precisión.
 */
export function analizarReferenciasTemporalesDePedido(texto) {
  const t = ocultarSeleccionesNumericasDeMenu(
    normalizar(texto).replace(/\s+/g, ' ').trim().slice(0, 1000),
  );
  if (!t) {
    return {
      fecha: null, hora: null, ambiguaFecha: false, ambiguaHora: false,
      objetivoInmediato: false, correccion: false,
      fechaNegada: false, horaNegada: false, rechazoDeHoraNombrada: false,
      fechasNegadas: [], horasNegadas: [],
      tieneReferenciaTemporal: false,
    };
  }
  const crudas = referenciasCrudas(t);
  const resueltas = resolverReferencias(t);
  const coordinacionAfirmativa = (referencias) => {
    const ordenadas = [...referencias].sort((a, b) => a.inicio - b.inicio);
    for (let i = 0; i < ordenadas.length - 1; i += 1) {
      const rechazada = ordenadas[i];
      const afirmada = ordenadas[i + 1];
      const entre = t.slice(rechazada.fin, afirmada.inicio);
      const despues = t.slice(afirmada.fin);
       if (/\bno\s*,?\s*(?:pero|y)\b[^.!?]*$/.test(entre)
           && /^\s*(?:[^.!?]{0,80}\s)?si\b/.test(despues)) {
        return { rechazada, afirmada };
      }
    }
    return null;
  };
  const fechaCoordinada = coordinacionAfirmativa(crudas.fechas);
  const horaCoordinada = coordinacionAfirmativa(crudas.horas);
  const rechazoTemporalCompleto = /(?:[,;]\s*)?\bno(?:\s+por\s+favor)?[.!]?\s*$/.test(t);
  const referenciaNegada = ({ inicio, fin }) => {
    const antes = t.slice(0, inicio);
    const despues = t.slice(fin);
    // Una negación anterior no cruza una autocorrección afirmativa. En
    // «no el viernes sino el sábado», el `no` niega viernes, no sábado.
    const fronterasAfirmativas = [...antes.matchAll(/\b(?:mejor|prefiero|cambia(?:lo)?|mueve(?:lo)?|pasalo|dejalo|ponlo|perdon|digo|corrijo|quise\s+decir|mas\s+bien|en\s+realidad|sino)\b/g)];
    const coordinacionesAfirmativas = [...antes.matchAll(
      /\bno\b\s*,?\s*(?:pero|y)\b[^,;.?!]{0,100}\bsi\b/g,
    )];
    const ultimaAfirmativa = [...fronterasAfirmativas, ...coordinacionesAfirmativas]
      .sort((a, b) => (a.index || 0) - (b.index || 0)).at(-1);
    const tramoAntes = ultimaAfirmativa
      ? antes.slice((ultimaAfirmativa.index || 0) + ultimaAfirmativa[0].length)
      : antes;
    const noEnLaMismaClausula = /\bno\b(?!\s*[,;])[^,;.?!]{0,100}$/.test(tramoAntes);
    const exclusion = /\b(?:excepto|salvo|cualquier\s+(?:dia|fecha)\s+menos)\s*$/.test(tramoAntes)
      || /\bsin\s+(?:entrega|envio|recogida|recoleccion)[^,;.?!]{0,60}$/.test(tramoAntes)
      || /\b(?:ni|tampoco|menos|descarta|descarto|descartemos|olvida|olvido)\b[^,;.?!]{0,60}$/.test(tramoAntes);
    const noAlFinal = /^\s*[,;]?\s*no(?:\s+por\s+favor)?[.!]?\s*$/.test(despues);
    const negacionDespues = /^\s*[,;]?\s*(?:tampoco|queda\s+descartad[oa]|no\s+(?:puedo|(?:me\s+)?(?:sirve|funciona|viene\s+bien|queda\s+bien)|esta\s+bien)|es\s+imposible)\b/.test(despues);
    return rechazoTemporalCompleto || noEnLaMismaClausula || exclusion || noAlFinal
      || negacionDespues;
  };
  let fechasNegadas = crudas.fechas.filter(referenciaNegada).map(({ valor }) => valor);
  if (fechaCoordinada) {
    fechasNegadas = fechasNegadas
      .filter((valor) => normalizar(valor) !== normalizar(fechaCoordinada.afirmada.valor));
    if (!fechasNegadas.some((valor) =>
      normalizar(valor) === normalizar(fechaCoordinada.rechazada.valor))) {
      fechasNegadas.push(fechaCoordinada.rechazada.valor);
    }
  }
  const horaTersaNegada = new RegExp(
    `\\b(las?\\s+(?:${HORA_NUMERICA}|${HORA_EN_PALABRAS}`
      + `(?:\\s+y\\s+(?:media|cuarto))?|mediodia|medianoche)${CALIFICADOR_HORA})`
      + `\\s+no(?:\\s+por\\s+favor)?[.!]?\\s*$`,
  ).exec(t)?.[1] || null;
  const encabezadoHoraRechazada = /^no\s*[,;]\s*(?:(?:esa|aquella|la)\s+)?(?:hora|horario)(?:\s+de)?\s*[:,]?\s*/.exec(t);
  const fronteraHoraCorregida = encabezadoHoraRechazada
    ? new RegExp('\\b(?:mejor|prefiero|cambia(?:lo)?|mueve(?:lo)?|pasalo|dejalo|ponlo|perdon|digo|corrijo|quise\\s+decir|mas\\s+bien|en\\s+realidad|sino)\\b')
      .exec(t.slice(encabezadoHoraRechazada[0].length))
    : null;
  const limiteHoraRechazada = fronteraHoraCorregida
    ? encabezadoHoraRechazada[0].length + (fronteraHoraCorregida.index || 0)
    : Number.POSITIVE_INFINITY;
  const esHoraNombradaRechazada = ({ inicio }) => !!encabezadoHoraRechazada
    && inicio >= encabezadoHoraRechazada[0].length && inicio < limiteHoraRechazada;
  const rechazoDeHoraNombrada = crudas.horas.some(esHoraNombradaRechazada);
  let horasNegadas = crudas.horas
    .filter((referencia) => referenciaNegada(referencia) || esHoraNombradaRechazada(referencia))
    .map(({ valor }) => valor);
  if (horaCoordinada) {
    horasNegadas = horasNegadas
      .filter((valor) => normalizar(valor) !== normalizar(horaCoordinada.afirmada.valor));
    if (!horasNegadas.some((valor) =>
      normalizar(valor) === normalizar(horaCoordinada.rechazada.valor))) {
      horasNegadas.push(horaCoordinada.rechazada.valor);
    }
  }
  if (horaTersaNegada && !horasNegadas.includes(horaTersaNegada)) {
    horasNegadas.push(horaTersaNegada);
  }
  const fechaNegada = fechasNegadas.length > 0;
  const horaNegada = horasNegadas.length > 0;
  const ambiguaFecha = !fechaCoordinada
    && (resueltas.ambiguaFecha || resueltas.fechas.length > 1);
  const ambiguaHora = !horaCoordinada
    && (resueltas.ambiguaHora || resueltas.horas.length > 1);
  let fecha = ambiguaFecha ? null : resueltas.fechas[0]?.valor || null;
  let hora = ambiguaHora ? null : resueltas.horas[0]?.valor || null;
  if (fechaCoordinada) fecha = fechaCoordinada.afirmada.valor;
  if (horaCoordinada) hora = horaCoordinada.afirmada.valor;
  if (rechazoTemporalCompleto) {
    fecha = null;
    hora = null;
  }
  // «viernes no» deja el candidato antes del `no`; no es una afirmación.
  // Solo se retira si ESE candidato quedó negado al final. En
  // «viernes, no sábado», el viernes resuelto permanece afirmado.
  if (fecha && !fechaCoordinada
      && crudas.fechas.some((r) => normalizar(r.valor) === normalizar(fecha)
      && referenciaNegada(r))) fecha = null;
  if (hora && !horaCoordinada
      && crudas.horas.some((r) => normalizar(r.valor) === normalizar(hora)
      && (referenciaNegada(r) || esHoraNombradaRechazada(r)))) hora = null;
  const objetivoInmediato = !ambiguaFecha
    && (resueltas.inmediato || /\bhoy\b/.test(fecha || ''));
  return {
    fecha,
    hora,
    ambiguaFecha,
    ambiguaHora,
    objetivoInmediato,
    correccion: resueltas.correccion || !!fechaCoordinada || !!horaCoordinada,
    fechaNegada,
    horaNegada,
    rechazoDeHoraNombrada,
    fechasNegadas,
    horasNegadas,
    tieneReferenciaTemporal: crudas.fechas.length > 0 || crudas.horas.length > 0
      || horasNegadas.length > 0
      || crudas.inmediato || crudas.ambiguaFecha || crudas.ambiguaHora,
  };
}

/**
 * Extrae únicamente fragmentos temporales de una lista cerrada.
 *
 * Nunca conserva la frase completa: nombre, teléfono, dirección, notas y
 * cualquier otra palabra quedan fuera del estado durable. Aquí aún no se
 * convierte «mañana»: `fechasExactasDePedido` lo liga después al ancla local
 * guardada, sin aceptar una reinterpretación de los argumentos del modelo.
 */
export function referenciasTemporalesDePedido(texto) {
  const analisis = analizarReferenciasTemporalesDePedido(texto);
  return { fecha: analisis.fecha, hora: analisis.hora };
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
  const esDoceDeLaNoche = hora === 12 && /\bde\s+la\s+noche\b/.test(fragmento);
  let candidatas;
  if (esDoceDeLaNoche) candidatas = [0];
  else if (esAM) candidatas = [hora === 12 ? 0 : hora];
  else if (esPM) candidatas = [hora < 12 ? hora + 12 : hora];
  else if (hora > 12 || hora === 0) candidatas = [hora];
  else candidatas = hora === 12 ? [0, 12] : [hora, hora + 12];

  return [...new Set(candidatas)]
    .filter((h) => h >= 0 && h <= 23)
    .map((h) => `${String(h).padStart(2, '0')}:${String(minutos).padStart(2, '0')}`);
}

/**
 * Fechas de calendario que autoriza literalmente una referencia del cliente.
 *
 * La conversión es deliberadamente cerrada: una fecha ISO, una fecha con mes,
 * hoy/mañana/pasado mañana, un día de semana o un día de mes. Todas las formas
 * relativas usan la fecha local guardada cuando el cliente las dijo. Frases
 * que nombran un intervalo (por ejemplo «la próxima semana») no eligen un día
 * y por tanto devuelven una lista vacía.
 */
export function fechasExactasDePedido(texto, { fechaAncla = null } = {}) {
  const t = normalizar(texto).replace(/\s+/g, ' ').trim();
  const fragmento = referenciasTemporalesDePedido(t).fecha;
  if (!fragmento) return [];

  if (/\bproxim[oa]\s+semana\b/.test(fragmento)) return [];

  let m = /\b((?:19|20)\d{2})-(0?[1-9]|1[0-2])-(0?[1-9]|[12]\d|3[01])\b/.exec(fragmento);
  if (m) {
    const fecha = fechaDesdePartes(m[1], m[2], m[3]);
    return fecha ? [fecha] : [];
  }

  m = /\b(0?[1-9]|[12]\d|3[01])[\/-](0?[1-9]|1[0-2])[\/-](\d{2}|(?:19|20)\d{2})\b/.exec(fragmento);
  if (m) {
    const anio = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const fecha = fechaDesdePartes(anio, m[2], m[1]);
    return fecha ? [fecha] : [];
  }

  m = /\b(0?[1-9]|[12]\d|3[01])\/(0?[1-9]|1[0-2])\b/.exec(fragmento);
  if (m) {
    const fecha = fechaSinAnioDesdeAncla(Number(m[2]), Number(m[1]), fechaAncla);
    return fecha ? [fecha] : [];
  }

  m = new RegExp(`\\b([1-9]|[12]\\d|3[01])\\s+(?:de\\s+)?(${Object.keys(MESES_NUMERO).join('|')})`
    + `\\.?(?:\\s+(?:de\\s+)?((?:19|20)\\d{2}))?\\b`).exec(fragmento);
  if (m) {
    const fecha = m[3]
      ? fechaDesdePartes(Number(m[3]), MESES_NUMERO[m[2]], Number(m[1]))
      : fechaSinAnioDesdeAncla(MESES_NUMERO[m[2]], Number(m[1]), fechaAncla);
    return fecha ? [fecha] : [];
  }

  const ancla = fechaCalendarioSegura(fechaAncla);
  if (/\bpasado\s+manana\b/.test(fragmento)) {
    const fecha = sumarDiasCalendario(ancla, 2);
    return fecha ? [fecha] : [];
  }
  if (/\bmanana\b/.test(fragmento)) {
    const fecha = sumarDiasCalendario(ancla, 1);
    return fecha ? [fecha] : [];
  }
  if (/\bhoy\b/.test(fragmento)) return ancla ? [ancla] : [];

  m = new RegExp(`\\b(${Object.keys(DIA_SEMANA_NUMERO).join('|')})\\b`).exec(fragmento);
  if (m && ancla) {
    const [y, mes, d] = ancla.split('-').map(Number);
    const actual = new Date(Date.UTC(y, mes - 1, d, 12)).getUTCDay();
    let diferencia = (DIA_SEMANA_NUMERO[m[1]] - actual + 7) % 7;
    if (diferencia === 0 && /\b(?:proxim[oa]|que\s+viene)\b/.test(fragmento)) diferencia = 7;
    const fecha = sumarDiasCalendario(ancla, diferencia);
    return fecha ? [fecha] : [];
  }

  m = /\b(?:para\s+)?(?:el(?:\s+dia)?|este(?:\s+dia)?|dia)\s+([1-9]|[12]\d|3[01])\b/.exec(fragmento);
  if (m) {
    const fecha = diaDelMesDesdeAncla(Number(m[1]), ancla);
    return fecha ? [fecha] : [];
  }
  m = new RegExp(
    `\\b(?:para\\s+(?:el(?:\\s+dia)?|este(?:\\s+dia)?|dia)|(?:el|este)\\s+dia)\\s+(${DIA_MES_EN_PALABRAS})\\b`,
  ).exec(fragmento);
  if (m) {
    const fecha = diaDelMesDesdeAncla(DIA_MES_PALABRA_NUMERO[m[1]], ancla);
    return fecha ? [fecha] : [];
  }
  return [];
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
  esperaFechaProgramacion = false,
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
  const diaDelMes = /\b(?:para\s+)?(?:el(?:\s+dia)?|este(?:\s+dia)?|dia)\s+\d{1,2}\b/.test(t)
    || new RegExp(
      `\\b(?:para\\s+(?:el(?:\\s+dia)?|este(?:\\s+dia)?|dia)|(?:el|este)\\s+dia)\\s+${DIA_MES_EN_PALABRAS}\\b`,
    ).test(t);
  const fechaRelativaCompleja = referenciaRelativaComplejaEn(t);
  // Una vez que ya hay artículos, el cliente suele contestar solo la parte
  // temporal. Incluye los prefijos naturales que aparecieron en revisión y
  // «a las 10 del viernes»; el cierre sin `?` evita secuestrar preguntas.
  const continuacionConDia = new RegExp(
    `^(?:(?:${AFIRMACION_TEMPORAL}|mejor|seria)\\s*[,;]?\\s*)?`
      + `(?:(?:dejalo|ponlo|hazlo)\\s+(?:para\\s+)?)?`
      + `(?:(?:para\\s+)?(?:este|el)\\s+)?${dias}(?:\\s+que\\s+viene)?`
      + `(?:\\s+(?:a\\s+las?\\s+[\\w:.]+|por\\s+la\\s+(?:manana|tarde|noche)))?`
      + `(?:\\s+por\\s+favor)?[.!]?$`,
  );
  const horaDelDia = new RegExp(
    `^(?:(?:${AFIRMACION_TEMPORAL}|mejor|seria)\\s*[,;]?\\s*)?a\\s+las?\\s+[\\w:.]+\\s+del\\s+${dias}[.!]?$`,
  );
  // Si ya hay una fecha durable, «a las 11» corrige la hora de ESA reserva.
  // Sin esta precondición sería demasiado ancho para pedidos inmediatos.
  const correccionSoloHora = hayProgramacionPrevia
    && new RegExp(
      `^(?:(?:no\\s*[,;]\\s*)|(?:${AFIRMACION_TEMPORAL})\\s*[,;]?\\s*)?`
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
    || fechaRelativaCompleja
    || continuacionTemporal;

  if (!futuro) return false;

  const temporalResuelta = analizarReferenciasTemporalesDePedido(t);
  if (esDiaNumericoDesnudoAmbiguo(t, { esperaFechaProgramacion })
      && !temporalResuelta.ambiguaFecha
      && (!temporalResuelta.fecha
        || /^el\s+(?:[1-9]|[12]\d|3[01])$/.test(temporalResuelta.fecha))) return false;

  const senalDeCorreccion = /\b(?:mejor|prefiero|cambia(?:lo)?|mueve(?:lo)?|pasalo|dejalo|ponlo)\b/.test(t);
  // Una pregunta nunca escribe hechos temporales salvo que esté corrigiendo
  // explícitamente una reserva previa («¿mejor para hoy?»). Preguntar si se
  // puede/debe pedir no equivale a asignar fecha.
  const preguntaSinCorreccion = /[?¿]/.test(t)
    && !(hayProgramacionPrevia && senalDeCorreccion);
  if (preguntaSinCorreccion) return false;

  // «No, el viernes…» rechaza la fecha propuesta; no es equivalente a la
  // corrección afirmativa «No, para el viernes…». Ante la forma tersa y
  // ambigua no escribimos hechos temporales. Una autocorrección explícita
  // («no, el viernes no; mejor el sábado») se resuelve por su último tramo.
  if (esRechazoTersoDeFecha(t)) return false;

  // Una referencia exclusivamente negada administra, a lo sumo, el estado
  // previo en el canal. Nunca constituye por sí misma un pedido futuro.
  if ((temporalResuelta.fechaNegada || temporalResuelta.horaNegada)
      && !temporalResuelta.fecha && !temporalResuelta.hora) return false;

  const consultaInformativa = /\b(?:saber|preguntar|consultar|promociones?|horarios?|abren|abre|cierran|cierra|disponibilidad|disponible|hay|tienen|manejan)\b/.test(t)
    || /^[¿\s]*(?:que|cual|cuales|cuando|donde|como|cuanto)\b/.test(t);
  // Una pregunta de capacidad no es todavía una instrucción, aunque incluya
  // literalmente el verbo «pedir». El modelo debe contestarla o pedir una
  // confirmación; no puede convertir «¿puedo pedir mañana?» en una mutación.
  if (esConsultaDePosibilidadDePedido(t)) return false;

  // Una fecha también aparece al administrar algo que NO es un pedido nuevo.
  // Estos verbos deben ganar incluso ante "quiero/necesito"; de lo contrario
  // el cierre desviaría recordatorios, cancelaciones, facturas o reservas de
  // mesa al flujo que puede registrar comida.
  // Una frase administrativa sola («confirmo/pago mañana», «envíame el
  // enlace mañana») no asigna entrega. La misma guarda también se usa en el
  // canal antes de tratar una referencia relativa como barrera ambigua.
  if (esGestionTemporalAjenaAlPedido(t)) return false;

  // Una programación ya existente cambia con expresiones tersas que no son
  // pedidos nuevos: «no, a las 11», «mejor 11 am» o «ya no mañana, mejor el
  // viernes». Se reconoce el reemplazo ANTES de la negación; la consulta
  // informativa y las preguntas siguen sin autorizar ninguna mutación.
  const referencias = referenciasTemporalesDePedido(t);
  const correccionTersa = correccionSoloHora
    || /^(?:no\s*[,;]\s*)?a\s+las?\s+(?:\d{1,2}(?::\d{2})?|[a-z]+)(?:\s+por\s+favor)?[.!]?$/.test(t);
  if (hayProgramacionPrevia && (referencias.fecha || referencias.hora)
      && !consultaInformativa && !/[?¿]/.test(t)
      && (senalDeCorreccion || correccionTersa)) return true;

  const negada = /\b(?:no|ya no)\s+(?:(?:lo|la)\s+)?(?:(?:quiero|quisiera|necesito|voy a)\s+)?(?:pedir|ordenar|encargar|apartar|reservar|programar|agendar)\b/.test(t)
    || /\b(?:no|ya no)\s+(?:es|seria|lo quiero)\s+para\s+(?:manana|pasado manana|el\s+(?:lunes|martes|miercoles|jueves|viernes|sabado|domingo))\b/.test(t);
  // Las formas coloquiales que se aceptan abajo tienen que conservar la misma
  // asimetría: una asignación afirmativa levanta la barrera, pero su negación
  // nunca lo hace. Esto también corrige el caso previo «no quiero dos waffles
  // mañana», que el `deseo` genérico llegaba a tratar como pedido futuro.
  const negadaColoquial = /\b(?:no|ya no)\s+(?:(?:me|te|nos|le|les|lo|la|los|las)\s+){0,3}(?:quiero|quisiera|necesito|voy\s+a\s+querer|gustaria|mando|mandas|manda|mandan|envio|envias|envia|envian|traigo|traes|trae|traen|llevo|llevas|lleva|llevan|entrego|entregas|entrega|entregan|recojo|recoges|recoge|recogen|recogemos|encargo|dejamos)\b/.test(t)
    || /\bque\s+no\s+(?:sea|sean|quede|queden)\b/.test(t)
    || /\b(?:no|ya no)\s+(?:va|queda|quedaria)\s+para\b/.test(t);
  // La negación puede ser solo el tramo descartado de una autocorrección:
  // «no los quiero mañana, mejor pasado mañana». En ese caso manda el último
  // candidato afirmado; sin uno, la negación sigue cerrando por completo.
  const reemplazoTemporalAfirmado = temporalResuelta.correccion
    && !temporalResuelta.objetivoInmediato
    && !!(temporalResuelta.fecha || temporalResuelta.hora);
  const asignacionTemporalEnClausulaPosterior = !!temporalResuelta.fecha
    && /(?:[,;]|\bpero\b)[^.!?]{0,80}\b(?:pedido|orden|fecha|entrega|envio|recogida|recoleccion|programacion|agenda)\b[^.!?]{0,45}\b(?:quiero|quisiera|prefiero|es|seria|queda|dame|deme|ponme|pon)\b/.test(t);
  if ((negada || negadaColoquial)
      && !reemplazoTemporalAfirmado && !asignacionTemporalEnClausulaPosterior) return false;

  // Sustantivos («¿tienen pedidos?») y verbos informativos («¿dónde
  // entregan?») no son órdenes. Solo formas de acción inequívocas o un deseo
  // no informativo habilitan el desvío mientras el negocio está cerrado.
  const accionDePedido = /\b(?:pedir|ordenar|encargar|apartar|reservar|programar|agendar)\b/.test(t)
    || /\b(?:prepara|preparen|enviame|envienme|apartame|reservame|programame|agendame)\b/.test(t)
    || /\b(?:fecha|entrega|envio|recogida|recoleccion|programacion|agenda)\b[^.!?]{0,35}\b(?:quiero|quisiera|prefiero|dame|deme|me\s+das|ponle|ponme|pon)\s+el\s+\d{1,2}\b/.test(t)
    || /\bseria\s+para\s+(?:enviar|entregar|recoger)\w*\b/.test(t)
    // «Te encargo dos waffles mañana» es una orden natural, no el infinitivo
    // «encargar» que cubre la primera rama. Se excluyen preguntas: una duda no
    // autoriza una mutación aunque nombre producto, fecha y hora.
    || (!/[?¿]/.test(t) && /(?:^|\b)te\s+encargo\b/.test(t));
  // Con un carrito en curso, el cliente suele referirse a sus renglones con
  // pronombres: «me los mandas mañana», «que sean para mañana», «va para
  // mañana» o «lo dejamos para mañana». Son asignaciones inequívocas sin los
  // infinitivos del detector original. La fecha sigue viniendo de la lista
  // cerrada y `programar_para` sigue obligado a validarla; esto solo conserva
  // el hecho de que NO se puede registrar como pedido inmediato.
  const asignacionColoquial = hayPedidoEnCurso && !/[?¿]/.test(t) && (
    /\b(?:(?:me|te|nos|le|les|lo|la|los|las)\s+){1,3}(?:mandas|manda|mandan|envias|envia|envian|traes|trae|traen|llevas|lleva|llevan|entregas|entrega|entregan|recojo|recoges|recoge|recogen|recogemos)\b/.test(t)
    || /\bque\s+(?:sea|sean|quede|queden)\s+(?:para\s+)?/.test(t)
    || /\b(?:(?:lo|la|los|las)\s+)?voy\s+a\s+querer\b/.test(t)
    || /\b(?:va|queda|quedaria)\s+para\b/.test(t)
    || /\b(?:(?:lo|la|los|las)\s+)?dejamos\s+para\b/.test(t)
    || /(?:^|\b)(?:(?:el|mi|este|ese)\s+pedido\s+)?(?:es|seria)\s+para\b/.test(t)
    || /\b(?:dejalo|ponlo|hazlo)\s+(?:para\s+)?/.test(t)
  );
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
  const palabra = '[a-zñ][a-zñ-]{1,}';
  const palabraOConector = `(?:${palabra}|[ayo])`;
  const meses = '(?:enero|ene|febrero|feb|marzo|mar|abril|abr|mayo|may|junio|jun|julio|jul|agosto|ago|septiembre|setiembre|sept|sep|octubre|oct|noviembre|nov|diciembre|dic)';
  const tiempo = `(?:(?:para\\s+)?(?:manana|pasado\\s+manana)`
    + `|(?:para\\s+)?(?:este|el)\\s+${dias}`
    + `|(?:para\\s+)?el\\s+\\d{1,2}(?:\\s+(?:de\\s+)?${meses})?`
    + `|(?:para\\s+)?\\d{1,2}\\/\\d{1,2}(?:\\/\\d{2,4})?`
    + `|(?:para\\s+)?(?:19|20)\\d{2}-\\d{1,2}-\\d{1,2})`;
  const nominalAntes = new RegExp(`^(?:${cantidad}\\s+)?${palabra}(?:\\s+${palabraOConector}){0,8}\\s*[,;:]?\\s+${tiempo}\\b`);
  const nominalDespues = new RegExp(`^${tiempo}\\b(?:\\s+a\\s+las?\\s+[\\w:.]+)?\\s+(?:${cantidad}\\s+)?${palabra}\\b`);
  const pedidoNominal = !consultaInformativa
    && !/^(?:no|ya\s+no)\b/.test(t)
    && (nominalAntes.test(t) || nominalDespues.test(t));
  const pedido = accionDePedido || asignacionColoquial
    || (deseo && !consultaInformativa) || pedidoNominal;
  // Cuando el carrito ya existe, una respuesta breve también asigna la
  // entrega. Se acepta fecha→hora u hora→fecha y una confirmación afirmativa
  // cerrada al principio o al final («sí, mañana a las 10» / «mañana a las
  // 10, sí»). La expresión completa queda anclada: no absorbe preguntas,
  // negaciones ni una frase informativa que meramente mencione mañana.
  const afirmacionTersa = AFIRMACION_TEMPORAL;
  const fechaTersa = String.raw`(?:manana|pasado\s+manana|(?:este\s+)?${dias}`
    + String.raw`|(?:19|20)\d{2}-\d{1,2}-\d{1,2}|\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?`
    + String.raw`|\d{1,2}\s+(?:de\s+)?${meses}\.?(?:\s+(?:de\s+)?\d{4})?`
    + String.raw`|(?:el(?:\s+dia)?|este(?:\s+dia)?|dia)\s+\d{1,2}`
    + String.raw`|(?:el(?:\s+dia)?|este(?:\s+dia)?|dia)\s+${DIA_MES_EN_PALABRAS}|\d{1,2})`;
  const horaTersa = String.raw`(?:a\s+las?\s+(?:\d{1,2}(?::\d{2})?|${HORA_EN_PALABRAS})`
    + String.raw`(?:\s+y\s+(?:media|cuarto))?${CALIFICADOR_HORA}|por\s+la\s+(?:manana|tarde|noche))`;
  const soloTiempo = new RegExp(
    String.raw`^(?:${afirmacionTersa}\s*[,;:]?\s*)?`
      + String.raw`(?:(?:para\s+)?(?:el\s+)?${fechaTersa}(?:\s+${horaTersa})?`
      + String.raw`|${horaTersa}\s+(?:(?:para\s+)?(?:el\s+)?)?${fechaTersa})`
      + String.raw`(?:\s*[,;:]?\s*${afirmacionTersa})?`
      + String.raw`(?:\s+por\s+favor)?[.!]?$`,
  );
  // Con carrito, una fecha futura inequívoca es barrera por defecto. No
  // agenda por sí sola: solo impide registrar HOY y obliga a que
  // `programar_para` valide el dato. Las salidas informativas, preguntas,
  // posibilidades, negaciones y objetivos ajenos ya terminaron arriba.
  const asignacionTemporalClara = hayPedidoEnCurso
    && !!temporalResuelta.fecha
    && !temporalResuelta.objetivoInmediato
    && !temporalResuelta.ambiguaFecha && !temporalResuelta.ambiguaHora;
  const detectada = pedido || asignacionTemporalClara
    || (hayPedidoEnCurso && !consultaInformativa
      && (continuacionTemporal || soloTiempo.test(t)));
  if (!detectada) return false;
  // La intención futura sí existe, pero una alternativa no autoriza llamar a
  // `programar_para`. El canal la conserva como pendiente para preguntar; un
  // caller directo queda rechazado antes de que argumentos del modelo elijan.
  return !temporalResuelta.ambiguaFecha && !temporalResuelta.ambiguaHora;
}

/**
 * Autoridad más estrecha para ejecutar `programar_para`.
 *
 * Una fecha cualquiera con carrito basta para levantar una barrera y evitar
 * registrar HOY, pero no basta para modificar la reserva. La herramienta solo
 * entra si el mismo mensaje pide/entrega el pedido, nombra un producto real
 * del catálogo o es una respuesta temporal tersa al ciclo en curso.
 */
export function autorizaProgramarParaDesdeMensaje(texto, {
  hayPedidoEnCurso = false, hayProgramacionPrevia = false,
  esperaFechaProgramacion = false, mencionaProducto = false,
} = {}) {
  const original = normalizar(texto).replace(/\s+/g, ' ').trim();
  const eraPregunta = /[¿?]/.test(original);
  const correccionInterrogativa = hayProgramacionPrevia
    && /\b(?:mejor|prefiero|cambia(?:lo)?|mueve(?:lo)?|pasalo|dejalo|ponlo)\b/.test(original);
  if (eraPregunta && !correccionInterrogativa) return false;
  const t = normalizar(texto).replace(/\s+/g, ' ').trim()
    .replace(/^[¿¡]\s*/, '').replace(/[?!]+$/, '').trim();
  const referencias = analizarReferenciasTemporalesDePedido(t);
  if (referencias.ambiguaFecha || referencias.ambiguaHora
      || ((referencias.fechaNegada || referencias.horaNegada)
        && !referencias.fecha && !referencias.hora)) return false;
  if (esConsultaDePosibilidadDePedido(t) || esGestionTemporalAjenaAlPedido(t)) return false;
  if (/^(?:(?:me\s+)?(?:puedes?|podrias?|puede|podria|puedo|podemos|quiere[sn]?)\b|me\s+ayudas\s+a\b)/.test(t)) {
    return false;
  }
  const solicitudDetectada = esSolicitudDePedidoProgramado(t, {
    hayPedidoEnCurso, hayProgramacionPrevia, esperaFechaProgramacion,
  });
  // Un pronombre autoriza hablar DEL pedido, no inventar una programación.
  // «Los quiero mixtos» y «lo quiero sin azúcar» no aportan día ni hora.
  if (!referencias.tieneReferenciaTemporal && !solicitudDetectada) return false;

  // Los verbos de entrega también describen vidas ajenas al carrito
  // ("recoger a mi hijo", "entregar un reporte"). Solo son autoridad sin
  // nombrar producto/pedido cuando llevan un objeto pronominal inequívoco:
  // "recogerlo", "que lo entreguen", "me los mandas". Esta forma además
  // cubre subjuntivos naturales que el detector ancho no reconoce.
  const accionPronominalDelPedido = hayPedidoEnCurso && (
    /\b(?:recoger|entregar|mandar|enviar|traer|llevar|preparar|pasar)(?:me|te|nos|le|les)?(?:lo|la|los|las)\b/.test(t)
    || /\b(?:recoge|entrega|manda|envia|trae|lleva|prepara|pasa)(?:me|te|nos|le|les)?(?:lo|la|los|las)\b/.test(t)
    || /\b(?:(?:me|te|nos|le|les)\s+)?(?:lo|la|los|las)\s+(?:entreguen|envien|manden|traigan|lleven|preparen|recojan|entregas?|envias?|mandas?|traes?|llevas?|preparas?|recoges?|recojo|llevo)\b/.test(t)
  );
  if (accionPronominalDelPedido && (referencias.fecha || referencias.hora)) return true;
  if (hayProgramacionPrevia && referencias.objetivoInmediato
      && /^(?:hoy|ahora)$/.test(t)) return true;

  // Si Xabor ya pidió específicamente el día que falta, una respuesta que el
  // detector compartido resolvió como fecha (después de descartar selección
  // de menú) es evidencia suficiente, aun con «sí, por favor» delante.
  if (esperaFechaProgramacion && referencias.fecha) return true;

  const fechaAlInicio = `(?:hoy|ahora|manana|pasado\\s+manana|`
    + `(?:(?:el|este|proxim[oa])\\s+)?${DIAS}(?:\\s+que\\s+viene)?|`
    + `(?:el\\s+)?(?:19|20)\\d{2}-\\d{1,2}-\\d{1,2}|\\d{1,2}[/-]\\d{1,2}`
    + `(?:[/-]\\d{2,4})?|(?:el(?:\\s+dia)?|este(?:\\s+dia)?|dia)\\s+\\d{1,2})`;
  const correccionTemporalDelPedido = hayPedidoEnCurso && referencias.correccion
    && (referencias.fecha || referencias.hora)
    && new RegExp(
      `^(?:no\\s+)?(?:(?:lo|la|los|las)\\s+)?`
        + `(?:(?:quiero|queria|prefiero|mejor)(?:\\s+no)?\\s+)?`
        + `(?:para\\s+)?${fechaAlInicio}\\b`,
    ).test(t);
  if (correccionTemporalDelPedido) return true;
  const correccionInmediataTrasRechazo = hayProgramacionPrevia
    && referencias.objetivoInmediato
    && new RegExp(
      `^(?:(?:ya\\s+)?no\\s+(?:para\\s+)?${fechaAlInicio}`
        + `|${fechaAlInicio}\\s+no)\\s*[,;]\\s*`
        + `(?:mejor|prefiero)\\s+(?:para\\s+)?(?:hoy|ahora)$`,
    ).test(t);
  if (correccionInmediataTrasRechazo) return true;
  const correccionFuturaTrasRechazo = hayProgramacionPrevia
    && !!referencias.fecha && !referencias.objetivoInmediato
    && new RegExp(
      `^(?:(?:ya\\s+)?no\\s+(?:para\\s+)?${fechaAlInicio}`
        + `|${fechaAlInicio}\\s+no)\\s*[,;]\\s*`
        + `(?:mejor|prefiero)\\s+(?:para\\s+)?${fechaAlInicio}`,
    ).test(t);
  if (correccionFuturaTrasRechazo) return true;
  const horaEnCoordinacion = `(?:a\\s+las?\\s+)?(?:${HORA_NUMERICA}|${HORA_EN_PALABRAS}`
    + `(?:\\s+y\\s+(?:media|cuarto))?)${CALIFICADOR_HORA}`;
  const fechaConHoraEnCoordinacion = `(?:para\\s+)?${fechaAlInicio}(?:\\s+${horaEnCoordinacion})?`;
  const coordinacionCompleta = new RegExp(
    `^${fechaConHoraEnCoordinacion}\\s+no\\s*,?\\s*(?:pero|y)\\s+`
      + `${fechaConHoraEnCoordinacion}\\s+si(?:\\s+por\\s+favor)?[.!]?$`,
  ).test(t);
  const correccionCoordinadaTersa = (hayPedidoEnCurso || hayProgramacionPrevia)
    && referencias.correccion
    && ((referencias.fechaNegada && !!referencias.fecha)
      || (referencias.horaNegada && !!referencias.hora))
    && (coordinacionCompleta || new RegExp(
      `^(?:(?:para\\s+)?${fechaAlInicio}\\s+no\\s*,?\\s*(?:pero|y)\\s+`
        + `(?:para\\s+)?${fechaAlInicio}\\s+si(?:\\s+${horaEnCoordinacion})?`
        + `|${horaEnCoordinacion}\\s+no\\s*,?\\s*(?:pero|y)\\s+`
        + `${horaEnCoordinacion}\\s+si)(?:\\s+por\\s+favor)?[.!]?$`,
    ).test(t));
  if (correccionCoordinadaTersa) return true;

  const accionDePedido = /\b(?:hacer|armar|preparar)\s+(?:(?:un|el|mi)\s+)?(?:pedido|orden)\b/.test(t)
    || /\b(?:programar|agendar|apartar|reservar)\s+(?:(?:un|el|mi)\s+)?(?:pedido|orden)\b/.test(t)
    // «quiero pedir mañana» no trae objeto ajeno entre el verbo y la fecha.
    // «quiero pedir una cita mañana» no coincide y queda sin autoridad.
    || new RegExp(
      `\\b(?:quiero|quisiera|necesito|prefiero|voy\\s+a)\\s+pedir(?:lo|la|los|las)?`
        + `\\s+(?:para\\s+)?${fechaAlInicio}\\b`,
    ).test(t);
  const contextoPedidoExplicito = /\b(?:pedido|orden)\b/.test(t)
    && /\b(?:para|es|seria|queda|quiero|quisiera|prefiero|dame|deme|ponme|pon)\b/.test(t);
  // «La entrega es para mañana» puede ser una respuesta natural sobre el
  // carrito. El sustantivo no da autoridad si lleva un complemento ajeno
  // («la entrega del paquete», «la recogida de mi hijo»), ni `agenda`/
  // `programación` personales bastan por sí solas.
  const contextoLogisticoDirecto = /^(?:para\s+)?(?:(?:la|el|mi|esta|este|esa|ese)\s+)?(?:entrega|envio|recogida|recoleccion|fecha)\s*[,;:]?\s*(?:(?:la|lo)\s+)?(?:para|es|seria|queda|quiero|quisiera|prefiero|dame|deme|ponme|pon)\b/.test(t)
    || /^quiero\s+que\s+(?:(?:la|el)\s+)?(?:entrega|envio|recogida|recoleccion)\s+(?:sea|quede)\b/.test(t);
  const contextoDePedido = contextoPedidoExplicito || contextoLogisticoDirecto;
  const asignacionColoquial = hayPedidoEnCurso && (
    /\b(?:lo|la|los|las)\s+(?:quiero|quisiera|prefiero)\b/.test(t)
    || /^(?:si[,;:]?\s*)?que\s+(?:sea|sean|quede|queden)\s+(?:para\s+)?/.test(t)
    || /\b(?:(?:lo|la|los|las)\s+)?voy\s+a\s+querer\b/.test(t)
    || /^(?:(?:esto|eso|el\s+pedido)\s+)?(?:va|queda|quedaria)\s+para\b/.test(t)
    || new RegExp(`^es\\s+(?:para\\s+)?${fechaAlInicio}\\b`).test(t)
    || /\b(?:(?:lo|la|los|las)\s+)?dejamos\s+para\b/.test(t)
    || /^(?:(?:el|mi|este|ese)\s+pedido\s+)(?:es|seria)\s+para\b/.test(t)
    || /\b(?:dejalo|ponlo|hazlo)\s+(?:para\s+)?/.test(t)
  );
  const seleccionDeMenuConFecha = hayPedidoEnCurso && !!referencias.fecha
    && /\b(?:menu|carta|lista|opcion|combo|articulo|item)\b/.test(t)
    && /\bpara\s+(?:(?:19|20)\d{2}-\d{1,2}-\d{1,2}|\d{1,2}[/-]\d{1,2}|(?:el\s+)?\d{1,2}\s+(?:de\s+)?[a-z]+|(?:el|este)\s+(?:lunes|martes|miercoles|jueves|viernes|sabado|domingo)|manana|pasado\s+manana)\b/.test(t);
  const accionOrdenConProducto = /\b(?:quiero|quisiera|necesito|pido|pedir|ordenar|encargar|te\s+encargo|dame|deme|ponme|agrega(?:me)?|reserva|programa|aparta)\b/.test(t);
  const inicioReferenciaTemporal = t.search(/\b(?:manana|pasado\s+manana|hoy|(?:el|este)\s+(?:lunes|martes|miercoles|jueves|viernes|sabado|domingo)|(?:el|este|para\s+el)\s+\d{1,2}(?:\s+de\s+[a-z]+)?|\d{1,2}[/-]\d{1,2}|(?:19|20)\d{2}-\d{1,2}-\d{1,2})\b/);
  const productoAntesDeFecha = mencionaProducto === true
    && inicioReferenciaTemporal > 0
    && !/\b(?:comprar|cocinar|desayunar|publicar|llevar|llevo|cita|agenda|paquete|amazon)\b/.test(t.slice(0, inicioReferenciaTemporal));
  const productoEnContextoDePedido = mencionaProducto === true
    && !esGestionTemporalAjenaAlPedido(t)
    && (accionOrdenConProducto || productoAntesDeFecha);
  if (accionDePedido || contextoDePedido
      || accionPronominalDelPedido || asignacionColoquial || seleccionDeMenuConFecha
      || (productoEnContextoDePedido && solicitudDetectada)) return true;

  const fechaTersa = `(?:manana|pasado\\s+manana|(?:(?:este|el|proxim[oa])\\s+)?${DIAS}`
    + `(?:\\s+que\\s+viene)?|(?:19|20)\\d{2}-\\d{1,2}-\\d{1,2}`
    + `|\\d{1,2}[/-]\\d{1,2}(?:[/-]\\d{2,4})?`
    + `|\\d{1,2}\\s+(?:de\\s+)?${MESES}(?:\\s+(?:de\\s+)?(?:19|20)\\d{2})?`
    + `|(?:el(?:\\s+dia)?|este(?:\\s+dia)?|dia)\\s+\\d{1,2}`
    + `|(?:el(?:\\s+dia)?|este(?:\\s+dia)?|dia)\\s+${DIA_MES_EN_PALABRAS})`;
  const horaTersa = `(?:a\\s+las?\\s+(?:${HORA_NUMERICA}|${HORA_EN_PALABRAS})`
    + `(?:\\s+y\\s+(?:media|cuarto))?${CALIFICADOR_HORA}`
    + `|(?:${HORA_NUMERICA}|${HORA_EN_PALABRAS})${CALIFICADOR_HORA}`
    + `|por\\s+la\\s+(?:manana|tarde|noche))`;
  const afirmacionTersa = `(?:${AFIRMACION_TEMPORAL}|esta\\s+bien)`;
  const prefijo = `(?:(?:no\\s*[,;]|${afirmacionTersa}|mejor|prefiero|seria|dejalo|ponlo|hazlo)\\s*[,;:]?\\s*)?`;
  const sufijo = `(?:\\s*[,;:]?\\s*${afirmacionTersa})?(?:\\s+por\\s+favor)?[.!]?`;
  const tTerso = t.replace(
    /[,;]\s*no\s+(?:hay\s+(?:problema|inconveniente)|te\s+preocupes|se\s+preocupe|pasa\s+nada)\s*(?=[,;]|$)/g,
    '',
  );
  const soloFechaOHora = new RegExp(
    `^${prefijo}(?:(?:para\\s+)?${fechaTersa}(?:\\s+${horaTersa})?`
      + `|${horaTersa}(?:\\s+(?:(?:del?|para\\s+el)\\s+${DIAS}|${fechaTersa}))?)${sufijo}$`,
  ).test(tTerso);
  if (!soloFechaOHora) return false;
  // Una hora sin fecha solo corrige una programación que ya tenía el día.
  return !!referencias.fecha || hayProgramacionPrevia || esperaFechaProgramacion;
}

/**
 * Autoridad para invalidar una parte de una reserva ya existente.
 *
 * El analizador temporal sabe que «mañana» está negado, pero no sabe si la
 * frase habla del pedido («mañana no») o de la vida del cliente («no trabajo
 * mañana»). Solo la primera puede mutar estado durable.
 */
export function autorizaNegacionDeProgramacionDesdeMensaje(texto, {
  hayProgramacionPrevia = false,
} = {}) {
  if (!hayProgramacionPrevia) return false;
  const t = normalizar(texto).replace(/\s+/g, ' ').trim();
  const referencias = analizarReferenciasTemporalesDePedido(t);
  if (!referencias.fechaNegada && !referencias.horaNegada) return false;

  // Para rechazos tersos quitamos los fragmentos temporales que el parser ya
  // identificó. Si queda un verbo/sustantivo ajeno («trabajar», «clases»,
  // «cita»), no hay autoridad. El vocabulario restante es deliberadamente
  // cerrado: ampliar esta lista exige un caso productivo y una regresión.
  const fragmentos = [
    ...(referencias.fechasNegadas || []), ...(referencias.horasNegadas || []),
    referencias.fecha, referencias.hora,
  ].filter(Boolean).sort((a, b) => b.length - a.length);
  const clausulas = t.split(
    /\s*(?:[;.]|\bpero\b|,\s*(?=(?:(?:el|la|mi|este|ese|esta|esa)\s+)?(?:pedido|orden|entrega|envio|recogida|recoleccion|programacion)\b)|\by\s+(?=(?:(?:el|la|mi|este|ese|esta|esa)\s+)?(?:pedido|orden|entrega|envio|recogida|recoleccion|programacion)\b))\s*/,
  ).filter(Boolean);
  const clausulasNegadas = clausulas.filter((clausula) =>
    fragmentos.some((fragmento) => clausula.includes(fragmento)));
  const contextoPedidoEnLaMismaClausula = clausulasNegadas.some((clausula) => (
    /\b(?:pedido|orden|entrega|envio|recogida|recoleccion|programacion)\b/.test(clausula)
    || /\b(?:lo|la|los|las)\s+(?:quiero|prefiero|recojo|recogemos|entrego|enviamos?|mandamos?|llevamos?)\b/.test(clausula)
    || /\b(?:recoger|entregar|mandar|enviar|traer|llevar|preparar|pasar)(?:me|te|nos|le|les)?(?:lo|la|los|las)\b/.test(clausula)
    || /\b(?:ya\s+)?no\s+(?:(?:lo|la)\s+)?(?:(?:quiero|necesito)\s+)?(?:pedir|programar|agendar|reservar)\s+(?:para\s+)?(?:manana|pasado\s+manana|(?:(?:el|este)\s+)?(?:lunes|martes|miercoles|jueves|viernes|sabado|domingo))\b/.test(clausula)
  ));
  if (contextoPedidoEnLaMismaClausula) return true;

  let residuo = clausulasNegadas.join(' ');
  for (const fragmento of fragmentos) {
    const patron = String(fragmento).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    residuo = residuo.replace(new RegExp(patron, 'g'), ' ');
  }
  const palabras = residuo.replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  const permitidas = new Set([
    'no', 'ya', 'por', 'favor', 'mejor', 'prefiero', 'que', 'sea', 'seria',
    'es', 'para', 'el', 'la', 'las', 'los', 'a', 'de', 'un', 'una', 'ese',
    'esa', 'esta', 'este', 'aquel', 'aquella', 'aquellos', 'aquellas', 'hora',
    'cualquier', 'dia', 'menos', 'excepto',
    'sin', 'tampoco', 'ni', 'descarta', 'descartado', 'descartada', 'descarto',
    'descartemos', 'olvida', 'olvido', 'puedo',
    'quiero', 'imposible', 'me', 'funciona', 'viene', 'bien', 'sirve',
    'queda', 'esta',
  ]);
  return palabras.length > 0 && palabras.every((palabra) => permitidas.has(palabra));
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
