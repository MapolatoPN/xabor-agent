// XECADOR · Qué le toca registrar a un empleado, según su última checada.
//
// Una sola regla para la tablet (qué ofrecer y qué aceptar), la vista del
// administrador (qué checadas quedaron fuera de orden), las alertas de
// secuencia y el resumen por turno. Vive aparte para que el checador y las
// correcciones la compartan sin depender uno del otro.
//
//   Sin checadas, o ya salió      → solo Entrada.
//   Trabajando                    → Inicio de descanso o Salida.
//   En descanso                   → solo Fin de descanso (10-nov-2026, pedido
//                                   de Mario: un «Inicio de descanso» seguido de
//                                   «Salida» dejaba el descanso sin cerrar).
//
// El turno se da por terminado sin salida cuando pasan 16 h desde su última
// checada, o 4 h desde un inicio de descanso que no se cerró (14-nov-2026: en
// la primera semana tocaron «Inicio de descanso» al salir y a la mañana
// siguiente la tablet solo les ofrecía «Fin de descanso», así que la entrada
// del día quedaba como regreso del descanso). Entonces se ofrece una entrada
// nueva y el turno anterior queda «sin cerrar» para que el administrador lo
// corrija.
//
// Trabajando, la tablet destaca «Salida» (primero y más grande) cuando ya pasó
// la mayor parte del turno: 6 h desde la entrada o con un descanso ya tomado.
// Antes, ninguna va destacada: a media mañana lo normal es el descanso.

export const TIPOS_CHECADA = ['entrada', 'salida', 'inicio_descanso', 'fin_descanso'];
export const TURNO_ABIERTO_HORAS = 16;
export const DESCANSO_ABIERTO_HORAS = 4;
export const DESTACAR_SALIDA_HORAS = 6;
const HORA_MS = 3.6e6;

/**
 * ¿El turno cuya última checada es `ultima` ({ tipo, hora_oficial }) ya se da
 * por terminado sin salida a la hora `ahora`? Las horas van como Date, ISO o ms.
 */
export function turnoVencido(ultima, ahora) {
  if (!ultima || ultima.tipo === 'salida') return false;
  const ms = new Date(ahora).getTime() - new Date(ultima.hora_oficial).getTime();
  return ms > TURNO_ABIERTO_HORAS * HORA_MS
    || (ultima.tipo === 'inicio_descanso' && ms > DESCANSO_ABIERTO_HORAS * HORA_MS);
}

/**
 * El turno que sigue abierto al final de `eventos` (lo que cuenta de UN
 * empleado, en orden, como [{ tipo, hora }]): cuándo entró (null si el turno
 * no empezó con entrada) y cuántos descansos ya cerró (un fin de descanso
 * cuenta si cierra un inicio del mismo turno). null si no hay turno.
 */
export function turnoEnCurso(eventos) {
  let tu = null;
  let previa = null;
  let enDescanso = false;
  for (const e of eventos || []) {
    if (tu && turnoVencido(previa, e.hora)) tu = null;
    if (e.tipo === 'entrada' || e.tipo === 'salida') {
      tu = e.tipo === 'entrada' ? { entrada: e.hora, descansos: 0 } : null;
      enDescanso = false;
    } else {
      if (!tu) { tu = { entrada: null, descansos: 0 }; enDescanso = false; }
      if (e.tipo === 'fin_descanso' && enDescanso) tu.descansos += 1;
      enDescanso = e.tipo === 'inicio_descanso';
    }
    previa = { tipo: e.tipo, hora_oficial: e.hora };
  }
  return tu;
}

/**
 * Qué puede registrar el empleado. `turno` (de turnoEnCurso) solo decide qué
 * botón se destaca; sin él no se destaca ninguno.
 *
 * Devuelve { posibles, sugerida, destacada, turnoSinCerrar }. `sugerida` no
 * cambia (siempre una de las posibles): la usan las tablets que todavía tengan
 * abierta la página anterior al 10-nov-2026, que la ponen primero.
 */
export function estadoTurno(ultima, ahora, turno = null) {
  if (!ultima || ultima.tipo === 'salida') return { posibles: ['entrada'], sugerida: 'entrada', destacada: null, turnoSinCerrar: false };
  if (turnoVencido(ultima, ahora)) return { posibles: ['entrada'], sugerida: 'entrada', destacada: null, turnoSinCerrar: true };
  if (ultima.tipo === 'inicio_descanso') return { posibles: ['fin_descanso'], sugerida: 'fin_descanso', destacada: null, turnoSinCerrar: false };
  const desdeEntrada = turno?.entrada ? new Date(ahora).getTime() - new Date(turno.entrada).getTime() : 0;
  const tarde = !!turno && (turno.descansos > 0 || desdeEntrada >= DESTACAR_SALIDA_HORAS * HORA_MS);
  return { posibles: ['salida', 'inicio_descanso'], sugerida: 'salida', destacada: tarde ? 'salida' : null, turnoSinCerrar: false };
}
