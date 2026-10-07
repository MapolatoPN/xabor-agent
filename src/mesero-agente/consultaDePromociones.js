// ¿El cliente PREGUNTA por las promociones? La usan el canal (que contesta con
// la fuente oficial, canalDelAgente.js) y el modo formulario
// (respuestasFijas.js). Vive aparte, sin dependencias, para que las respuestas
// fijas no tengan que importar el adaptador entero. El cuerpo es el de
// canalDelAgente.js en fc1c803, sin cambios: el canal la reexporta.
export const esConsultaDePromociones = (mensaje) => {
  const t = String(mensaje || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (!/\bpromo(?:s|cion(?:es)?)?\b/.test(t)) return false;
  // «Quiero una promoción» pide conocer/ofrecer la vigente y debe pasar por
  // la fuente oficial. Solo apartamos frases que expresan una mutación del
  // pedido («aplicarla», «usarla», «agregarla al pedido»); no confundimos el
  // verbo «quiero» con la intención de aplicar un descuento.
  if (/\b(?:usar|aplicar|aplicame|agrega|anade|añade|ponme)\b/.test(t)
    || /\bpromo(?:s|cion(?:es)?)?\b.*\b(?:pedido|orden)\b/.test(t)
    || /\b(?:pedido|orden)\b.*\bpromo(?:s|cion(?:es)?)?\b/.test(t)) return false;
  return /[¿?]/.test(t)
    || /^(?:que|cual|hay|tienen)\b/.test(t)
    || /\b(?:quiero|dame)\b.*\bpromo(?:s|cion(?:es)?)?\b/.test(t)
    || /^(?:(?:una|un|alguna|otra)\s+)?promo(?:s|cion(?:es)?)?$/.test(t)
    || /^dime\s+(?:(?:una|un)\s+)?promo(?:s|cion(?:es)?)?$/.test(t)
    || /\b(?:vigente|vigentes|disponible|disponibles)\b/.test(t)
    || /\bpromo(?:s|cion(?:es)?)?\s+(?:de|del)\s+(?:hoy|dia|manana)\b/.test(t);
};
