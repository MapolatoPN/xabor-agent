// XECADOR · Alertas de secuencia de las checadas (10-nov-2026, pedido de Mario).
//
// Lo que «Para revisar» muestra además de las checadas raras: turnos que no
// cuadran. Se calcula sobre la LÍNEA EFECTIVA (correcciones aplicadas, sin lo
// anulado), así que una corrección hace desaparecer su alerta sola. Nada de
// esto se guarda en las checadas: una checada no se cambia nunca.
//
//   sin_salida           turno que no tuvo salida: pasaron 16 h (la regla de
//                        la tablet) o llegó otra entrada.
//   descanso_sin_cerrar  un inicio de descanso sin su fin (le siguió la salida,
//                        otro inicio o nada).
//   repetida             dos checadas del mismo tipo seguidas en menos de 2 min.
//   turno_largo          de la entrada a la salida, más de 12 h.
//   reentrada            salió y volvió a entrar en menos de 1 h (¿era descanso?).
//   sin_entrada          un turno que empieza con salida o descanso.
//   fin_sin_inicio       un fin de descanso sin inicio.
//
// El orden es el de la HORA que cuenta, no el de llegada: las checadas sin
// conexión que se sincronizan tarde o desordenadas se acomodan solas.
//
// Puro (sin base): lo usan «Para revisar» y sus pruebas.
import { TURNO_ABIERTO_HORAS } from './turnoChecador.js';

export const MOTIVOS_SECUENCIA = ['sin_salida', 'descanso_sin_cerrar', 'repetida', 'turno_largo', 'reentrada', 'sin_entrada', 'fin_sin_inicio'];
export const REPETIDA_MS = 2 * 60 * 1000;
export const TURNO_LARGO_MS = 12 * 3600 * 1000;
export const REENTRADA_MS = 60 * 60 * 1000;
const ABIERTO_MS = TURNO_ABIERTO_HORAS * 3600 * 1000;

/**
 * `eventos`: la línea efectiva de UN empleado, sin anuladas, como
 * [{ clave: 'c:<checada>' | 'a:<agregada>', tipo, hora }]. `ahora` decide si un
 * turno abierto ya se da por «sin salida».
 *
 * Devuelve [{ motivo, ancla, hora, eventos: [{ clave, tipo, hora }] }]. El
 * ancla es la checada con la que se identifica la alerta (para marcarla
 * revisada): la primera del turno, el inicio del descanso, la repetida o la
 * salida de la que volvió.
 */
export function alertasDeSecuencia(eventos, { ahora = new Date() } = {}) {
  const ahoraMs = new Date(ahora).getTime();
  const lista = (eventos || [])
    .map((e) => ({ clave: e.clave, tipo: e.tipo, hora: e.hora, ms: new Date(e.hora).getTime() }))
    .filter((e) => Number.isFinite(e.ms))
    .sort((a, b) => a.ms - b.ms);   // estable: los empates quedan como vienen
  const alertas = [];
  const pub = (e) => ({ clave: e.clave, tipo: e.tipo, hora: e.hora });
  const alerta = (motivo, ancla, evs) => alertas.push({ motivo, ancla: ancla.clave, hora: ancla.hora, eventos: evs.map(pub) });

  let tu = null;            // turno abierto: { inicio, entrada, ultimo, descanso }
  let salidaPrevia = null;  // la salida que cerró el turno anterior
  let previo = null;        // la checada anterior que contó (para las repetidas)

  const cerrarSinSalida = () => {
    if (tu.descanso) alerta('descanso_sin_cerrar', tu.descanso, [tu.descanso]);
    alerta('sin_salida', tu.inicio, [tu.inicio, ...(tu.ultimo !== tu.inicio ? [tu.ultimo] : [])]);
    tu = null;
    salidaPrevia = null;
  };

  for (const ev of lista) {
    // La misma checada dos veces (doble toque, o sin conexión y luego en
    // línea): se avisa y no cambia el turno.
    if (previo && previo.tipo === ev.tipo && ev.ms - previo.ms < REPETIDA_MS) {
      alerta('repetida', ev, [previo, ev]);
      continue;
    }
    previo = ev;
    if (tu && ev.ms - tu.ultimo.ms > ABIERTO_MS) cerrarSinSalida();

    if (!tu) {
      if (ev.tipo === 'entrada') {
        if (salidaPrevia && ev.ms - salidaPrevia.ms < REENTRADA_MS) alerta('reentrada', salidaPrevia, [salidaPrevia, ev]);
        tu = { inicio: ev, entrada: ev, ultimo: ev, descanso: null };
      } else {
        alerta('sin_entrada', ev, [ev]);
        // Una salida sola es un turno de una checada; lo demás abre un turno sin entrada.
        tu = ev.tipo === 'salida' ? null : { inicio: ev, entrada: null, ultimo: ev, descanso: ev.tipo === 'inicio_descanso' ? ev : null };
      }
      salidaPrevia = null;
      continue;
    }

    if (ev.tipo === 'entrada') {
      // Otra entrada con el turno abierto: el anterior se quedó sin salida.
      cerrarSinSalida();
      tu = { inicio: ev, entrada: ev, ultimo: ev, descanso: null };
      continue;
    }
    tu.ultimo = ev;
    if (ev.tipo === 'inicio_descanso') {
      if (tu.descanso) alerta('descanso_sin_cerrar', tu.descanso, [tu.descanso, ev]);
      tu.descanso = ev;
    } else if (ev.tipo === 'fin_descanso') {
      if (!tu.descanso) alerta('fin_sin_inicio', ev, [ev]);
      tu.descanso = null;
    } else if (ev.tipo === 'salida') {
      if (tu.descanso) alerta('descanso_sin_cerrar', tu.descanso, [tu.descanso, ev]);
      if (tu.entrada && ev.ms - tu.entrada.ms > TURNO_LARGO_MS) alerta('turno_largo', tu.entrada, [tu.entrada, ev]);
      tu = null;
      salidaPrevia = ev;
    }
  }
  // El turno que sigue abierto solo es «sin salida» cuando ya pasaron 16 h.
  if (tu && ahoraMs - tu.ultimo.ms > ABIERTO_MS) cerrarSinSalida();
  return alertas;
}
