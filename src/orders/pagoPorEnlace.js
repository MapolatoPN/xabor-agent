// Alias de las formas que significan "pago por enlace" en los canales que
// hablan con el cliente. El pedido canónico usa `enlace_pago`; la voz y el
// bot legacy todavía pueden producir la etiqueta visible en español.
export function esPagoPorEnlace(formaPago) {
  const valor = String(formaPago ?? '').trim().toLowerCase();
  return valor === 'enlace de pago' || valor === 'enlace_pago' || valor === 'link de pago';
}

const esVerdadero = (valor) => valor === true
  || String(valor ?? '').trim().toLowerCase() === 'true';

/**
 * Una reserva programada puede venir de snapshots anteriores a la barrera
 * `pendiente_pago`. Por eso el estado no basta para decidir si ya puede ir a
 * cocina: la forma de pago y la bandera de anticipo siguen siendo autoridad.
 */
export function requierePagoConfirmadoParaActivar(pedido = {}) {
  return pedido?.estado === 'pendiente_pago'
    || esVerdadero(pedido?.requierePagoAnticipado)
    || esPagoPorEnlace(pedido?.forma_pago_tipo)
    || esPagoPorEnlace(pedido?.forma_pago);
}

export function puedeActivarsePedidoProgramado(pedido = {}) {
  return !requierePagoConfirmadoParaActivar(pedido)
    || esVerdadero(pedido?.pago_confirmado);
}
