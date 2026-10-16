// Política por negocio. Sin configurar un mínimo, conserva el horario existente.
export function validarHoraMinimaProgramados(hora, minima) {
  if (minima === null || minima === undefined || minima === '') return { ok: true };
  const minutos = valor => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(valor))
    ? Number(valor.slice(0, 2)) * 60 + Number(valor.slice(3)) : null;
  const inicio = minutos(minima), pedido = minutos(hora);
  if (inicio === null || pedido === null) return { ok: false, motivo: 'hora_minima_invalida',
    mensaje: 'No podemos validar ese horario de programación. El personal debe revisarlo.' };
  return pedido >= inicio ? { ok: true } : { ok: false, motivo: 'antes_hora_minima',
    mensaje: `La primera hora disponible para un pedido programado es ${minima}.` };
}
