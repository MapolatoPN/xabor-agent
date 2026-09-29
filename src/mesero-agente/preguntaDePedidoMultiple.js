// Pregunta de producto, no un asistente paso a paso. Solo datos que realmente
// faltan; un texto puede completarlos todos. Nunca copia preferencias.
export function preguntaDePedidoMultiple(pedido) {
  if ((pedido?.lineas || []).length < 2 || !(pedido.aclaraciones || []).length) return null;
  // Una elección ambigua necesita mostrar sus alternativas concretas.
  if (pedido.aclaraciones.some(a=>a.tipo!=='grupo_requerido')) return null;
  const pendientes = pedido.lineas.map((l,i)=>({l,n:i+1,
    grupos:[...new Set(pedido.aclaraciones.filter(a=>a.lid===l.linea_id).map(a=>a.grupo))]}))
    .filter(x=>x.grupos.length);
  if (pendientes.length < 2) return null;
  const visibles = pendientes.slice(0,3);
  const lineas = visibles.map(({l,n,grupos})=>`${n}. ${l.producto}: ${grupos.join(' y ')}.`);
  return `Para completar ${pendientes.length>3?'estos platillos':'tu pedido'}, dime:\n${lineas.join('\n')}\n`
    + 'Puedes responder todo en un mensaje indicando el platillo. Conservo lo que ya elegiste.';
}
