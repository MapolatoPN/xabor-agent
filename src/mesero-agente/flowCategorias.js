import { categoriasFlow,loteTacos,opcionTortilla,cantidadFlow,MAX_TACOS_LOTE,MAX_CANTIDAD_FLOW } from './catalogoFlowCategorias.js';
import { cambiarBorrador,respuestaBorrador,MAX_PLATILLOS_FLOW } from './flowRepetible.js';
import { comandosFormulario } from './formularioAgrupado.js';
import { leerObservacionesPlatillo } from './observacionesDelPlatillo.js';
export const borradorCategorias=()=>({revision:0,etapa:'MENU',items:[],categoria:null});
const camposItem=k=>/^producto0$|^g[0-5]_[sm]$|^observaciones$|^cantidad$/.test(k);
const valido=(foto,items)=>comandosFormulario(foto,{items,modalidad:'m0',pago:'p0'})!==null;
export function cambiarCategorias(foto,anterior,solicitud) {
  const actual=structuredClone(anterior),d=solicitud.data;
  const fallo=error=>({borrador:structuredClone(anterior),error});
  if(solicitud.action==='INIT')return {borrador:actual};
  if(solicitud.action==='BACK') {
    // Meta entrega en screen el destino del botón Atrás. Refrescarlo evita
    // reutilizar una revisión vieja del menú después de guardar otro lote.
    const destinos={TACOS:['MENU'],PLATILLO:['MENU','TACOS'],ENTREGA:['MENU','TACOS','PLATILLO']};
    if(destinos[actual.etapa]?.includes(solicitud.screen)) {
      const categoria=categoriasFlow(foto).find(c=>c.id===actual.categoria);
      if(solicitud.screen==='TACOS' && !loteTacos(foto,categoria).length)return fallo('Elige una categoría para continuar.');
      actual.etapa=solicitud.screen;actual.revision++;
    }
    return {borrador:actual};
  }
  if(solicitud.action!=='data_exchange' || !d || typeof d!=='object' || Array.isArray(d))return fallo('No pude leer la selección.');
  if(d.revision!==String(actual.revision) || solicitud.screen!==actual.etapa)return fallo('La ventana cambió. Revisa la selección actual.');
  if(['ENTREGA','FINAL'].includes(actual.etapa))return cambiarBorrador(foto,actual,solicitud);
  const cat=categoriasFlow(foto).find(c=>c.id===actual.categoria);
  const oper=d.operacion;
  if(actual.etapa==='MENU') {
    if(Object.keys(d).some(k=>!['revision','operacion','categoria'].includes(k)))return fallo('Selección no disponible.');
    if(oper==='terminar' && actual.items.length)actual.etapa='ENTREGA';
    else if(oper==='categoria') {
      const elegida=categoriasFlow(foto).find(c=>c.id===d.categoria);
      if(!elegida)return fallo('Elige una categoría disponible.');
      actual.categoria=elegida.id;actual.etapa=loteTacos(foto,elegida).length?'TACOS':'PLATILLO';
    } else return fallo('Elige una categoría para agregar tu primer platillo.');
  } else {
    if(!cat || !['agregar','terminar','categorias','individual'].includes(oper))return fallo('Selección no disponible.');
    const nuevos=[];
    if(actual.etapa==='PLATILLO') {
      if(oper==='individual' || Object.keys(d).some(k=>!camposItem(k) && !['revision','operacion'].includes(k)))return fallo('Selección no disponible.');
      const item=Object.fromEntries(Object.entries(d).filter(([k])=>camposItem(k)));
      const sinProducto=!item.producto0;
      const otros=Object.entries(item).filter(([k])=>!['cantidad','producto0'].includes(k)).some(([,v])=>Array.isArray(v)?v.length:!!v);
      if(sinProducto && (otros || ![undefined,'','1'].includes(item.cantidad)))return fallo('Elige el platillo de estas opciones y observaciones.');
      if(!sinProducto) {
        if(!cat.indices.some(i=>item.producto0===`p${i}`) || !cantidadFlow(item.cantidad) || !valido(foto,[item]))return fallo('Completa las opciones y la cantidad del platillo.');
        nuevos.push(item);
      }
    } else if(actual.etapa==='TACOS') {
      const indices=loteTacos(foto,cat);
      if(Object.keys(d).some(k=>!['revision','operacion','tortilla'].includes(k) && !/^t(?:[0-9]|1[01])_(q|nota)$/.test(k)))return fallo('Selección no disponible.');
      for(let n=0;n<MAX_TACOS_LOTE;n++) {
        const q=d[`t${n}_q`],nota=leerObservacionesPlatillo(d[`t${n}_nota`]);
        if(nota===null)return fallo('Usa hasta 300 caracteres de texto en cada nota.');
        if([undefined,'','0'].includes(q)) {if(nota)return fallo('Indica cantidad para el taco que tiene una nota, o borra su nota.');continue;}
        const i=indices[n];if(i===undefined || !cantidadFlow(q))return fallo('Revisa las cantidades de tacos.');
        const p=foto.productos[i],o=opcionTortilla(p,d.tortilla);
        if(o<0)return fallo('Elige la tortilla para estos tacos.');
        const multi=p.grupos[0].maximo>1;
        nuevos.push({producto0:`p${i}`,cantidad:q,observaciones:nota,[multi?'g0_m':'g0_s']:multi?[`p${i}g0o${o}`]:`p${i}g0o${o}`});
      }
      if(nuevos.length && !valido(foto,nuevos))return fallo('Revisa las opciones de tus tacos.');
    } else return fallo('Ventana no disponible.');
    if(!nuevos.length && (oper==='agregar' || (oper==='terminar' && !actual.items.length)))return fallo('Elige al menos un platillo y su cantidad.');
    if(actual.items.length+nuevos.length>MAX_PLATILLOS_FLOW)return fallo('Esta ventana llegó a 50 renglones. Revisa lo agregado.');
    actual.items.push(...nuevos);
    actual.etapa=oper==='terminar'?'ENTREGA':oper==='categorias'?'MENU':oper==='individual'?'PLATILLO':actual.etapa;
  }
  actual.revision++;
  return {borrador:actual};
}

