// XECADOR · Horas y faltas de la semana — Parte B4.
//
// Sobre los turnos del resumen (exportacionFormato.turnosCrudos: un turno es
// el mismo en el resumen y aquí) y la jornada que regía cada día, calcula lo
// que pide la nómina: horas contra la jornada, extra autorizada, retardos y
// faltas. No toca la base; los datos los junta horasService.js.
//
// Reglas que decidió Mario (14-nov-2026):
//   · Cuenta la jornada. Lo checado antes de la entrada o después de la salida
//     (y un turno en un día de descanso) se ve aparte, «fuera de jornada», y
//     solo suma si el administrador lo autoriza como extra.
//   · El descanso se paga: no se descuenta de las horas.
//   · Sin tolerancia: una entrada en un minuto posterior al de la jornada es
//     retardo (7:01 con jornada de 7:00). A las 7:00:59 todavía no.
//   · La semana va de lunes a domingo.
// Lo que dice la Ley Federal del Trabajo (no lo decide el negocio):
//   · La extra se paga doble hasta 9 h a la semana y triple la que pase (arts.
//     67 y 68). Se avisa si un día pasa de 3 h de extra o si hay extra en más
//     de 3 días de la semana (art. 66).
//   · Los días de descanso obligatorio (art. 74) no son falta y, si se
//     trabajan, se marca. El día de elecciones no se calcula: lo fija la ley
//     electoral.
//   · Un turno de más de 6 h sin ningún descanso se marca (art. 63: en jornada
//     continua corresponde al menos media hora).
import { local, celdaCsv } from './exportacionFormato.js';

const MIN_MS = 6e4;
const HORA_MS = 36e5;
export const EXTRA_DOBLE_MAX_MIN = 9 * 60;
export const EXTRA_DIA_MAX_MIN = 3 * 60;
export const EXTRA_DIAS_MAX = 3;
export const SIN_DESCANSO_HORAS = 6;
// Máximo de la jornada semanal. Cada renglón rige desde su fecha: si la ley
// baja el máximo (la reducción gradual a 40 h), se agrega un renglón aquí.
export const MAXIMO_SEMANAL = [{ desde: '1970-01-01', horas: 48 }];

export const maximoSemanalHoras = (lunes) => MAXIMO_SEMANAL.filter((m) => m.desde <= lunes).at(-1).horas;

// ── Fechas ──────────────────────────────────────────────────────────────────
export function sumarDias(iso, n) {
  const [a, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, d + n)).toISOString().slice(0, 10);
}
/** 1 = lunes … 7 = domingo (como guarda la jornada). */
export function diaIso(iso) {
  const [a, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, d)).getUTCDay() || 7;
}
export const esLunes = (iso) => typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(iso)
  && sumarDias(iso, 0) === iso && diaIso(iso) === 1;
const fechaLocal = (ms) => local(ms)?.fecha ?? '';

/** Una hora de pared en America/Matamoros ('AAAA-MM-DD', 'HH:MM') → ms. */
export function msLocal(fecha, hhmm) {
  const [a, m, d] = fecha.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  const objetivo = Date.UTC(a, m - 1, d, h, mi);
  let t = objetivo;
  for (let i = 0; i < 3; i++) {
    const l = local(t);
    const [la, lm, ld] = l.fecha.split('-').map(Number);
    const [lh, lmi, ls] = l.hora.split(':').map(Number);
    const visto = Date.UTC(la, lm - 1, ld, lh, lmi, ls);
    if (visto === objetivo) return t;
    t += objetivo - visto;
  }
  return t;   // una hora que no existe (cambio de horario): la más cercana
}

