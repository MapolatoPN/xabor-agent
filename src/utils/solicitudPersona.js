// Intención explícita; no depende de que el modelo emita un marcador.
export function solicitaAtencionHumana(texto) {
  const t = String(texto || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[¿?¡!]/g, ' ').replace(/\s+/g, ' ').trim();
  const objetivo = '(?:(?:(?:un|una|el|la)\\s+)?(?:persona(?:\\s+real)?|humano|humana|asesor|asesora|agente|encargado|encargada)|alguien(?:\\s+(?:del\\s+equipo|de\\s+soporte|real))?)';
  const patrones = [
    new RegExp(`^(?:por\\s+favor[,\\s]+)?(?:hablar\\s+con\\s+${objetivo}|atencion\\s+humana)$`, 'g'),
    new RegExp(`\\b(?:quiero|necesito|prefiero|quisiera|deseo)\\s+`
      + `(?:hablar\\s+con\\s+${objetivo}|(?:la\\s+)?atencion\\s+(?:de|con)\\s+${objetivo}`
      + `|(?:que\\s+me\\s+atienda\\s+)?${objetivo})\\b`, 'g'),
    new RegExp(`\\b(?:puedo|podria|me\\s+gustaria)\\s+hablar\\s+con\\s+${objetivo}\\b`, 'g'),
    new RegExp(`\\b(?:me\\s+)?(?:puedes?|podrias?|puede|podria)\\s+`
      + `(?:pasar|comunicar|conectar|transferir)(?:me)?\\s+con\\s+${objetivo}\\b`, 'g'),
    new RegExp(`\\bme\\s+(?:pasas?|comunicas?|conectas?|transfieres?)\\s+con\\s+${objetivo}\\b`, 'g'),
    new RegExp(`\\b(?:pasame|paseme|comunicame|comuniqueme|conectame|conecteme|transfiereme|transfierame)`
      + `\\s+con\\s+${objetivo}\\b`, 'g'),
  ];
  for (const patron of patrones) {
    for (const coincidencia of t.matchAll(patron)) {
      const antes = t.slice(0, coincidencia.index);
      // «No quiero un humano» es rechazo. Una afirmación posterior sigue
      // contando: «ya no quiero hablar con el bot, quiero una persona».
      if (/(?:^|\s)(?:(?:ya\s+)?no|nunca|jamas|sin)\s+$/.test(antes)) continue;
      return true;
    }
  }
  return false;
}

/**
 * Lee únicamente el texto que Meta entrega dentro del propio webhook. Esto
 * permite respetar una solicitud humana antes de descargar/analizar archivos
 * y antes de cualquier corte del bot. Una imagen o documento con caption es
 * también un mensaje escrito por el cliente, no solo un adjunto.
 */
export function textoInmediatoDeMensajeWhatsapp(message) {
  if (!message || typeof message !== 'object') return '';
  if (message.type === 'text') return String(message.text?.body || '');
  if (message.type === 'image') return String(message.image?.caption || '');
  if (message.type === 'document') return String(message.document?.caption || '');
  return '';
}

export function payloadsSolicitanAtencionHumana(payloads) {
  return Array.isArray(payloads) && payloads.some((payload) =>
    solicitaAtencionHumana(textoInmediatoDeMensajeWhatsapp(payload?.message)));
}
