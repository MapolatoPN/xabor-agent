import { categoriasFlow,loteTacos,opcionTortilla,cantidadFlow,MAX_TACOS_LOTE,MAX_CANTIDAD_FLOW } from './catalogoFlowCategorias.js';
import { cambiarBorrador,respuestaBorrador,MAX_PLATILLOS_FLOW } from './flowRepetible.js';
import { comandosFormulario } from './formularioAgrupado.js';
import { leerObservacionesPlatillo } from './observacionesDelPlatillo.js';
import { CONTRATO_DIRECCION,CAMPOS_PANTALLA_DIRECCION,LIMITES_DIRECCION,validarDireccion,datosPantallaDireccion,esDomicilio,
  limpiarCampo,sinContratoDireccion } from './direccionFormulario.js';
import { CONTRATO_NOTA,ERROR_NOTA_PEDIDO,leerNotaPedido } from './notaDelPedido.js';
export const borradorCategorias=()=>({revision:0,etapa:'MENU',items:[],categoria:null,navegacion:[]});
/** Quita del borrador la dirección y su aviso (cierre sin domicilio). */
export const sinDireccion=b=>{delete b.direccion;delete b.aviso_direccion;};
const camposItem=k=>/^producto0$|^g[0-5]_[sm]$|^observaciones$|^cantidad$/.test(k);
const valido=(foto,items)=>comandosFormulario(sinContratoDireccion(foto),{items,modalidad:'m0',pago:'p0'})!==null;
const unir=l=>l.length<2?l.join(''):`${l.slice(0,-1).join(', ')} y ${l.at(-1)}`;
// Nombra las opciones obligatorias sin elegir (incidente 1-oct-2026:
// «Completa las opciones» no decía cuáles faltaban).
function faltantesPlatillo(foto,item) {
  const pi=Number(String(item.producto0).slice(1)),p=foto.productos?.[pi];
  if(!p)return [];
  return p.grupos.filter((g,gi)=>{
    const v=item[`g${gi}_${g.maximo>1?'m':'s'}`];
    return (Array.isArray(v)?v.length:v?1:0)<g.minimo;
  }).map(g=>g.nombre);
}
// Historial del servidor, nunca un destino o historial recibido del cliente.
// Un borrador anterior sin historial vuelve al menú, sin inventar su recorrido.
const historial=b=>Array.isArray(b.navegacion)?[...b.navegacion]:b.etapa==='MENU'?[]:['MENU'];
function navegar(b,destino) {
  if(destino===b.etapa)return;
  const camino=historial(b),previa=camino.indexOf(destino);
  b.navegacion=destino==='MENU'?[]:previa>=0?camino.slice(0,previa):[...camino,b.etapa];
  b.etapa=destino;
}
export function cambiarCategorias(foto,anterior,solicitud) {
  const actual=structuredClone(anterior),d=solicitud.data;
  const fallo=error=>({borrador:structuredClone(anterior),error});
  if(solicitud.action==='INIT') {
    // [M] 4-oct: toda apertura es el MENU, la primera pantalla; el teléfono
    // rechaza un INIT en otra (uno que abría en ENTREGA dio aviso dos veces).
    // Reabierto o retomado a medias (tacos, platillo, entrega, dirección), lo
    // elegido (platillos, entrega, pago, dirección, nota) se conserva y «ORDEN
    // COMPLETA» lleva a «Entrega y pago» ya precargada. FINAL no se toca.
    if(!['MENU','FINAL'].includes(actual.etapa)) {actual.etapa='MENU';actual.navegacion=[];actual.revision++;}
    return {borrador:actual};
  }
  if(solicitud.action==='BACK') {
    // Meta envía la pantalla de ORIGEN. Atrás solo navega: no guarda campos
    // incompletos ni consume otra vez lo agregado. Duplicados/orígenes viejos
    // no hacen retroceder un segundo paso; FINAL nunca se vuelve a abrir.
    // Desde la dirección se regresa a «Entrega y pago», sin perder lo elegido.
    if(solicitud.screen===actual.etapa && actual.etapa==='DIRECCION') {actual.etapa='ENTREGA';actual.revision++;return {borrador:actual};}
    if(solicitud.screen===actual.etapa && ['TACOS','PLATILLO','ENTREGA'].includes(actual.etapa)) {
      const camino=historial(actual),destino=camino.pop();
      if(['MENU','TACOS','PLATILLO'].includes(destino)) {
        actual.etapa=destino;actual.navegacion=camino;actual.revision++;
      }
    }
    return {borrador:actual};
  }
  if(solicitud.action!=='data_exchange' || !d || typeof d!=='object' || Array.isArray(d))return fallo('No pude leer la selección.');
  if(d.revision!==String(actual.revision) || solicitud.screen!==actual.etapa)return fallo('La ventana cambió. Revisa la selección actual.');
  if(actual.etapa==='DIRECCION')return cambiarDireccion(foto,actual,d);
  if(['ENTREGA','FINAL'].includes(actual.etapa)) {
    // Contrato nota_v1: la nota del pedido llega con la entrega y el pago. Se
    // valida aquí y el resto sigue el camino de siempre; sin el contrato, una
    // clave «nota» es desconocida y se rechaza como hoy.
    const conNota=foto.contrato_nota===CONTRATO_NOTA && actual.etapa==='ENTREGA';
    const nota=conNota?leerNotaPedido(d.nota):undefined;
    if(nota===null)return fallo(ERROR_NOTA_PEDIDO);
    const {nota:_,...sinNota}=d;
    const paso=cambiarBorrador(foto,actual,conNota?{...solicitud,data:sinNota}:solicitud);
    if(conNota && !paso.error && paso.borrador.etapa!=='ENTREGA')paso.borrador.nota=nota;
    // Contrato direccion_v1: con domicilio, la dirección se escribe aquí mismo.
    if(foto.contrato===CONTRATO_DIRECCION && actual.etapa==='ENTREGA' && !paso.error && paso.borrador.etapa==='FINAL') {
      if(esDomicilio(foto.modalidades?.[Number(String(paso.borrador.modalidad).slice(1))]?.valor))paso.borrador.etapa='DIRECCION';
      // Sin domicilio no viaja dirección: la de un aviso anterior haría que el
      // recibo se rechazara entero (dirección sin domicilio).
      else sinDireccion(paso.borrador);
    }
    return paso;
  }
  const cat=categoriasFlow(foto).find(c=>c.id===actual.categoria);
  const oper=d.operacion;
  if(actual.etapa==='MENU') {
    if(Object.keys(d).some(k=>!['revision','operacion','categoria'].includes(k)))return fallo('Selección no disponible.');
    if(oper==='terminar' && actual.items.length)navegar(actual,'ENTREGA');
    else if(oper==='categoria') {
      const elegida=categoriasFlow(foto).find(c=>c.id===d.categoria);
      if(!elegida)return fallo('Elige una categoría disponible.');
      actual.categoria=elegida.id;navegar(actual,loteTacos(foto,elegida).length?'TACOS':'PLATILLO');
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
        if(!cat.indices.some(i=>item.producto0===`p${i}`) || !cantidadFlow(item.cantidad) || !valido(foto,[item])) {
          const faltan=cat.indices.some(i=>item.producto0===`p${i}`)?faltantesPlatillo(foto,item):[];
          return fallo(faltan.length?`Falta elegir ${unir(faltan)} para este platillo.`
            :!cantidadFlow(item.cantidad)?'Elige la cantidad del platillo.':'Completa las opciones y la cantidad del platillo.');
        }
        nuevos.push(item);
      }
    } else if(actual.etapa==='TACOS') {
      const indices=loteTacos(foto,cat);
      if(Object.keys(d).some(k=>!['revision','operacion','tortilla'].includes(k) && !/^t(?:[0-9]|1[01])_(q|nota)$/.test(k)))return fallo('Selección no disponible.');
      for(let n=0;n<MAX_TACOS_LOTE;n++) {
        const q=d[`t${n}_q`],nota=leerObservacionesPlatillo(d[`t${n}_nota`]);
        if(nota===null)return fallo('Usa hasta 300 caracteres de texto en cada nota.');
        if([undefined,null,'','0'].includes(q)) {if(nota)return fallo('Indica cantidad para el taco que tiene una nota, o borra su nota.');continue;}
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
    navegar(actual,oper==='terminar'?'ENTREGA':oper==='categorias'?'MENU':oper==='individual'?'PLATILLO':actual.etapa);
  }
  actual.revision++;
  return {borrador:actual};
}

export function respuestaCategorias(foto,b,token,error='',seleccion=null) {
  if(b.etapa==='DIRECCION')return {screen:'DIRECCION',data:datosPantallaDireccion(foto,{revision:b.revision,
    resumen:'Escribe dónde entregamos tu pedido.',error,guardada:b.direccion,aviso:b.aviso_direccion,
    intento:error && seleccion?.revision===String(b.revision)?seleccion:null})};
  if(['ENTREGA','FINAL'].includes(b.etapa))return respuestaBorrador(foto,b,token,error,seleccion);
  const unidades=b.items.reduce((n,i)=>n+Number(i.cantidad || 1),0);
  const inicio={MENU:'Elige una categoría para comenzar.',TACOS:'Elige tus tacos.',PLATILLO:'Elige y personaliza tu platillo.'};
  // En el MENU con platillos, cómo seguir: al reabrir se vuelve aquí y lo elegido espera tras «ORDEN COMPLETA».
  const comunes={revision:String(b.revision),resumen:unidades?`${unidades} artículo${unidades===1?'':'s'} en tu pedido.${b.etapa==='MENU'?' Para seguir, toca ORDEN COMPLETA.':''}`:inicio[b.etapa],error,error_visible:!!error};
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

/**
 * Pantalla DIRECCION (contrato direccion_v1), compartida con el carrito. Un
 * aviso de zona se guarda en el borrador con lo escrito: si el cliente vuelve
 * a mandar lo mismo, se respeta lo que eligió.
 */
export function cambiarDireccion(foto,anterior,d) {
  const actual=structuredClone(anterior);
  if(foto.contrato!==CONTRATO_DIRECCION || d.operacion!=='direccion' || Object.keys(d).some(k=>!CAMPOS_PANTALLA_DIRECCION.includes(k)))
    return {borrador:structuredClone(anterior),error:'Selección no disponible.'};
  const v=validarDireccion(foto,d,{confirmada:actual.aviso_direccion ?? null});
  if(!v.ok) {
    if(!v.aviso)return {borrador:structuredClone(anterior),error:v.error};
    // El aviso solo sale con los campos ya válidos: se guardan tal cual para
    // que la pantalla los muestre y el reenvío igual confirme.
    actual.aviso_direccion=v.aviso;
    actual.direccion={calle:limpiarCampo(d.calle,LIMITES_DIRECCION.calle),colonia:limpiarCampo(d.colonia,LIMITES_DIRECCION.colonia),
      referencias:limpiarCampo(d.referencias,LIMITES_DIRECCION.referencias),zona:d.zona};
    actual.revision++;
    return {borrador:actual,error:v.error};
  }
  const {calle,colonia,referencias,zona,confirmada}=v.partes;
  actual.direccion={calle,colonia,referencias,zona,...(confirmada?{confirmada}:{})};
  delete actual.aviso_direccion;
  actual.etapa='FINAL';actual.revision++;
  return {borrador:actual};
}