function enesimoLunes(anio, mes, n) {
  const primero = new Date(Date.UTC(anio, mes - 1, 1)).getUTCDay();
  return new Date(Date.UTC(anio, mes - 1, 1 + ((8 - primero) % 7) + 7 * (n - 1))).toISOString().slice(0, 10);
}
/** ¿Día de descanso obligatorio (LFT art. 74)? Sin el día de elecciones. */
export function descansoObligatorio(iso) {
  const anio = Number(iso.slice(0, 4));
  const dias = [`${anio}-01-01`, `${anio}-05-01`, `${anio}-09-16`, `${anio}-12-25`,
    enesimoLunes(anio, 2, 1), enesimoLunes(anio, 3, 3), enesimoLunes(anio, 11, 3)];
  // El 1 de octubre de cada seis años, con la transmisión del Poder Ejecutivo.
  if (anio >= 2024 && (anio - 2024) % 6 === 0) dias.push(`${anio}-10-01`);
  return dias.includes(iso);
}

/** La jornada que regía en esa fecha y su horario de ese día (null = descanso). */
export function jornadaDelDia(jornadas, fecha) {
  let rige = null;
  for (const j of jornadas || []) if (j.vigente_desde <= fecha) rige = j;   // en orden de vigencia
  if (!rige) return { jornada: null, dia: null };
  const d = (rige.dias || []).find((x) => Number(x.dia) === diaIso(fecha));
  return { jornada: rige, dia: d || null };
}

const minutos = (ms) => Math.round(ms / MIN_MS);
const iso = (ms) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

/**
 * Las horas de UN empleado en la semana que empieza en `lunes`.
 *   turnos     los de turnosCrudos (ms), los que empiezan en esa semana
 *   jornadas   [{ vigente_desde, tipo, dias: [{ dia, entrada, salida }] }] en orden de vigencia
 *   ajustes    [{ id, fecha, tipo: 'extra'|'falta', minutos, justificada, motivo, autor, created_at }]
 *              en orden de creación: el último de cada día y tipo es el que manda
 * Todo lo que regresa en minutos.
 */
