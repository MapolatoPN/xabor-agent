// Identidades procedentes de la foto de Xabor, no de nombres del cliente.
export const MAX_TACOS_LOTE = 12;
export const MAX_CANTIDAD_FLOW = 20;
const norm=s=>String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
export const cantidadFlow=v=>typeof v==='string' && /^(?:[1-9]|1\d|20)$/.test(v)?Number(v):null;
export function categoriasFlow(foto) {
  const categorias=[];
  foto.productos.forEach((p,i)=>{
    const clave=p.categoriaId ?? p.categoria ?? '';
    let c=categorias.find(c=>c.clave===clave);
    if(!c){c={id:`c${categorias.length}`,clave,nombre:p.categoria || 'Menú',indices:[]};categorias.push(c);}
    c.indices.push(i);
  });
  return categorias;
}
export function loteTacos(foto,categoria) {
  if(norm(categoria?.nombre)!=='tacos')return [];
  // Solo tacos que pueden describirse con una tortilla elegida explícitamente.
  // Los que requieren otros grupos siguen disponibles en Personalizar uno.
  return categoria.indices.filter(i=>{
    const p=foto.productos[i],g=p.grupos[0];
    return p.precio>0 && p.grupos.length===1 && norm(g.nombre)==='tortilla'
      && g.minimo<=1 && g.maximo>=1 && ['harina','maiz'].every(n=>g.opciones.filter(o=>norm(o.nombre)===n && o.precio===0).length===1);
  }).slice(0,MAX_TACOS_LOTE);
}
export function opcionTortilla(ficha,eleccion) {
  if(!['harina','maiz'].includes(eleccion))return -1;
  return ficha.grupos[0].opciones.findIndex(o=>norm(o.nombre)===eleccion);
}
