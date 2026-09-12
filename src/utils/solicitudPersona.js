// Intención explícita; no depende de que el modelo emita un marcador.
export function solicitaAtencionHumana(texto) {
  const t=String(texto||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
  return /^(?:(?:hola|por favor)[,\s]+)?(?:quiero|necesito|prefiero|puedo)\s+hablar\s+con\s+(?:(?:una?|el|la)\s+)?(?:persona|humano|humana|asesor|asesora|encargado|encargada)\b/.test(t)
    || /^(?:me pasas|pasame|comunicame)\s+con\s+(?:(?:una?|el|la)\s+)?(?:persona|humano|humana|asesor|asesora|encargado|encargada)\b/.test(t);
}
