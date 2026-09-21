// Alias de las formas que significan "pago por enlace" en los canales que
// hablan con el cliente. El pedido canónico usa `enlace_pago`; la voz y el
// bot legacy todavía pueden producir la etiqueta visible en español.
export function esPagoPorEnlace(formaPago) {
  const valor = String(formaPago ?? '').trim().toLowerCase();
  return valor === 'enlace de pago' || valor === 'enlace_pago' || valor === 'link de pago';
}