export function horasDeLaSemana({ lunes, turnos = [], jornadas = [], ajustes = [], fechaIngreso = null, bajaFecha = null, ahora }) {
  const ahoraMs = new Date(ahora).getTime();
  const ultimo = new Map();
  for (const a of ajustes) ultimo.set(`${a.fecha}|${a.tipo}`, a);
  const dias = [];
  for (let i = 0; i < 7; i++) {
    const fecha = sumarDias(lunes, i);
    const { jornada, dia: jd } = jornadaDelDia(jornadas, fecha);
    const festivo = descansoObligatorio(fecha);
    const j0 = jd ? msLocal(fecha, jd.entrada) : null;
    // Salida antes que entrada: el turno cruza la medianoche.
    const j1 = jd ? msLocal(jd.salida <= jd.entrada ? sumarDias(fecha, 1) : fecha, jd.salida) : null;

    const suyos = turnos.filter((t) => fechaLocal(t.inicio) === fecha);
    let dentro = 0, fuera = 0, incompletos = 0, enCurso = false;
    const notas = new Set();
    for (const t of suyos) {
      if (t.entrada !== null && t.salida !== null) {
        const total = Math.max(0, t.salida - t.entrada);
        const solapa = jd ? Math.max(0, Math.min(t.salida, j1) - Math.max(t.entrada, j0)) : 0;
        dentro += solapa;
        fuera += total - solapa;
        const descanso = t.descansos.reduce((s, d) => s + (d.desde !== null && d.hasta !== null ? d.hasta - d.desde : 0), 0);
        if (total > SIN_DESCANSO_HORAS * HORA_MS && descanso < MIN_MS) notas.add('sin_descanso');
      } else if (t.notas.has('en_turno') || t.notas.has('en_descanso')) {
        enCurso = true;
      } else {
        incompletos += 1;
      }
    }
    if (incompletos) notas.add('incompleto');
    if (suyos.length && !jornada) notas.add('sin_jornada');
    else if (suyos.length && !jd) notas.add('descanso_trabajado');
    if (suyos.length && festivo) notas.add('festivo_trabajado');

    // Retardo: la entrada del primer turno del día contra la de la jornada.
    const primera = suyos[0]?.entrada ?? null;
    const retardo = jd && primera !== null && primera - j0 >= MIN_MS ? Math.floor((primera - j0) / MIN_MS) : 0;
    const ultimaSalida = suyos.at(-1)?.salida ?? null;
    const salidaAntes = jd && ultimaSalida !== null && j1 - ultimaSalida >= MIN_MS ? Math.floor((j1 - ultimaSalida) / MIN_MS) : 0;

    // Falta: día con jornada, ya terminado, sin ningún turno, mientras era
    // empleado y que no sea de descanso obligatorio.
    const empleado = (!fechaIngreso || fecha >= fechaIngreso) && (!bajaFecha || fecha < bajaFecha);
    let falta = false, sinLlegar = false;
    if (jd && !festivo && empleado && !suyos.length) {
      if (ahoraMs >= j1) falta = true;
      else if (ahoraMs >= j0) sinLlegar = true;
    }
    const ajusteFalta = ultimo.get(`${fecha}|falta`) || null;
    const ajusteExtra = ultimo.get(`${fecha}|extra`) || null;
    const justificada = falta && ajusteFalta?.justificada === true;

    const dentroMin = minutos(dentro);
    const fueraMin = minutos(fuera);
    const autorizado = Math.min(ajusteExtra ? ajusteExtra.minutos : 0, fueraMin);
    dias.push({
      fecha, dia: diaIso(fecha), festivo,
      jornada: jd ? { tipo: jornada.tipo, entrada: jd.entrada, salida: jd.salida } : null,
      sin_jornada: !jornada,
      turnos: suyos.map((t) => ({
        entrada: iso(t.entrada), salida: iso(t.salida),
        descansos: t.descansos.map((d) => ({ desde: iso(d.desde), hasta: iso(d.hasta) })),
      })),
      programado: jd && !festivo ? minutos(j1 - j0) : 0,
      dentro: dentroMin, fuera: fueraMin, autorizado, trabajado: dentroMin + autorizado,
      retardo, salida_antes: salidaAntes, falta, justificada, sin_llegar: sinLlegar, en_curso: enCurso, incompletos,
      ajustes: { extra: ajusteExtra, falta: ajusteFalta },
      notas: [...notas],
    });
  }

  const suma = (k) => dias.reduce((s, d) => s + d[k], 0);
  const extra = suma('autorizado');
  const maximo = maximoSemanalHoras(lunes);
  const totales = {
    programado: suma('programado'), dentro: suma('dentro'), fuera: suma('fuera'),
    autorizado: extra, trabajado: suma('trabajado'),
    extra_dobles: Math.min(extra, EXTRA_DOBLE_MAX_MIN), extra_triples: Math.max(0, extra - EXTRA_DOBLE_MAX_MIN),
    retardos: dias.filter((d) => d.retardo > 0).length, minutos_retardo: suma('retardo'),
    faltas: dias.filter((d) => d.falta && !d.justificada).length, justificadas: dias.filter((d) => d.justificada).length,
    incompletos: suma('incompletos'),
  };
  const avisos = [];
  if (!dias.some((d) => !d.sin_jornada)) avisos.push('sin_jornada');
  if (dias.some((d) => d.autorizado > EXTRA_DIA_MAX_MIN)) avisos.push('extra_mas_de_3_h');
  if (dias.filter((d) => d.autorizado > 0).length > EXTRA_DIAS_MAX) avisos.push('extra_mas_de_3_dias');
  if (totales.programado > maximo * 60) avisos.push('jornada_sobre_maximo');
  return { dias, totales, avisos, maximo_semanal_horas: maximo };
}

// ── Textos y CSV ────────────────────────────────────────────────────────────
export const TEXTOS_HORAS = {
  nota: {
    incompleto: 'Turno incompleto: corrígelo para contar sus horas', sin_jornada: 'Sin jornada capturada',
    descanso_trabajado: 'Trabajó en su día de descanso', festivo_trabajado: 'Trabajó en día de descanso obligatorio',
    sin_descanso: 'Más de 6 h sin descanso',
  },
  aviso: {
    sin_jornada: 'Sin jornada capturada: captúrala en Empleados para calcular sus horas',
    extra_mas_de_3_h: 'Un día pasa de 3 h de extra (LFT art. 66)',
    extra_mas_de_3_dias: 'Extra en más de 3 días de la semana (LFT art. 66)',
    jornada_sobre_maximo: 'La jornada de la semana pasa del máximo legal',
  },
};