export function respuestaCategorias(foto,b,token,error='',seleccion=null) {
  if(['ENTREGA','FINAL'].includes(b.etapa))return respuestaBorrador(foto,b,token,error,seleccion);
  const unidades=b.items.reduce((n,i)=>n+Number(i.cantidad || 1),0);
  const comunes={revision:String(b.revision),resumen:unidades?`${unidades} unidades en tu pedido.`:'Elige una categoría para comenzar.',error,error_visible:!!error};
  const cats=categoriasFlow(foto),cat=cats.find(c=>c.id===b.categoria);
  const vigente=error && seleccion?.revision===String(b.revision)?seleccion:null;
  if(b.etapa==='MENU')return {screen:'MENU',data:{...comunes,categorias:cats.map(c=>({id:c.id,title:c.nombre.slice(0,30)}))}};
  if(b.etapa==='PLATILLO') {
    const r=respuestaBorrador(foto,b,token,error,seleccion);
    r.data.productos0=r.data.productos0.filter(p=>cat.indices.some(i=>p.id===`p${i}`));
    r.data.categoria_nombre=cat.nombre;r.data.resumen=comunes.resumen;
    r.data.cantidad_inicial=vigente && cantidadFlow(vigente.cantidad)?vigente.cantidad:'1';
    for(const p of r.data.productos0)p['on-select-action'].payload.cantidad_inicial='1';
    return r;
  }
  const indices=loteTacos(foto,cat),data={...comunes,tortilla_inicial:['harina','maiz'].includes(vigente?.tortilla)?vigente.tortilla:''};
  for(let n=0;n<MAX_TACOS_LOTE;n++) {
    const p=foto.productos[indices[n]],cantidad=vigente && cantidadFlow(vigente[`t${n}_q`])?vigente[`t${n}_q`]:'0';
    data[`t${n}_visible`]=!!p;data[`t${n}_titulo`]=p?`${p.nombre} · $${p.precio} c/u`:'Taco';
    data[`t${n}_inicial`]=cantidad;data[`t${n}_activo`]=cantidad!=='0';
    data[`t${n}_nota`]=p?(leerObservacionesPlatillo(vigente?.[`t${n}_nota`]) ?? ''):'';
    data[`t${n}_cantidades`]=Array.from({length:MAX_CANTIDAD_FLOW+1},(_,q)=>({id:String(q),title:String(q),
      'on-select-action':{name:'update_data',payload:{[`t${n}_activo`]:q>0,...(q===0?{[`t${n}_nota`]:''}:{})}}}));
  }
  return {screen:'TACOS',data};
}
