// Calendario puro compartido por Mesero y Tienda. Cada fila semanal inicia
// una jornada en ese día; un cierre menor a la apertura pertenece al siguiente.
// Los extremos son [apertura, cierre): nunca se acepta en el cierre exacto.
const DIAS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];

export function minutosDeHorario(valor, { cierre = false } = {}) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(valor ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (min > 59 || h > 23 && !(cierre && h === 24 && min === 0)) return null;
  return h * 60 + min;
}

function ventana(reglas, fecha) {
  const dia = DIAS[new Date(`${fecha}T12:00:00Z`).getUTCDay()];
  const horario = reglas?.horarios?.[dia];
  const especiales = (reglas?.cierres_especiales || []).filter(c => c?.fecha === fecha);
  const inicio = minutosDeHorario(horario?.apertura);
  const cierre = minutosDeHorario(horario?.cierre, { cierre: true });
  const invalida = horario?.abierto === true && (inicio === null || cierre === null);
  let finSemanal = cierre;
  if (inicio !== null && cierre !== null && cierre < inicio) finSemanal += 1440;
  // Apertura == cierre NO implica 24 horas. Eso requiere 00:00 -> 24:00.
  let fin = finSemanal;
  let especial = null;
  let especialInvalido = false;
  for (const e of especiales) {
    const m = minutosDeHorario(e.hora_cierre, { cierre: true });
    if (!e.hora_cierre || m === null) {
      fin = inicio; especial = e; especialInvalido ||= !!e.hora_cierre;
      continue;
    }
    const limite = m + (finSemanal >= 1440 && m < inicio ? 1440 : 0);
    // También una jornada que termina a medianoche puede acortarse de noche.
    if (limite < fin) { fin = limite; especial = e; }
  }
  const activa = horario?.abierto === true && !invalida;
  return { horario, inicio, fin, finSemanal, activa, invalida, especiales, especial, especialInvalido };
}

/** Recibe fecha civil YYYY-MM-DD y minuto (0..1439), ya en la zona del negocio. */
export function evaluarHorarioLocal(reglas, fecha, minuto) {
  const civil = new Date(`${fecha}T12:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fecha)) || Number.isNaN(civil.getTime())
      || civil.toISOString().slice(0, 10) !== fecha || !Number.isInteger(minuto) || minuto < 0 || minuto >= 1440) {
    return { abierto: false, preApertura: false, horarioInvalido: true, cierreEspecial: null };
  }
  const anterior = new Date(civil.getTime() - 86400000).toISOString().slice(0, 10);
  const hoy = ventana(reglas, fecha), ayer = ventana(reglas, anterior);
  const cabe = (v, m) => v.activa && m >= v.inicio && m < v.fin;
  const restoAyer = cabe(ayer, minuto + 1440);
  // Una excepción de calendario del día actual manda también sobre el
  // remanente de ayer; un día semanal desmarcado solo impide abrir otra jornada.
  const vetoHoy = hoy.especiales.find(e => !e.hora_cierre
    || minutosDeHorario(e.hora_cierre, { cierre: true }) === null);
  const vetoResto = hoy.especiales.find(e =>
    minuto >= minutosDeHorario(e.hora_cierre, { cierre: true }));
  const abiertoHoy = cabe(hoy, minuto) && !vetoHoy;
  const abiertoAyer = restoAyer && !vetoHoy && !vetoResto;
  const abierto = abiertoHoy || abiertoAyer;
  const preApertura = !abierto && !vetoHoy && hoy.activa && hoy.fin > hoy.inicio && minuto < hoy.inicio;
  const recorteAyer = ayer.activa && minuto + 1440 < ayer.finSemanal && minuto + 1440 >= ayer.fin;
  const recorteHoy = hoy.activa && minuto >= hoy.fin && hoy.especial;
  const vigente = abiertoAyer && !abiertoHoy ? ayer : hoy;
  let finVigente = vigente.fin;
  if (abiertoAyer && !abiertoHoy) {
    for (const e of hoy.especiales) {
      const m = minutosDeHorario(e.hora_cierre, { cierre: true });
      if (m !== null) finVigente = Math.min(finVigente, 1440 + m);
    }
  }
  const finDelDia = finVigente % 1440;
  const cierreVigente = finVigente === vigente.finSemanal ? vigente.horario?.cierre
    : `${String(Math.floor(finDelDia / 60)).padStart(2, '0')}:${String(finDelDia % 60).padStart(2, '0')}`;
  return {
    abierto, preApertura,
    horarioDia: hoy.horario,
    horarioVigente: vigente.horario,
    cierreVigente: abierto ? cierreVigente : null,
    horarioInvalido: hoy.invalida || hoy.especialInvalido,
    cierreEspecial: abierto ? null : (vetoHoy || (restoAyer && vetoResto)
      || (recorteHoy && hoy.especial) || (recorteAyer && ayer.especial) || null),
  };
}
