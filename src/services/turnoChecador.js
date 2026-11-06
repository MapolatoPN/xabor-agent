// XECADOR · Qué le toca registrar a un empleado, según su última checada.
//
// Una sola regla para la tablet (qué ofrecer y qué aceptar) y para la vista
// del administrador (qué checadas quedaron fuera de orden). Vive aparte para
// que el checador y las correcciones la compartan sin depender uno del otro.
//
// Una entrada (o descanso) de hace más de 16 h ya no es el turno de hoy: se
// ofrece una entrada nueva y el turno anterior queda «sin cerrar».

export const TIPOS_CHECADA = ['entrada', 'salida', 'inicio_descanso', 'fin_descanso'];
export const TURNO_ABIERTO_HORAS = 16;

export function estadoTurno(ultima, ahora) {
  if (!ultima || ultima.tipo === 'salida') return { posibles: ['entrada'], sugerida: 'entrada', turnoSinCerrar: false };
  const horas = (new Date(ahora) - new Date(ultima.hora_oficial)) / 3.6e6;
  if (horas > TURNO_ABIERTO_HORAS) return { posibles: ['entrada'], sugerida: 'entrada', turnoSinCerrar: true };
  if (ultima.tipo === 'inicio_descanso') return { posibles: ['fin_descanso', 'salida'], sugerida: 'fin_descanso', turnoSinCerrar: false };
  return { posibles: ['salida', 'inicio_descanso'], sugerida: 'salida', turnoSinCerrar: false };
}
