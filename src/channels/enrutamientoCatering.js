// Decide qué motor puede atender una solicitud de evento ANTES de ejecutar
// atajos de pedido/pago/menú. La decisión es pura para que una regresión no
// vuelva a dejar que "catering y pásame el link" cobre un pedido anterior.
export function decidirRutaCateringWhatsApp({
  solicitudExplicita = false,
  entradaPerfilCatering = false,
  canarioActivo = false,
  eventoCanarioActivo = false,
  sesionAnteriorActiva = false,
} = {}) {
  // No inventar una ficha del agente a partir de una captura del motor retirado.
  if (sesionAnteriorActiva) return 'revision';
  if (entradaPerfilCatering) return canarioActivo ? 'agente' : 'revision';
  if (eventoCanarioActivo) return canarioActivo ? 'agente' : 'revision';
  if (canarioActivo && solicitudExplicita) return 'agente';
  if (solicitudExplicita) return 'revision';
  return 'normal';
}
