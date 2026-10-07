// Compartido por las dos pantallas. Los índices originales se conservan al agrupar.
window.XaborPersonas = {
  titulo(persona) {
    return persona ? `Orden ${persona.numero}${persona.nombre ? ' — ' + persona.nombre : ''}` : 'Compartido / sin asignar';
  },
  grupos(items) {
    const grupos = new Map();
    items.forEach((item, indice) => {
      const numero = item.persona?.numero || 0;
      if (!grupos.has(numero)) grupos.set(numero, { persona: item.persona, lineas: [] });
      grupos.get(numero).lineas.push({ item, indice });
    });
    return [...grupos.values()].sort((a, b) => (a.persona?.numero || 0) - (b.persona?.numero || 0));
  },
  html(items, renderLinea, esc) {
    if (!items.some(i => i.persona)) return items.map(renderLinea).join('');
    return this.grupos(items).map(g =>
      `<div class="persona-titulo" style="font-weight:800;padding-top:12px;padding-bottom:5px;">${esc(this.titulo(g.persona))}</div>`
      + g.lineas.map(({ item, indice }) => renderLinea(item, indice)).join('')).join('');
  },
  opciones(maximo, seleccion) {
    return '<option value="0">Compartido / sin asignar</option>'
      + Array.from({ length: Math.min(99, maximo) }, (_, i) =>
        `<option value="${i + 1}" ${seleccion === i + 1 ? 'selected' : ''}>Orden ${i + 1}</option>`).join('');
  },
};