/** 125 → '2:05' */
export const hm = (min) => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;

const DIA_LARGO = { 1: 'lunes', 2: 'martes', 3: 'miércoles', 4: 'jueves', 5: 'viernes', 6: 'sábado', 7: 'domingo' };
const fechaCorta = (f) => `${f.slice(8, 10)}/${f.slice(5, 7)}/${f.slice(0, 4)}`;
const horaCorta = (v) => (local(v)?.hora ?? '').slice(0, 5);

/** Lo que dice la columna «Observaciones» de un día. */
export function observacionesDelDia(d) {
  const o = [];
  if (d.en_curso) o.push('En turno');
  if (d.sin_llegar) o.push('Sin entrada todavía');
  if (d.salida_antes) o.push(`Salió ${d.salida_antes} min antes`);
  for (const n of d.notas) o.push(TEXTOS_HORAS.nota[n] || n);
  if (d.festivo && !d.notas.includes('festivo_trabajado')) o.push('Día de descanso obligatorio');
  if (d.autorizado && d.ajustes.extra?.motivo) o.push(`Extra: ${d.ajustes.extra.motivo}`);
  return o;
}

export const COLUMNAS_HORAS = [
  'Fecha', 'Día', 'Núm.', 'Empleado', 'Jornada', 'Entrada', 'Salida', 'Horas en jornada', 'Fuera de jornada',
  'Extra autorizada', 'Horas trabajadas', 'Retardo (min)', 'Falta', 'Observaciones',
];

/**
 * El CSV de la semana: un renglón por empleado y día, y uno de total por
 * empleado. Con encabezado y CRLF (sin BOM: lo pone la ruta).
 *   reporte: { semana: { lunes, domingo }, empleados: [{ numero, nombre, dias, totales, avisos }] }
 */
export function csvHoras(reporte) {
  const lineas = [COLUMNAS_HORAS.map((c) => celdaCsv(c)).join(',')];
  const renglon = (celdas, textos = []) => lineas.push(celdas.map((v, i) => celdaCsv(v, { texto: textos.includes(i) })).join(','));
  for (const e of reporte.empleados) {
    for (const d of e.dias) {
      const jornada = d.jornada ? `${d.jornada.entrada}-${d.jornada.salida}` : d.sin_jornada ? 'Sin jornada' : 'Descanso';
      const falta = !d.falta ? '' : d.justificada ? `Justificada: ${d.ajustes.falta.motivo}` : 'Sí';
      renglon([
        fechaCorta(d.fecha), DIA_LARGO[d.dia], e.numero, e.nombre, jornada,
        d.turnos.map((t) => (t.entrada ? horaCorta(t.entrada) : '?')).join('; '),
        d.turnos.map((t) => (t.salida ? horaCorta(t.salida) : '?')).join('; '),
        d.turnos.length ? hm(d.dentro) : '', d.fuera ? hm(d.fuera) : '', d.autorizado ? hm(d.autorizado) : '',
        d.turnos.length ? hm(d.trabajado) : '', d.retardo || '', falta, observacionesDelDia(d).join('; '),
      ], [3, 12, 13]);
    }
    const t = e.totales;
    renglon([
      `${fechaCorta(reporte.semana.lunes)} a ${fechaCorta(reporte.semana.domingo)}`, 'Total', e.numero, e.nombre,
      `${hm(t.programado)} programadas`, '', '', hm(t.dentro), hm(t.fuera), hm(t.autorizado), hm(t.trabajado),
      t.retardos ? `${t.retardos} (${t.minutos_retardo} min)` : '',
      t.faltas || t.justificadas ? `${t.faltas}${t.justificadas ? ` y ${t.justificadas} justificada(s)` : ''}` : '',
      [t.autorizado ? `Extra: ${hm(t.extra_dobles)} dobles, ${hm(t.extra_triples)} triples` : '',
        ...e.avisos.map((a) => TEXTOS_HORAS.aviso[a] || a)].filter(Boolean).join('; '),
    ], [3]);
  }
  return lineas.join('\r\n') + '\r\n';
}
