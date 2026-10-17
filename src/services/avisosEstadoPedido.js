// ─── Qué le dice WhatsApp al cliente cuando el panel cambia el estado ──────
//
// Decisión de Mario (15-oct-2026), a pedido de los trabajadores:
//   · «Listo» es «listo, en espera de recolección». A domicilio ya no se le
//     dice «en camino» al pulsar Listo: el pedido sigue en el mostrador
//     esperando al repartidor.
//   · «Entregado a repartidor» (el «Entregado» de un pedido a domicilio) es
//     cuando de verdad sale: ahí se avisa «va en camino».
//   · Recoger en tienda no cambia: «listo, puedes pasar».
// Sin teléfono real (presencial «—», o el teléfono técnico «rappi-…») no se
// avisa nada. Puro: decide el texto; quien llama lo manda.
//
// Tampoco a un pedido de días anteriores (17-oct-2026): cerrar en el panel
// un pedido que se quedó abierto (Pedidos › Domicilio › «Sin cerrar de días
// anteriores» › Entregado, la misma ruta) es una corrección, no una entrega.
// XAB-1401 de Acuña, del 9-oct, le habría mandado «va en camino» a la
// clienta una semana después. Pasadas VIGENCIA_AVISO_MS desde la hora del
// pedido (la programada, o la de registro) no se avisa.

export const MODALIDAD_DOMICILIO = 'entrega a domicilio';
export const VIGENCIA_AVISO_MS = 12 * 60 * 60 * 1000;

// La hora que cuenta: la programada si la hay, si no la de registro. Sin
// ninguna de las dos se avisa como siempre (no hay con qué decir que es viejo).
function horaDelPedido(pedido) {
  const t = Date.parse(pedido.programado_para || pedido.timestamp || '');
  return Number.isFinite(t) ? t : null;
}

export function avisoVigente(pedido, ahora = Date.now()) {
  const hora = horaDelPedido(pedido);
  return hora === null || ahora - hora <= VIGENCIA_AVISO_MS;
}

export function telefonoAvisable(telefono) {
  const tel = String(telefono || '').trim();
  return tel.length >= 7 && tel !== '—' && !tel.startsWith('rappi-');
}

/** Texto del aviso al cliente para ese estado, o null si no se avisa. */
export function mensajeEstadoParaCliente(pedido, estado, { ahora = Date.now() } = {}) {
  if (!pedido || !telefonoAvisable(pedido.cliente?.telefono)) return null;
  if (!avisoVigente(pedido, ahora)) return null;
  const folio = pedido.id || pedido.folio;
  const domicilio = pedido.modalidad === MODALIDAD_DOMICILIO;
  if (estado === 'listo') {
    return domicilio
      ? `Tu pedido ${folio} está listo. En breve sale con el repartidor.`
      : `Tu pedido ${folio} está listo. Puedes pasar a recogerlo cuando gustes.`;
  }
  if (estado === 'entregado' && domicilio) {
    return `Tu pedido ${folio} va en camino. Llega en unos minutos.`;
  }
  return null;
}
