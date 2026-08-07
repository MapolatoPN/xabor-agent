// Detección DETERMINISTA de "quiero pagar con enlace de pago" (hotfix
// bot-envio-enlace-pago). El incidente real: la intención caía a la IA, que
// no tiene ninguna herramienta para generar/enviar el enlace de un pedido
// activo -- el prompt incluso le dice que "el sistema lo envía
// automáticamente" (solo cierto al confirmar el pedido). Este detector es
// puro (sin I/O) y el atajo del canal decide con él ANTES de invocar a la
// IA -- el envío del enlace jamás vuelve a depender del criterio del modelo.
//
// Tolerancia: mayúsculas/minúsculas, acentos presentes o ausentes y
// puntuación. NO intenta adivinar typos arbitrarios: mejor un falso
// negativo (cae a la IA, que puede pedir aclaración) que enviar un enlace
// de cobro por un mensaje que no lo pedía.
const quitarAcentos = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

export function detectarSolicitudEnlacePago(texto) {
  if (typeof texto !== 'string') return false;
  const t = quitarAcentos(texto.toLowerCase()).replace(/[¿?¡!.,;]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return false;

  // "dónde pago" / "cómo pago" -- solicitud de vía de pago sin mencionar
  // el método: se atiende igual (el atajo decide qué ofrecer).
  if (/\b(donde|como)\s+(te\s+|le\s+)?pago\b/.test(t)) return true;
  // "pagar en línea" sin la palabra enlace/link.
  if (/\bpag\w*\s+en\s+linea\b/.test(t)) return true;

  const mencionaEnlace = /\b(enlace|link|liga)\b/.test(t);
  if (!mencionaEnlace) return false;

  // Con mención de enlace/link/liga: basta un contexto de pago o de envío
  // ("quiero pagar con enlace", "mandame el link", "me generas el enlace",
  // "sí, con link", "el enlace otra vez").
  // Palabras completas de pago -- jamás el prefijo suelto "pag", que
  // convertía "página" en intención de cobro.
  if (/\b(pago|pagos|pagar|pagare|pagaria|pague|paguen|pagando|cobro|cobrar|cobras|cobren)\b/.test(t)) return true;
  if (/\b(manda|mandame|pasa|pasame|envia|enviame|genera|generas|generame|comparte|dame)\b/.test(t)) return true;
  if (/\botra\s+vez\b|\bde\s+nuevo\b|\breenvia/.test(t)) return true;   // reenvío
  if (/\b(si|sale|va|ok|okey|dale|claro)\b.*\b(enlace|link|liga)\b|\b(enlace|link|liga)\b\s*(por\s+favor|porfa)?$/.test(t)) return true; // "sí, con link" / "con enlace, por favor"
  return false;
}
