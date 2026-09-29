// Recorta evidencia ESCRITA por el cliente; nunca autoriza opciones desde
// prosa del modelo. Nombres completos y referencias ordinales son anclas.
// Lo que no se puede separar inequívocamente queda para aclaración.
const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'')
  .toLowerCase().replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
export function textoParaPlatillo({ mensaje, catalogo = [], estado, ficha, lineaId }) {
  const t = ` ${norm(mensaje)} `;
  const items = estado?.carrito?.items || [];
  const nombres = [...new Set(catalogo.flatMap(c => c.productos || []).map(p => norm(p.nombre)))];
  const anclas = [];
  for (const nombre of nombres.filter(Boolean)) {
    let i = t.indexOf(` ${nombre} `);
    while (i >= 0) {
      anclas.push({ i, fin:i+nombre.length+1, nombre });
      i = t.indexOf(` ${nombre} `,i+nombre.length+1);
    }
  }
  for (const m of (lineaId ? t.matchAll(/\b(?:el|la|al|a la) (primero?|primera|segundo|segunda|tercero?|tercera)\b/g) : [])) {
    const n = /^(primer)/.test(m[1]) ? 0 : /^segund/.test(m[1]) ? 1 : 2;
    anclas.push({i:m.index,fin:m.index+m[0].length,lid:items[n]?.lid || '__inexistente__'});
  }
  // Las referencias numéricas solo se aceptan al inicio de una línea,
  // seguidas de ':' o ')': un precio o una cantidad no es un renglón.
  for (const m of (lineaId ? String(mensaje).matchAll(/(?:^|\n)\s*([1-9])[:)]\s*([^\n]*)/g) : [])) {
    const cuerpo = norm(m[2]);
    const i = t.indexOf(` ${m[1]} ${cuerpo}`);
    if (i >= 0) anclas.push({i,fin:i+3,lid:items[Number(m[1])-1]?.lid || '__inexistente__'});
  }
  const ordenadas = anclas.sort((a,b)=>a.i-b.i || b.fin-a.fin)
    .filter((a,i,xs)=>!xs.slice(0,i).some(b=>b.i<=a.i && b.fin>=a.fin));
  if (!ordenadas.length) return { texto:mensaje, acotado:false };
  // Una única mención del producto no necesita recorte. Las referencias de
  // línea sí: «al segundo» nunca permite modificar el primero.
  if (ordenadas.length === 1 && !ordenadas[0].lid && items.length <= 1)
    return {texto:mensaje,acotado:false};
  const compartida = /\b(?:todos|todas|los tres|las tres|ambos|ambas) con\b/.exec(t);
  // Negaciones/excepciones no se extienden a todos automáticamente.
  const tramoComun = compartida ? t.slice(compartida.index,
    ordenadas.find(a=>a.i>compartida.index)?.i ?? t.length) : '';
  const comun = tramoComun && !/\b(?:excepto|menos|salvo|no|sin)\b/.test(tramoComun) ? tramoComun : '';
  const partes = ordenadas.filter(a => a.lid ? a.lid === lineaId : a.nombre === norm(ficha?.nombre))
    .map(a => {
      const i = ordenadas.indexOf(a);
      return t.slice(a.i,Math.min(ordenadas[i+1]?.i ?? t.length,compartida?.index ?? t.length));
    });
  return {texto:[...partes,comun].filter(Boolean).join(' '),acotado:true};
}
