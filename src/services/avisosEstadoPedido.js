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

export const MODALIDAD_DOMICILIO = 'entrega a domicilio';

export function telefonoAvisable(telefono) {
  const tel = String(telefono || '').trim();
  return tel.length >= 7 && tel !== '—' && !tel.startsWith('rappi-');
}

/** Texto del aviso al cliente para ese estado, o null si no se avisa. */
export function mensajeEstadoParaCliente(pedido, estado) {
  if (!pedido || !telefonoAvisable(pedido.cliente?.telefono)) return null;
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
