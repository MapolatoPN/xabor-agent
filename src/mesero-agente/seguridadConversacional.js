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
    /\b(?:para\s+)?el\s+(?:[1-9]|[12]\d|3[01])\b/,
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
  '\\b(?:para\\s+)?el\\s+(?:[1-9]|[12]\\d|3[01])\\b',
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
    ambiguaFecha: fechas.length > 1,
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
  // «viernes, no, sábado» y «viernes no; sábado» afirman lo que sigue.
  agregar(/(?:,\s*)?\bno\b\s*[,;]\s*/g, 'reemplaza');
  // «viernes, no sábado» niega solo el segundo candidato: conserva el tramo
  // anterior y nunca elige silenciosamente la referencia negada.
  agregar(/[,;]\s*\bno\b(?!\s*[,;])\s+/g, 'niega_sufijo', false);
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
  const t = normalizar(texto).replace(/\s+/g, ' ').trim().slice(0, 1000);
  if (!t) {
    return {
      fecha: null, hora: null, ambiguaFecha: false, ambiguaHora: false,
      objetivoInmediato: false, correccion: false, tieneReferenciaTemporal: false,
    };
  }
  const crudas = referenciasCrudas(t);
  const resueltas = resolverReferencias(t);
  const ambiguaFecha = resueltas.ambiguaFecha || resueltas.fechas.length > 1;
  const ambiguaHora = resueltas.ambiguaHora || resueltas.horas.length > 1;
  const fecha = ambiguaFecha ? null : resueltas.fechas[0]?.valor || null;
  const hora = ambiguaHora ? null : resueltas.horas[0]?.valor || null;
  const objetivoInmediato = !ambiguaFecha
    && (resueltas.inmediato || /\bhoy\b/.test(fecha || ''));
  return {
    fecha,
    hora,
    ambiguaFecha,
    ambiguaHora,
    objetivoInmediato,
    correccion: resueltas.correccion,
    tieneReferenciaTemporal: crudas.fechas.length > 0 || crudas.horas.length > 0
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

  m = /\b(?:para\s+)?el\s+([1-9]|[12]\d|3[01])\b/.exec(fragmento);
  if (m) {
    const fecha = diaDelMesDesdeAncla(Number(m[1]), ancla);
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
  const detectada = pedido || (hayPedidoEnCurso && !consultaInformativa
    && (continuacionTemporal || soloTiempo.test(t)));
  if (!detectada) return false;
  // La intención futura sí existe, pero una alternativa no autoriza llamar a
  // `programar_para`. El canal la conserva como pendiente para preguntar; un
  // caller directo queda rechazado antes de que argumentos del modelo elijan.
  const temporal = analizarReferenciasTemporalesDePedido(t);
  return !temporal.ambiguaFecha && !temporal.ambiguaHora;
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
