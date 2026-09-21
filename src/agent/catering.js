// Reglas de entrada del perfil de catering. Se mantienen fuera del prompt y
// del agente de pedidos para que una solicitud de evento no pueda abrir un
// carrito ni confirmar platillos.

const PALABRAS_EVENTO = /\b(evento|fiesta|boda|cumplea(?:n|ñ)os|reuni[oó]n|banquete|congreso|graduaci[oó]n)\b/i;
const SERVICIOS_EVENTO = /\b(catering|mesa\s+de\s+postres|servicio\s+de\s+(?:comida|desayuno|cena)|desayuno|cena)\b/i;
const COTIZACION = /\b(cotizaci[oó]n|cotizar|presupuesto|presupuestar)\b/i;

/**
 * Detecta solo el inicio de una solicitud de evento. Las continuaciones se
 * reconocen por la sesión comercial activa, así un "20 personas" posterior
 * nunca vuelve a entrar al flujo de pedidos.
 */
export function esSolicitudCatering(texto = '') {
  const t = String(texto || '').trim();
  if (!t) return false;
  if (SERVICIOS_EVENTO.test(t) && (PALABRAS_EVENTO.test(t) || COTIZACION.test(t))) return true;
  if (COTIZACION.test(t) && PALABRAS_EVENTO.test(t)) return true;
  return false;
}

