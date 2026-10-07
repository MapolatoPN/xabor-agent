// Señal de recepción, nunca un parser comercial: no resuelve productos,
// cantidades, precios ni notas y no concede autoridad para cambiar un pedido.
// Una lista puede contener nombres que todavía no coinciden con la carta.
const normalizar = texto => texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const CANTIDAD = /^(?:[-*•]\s*)?(?:([1-9]\d?)(?:\s*[x×])?|(?:un|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez))\s+([a-z][^\n]*)$/;
const METADATO = /^(?:calles?|avenidas?|av\b|colonias?|col\b|cp\b|codigo postal|telefonos?|tel\b|cuentas?|clabe|transferencias?|depositos?|comprobantes?|facturas?|pagos?|pesos?|dolares?|mxn|usd|minutos?|horas?|dias?|meses?|anos?|veces|personas|adultos|invitados|cosas?|dudas?|preguntas?|detalles?|temas?|consultas?|pedidos?|orden(?:es)?|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\b/;
const CONSULTA = /\b(?:tienen|hay|venden|manejan|cuanto cuestan?|cuanto valen?|cotiz\w*|precio de)\b/;
const HISTORICO_O_NEGACION = /\b(?:ayer|pedido anterior|orden anterior|ya (?:pedi|ordene)|(?:esta|esa) (?:fue|era) (?:mi|la) (?:orden|pedido)|(?:no|ya no) (?:quiero|necesito|voy a pedir|voy a ordenar))\b/;

/** Renglones de cantidad y descripción, sin interpretar su contenido. */
export function esListaDeOrdenEscrita(mensaje) {
  if (typeof mensaje !== 'string' || !mensaje.trim() || mensaje.length > 16384) return false;
  const lineas = normalizar(mensaje).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const items = lineas.map(l => {
    const m = l.match(CANTIDAD);
    return !!m && !METADATO.test(m[2]);
  });
  const primero = items.indexOf(true);
  if (primero < 0) return false;
  if (items.filter(Boolean).length === 1 && CONSULTA.test(lineas[primero])) return false;
  // «¿Tienen estos productos?» y una orden histórica no son una compra nueva.
  const introduccion = lineas.slice(0, primero).join(' ');
  return !CONSULTA.test(introduccion) && !HISTORICO_O_NEGACION.test(introduccion);
}
