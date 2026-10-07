// Puro y dentro del paquete Edge: funciona también en instalaciones autónomas.
export function agruparPorPersona(items) {
  const grupos = new Map();
  for (const item of items || []) {
    const numero = item.persona?.numero || 0;
    if (!grupos.has(numero)) grupos.set(numero, { persona: item.persona, items: [] });
    grupos.get(numero).items.push(item);
  }
  return [...grupos.values()].sort((a, b) => (a.persona?.numero || 0) - (b.persona?.numero || 0));
}

export function tituloPersona(persona) {
  return persona ? `Orden ${persona.numero}${persona.nombre ? ' — ' + persona.nombre : ''}` : 'Compartido / sin asignar';
}

// El servidor etiqueta también la nota para Edges instalados con el renderer anterior.
export function quitarEtiquetaPersona(nota, item) {
  if (!item.persona_en_notas || !item.persona) return nota;
  const etiqueta = tituloPersona(item.persona);
  if (nota === etiqueta) return '';
  return String(nota || '').startsWith(etiqueta + ' · ') ? nota.slice(etiqueta.length + 3) : nota;
}
