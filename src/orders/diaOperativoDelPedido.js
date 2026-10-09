// ─── ¿Un pedido abierto es del día operativo? ───────────────────────────────
//
// El tablero no resucita pedidos de días anteriores al recargar (aa99cba,
// 21-sep): cuenta el día en que se REGISTRÓ el pedido (`timestamp`). Eso deja
// fuera a los programados. El 9-oct, XAB-1401 de Acuña se pidió la noche
// anterior para las 8:30; el scheduler lo activó a las 7:34 y en el primer F5
// desapareció de «En curso»: pagado, en estado «nuevo» y sin que nadie lo
// viera hasta que el cliente llamó. Para un programado lo que cuenta es el día
// PARA EL QUE se programó.
//
// La regla solo AÑADE visibilidad -- todo lo que antes se mostraba se sigue
// mostrando:
//   - registrado hoy                      → del día (igual que antes);
//   - programado para hoy o un día después → del día. «Después» cubre al que
//     el scheduler activa antes de medianoche para la madrugada siguiente (lo
//     activa una hora antes de su hora);
//   - registrado antes de hoy y programado para un día que ya pasó (o sin
//     programar) → de días anteriores.
//
// `programado_para` es el ISO que guarda el canal dentro del pedido: la
// identidad temporal canónica de la reserva (ver convertirPedidoAProgramado).
//
// Pura a propósito: el día operativo de un instante lo da quien llama
// (fechaOperativaDe de cortesCaja.js con la zona del negocio), así esta regla
// se prueba sin base ni servidor.

function fechaDe(valor, fechaOperativa) {
  if (!valor) return null;
  const instante = new Date(valor);
  return Number.isNaN(instante.getTime()) ? null : fechaOperativa(instante);
}

/**
 * @param {object} pedido  pedido en memoria (`timestamp`, `programado_para`)
 * @param {string} hoy     'YYYY-MM-DD' del día operativo actual del negocio
 * @param {(instante: Date) => string} fechaOperativa  'YYYY-MM-DD' de un instante en la zona del negocio
 */
export function esDelDiaOperativo(pedido, hoy, fechaOperativa) {
  if (fechaDe(pedido?.timestamp, fechaOperativa) === hoy) return true;
  const programado = fechaDe(pedido?.programado_para, fechaOperativa);
  return programado !== null && programado >= hoy;
}
